import { dec, ZERO, D, roundMoney, type Dec, type DecInput } from './money.js';

export type PromotionRule =
  | { type: 'percent_off'; percent: DecInput }
  | { type: 'amount_off_unit'; amount: DecInput }
  | { type: 'buy_x_get_y'; buyQty: number; getQty: number; getPercent: DecInput }
  | { type: 'bundle_price'; qty: number; price: DecInput }
  | { type: 'basket_threshold'; threshold: DecInput; percent?: DecInput; amount?: DecInput };

export interface Promotion {
  id: string;
  code: string;
  nameAr: string;
  nameEn?: string;
  priority: number;              // lower first
  exclusive: boolean;            // if true, units it touches can't get other promotions
  stackable: boolean;            // may apply on top of already-discounted units
  validFrom: string;
  validTo: string | null;
  /** Daily time window "HH:MM"-"HH:MM" in branch local time (optional) */
  timeFrom?: string | null;
  timeTo?: string | null;
  couponCode?: string | null;
  customerGroupIds?: string[] | null;
  targets: { variantIds?: string[]; categoryIds?: string[]; brandIds?: string[]; all?: boolean };
  rule: PromotionRule;
}

export interface PromoLineInput {
  lineId: string;
  variantId: string;
  categoryPath: string[];        // ancestors incl. own category
  brandId?: string | null;
  qty: Dec;
  unitPrice: Dec;
  isWeighted: boolean;
}

export interface PromoApplication { promotionId: string; code: string; lineId: string | null; amount: Dec }

export interface PromoContext { at: Date; localTime: string /* HH:MM */; couponCodes: string[]; customerGroupIds: string[] }

function isActive(p: Promotion, ctx: PromoContext): boolean {
  const t = ctx.at.getTime();
  if (Date.parse(p.validFrom) > t) return false;
  if (p.validTo && Date.parse(p.validTo) <= t) return false;
  if (p.timeFrom && p.timeTo) {
    const inWin = p.timeFrom <= p.timeTo
      ? ctx.localTime >= p.timeFrom && ctx.localTime < p.timeTo
      : ctx.localTime >= p.timeFrom || ctx.localTime < p.timeTo; // overnight window
    if (!inWin) return false;
  }
  if (p.couponCode && !ctx.couponCodes.map((c) => c.toUpperCase()).includes(p.couponCode.toUpperCase())) return false;
  if (p.customerGroupIds?.length && !p.customerGroupIds.some((g) => ctx.customerGroupIds.includes(g))) return false;
  return true;
}

function matches(p: Promotion, l: PromoLineInput): boolean {
  const t = p.targets;
  if (t.all) return true;
  if (t.variantIds?.includes(l.variantId)) return true;
  if (t.categoryIds?.some((c) => l.categoryPath.includes(c))) return true;
  if (l.brandId && t.brandIds?.includes(l.brandId)) return true;
  return false;
}

interface LineState { line: PromoLineInput; discount: Dec; claimedExclusive: boolean; discountedUnits: number }

/**
 * Deterministic promotion engine shared by POS (offline) and server (recompute).
 * Line-level promotions are evaluated in priority order; basket_threshold promotions are evaluated last
 * on the subtotal after line promotions. Returns per-line and basket applications. Never produces a
 * discount larger than the line amount.
 */
export function applyPromotions(lines: PromoLineInput[], promos: Promotion[], ctx: PromoContext): { applications: PromoApplication[]; lineDiscounts: Map<string, Dec>; basketDiscount: Dec } {
  const active = promos.filter((p) => isActive(p, ctx)).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const state = new Map<string, LineState>(lines.map((l) => [l.lineId, { line: l, discount: ZERO, claimedExclusive: false, discountedUnits: 0 }]));
  const apps: PromoApplication[] = [];

  const addLineDiscount = (p: Promotion, s: LineState, amount: Dec) => {
    const lineAmount = s.line.unitPrice.mul(s.line.qty);
    const room = lineAmount.sub(s.discount);
    const a = roundMoney(D.min(amount, room));
    if (a.lte(0)) return;
    s.discount = s.discount.add(a);
    if (p.exclusive) s.claimedExclusive = true;
    apps.push({ promotionId: p.id, code: p.code, lineId: s.line.lineId, amount: a });
  };

  for (const p of active.filter((x) => x.rule.type !== 'basket_threshold')) {
    const eligible = [...state.values()].filter((s) => matches(p, s.line) && s.line.qty.gt(0) && !s.claimedExclusive && (p.stackable || s.discount.isZero()));
    if (!eligible.length) continue;
    const r = p.rule;
    switch (r.type) {
      case 'percent_off':
        for (const s of eligible) addLineDiscount(p, s, s.line.unitPrice.mul(s.line.qty).mul(dec(r.percent)).div(100));
        break;
      case 'amount_off_unit':
        for (const s of eligible) addLineDiscount(p, s, D.min(dec(r.amount), s.line.unitPrice).mul(s.line.qty));
        break;
      case 'buy_x_get_y':
      case 'bundle_price': {
        // unit expansion over integer units only (weighted goods excluded)
        const units: { s: LineState; price: Dec }[] = [];
        for (const s of eligible) {
          if (s.line.isWeighted) continue;
          const n = s.line.qty.floor().toNumber();
          for (let i = 0; i < n; i++) units.push({ s, price: s.line.unitPrice });
        }
        // most expensive first so the customer gets the cheapest free (standard retail practice)
        units.sort((a, b) => b.price.cmp(a.price));
        if (r.type === 'buy_x_get_y') {
          const group = r.buyQty + r.getQty;
          const groups = Math.floor(units.length / group);
          if (!groups) break;
          const freeUnits = units.slice(units.length - groups * r.getQty); // cheapest units
          const perLine = new Map<LineState, Dec>();
          for (const u of freeUnits) perLine.set(u.s, (perLine.get(u.s) ?? ZERO).add(u.price.mul(dec(r.getPercent)).div(100)));
          for (const [s, amt] of perLine) addLineDiscount(p, s, amt);
        } else {
          const groups = Math.floor(units.length / r.qty);
          if (!groups) break;
          const used = units.slice(0, groups * r.qty);
          const regular = used.reduce<Dec>((acc, u) => acc.add(u.price), ZERO);
          const totalDiscount = regular.sub(dec(r.price).mul(groups));
          if (totalDiscount.lte(0)) break;
          // allocate discount across used units proportionally to price
          const perLine = new Map<LineState, Dec>();
          for (const u of used) perLine.set(u.s, (perLine.get(u.s) ?? ZERO).add(u.price));
          const entries = [...perLine.entries()];
          let allocated = ZERO;
          entries.forEach(([s, w], i) => {
            const share = i === entries.length - 1 ? totalDiscount.sub(allocated) : roundMoney(totalDiscount.mul(w).div(regular));
            allocated = allocated.add(share);
            addLineDiscount(p, s, share);
          });
        }
        break;
      }
    }
  }

  const subtotalAfterLines = [...state.values()].reduce<Dec>((acc, s) => acc.add(s.line.unitPrice.mul(s.line.qty)).sub(s.discount), ZERO);
  let basketDiscount = ZERO;
  for (const p of active.filter((x) => x.rule.type === 'basket_threshold')) {
    const r = p.rule as Extract<PromotionRule, { type: 'basket_threshold' }>;
    const base = subtotalAfterLines.sub(basketDiscount);
    if (base.lt(dec(r.threshold))) continue;
    if (!p.stackable && !basketDiscount.isZero()) continue;
    let amt = r.percent !== undefined ? base.mul(dec(r.percent)).div(100) : dec(r.amount ?? 0);
    amt = roundMoney(D.min(amt, base));
    if (amt.lte(0)) continue;
    basketDiscount = basketDiscount.add(amt);
    apps.push({ promotionId: p.id, code: p.code, lineId: null, amount: amt });
  }

  return { applications: apps, lineDiscounts: new Map([...state].map(([k, v]) => [k, v.discount])), basketDiscount };
}

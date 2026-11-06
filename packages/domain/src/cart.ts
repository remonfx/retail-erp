import { allocate, dec, roundMoney, roundToIncrement, sum, ZERO, D, type Dec, type DecInput } from './money.js';
import { computeTax, type TaxRate, type TaxLineResult } from './tax.js';
import { applyPromotions, type Promotion, type PromoApplication, type PromoContext } from './promotions.js';

export const CALC_ENGINE_VERSION = 'rc-calc-1.0.0';

export interface CartLineInput {
  lineId: string;
  variantId: string;
  qty: DecInput;
  unitPrice: DecInput;
  priceIncludesTax: boolean;
  taxRates: TaxRate[];
  categoryPath?: string[];
  brandId?: string | null;
  isWeighted?: boolean;
  manualDiscountPercent?: DecInput | null;
  manualDiscountAmount?: DecInput | null;
}

export interface CartInput {
  lines: CartLineInput[];
  promotions?: Promotion[];
  context: PromoContext;
  basketManualDiscountPercent?: DecInput | null;
  basketManualDiscountAmount?: DecInput | null;
  limits?: { maxLineDiscountPercent: DecInput; maxBasketDiscountPercent: DecInput };
}

export interface CartLineResult {
  lineId: string;
  variantId: string;
  qty: Dec;
  unitPrice: Dec;
  lineAmount: Dec;       // qty × unitPrice (rounded)
  promoDiscount: Dec;
  manualDiscount: Dec;
  basketDiscount: Dec;
  discountTotal: Dec;
  net: Dec;              // excluding tax
  tax: Dec;
  total: Dec;            // including tax
  taxLines: TaxLineResult[];
}

export interface CartResult {
  engineVersion: string;
  lines: CartLineResult[];
  subtotal: Dec;         // Σ lineAmount
  discountTotal: Dec;
  netTotal: Dec;
  taxTotal: Dec;
  grandTotal: Dec;
  promotions: PromoApplication[];
  violations: { code: 'LINE_DISCOUNT_LIMIT' | 'BASKET_DISCOUNT_LIMIT'; lineId?: string; percent: Dec }[];
}

export function computeCart(input: CartInput): CartResult {
  const lines = input.lines.map((l) => ({
    ...l,
    qtyD: dec(l.qty),
    priceD: dec(l.unitPrice),
    lineAmount: roundMoney(dec(l.qty).mul(dec(l.unitPrice))),
  }));
  for (const l of lines) {
    if (l.qtyD.lte(0)) throw new Error('CART_QTY_MUST_BE_POSITIVE');
    if (l.priceD.lt(0)) throw new Error('CART_PRICE_NEGATIVE');
  }

  const promo = applyPromotions(
    lines.map((l) => ({ lineId: l.lineId, variantId: l.variantId, categoryPath: l.categoryPath ?? [], brandId: l.brandId ?? null, qty: l.qtyD, unitPrice: l.priceD, isWeighted: !!l.isWeighted })),
    input.promotions ?? [],
    input.context,
  );

  const violations: CartResult['violations'] = [];
  const afterLine = lines.map((l) => {
    const promoDiscount = promo.lineDiscounts.get(l.lineId) ?? ZERO;
    const remaining = l.lineAmount.sub(promoDiscount);
    let manual = ZERO;
    if (l.manualDiscountPercent) manual = manual.add(remaining.mul(dec(l.manualDiscountPercent)).div(100));
    if (l.manualDiscountAmount) manual = manual.add(dec(l.manualDiscountAmount));
    manual = roundMoney(D.min(manual, remaining));
    if (input.limits && l.lineAmount.gt(0)) {
      const pct = manual.div(l.lineAmount).mul(100);
      if (pct.gt(dec(input.limits.maxLineDiscountPercent))) violations.push({ code: 'LINE_DISCOUNT_LIMIT', lineId: l.lineId, percent: pct.toDecimalPlaces(2) });
    }
    return { l, promoDiscount, manual, base: remaining.sub(manual) };
  });

  const baseTotal = sum(afterLine.map((x) => x.base));
  let basketManual = ZERO;
  if (input.basketManualDiscountPercent) basketManual = basketManual.add(baseTotal.sub(promo.basketDiscount).mul(dec(input.basketManualDiscountPercent)).div(100));
  if (input.basketManualDiscountAmount) basketManual = basketManual.add(dec(input.basketManualDiscountAmount));
  basketManual = roundMoney(basketManual);
  const basketTotal = roundMoney(D.min(promo.basketDiscount.add(basketManual), baseTotal));
  if (input.limits && baseTotal.gt(0) && basketManual.gt(0)) {
    const pct = basketManual.div(baseTotal).mul(100);
    if (pct.gt(dec(input.limits.maxBasketDiscountPercent))) violations.push({ code: 'BASKET_DISCOUNT_LIMIT', percent: pct.toDecimalPlaces(2) });
  }
  const basketShares = allocate(basketTotal, afterLine.map((x) => x.base));

  const resultLines: CartLineResult[] = afterLine.map((x, i) => {
    const basketDiscount = basketShares[i] ?? ZERO;
    const finalAmount = x.base.sub(basketDiscount);
    const tax = computeTax(finalAmount, x.l.taxRates, x.l.priceIncludesTax);
    return {
      lineId: x.l.lineId, variantId: x.l.variantId, qty: x.l.qtyD, unitPrice: x.l.priceD,
      lineAmount: x.l.lineAmount, promoDiscount: x.promoDiscount, manualDiscount: x.manual, basketDiscount,
      discountTotal: x.promoDiscount.add(x.manual).add(basketDiscount),
      net: tax.net, tax: tax.tax, total: tax.gross, taxLines: tax.lines,
    };
  });

  return {
    engineVersion: CALC_ENGINE_VERSION,
    lines: resultLines,
    subtotal: sum(resultLines.map((l) => l.lineAmount)),
    discountTotal: sum(resultLines.map((l) => l.discountTotal)),
    netTotal: sum(resultLines.map((l) => l.net)),
    taxTotal: sum(resultLines.map((l) => l.tax)),
    grandTotal: sum(resultLines.map((l) => l.total)),
    promotions: promo.applications,
    violations,
  };
}

export interface TenderInput { method: string; amount: DecInput }

/**
 * Validate tenders against grand total. Cash may exceed due (change given); non-cash may not.
 * Optional cash rounding increment (e.g. 0.25) applies only when the remaining due is paid in cash.
 */
export function settleTenders(grandTotal: DecInput, tenders: TenderInput[], cashRoundingIncrement?: DecInput) {
  const total = dec(grandTotal);
  const nonCash = sum(tenders.filter((t) => t.method !== 'cash').map((t) => t.amount));
  const cash = sum(tenders.filter((t) => t.method === 'cash').map((t) => t.amount));
  if (tenders.some((t) => dec(t.amount).lte(0))) return { ok: false as const, error: 'TENDER_AMOUNT_NOT_POSITIVE' };
  if (nonCash.gt(total)) return { ok: false as const, error: 'NON_CASH_EXCEEDS_TOTAL' };
  const cashDue = total.sub(nonCash);
  const roundedCashDue = cash.gt(0) && cashRoundingIncrement ? roundToIncrement(cashDue, cashRoundingIncrement) : cashDue;
  const rounding = roundedCashDue.sub(cashDue);
  if (cash.lt(roundedCashDue)) return { ok: false as const, error: 'INSUFFICIENT_PAYMENT', due: roundedCashDue.sub(cash) };
  return { ok: true as const, change: cash.sub(roundedCashDue), rounding, cashApplied: roundedCashDue, nonCash };
}

/**
 * POS engine — offline-first. The local store is the system of record until the server acknowledges.
 * Every sale is committed atomically together with its outbox item (one store transaction) BEFORE the
 * receipt prints; sync pushes outbox items in sequence and only drops them after an explicit server ack.
 */
import {
  uuidv7, computeCart, settleTenders, resolvePrice, parseEmbeddedBarcode, normalizeArabic, fmt, dec, CALC_ENGINE_VERSION,
  type CartResult, type PriceCandidate, type Promotion, type TaxRate, type EmbeddedBarcodeRule, type SyncItem, type SyncItemResult,
} from '@rc/domain';
import { put, type PosStore, type TxOp } from './store';

export type Transport = (method: 'GET' | 'POST', url: string, body: unknown, headers: Record<string, string>) => Promise<{ status: number; body: any }>;
export const fetchTransport: Transport = async (method, url, body, headers) => {
  const r = await fetch(url, { method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};

export interface Variant { id: string; sku: string; name_ar: string; name_en: string | null; name_suffix_ar: string | null; category_path: string[]; brand_id: string | null; tax_class_id: string; sales_uom_id: string; tracking: string; is_weighted: boolean; blocked_for_sale: boolean; sellable: boolean }
export interface PosUser { id: string; full_name: string; pos_pin_hash: string | null; pos_permissions: string[]; limits: Record<string, number>[]; active: boolean }
export interface CartLine { lineId: string; variantId: string; qty: string; unitPrice: string; priceListItemId: string | null; manualDiscountPercent?: string | null; overrideBy?: string | null; returnOfLineId?: string | null; serialNo?: string | null }
export interface Tender { method: 'cash' | 'card' | 'wallet' | 'instapay' | 'bnpl'; amount: string; reference?: string; cardLast4?: string; approvalCode?: string }
export interface OutboxItem { seq: number; id: string; type: SyncItem['type']; payload: unknown; status: 'pending' | 'acked' | 'quarantined'; attempts: number; lastError: string | null; createdAt: string; ackedAt?: string }
export interface LocalSession { id: string; businessDate: string; openedAt: string; openedBy: string; openingFloat: string; state: 'open' | 'closed'; closedAt?: string; countedCash?: string }

const STREAMS = ['tax', 'users', 'catalog', 'barcodes', 'prices', 'promotions', 'assortment', 'customers'] as const;

export class PosError extends Error { constructor(public code: string, msg?: string) { super(msg ? `${code}: ${msg}` : code); } }

export class PosEngine {
  private chain: Promise<unknown> = Promise.resolve();
  private barcodeIndex = new Map<string, { variant_id: string; pack_qty: string }>();
  private variants = new Map<string, Variant>();
  private nameIndex: { id: string; text: string }[] = [];
  private prices = new Map<string, PriceCandidate[]>();
  private taxesByClass = new Map<string, TaxRate[]>();
  private promotions: Promotion[] = [];
  private users = new Map<string, PosUser>();
  config: any = null;
  cashier: PosUser | null = null;

  constructor(private store: PosStore, private transport: Transport = fetchTransport, private now: () => Date = () => new Date()) {}

  /** Serialize all mutating operations (single-writer semantics for seq allocation). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> { const p = this.chain.then(fn, fn); this.chain = p.catch(() => undefined); return p; }

  // ---------- device ----------
  async meta<T>(key: string): Promise<T | undefined> { return (await this.store.get<{ v: T }>('meta', key))?.v; }
  private setMeta(key: string, v: unknown): TxOp { return put('meta', key, { v }); }
  async isEnrolled() { return !!(await this.meta<string>('deviceSecret')); }

  async enroll(apiUrl: string, deviceId: string, enrollmentCode: string) {
    const r = await this.transport('POST', `${apiUrl}/api/v1/devices/enroll`, { deviceId, enrollmentCode, appVersion: 'pos-0.1.0' }, {});
    if (r.status !== 200) throw new PosError(r.body?.code ?? 'ENROLL_FAILED');
    await this.store.tx([this.setMeta('apiUrl', apiUrl), this.setMeta('deviceId', deviceId), this.setMeta('deviceSecret', r.body.secret), this.setMeta('seq', 0), this.setMeta('receiptSeq', 0)]);
    return r.body;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown) {
    const [api, id, secret] = await Promise.all([this.meta<string>('apiUrl'), this.meta<string>('deviceId'), this.meta<string>('deviceSecret')]);
    if (!api || !id || !secret) throw new PosError('NOT_ENROLLED');
    const r = await this.transport(method, `${api}${path}`, body, { authorization: `Device ${id}:${secret}` });
    if (r.status === 401) throw new PosError('DEVICE_REVOKED');
    if (r.status >= 400) throw new PosError(r.body?.code ?? `HTTP_${r.status}`, r.body?.detail);
    return r.body;
  }

  async refreshConfig() {
    this.config = await this.call('GET', '/api/v1/sync/config');
    await this.store.tx([this.setMeta('config', this.config)]);
    return this.config;
  }

  // ---------- master data ----------
  async pullAll(onProgress?: (stream: string, n: number) => void) {
    for (const stream of STREAMS) {
      let since = (await this.meta<number>(`cursor.${stream}`)) ?? 0;
      for (let guard = 0; guard < 10_000; guard++) {
        const r = await this.call('GET', `/api/v1/sync/pull?stream=${stream}&since=${since}&limit=2000`);
        const table = ({ tax: 'taxes', users: 'users', catalog: 'variants', barcodes: 'barcodes', prices: 'prices', promotions: 'promotions', assortment: 'assortment', customers: 'customers' } as const)[stream];
        const ops: TxOp[] = r.items.map((it: any) => put(table, it.id ?? it.variant_id, it));
        for (const d of r.deleted) ops.push({ table, op: 'delete', key: d });
        ops.push(this.setMeta(`cursor.${stream}`, r.nextVersion));
        await this.store.tx(ops);
        onProgress?.(stream, r.items.length);
        since = r.nextVersion;
        if (!r.hasMore) break;
      }
    }
    await this.store.tx([this.setMeta('lastPullAt', this.now().toISOString())]);
    await this.loadIndexes();
  }

  async loadIndexes() {
    this.config = (await this.meta('config')) ?? this.config;
    const [variants, barcodes, prices, taxes, promos, users] = await Promise.all(['variants', 'barcodes', 'prices', 'taxes', 'promotions', 'users'].map((t) => this.store.all<any>(t as never)));
    this.variants = new Map(variants.map((v) => [v.id, v]));
    this.nameIndex = variants.filter((v) => v.sellable).map((v) => ({ id: v.id, text: normalizeArabic(`${v.name_ar} ${v.name_en ?? ''} ${v.name_suffix_ar ?? ''} ${v.sku}`) }));
    this.barcodeIndex = new Map(barcodes.filter((b) => b.status !== 'retired').map((b) => [b.code, { variant_id: b.variant_id, pack_qty: b.pack_qty }]));
    this.prices = new Map();
    for (const p of prices) {
      const c: PriceCandidate = { priceListItemId: p.id, priceListId: p.price_list_id, scope: p.scope, priority: p.priority, variantId: p.variant_id, uomId: p.uom_id, price: p.price, minQty: p.min_qty, validFrom: new Date(p.valid_from).toISOString(), validTo: p.valid_to ? new Date(p.valid_to).toISOString() : null };
      this.prices.set(p.variant_id, [...(this.prices.get(p.variant_id) ?? []), c]);
    }
    this.taxesByClass = new Map();
    for (const tr of taxes) for (const cid of tr.tax_class_ids) this.taxesByClass.set(cid, [...(this.taxesByClass.get(cid) ?? []), { id: tr.id, code: tr.code, rate: tr.rate, kind: tr.kind, sequence: tr.sequence }]);
    this.promotions = promos.filter((p) => p.applicable).map((p) => ({ id: p.id, code: p.code, nameAr: p.name_ar, nameEn: p.name_en, priority: p.priority, exclusive: p.exclusive, stackable: p.stackable,
      validFrom: new Date(p.valid_from).toISOString(), validTo: p.valid_to ? new Date(p.valid_to).toISOString() : null, timeFrom: p.time_from, timeTo: p.time_to, couponCode: p.coupon_code, customerGroupIds: p.customer_group_ids, targets: p.targets, rule: p.rule }));
    this.users = new Map(users.map((u) => [u.id, u]));
  }

  catalogSize() { return this.variants.size; }
  variant(id: string) { return this.variants.get(id); }
  cashiers() { return [...this.users.values()].filter((u) => u.active && u.pos_permissions.includes('pos.sell')); }

  /** Barcode (incl. pack & scale labels) or SKU → variant + qty. */
  lookup(code: string): { variant: Variant; qty: string; unitPrice?: string } | null {
    const c = code.trim();
    const b = this.barcodeIndex.get(c);
    if (b) { const v = this.variants.get(b.variant_id); return v ? { variant: v, qty: dec(b.pack_qty).toString() } : null; }
    const rules: EmbeddedBarcodeRule[] = this.config?.embeddedBarcodeRules ?? [];
    const emb = parseEmbeddedBarcode(c, rules);
    if (emb) {
      const plu = (this.config?.scalePlu ?? []).find((p: any) => p.item_code === emb.itemCode);
      const v = plu ? this.variants.get(plu.variant_id) : undefined;
      if (v) {
        if (emb.valueType === 'weight' || emb.valueType === 'quantity') return { variant: v, qty: emb.value.toString() };
        const unit = this.priceFor(v.id, '1');
        if (unit && dec(unit.price).gt(0)) return { variant: v, qty: emb.value.div(dec(unit.price)).toDecimalPlaces(3).toString() };
      }
    }
    for (const v of this.variants.values()) if (v.sku.toUpperCase() === c.toUpperCase()) return { variant: v, qty: '1' };
    return null;
  }

  search(text: string, limit = 20): Variant[] {
    const q = normalizeArabic(text);
    if (q.length < 2) return [];
    const parts = q.split(' ');
    const out: Variant[] = [];
    for (const e of this.nameIndex) { if (parts.every((p) => e.text.includes(p))) { out.push(this.variants.get(e.id)!); if (out.length >= limit) break; } }
    return out;
  }

  priceFor(variantId: string, qty: string) {
    const v = this.variants.get(variantId);
    if (!v) return null;
    const r = resolvePrice(this.prices.get(variantId) ?? [], variantId, v.sales_uom_id, qty, this.now());
    return r ? { price: fmt(r.unitPrice, 2), priceListItemId: r.priceListItemId } : null;
  }

  newLine(variantId: string, qty: string): CartLine {
    const p = this.priceFor(variantId, qty);
    if (!p) throw new PosError('NO_PRICE');
    const v = this.variants.get(variantId)!;
    if (!v.sellable || v.blocked_for_sale) throw new PosError('NOT_SELLABLE');
    return { lineId: uuidv7(), variantId, qty, unitPrice: p.price, priceListItemId: p.priceListItemId };
  }

  // ---------- cashier ----------
  async login(userId: string, pin: string, verify: (hash: string, pin: string) => Promise<boolean>) {
    const u = this.users.get(userId);
    if (!u?.active || !u.pos_pin_hash) throw new PosError('CASHIER_NOT_ALLOWED');
    if (!(await verify(u.pos_pin_hash, pin))) throw new PosError('WRONG_PIN');
    this.cashier = u;
    return u;
  }
  limit(u: PosUser | null, key: string, fallback: number) {
    const vals = (u?.limits ?? []).map((l) => Number(l[key])).filter(Number.isFinite);
    return vals.length ? Math.max(...vals) : fallback;
  }

  // ---------- pricing ----------
  computeCart(lines: CartLine[], opts: { couponCodes?: string[]; basketDiscountPercent?: string | null } = {}): CartResult {
    const at = this.now();
    const localTime = at.toLocaleTimeString('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: false });
    const includesTax = this.config?.terminal?.prices_include_tax ?? true;
    return computeCart({
      lines: lines.map((l) => {
        const v = this.variants.get(l.variantId)!;
        return { lineId: l.lineId, variantId: l.variantId, qty: l.qty, unitPrice: l.unitPrice, priceIncludesTax: includesTax, taxRates: this.taxesByClass.get(v.tax_class_id) ?? [], categoryPath: v.category_path, brandId: v.brand_id, isWeighted: v.is_weighted, manualDiscountPercent: l.manualDiscountPercent };
      }),
      promotions: lines.some((l) => l.returnOfLineId) ? [] : this.promotions,
      context: { at, localTime, couponCodes: opts.couponCodes ?? [], customerGroupIds: [] },
      basketManualDiscountPercent: opts.basketDiscountPercent,
      limits: { maxLineDiscountPercent: this.limit(this.cashier, 'maxLineDiscountPercent', Number(this.config?.terminal?.settings?.maxLineDiscountPercent ?? 0)), maxBasketDiscountPercent: this.limit(this.cashier, 'maxBasketDiscountPercent', Number(this.config?.terminal?.settings?.maxBasketDiscountPercent ?? 0)) },
    });
  }

  // ---------- sessions ----------
  async currentSession(): Promise<LocalSession | null> { return (await this.meta<LocalSession>('session')) ?? null; }

  async openSession(openingFloat: string) {
    return this.exclusive(async () => {
      if (!this.cashier) throw new PosError('NO_CASHIER');
      if (await this.currentSession()) throw new PosError('SESSION_ALREADY_OPEN');
      const s: LocalSession = { id: uuidv7(), businessDate: this.businessDate(), openedAt: this.now().toISOString(), openedBy: this.cashier.id, openingFloat, state: 'open' };
      await this.enqueue('session_open', s.id, { id: s.id, terminalId: this.config.terminal.id, openedBy: s.openedBy, openedAt: s.openedAt, businessDate: s.businessDate, openingFloat }, [this.setMeta('session', s), put('sessions', s.id, s)]);
      return s;
    });
  }

  businessDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: this.config?.terminal?.timezone ?? 'Africa/Cairo' }).format(this.now()); }

  private async enqueue(type: SyncItem['type'], id: string, payload: unknown, extra: TxOp[] = []) {
    const seq = ((await this.meta<number>('seq')) ?? 0) + 1;
    const item: OutboxItem = { seq, id, type, payload, status: 'pending', attempts: 0, lastError: null, createdAt: this.now().toISOString() };
    // atomic: business record + outbox + seq counter
    await this.store.tx([...extra, put('outbox', String(seq).padStart(12, '0'), item), this.setMeta('seq', seq)]);
    return item;
  }

  async offlineBlocked(): Promise<boolean> {
    const last = await this.meta<string>('lastSyncOkAt');
    const max = Number(this.config?.terminal?.settings?.maxOfflineHours ?? 72);
    const pending = (await this.store.all<OutboxItem>('outbox')).some((o) => o.status === 'pending');
    if (!pending || !last) return false;
    return this.now().getTime() - Date.parse(last) > max * 3600_000;
  }

  /** Commit a sale or return. Returns the persisted order (print AFTER this resolves). */
  async commit(args: { lines: CartLine[]; tenders: Tender[]; kind?: 'sale' | 'return'; returnOfId?: string | null; couponCodes?: string[]; basketDiscountPercent?: string | null; overrideBy?: string | null; offline: boolean; customerId?: string | null }) {
    return this.exclusive(async () => {
      const session = await this.currentSession();
      if (!session) throw new PosError('NO_SESSION');
      if (!this.cashier) throw new PosError('NO_CASHIER');
      if (await this.offlineBlocked()) throw new PosError('OFFLINE_LIMIT_EXCEEDED');
      if (!args.lines.length) throw new PosError('EMPTY_CART');
      const kind = args.kind ?? 'sale';
      const cart = this.computeCart(args.lines, { couponCodes: args.couponCodes, basketDiscountPercent: args.basketDiscountPercent });
      if (cart.violations.length && !args.overrideBy) throw new PosError('DISCOUNT_OVERRIDE_REQUIRED', cart.violations.map((v) => v.code).join(','));
      const rounding = this.config?.terminal?.settings?.cashRounding;
      const st = settleTenders(cart.grandTotal, args.tenders, rounding && rounding !== '0' ? rounding : undefined);
      if (!st.ok) throw new PosError(st.error);
      const receiptSeq = ((await this.meta<number>('receiptSeq')) ?? 0) + 1;
      const id = uuidv7();
      const payload = {
        id, sessionId: session.id, receiptNo: `${this.config.terminal.branch_code}-${this.config.terminal.code}-${String(receiptSeq).padStart(7, '0')}`, kind, returnOfId: args.returnOfId ?? null,
        businessDate: session.businessDate, soldAt: this.now().toISOString(), cashierId: this.cashier.id, customerId: args.customerId ?? null, couponCodes: args.couponCodes ?? [],
        basketManualDiscountPercent: args.basketDiscountPercent ?? null, offline: args.offline, engineVersion: CALC_ENGINE_VERSION,
        lines: cart.lines.map((l, i) => ({ lineId: l.lineId, variantId: l.variantId, qty: l.qty.toString(), uomId: this.variants.get(l.variantId)!.sales_uom_id, unitPrice: fmt(l.unitPrice, 2), priceListItemId: args.lines[i]!.priceListItemId,
          manualDiscountPercent: args.lines[i]!.manualDiscountPercent ?? null, overrideBy: args.overrideBy ?? null, serialNo: args.lines[i]!.serialNo ?? null, returnOfLineId: args.lines[i]!.returnOfLineId ?? null,
          discountTotal: fmt(l.discountTotal, 2), net: fmt(l.net, 2), tax: fmt(l.tax, 2), total: fmt(l.total, 2) })),
        payments: args.tenders.map((t) => ({ id: uuidv7(), method: t.method, amount: t.amount, reference: t.reference ?? null, cardLast4: t.cardLast4 ?? null, approvalCode: t.approvalCode ?? null })),
        subtotal: fmt(cart.subtotal, 2), discountTotal: fmt(cart.discountTotal, 2), taxTotal: fmt(cart.taxTotal, 2), grandTotal: fmt(cart.grandTotal, 2), rounding: fmt(st.rounding, 2), change: fmt(st.change, 2),
      };
      const order = { ...payload, promotions: cart.promotions.map((p) => ({ code: p.code, amount: fmt(p.amount, 2) })), printed: false };
      await this.enqueue('pos_txn', id, payload, [put('orders', id, order), this.setMeta('receiptSeq', receiptSeq)]);
      return order;
    });
  }

  async markPrinted(orderId: string) { const o = await this.store.get<any>('orders', orderId); if (o) await this.store.tx([put('orders', orderId, { ...o, printed: true })]); }
  /** Crash recovery: orders committed but never printed (power loss between commit and print). */
  async unprintedOrders() { return (await this.store.all<any>('orders')).filter((o) => !o.printed); }

  async findLocalOrder(receiptNo: string) { return (await this.store.all<any>('orders')).find((o) => o.receiptNo === receiptNo && o.kind === 'sale') ?? null; }
  async returnedQty(lineId: string) { return (await this.store.all<any>('orders')).filter((o) => o.kind === 'return').flatMap((o) => o.lines).filter((l: any) => l.returnOfLineId === lineId).reduce((s: number, l: any) => s + Number(l.qty), 0); }

  async cashMovement(kind: 'cash_in' | 'cash_out' | 'safe_drop', amount: string, reason: string) {
    return this.exclusive(async () => {
      const s = await this.currentSession();
      if (!s || !this.cashier) throw new PosError('NO_SESSION');
      const m = { id: uuidv7(), sessionId: s.id, kind, amount, reason, at: this.now().toISOString(), userId: this.cashier.id };
      await this.enqueue('cash_movement', m.id, m, [put('cash_movements', m.id, m)]);
      return m;
    });
  }

  /** X report (no side effects) — computed from the local journal, so it works offline. */
  async xReport() {
    const s = await this.currentSession();
    if (!s) return null;
    const orders = (await this.store.all<any>('orders')).filter((o) => o.sessionId === s.id);
    const moves = (await this.store.all<any>('cash_movements')).filter((m) => m.sessionId === s.id);
    const tenders: Record<string, number> = {};
    let sales = 0, returns = 0;
    for (const o of orders) {
      const sign = o.kind === 'sale' ? 1 : -1;
      if (o.kind === 'sale') sales += Number(o.grandTotal); else returns += Number(o.grandTotal);
      let change = Number(o.change);
      for (const p of o.payments) { let a = Number(p.amount); if (p.method === 'cash' && change > 0) { const take = Math.min(change, a); a -= take; change -= take; } tenders[p.method] = (tenders[p.method] ?? 0) + sign * a; }
    }
    const mv = moves.reduce((acc, m) => acc + (m.kind === 'cash_in' ? 1 : -1) * Number(m.amount), 0);
    const expectedCash = Number(s.openingFloat) + (tenders.cash ?? 0) + mv;
    return { session: s, orders: orders.length, sales: sales.toFixed(2), returns: returns.toFixed(2), tenders: Object.fromEntries(Object.entries(tenders).map(([k, v]) => [k, v.toFixed(2)])), cashMovements: mv.toFixed(2), expectedCash: expectedCash.toFixed(2) };
  }

  async closeSession(countedCash: string, notes?: string) {
    return this.exclusive(async () => {
      const s = await this.currentSession();
      if (!s || !this.cashier) throw new PosError('NO_SESSION');
      const x = await this.xReport();
      const closed: LocalSession = { ...s, state: 'closed', closedAt: this.now().toISOString(), countedCash };
      await this.enqueue('session_close', uuidv7(), { id: s.id, closedBy: this.cashier.id, closedAt: closed.closedAt, countedCash, notes: notes ?? null }, [put('sessions', s.id, closed), { table: 'meta', op: 'delete', key: 'session' }]);
      return { ...x, countedCash, difference: (Number(countedCash) - Number(x!.expectedCash)).toFixed(2) };
    });
  }

  // ---------- sync ----------
  async queue() { return (await this.store.all<OutboxItem>('outbox')).sort((a, b) => a.seq - b.seq); }

  async syncStatus() {
    const q = await this.queue();
    const pending = q.filter((o) => o.status === 'pending');
    return { pending: pending.length, quarantined: q.filter((o) => o.status === 'quarantined').length, oldestPendingAt: pending[0]?.createdAt ?? null, lastSyncOkAt: (await this.meta<string>('lastSyncOkAt')) ?? null, lastError: (await this.meta<string>('lastSyncError')) ?? null };
  }

  /** Push pending items in seq order. Never deletes an item before the server acknowledges it. */
  async syncOnce(batchSize = 50): Promise<{ pushed: number; acked: number; quarantined: number; retry: number; error?: string }> {
    return this.exclusive(async () => {
      const pending = (await this.queue()).filter((o) => o.status === 'pending').slice(0, batchSize);
      if (!pending.length) { await this.store.tx([this.setMeta('lastSyncOkAt', this.now().toISOString())]); return { pushed: 0, acked: 0, quarantined: 0, retry: 0 }; }
      let results: SyncItemResult[];
      try {
        const r = await this.call('POST', '/api/v1/sync/push', { batchId: uuidv7(), items: pending.map((o) => ({ type: o.type, id: o.id, seq: o.seq, payload: o.payload })) });
        results = r.results;
      } catch (e) {
        const msg = (e as Error).message;
        await this.store.tx([...pending.map((o) => put('outbox', String(o.seq).padStart(12, '0'), { ...o, attempts: o.attempts + 1, lastError: msg })), this.setMeta('lastSyncError', msg)]);
        return { pushed: pending.length, acked: 0, quarantined: 0, retry: pending.length, error: msg };
      }
      const byId = new Map(results.map((r) => [r.id, r]));
      const ops: TxOp[] = [];
      let acked = 0, quarantined = 0, retry = 0;
      for (const o of pending) {
        const r = byId.get(o.id);
        const key = String(o.seq).padStart(12, '0');
        if (r?.status === 'applied' || r?.status === 'duplicate_ack') { acked++; ops.push(put('outbox', key, { ...o, status: 'acked', ackedAt: this.now().toISOString(), lastError: null })); }
        else if (r?.status === 'quarantined') { quarantined++; ops.push(put('outbox', key, { ...o, status: 'quarantined', lastError: r.error ?? 'QUARANTINED' })); }
        else { retry++; ops.push(put('outbox', key, { ...o, attempts: o.attempts + 1, lastError: r?.error ?? 'NO_RESULT' })); }
      }
      ops.push(this.setMeta('lastSyncOkAt', this.now().toISOString()), this.setMeta('lastSyncError', null));
      await this.store.tx(ops);
      return { pushed: pending.length, acked, quarantined, retry };
    });
  }

  /** Purge acknowledged items older than retentionDays (never pending ones). */
  async purgeAcked(retentionDays = 30) {
    const cutoff = this.now().getTime() - retentionDays * 86400_000;
    const ops: TxOp[] = (await this.queue()).filter((o) => o.status === 'acked' && o.ackedAt && Date.parse(o.ackedAt) < cutoff).map((o) => ({ table: 'outbox', op: 'delete', key: String(o.seq).padStart(12, '0') }));
    if (ops.length) await this.store.tx(ops);
    return ops.length;
  }

  async heartbeat(appVersion = 'pos-0.1.0') {
    const s = await this.syncStatus();
    return this.call('POST', '/api/v1/sync/heartbeat', { queueDepth: s.pending, oldestPendingAt: s.oldestPendingAt, appVersion, lastError: s.lastError ?? undefined });
  }
}

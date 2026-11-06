import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { uuidv7, computeCart, settleTenders, fmt, CALC_ENGINE_VERSION } from '@rc/domain';
import { call, signup, userWithRole, product, locations, receiveOpening, ownerPool } from './helpers.js';
import { assertInvariants, CLEAN } from './invariants.js';
import { drainOutbox } from '../src/lib/outbox.js';
import { closePool } from '../src/lib/db.js';

afterAll(async () => { await closePool(); });

let t: Awaited<ReturnType<typeof signup>>;
let device: string, terminalId: string, cashierId: string, stock: string;
let p1: Awaited<ReturnType<typeof product>>, p2: Awaited<ReturnType<typeof product>>;
let seq = 0;
const VAT = (p: { vat14: string }) => [{ id: p.vat14, code: 'VAT14', rate: '14', kind: 'vat' as const }];

beforeAll(async () => {
  t = await signup('pos');
  const cashier = await userWithRole(t, 'cashier', { scopeType: 'branch', branchId: t.branchId });
  cashierId = cashier.userId;
  const d = await call('POST', '/api/v1/devices', { branchId: t.branchId, kind: 'pos', name: 'Till 1' }, { token: t.token, company: t.companyId });
  const term = await call('POST', '/api/v1/terminals', { branchId: t.branchId, code: 'T01', name: 'Till 1', deviceId: d.body.id }, { token: t.token, company: t.companyId });
  terminalId = term.body.id;
  const bad = await call('POST', '/api/v1/devices/enroll', { deviceId: d.body.id, enrollmentCode: 'WRONG123' });
  expect(bad.status).toBe(401);
  const en = await call('POST', '/api/v1/devices/enroll', { deviceId: d.body.id, enrollmentCode: d.body.enrollmentCode, appVersion: '1.0.0' });
  expect(en.status).toBe(200);
  expect(en.body.terminal.id).toBe(terminalId);
  device = `${d.body.id}:${en.body.secret}`;
  // enrollment code is single-use
  expect((await call('POST', '/api/v1/devices/enroll', { deviceId: d.body.id, enrollmentCode: d.body.enrollmentCode })).status).toBe(401);
  stock = (await locations(t)).find((l) => l.type === 'internal' && l.branch_id === t.branchId)!.id;
  p1 = await product(t, { price: '57.00', barcode: '6221234567890'.slice(0, 12) + '0' });
  p2 = await product(t, { price: '114.00' });
  await receiveOpening(t, stock, p1.variantId, '100', '30');
  await receiveOpening(t, stock, p2.variantId, '5', '60');
});

function sale(sessionId: string, lines: { p: typeof p1; qty: string; price: string }[], tenders: { method: 'cash' | 'card'; amount: string }[], opts: { offline?: boolean; kind?: 'sale' | 'return'; returnOf?: { id: string; lineIds: string[] } } = {}) {
  const lineIds = lines.map(() => uuidv7());
  const cart = computeCart({ lines: lines.map((l, i) => ({ lineId: lineIds[i]!, variantId: l.p.variantId, qty: l.qty, unitPrice: l.price, priceIncludesTax: true, taxRates: VAT(l.p), categoryPath: [l.p.rootCategory] })),
    context: { at: new Date(), localTime: '12:00', couponCodes: [], customerGroupIds: [] } });
  const s = settleTenders(cart.grandTotal, tenders);
  if (!s.ok) throw new Error(s.error);
  const id = uuidv7();
  return {
    type: 'pos_txn' as const, id, seq: ++seq,
    payload: {
      id, sessionId, receiptNo: `CAI01-T01-${String(seq).padStart(6, '0')}`, kind: opts.kind ?? 'sale', returnOfId: opts.returnOf?.id ?? null, businessDate: new Date().toISOString().slice(0, 10), soldAt: new Date().toISOString(),
      cashierId, customerId: null, couponCodes: [], offline: !!opts.offline, engineVersion: CALC_ENGINE_VERSION,
      lines: cart.lines.map((l, i) => ({ lineId: l.lineId, variantId: l.variantId, qty: l.qty.toString(), uomId: lines[i]!.p.pcs, unitPrice: fmt(l.unitPrice, 2), discountTotal: fmt(l.discountTotal, 2), net: fmt(l.net, 2), tax: fmt(l.tax, 2), total: fmt(l.total, 2), returnOfLineId: opts.returnOf?.lineIds[i] ?? null })),
      payments: tenders.map((x) => ({ id: uuidv7(), method: x.method, amount: x.amount })),
      subtotal: fmt(cart.subtotal, 2), discountTotal: fmt(cart.discountTotal, 2), taxTotal: fmt(cart.taxTotal, 2), grandTotal: fmt(cart.grandTotal, 2), rounding: '0', change: fmt(s.change, 2),
    },
  };
}
const push = (items: unknown[]) => call('POST', '/api/v1/sync/push', { batchId: uuidv7(), items }, { device });

describe('POS offline sync', () => {
  const sessionId = uuidv7();
  let firstSale: ReturnType<typeof sale>;

  it('device auth: wrong secret rejected', async () => {
    const [id] = device.split(':');
    expect((await call('GET', '/api/v1/sync/config', undefined, { device: `${id}:nope` })).status).toBe(401);
    const cfg = await call('GET', '/api/v1/sync/config', undefined, { device });
    expect(cfg.status).toBe(200);
    expect(cfg.body.terminal.code).toBe('T01');
  });

  it('pull streams deliver catalog, barcodes, prices, users, tax', async () => {
    const cat = await call('GET', '/api/v1/sync/pull?stream=catalog&since=0', undefined, { device });
    expect(cat.body.items.map((i: { id: string }) => i.id)).toEqual(expect.arrayContaining([p1.variantId, p2.variantId]));
    const prices = await call('GET', '/api/v1/sync/pull?stream=prices&since=0', undefined, { device });
    expect(prices.body.items.length).toBeGreaterThanOrEqual(2);
    const users = await call('GET', '/api/v1/sync/pull?stream=users&since=0', undefined, { device });
    const cashier = users.body.items.find((u: { id: string }) => u.id === cashierId);
    expect(cashier.pos_permissions).toContain('pos.sell');
    const next = await call('GET', `/api/v1/sync/pull?stream=catalog&since=${cat.body.nextVersion}`, undefined, { device });
    expect(next.body.items).toHaveLength(0);
  });

  it('session open + sales applied exactly once under concurrent replays', async () => {
    const open = { type: 'session_open' as const, id: sessionId, seq: ++seq, payload: { id: sessionId, terminalId, openedBy: cashierId, openedAt: new Date().toISOString(), businessDate: new Date().toISOString().slice(0, 10), openingFloat: '500' } };
    firstSale = sale(sessionId, [{ p: p1, qty: '2', price: '57.00' }, { p: p2, qty: '1', price: '114.00' }], [{ method: 'cash', amount: '300' }]);
    const r = await push([open, firstSale]);
    expect(r.body.results.map((x: { status: string }) => x.status)).toEqual(['applied', 'applied']);
    // ack lost → device retries the same batch 10 times concurrently
    const replays = await Promise.all(Array.from({ length: 10 }, () => push([open, firstSale])));
    for (const rr of replays) expect(rr.body.results.map((x: { status: string }) => x.status)).toEqual(['duplicate_ack', 'duplicate_ack']);
    const pool = ownerPool();
    const n = (await pool.query('SELECT count(*)::int AS n FROM pos_order WHERE id = $1', [firstSale.id])).rows[0].n;
    const moves = (await pool.query('SELECT count(*)::int AS n FROM inv_stock_move WHERE ref_doc_id = $1', [firstSale.id])).rows[0].n;
    await pool.end();
    expect(n).toBe(1);
    expect(moves).toBe(2);
  });

  it('same id with tampered payload is quarantined, original kept', async () => {
    const tampered = { ...firstSale, seq: ++seq, payload: { ...firstSale.payload, grandTotal: '1.00' } };
    const r = await push([tampered]);
    expect(r.body.results[0]).toMatchObject({ status: 'quarantined', error: 'PAYLOAD_HASH_MISMATCH' });
  });

  it('inconsistent totals are quarantined with full payload (never discarded)', async () => {
    const bad = sale(sessionId, [{ p: p1, qty: '1', price: '57.00' }], [{ method: 'cash', amount: '57' }]);
    bad.payload.grandTotal = '50.00';
    const r = await push([bad]);
    expect(r.body.results[0]).toMatchObject({ status: 'quarantined', error: 'TOTALS_INCONSISTENT' });
    const st = await call('GET', '/api/v1/pos/sync-status', undefined, { token: t.token, company: t.companyId });
    expect(st.body.quarantine.some((q: { client_id: string }) => q.client_id === bad.id)).toBe(true);
    const pool = ownerPool();
    const row = (await pool.query('SELECT payload FROM pos_sync_inbox WHERE client_id = $1', [bad.id])).rows[0];
    await pool.end();
    expect(row.payload.payload.grandTotal).toBe('50.00');
  });

  it('offline sale beyond stock is accepted with negative-stock exception', async () => {
    const s = sale(sessionId, [{ p: p2, qty: '10', price: '114.00' }], [{ method: 'card', amount: '1140.00' }], { offline: true });
    const r = await push([s]);
    expect(r.body.results[0].status).toBe('applied');
    expect(r.body.results[0].exceptions).toContain('NEGATIVE_STOCK:1');
    const ex = await call('GET', '/api/v1/inventory/negative-exceptions', undefined, { token: t.token, company: t.companyId });
    expect(ex.body.some((e: { variant_id: string }) => e.variant_id === p2.variantId)).toBe(true);
  });

  it('return against original receipt: cost restored at original cost; over-return quarantined', async () => {
    const order = await call('GET', `/api/v1/pos/orders/${firstSale.id}`, undefined, { device });
    const l1 = order.body.lines.find((l: { variant_id: string }) => l.variant_id === p1.variantId);
    const ret = sale(sessionId, [{ p: p1, qty: '1', price: '57.00' }], [{ method: 'cash', amount: '57.00' }], { kind: 'return', returnOf: { id: firstSale.id, lineIds: [l1.id] } });
    expect((await push([ret])).body.results[0].status).toBe('applied');
    const over = sale(sessionId, [{ p: p1, qty: '2', price: '57.00' }], [{ method: 'cash', amount: '114.00' }], { kind: 'return', returnOf: { id: firstSale.id, lineIds: [l1.id] } });
    expect((await push([over])).body.results[0]).toMatchObject({ status: 'quarantined', error: 'RETURN_EXCEEDS_SOLD' });
  });

  it('cash movement + session close → Z report and balanced GL posting', async () => {
    const cm = { type: 'cash_movement' as const, id: uuidv7(), seq: ++seq, payload: { id: uuidv7(), sessionId, kind: 'safe_drop' as const, amount: '200', reason: 'إيداع الخزينة', at: new Date().toISOString(), userId: cashierId } };
    cm.id = cm.payload.id;
    // expected cash: 500 float + 228 (sale 1) − 57 (refund) − 200 drop = 471 ; counted 470 → short 1
    const close = { type: 'session_close' as const, id: uuidv7(), seq: ++seq, payload: { id: sessionId, closedBy: cashierId, closedAt: new Date().toISOString(), countedCash: '470' } };
    const r = await push([cm, close]);
    expect(r.body.results.map((x: { status: string }) => x.status)).toEqual(['applied', 'applied']);
    expect(r.body.results[1].exceptions).toEqual(['CASH_DIFFERENCE:-1.00']);
    const late = sale(sessionId, [{ p: p1, qty: '1', price: '57.00' }], [{ method: 'cash', amount: '57' }]);
    expect((await push([late])).body.results[0]).toMatchObject({ status: 'quarantined', error: 'SESSION_NOT_OPEN' });
    await drainOutbox();
    const z = await call('GET', `/api/v1/pos/sessions/${sessionId}/z-report`, undefined, { token: t.token, company: t.companyId });
    expect(z.body.session.state).toBe('posted');
    expect(z.body.session.cash_difference).toBe('-1.0000');
    const je = await call('GET', `/api/v1/journal-entries/${z.body.session.journal_entry_id}`, undefined, { token: t.token, company: t.companyId });
    expect(je.body.state).toBe('posted');
    expect(je.body.total_debit).toBe(je.body.total_credit);
    const codes = je.body.lines.map((l: { account_code: string }) => l.account_code);
    expect(codes).toEqual(expect.arrayContaining(['1101', '1121', '4101', '4103', '2111', '5101', '1141', '1102', '5404']));
    const rec = await call('GET', '/api/v1/reports/inventory-reconciliation', undefined, { token: t.token, company: t.companyId });
    expect(rec.body.reconciled).toBe(true);
    const dash = await call('GET', `/api/v1/dashboard?from=2026-01-01&to=2027-12-31`, undefined, { token: t.token, company: t.companyId });
    expect(Number(dash.body.kpi.net_sales)).toBeGreaterThan(0);
    expect(await assertInvariants(t.tenantId)).toEqual(CLEAN);
  });

  it('revoked device can no longer sync', async () => {
    const [id] = device.split(':');
    expect((await call('POST', `/api/v1/devices/${id}/revoke`, {}, { token: t.token, company: t.companyId })).status).toBe(200);
    expect((await call('GET', '/api/v1/sync/config', undefined, { device })).status).toBe(401);
  });
});

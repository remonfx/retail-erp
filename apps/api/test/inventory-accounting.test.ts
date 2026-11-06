import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { call, signup, userWithRole, product, locations, reasons, receiveOpening, ownerPool } from './helpers.js';
import { assertInvariants, CLEAN } from './invariants.js';
import { drainOutbox } from '../src/lib/outbox.js';
import { closePool } from '../src/lib/db.js';

afterAll(async () => { await closePool(); });

let t: Awaited<ReturnType<typeof signup>>;
let stock: string, alxStock: string;
beforeAll(async () => {
  t = await signup('inv');
  const br2 = await call('POST', '/api/v1/branches', { code: 'ALX01', nameAr: 'فرع الإسكندرية' }, { token: t.token, company: t.companyId });
  const locs = await locations(t);
  stock = locs.find((l) => l.type === 'internal' && l.branch_id === t.branchId)!.id;
  alxStock = locs.find((l) => l.type === 'internal' && l.branch_id === br2.body.branchId)!.id;
});

describe('Inventory engine', () => {
  it('opening stock, weighted average, loss, negative-stock block, GL reconciliation', async () => {
    const p = await product(t);
    await receiveOpening(t, stock, p.variantId, '10', '20');
    await receiveOpening(t, stock, p.variantId, '10', '26');
    const prod = await call('GET', `/api/v1/products/${p.productId}`, undefined, { token: t.token, company: t.companyId });
    expect(prod.body.costs[0].qty).toBe('20.000000');
    expect(prod.body.costs[0].value).toBe('460.0000');               // avg 23
    const rc = await reasons(t.token);
    const loss = await call('POST', '/api/v1/stock-adjustments', { kind: 'adjustment', locationId: stock, reasonCodeId: rc.SHRINK, lines: [{ variantId: p.variantId, qty: '-3' }] }, { token: t.token, company: t.companyId });
    expect(loss.status).toBe(201);
    expect(loss.body.state).toBe('done');
    const neg = await call('POST', '/api/v1/stock-adjustments', { kind: 'scrap', locationId: stock, reasonCodeId: rc.DAMAGE, lines: [{ variantId: p.variantId, qty: '100' }] }, { token: t.token, company: t.companyId });
    expect(neg.status).toBe(409);
    expect(neg.body.code).toBe('INSUFFICIENT_STOCK');
    await drainOutbox();
    const rec = await call('GET', '/api/v1/reports/inventory-reconciliation', undefined, { token: t.token, company: t.companyId });
    expect(rec.body.subledger).toBe('391.00');                        // 17 × 23
    expect(rec.body.reconciled).toBe(true);
    // immutable ledger
    const pool = ownerPool();
    await expect(pool.query(`UPDATE inv_stock_move SET qty = 1 WHERE ref_doc_id = $1`, [loss.body.id])).rejects.toThrow(/IMMUTABLE_RECORD/);
    await pool.end();
  });

  it('adjustment above reason threshold requires approval by another user', async () => {
    const p = await product(t);
    await receiveOpening(t, stock, p.variantId, '1000', '10');
    const rc = await reasons(t.token);
    const big = await call('POST', '/api/v1/stock-adjustments', { kind: 'adjustment', locationId: stock, reasonCodeId: rc.SHRINK, lines: [{ variantId: p.variantId, qty: '-600' }] }, { token: t.token, company: t.companyId });
    expect(big.body.state).toBe('pending_approval');                  // 6,000 > 5,000 threshold
    const approvals = await call('GET', '/api/v1/approvals', undefined, { token: t.token, company: t.companyId });
    const req = approvals.body.find((a: { doc_id: string }) => a.doc_id === big.body.id);
    expect(req.canDecide).toBe(false);                                // requester cannot approve own request
    expect((await call('POST', `/api/v1/approvals/${req.id}/decide`, { decision: 'approve' }, { token: t.token })).body.code).toBe('SELF_APPROVAL_FORBIDDEN');
    const mgr = await userWithRole(t, 'inventory_manager', { scopeType: 'company' });
    const d = await call('POST', `/api/v1/approvals/${req.id}/decide`, { decision: 'approve' }, { token: mgr.token });
    expect(d.status).toBe(200);
    const doc = await call('GET', `/api/v1/stock-documents/${big.body.id}`, undefined, { token: t.token, company: t.companyId });
    expect(doc.body.state).toBe('done');
    expect(doc.body.moves).toHaveLength(1);
  });

  it('two-step inter-branch transfer with shortage; in-transit visible; GL balanced', async () => {
    const p = await product(t);
    await receiveOpening(t, stock, p.variantId, '50', '8');
    const tr = await call('POST', '/api/v1/transfers', { fromLocationId: stock, toLocationId: alxStock, lines: [{ variantId: p.variantId, qty: '20' }] }, { token: t.token, company: t.companyId });
    expect(tr.status).toBe(201);
    expect((await call('POST', `/api/v1/transfers/${tr.body.id}/dispatch`, {}, { token: t.token, company: t.companyId })).body.state).toBe('in_transit');
    const transit = await call('GET', `/api/v1/stock?variantId=${p.variantId}`, undefined, { token: t.token, company: t.companyId });
    expect(transit.body.data.map((r: { location_code: string; qty_on_hand: string }) => [r.location_code, r.qty_on_hand]).sort()).toEqual([['CAI01-STOCK', '30.000000'], ['TRANSIT', '20.000000']]);
    const doc = await call('GET', `/api/v1/stock-documents/${tr.body.id}`, undefined, { token: t.token, company: t.companyId });
    const rc = await reasons(t.token);
    const noReason = await call('POST', `/api/v1/transfers/${tr.body.id}/receive`, { lines: [{ lineId: doc.body.lines[0].id, qtyReceived: '18' }] }, { token: t.token, company: t.companyId });
    expect(noReason.body.code).toBe('SHORTAGE_REASON_REQUIRED');
    const rcv = await call('POST', `/api/v1/transfers/${tr.body.id}/receive`, { lines: [{ lineId: doc.body.lines[0].id, qtyReceived: '18' }], shortageReasonCodeId: rc.TRANSIT }, { token: t.token, company: t.companyId });
    expect(rcv.body).toMatchObject({ state: 'done', shortage: true });
    await drainOutbox();
    const rec = await call('GET', '/api/v1/reports/inventory-reconciliation', undefined, { token: t.token, company: t.companyId });
    expect(rec.body.reconciled).toBe(true);
  });

  it('stock count posts variance considering moves after snapshot', async () => {
    const p = await product(t);
    await receiveOpening(t, stock, p.variantId, '40', '5');
    const c = await call('POST', '/api/v1/stock-counts', { locationId: stock, kind: 'cycle', variantIds: [p.variantId] }, { token: t.token, company: t.companyId });
    expect(c.status).toBe(201);
    await receiveOpening(t, stock, p.variantId, '10', '5');          // movement during the count
    const counter = await userWithRole(t, 'warehouse_clerk', { scopeType: 'branch', branchId: t.branchId });
    expect((await call('POST', `/api/v1/stock-counts/${c.body.id}/entries`, { entries: [{ variantId: p.variantId, countedQty: '47' }] }, { token: counter.token, company: t.companyId })).status).toBe(200);
    const post = await call('POST', `/api/v1/stock-counts/${c.body.id}/post`, {}, { token: t.token, company: t.companyId });
    expect(post.status).toBe(200);
    expect(post.body.variances).toEqual([{ variantId: p.variantId, expected: '50.000000', counted: '47.000000', diff: '-3.000000' }]);
    expect(post.body.value).toBe('-15.00');
  });

  it('serial-tracked items: serial required and no duplicates', async () => {
    const p = await product(t, { tracking: 'serial' });
    const rc = await reasons(t.token);
    const noSerial = await call('POST', '/api/v1/stock-adjustments', { kind: 'adjustment', locationId: stock, reasonCodeId: rc.FOUND, lines: [{ variantId: p.variantId, qty: '1', unitCost: '1000' }] }, { token: t.token, company: t.companyId });
    expect(noSerial.body.code).toBe('SERIAL_REQUIRED');
    const ok = await call('POST', '/api/v1/stock-adjustments', { kind: 'adjustment', locationId: stock, reasonCodeId: rc.FOUND, lines: [{ variantId: p.variantId, qty: '1', serialNo: 'SN-001', unitCost: '1000' }] }, { token: t.token, company: t.companyId });
    expect(ok.status).toBe(201);
    const dup = await call('POST', '/api/v1/stock-adjustments', { kind: 'adjustment', locationId: stock, reasonCodeId: rc.FOUND, lines: [{ variantId: p.variantId, qty: '1', serialNo: 'SN-001', unitCost: '1000' }] }, { token: t.token, company: t.companyId });
    expect(dup.body.code).toBe('DUPLICATE_SERIAL');
  });
});

describe('Accounting engine', () => {
  async function acct(code: string) {
    const a = await call('GET', '/api/v1/accounts', undefined, { token: t.token, company: t.companyId });
    return a.body.find((x: { code: string }) => x.code === code).id as string;
  }

  it('manual journal: unbalanced rejected, maker-checker enforced, posted entry immutable, reversal', async () => {
    const [safe, capital] = [await acct('1102'), await acct('3101')];
    const acc = await userWithRole(t, 'accountant', { scopeType: 'company' });
    const unb = await call('POST', '/api/v1/journal-entries', { date: '2026-11-02', memo: 'capital', lines: [{ accountId: safe, debit: '100' }, { accountId: capital, credit: '90' }] }, { token: acc.token, company: t.companyId });
    expect(unb.body.code).toBe('UNBALANCED_ENTRY');
    const je = await call('POST', '/api/v1/journal-entries', { date: '2026-11-02', memo: 'capital injection', lines: [{ accountId: safe, debit: '100000' }, { accountId: capital, credit: '100000' }] }, { token: acc.token, company: t.companyId });
    expect(je.status).toBe(201);
    const fc = await userWithRole(t, 'financial_controller', { scopeType: 'company' });
    const post = await call('POST', `/api/v1/journal-entries/${je.body.id}/post`, { postingDate: '2026-11-02' }, { token: fc.token, company: t.companyId });
    expect(post.status).toBe(200);
    expect(post.body.number).toMatch(/^GEN\/2026\/\d{6}$/);
    const pool = ownerPool();
    await expect(pool.query(`UPDATE acc_journal_line SET debit = 1 WHERE entry_id = $1`, [je.body.id])).rejects.toThrow(/POSTED_ENTRY_IMMUTABLE/);
    await expect(pool.query(`DELETE FROM acc_journal_entry WHERE id = $1`, [je.body.id])).rejects.toThrow(/POSTED_ENTRY_IMMUTABLE/);
    await expect(pool.query(`UPDATE acc_journal_entry SET memo = 'x' WHERE id = $1`, [je.body.id])).rejects.toThrow(/POSTED_ENTRY_IMMUTABLE/);
    await pool.end();
    const rev = await call('POST', `/api/v1/journal-entries/${je.body.id}/reverse`, { reversalDate: '2026-11-03', reason: 'خطأ في المبلغ' }, { token: fc.token, company: t.companyId });
    expect(rev.status).toBe(200);
    const orig = await call('GET', `/api/v1/journal-entries/${je.body.id}`, undefined, { token: fc.token, company: t.companyId });
    expect(orig.body.state).toBe('reversed');
  });

  it('hard-locked period blocks posting even via direct SQL; late postings move to next open period', async () => {
    const fc = await userWithRole(t, 'financial_controller', { scopeType: 'company' });
    const periods = await call('GET', '/api/v1/fiscal-periods', undefined, { token: fc.token, company: t.companyId });
    const jan = periods.body.find((p: { code: string }) => p.code === '2026-01');
    await drainOutbox();
    const lock = await call('POST', `/api/v1/fiscal-periods/${jan.id}/state`, { state: 'hard_locked' }, { token: fc.token, company: t.companyId });
    expect(lock.status).toBe(200);
    const [safe, capital] = [await acct('1102'), await acct('3101')];
    const acc = await userWithRole(t, 'accountant', { scopeType: 'company' });
    const je = await call('POST', '/api/v1/journal-entries', { date: '2026-01-15', memo: 'late', lines: [{ accountId: safe, debit: '5' }, { accountId: capital, credit: '5' }] }, { token: acc.token, company: t.companyId });
    const post = await call('POST', `/api/v1/journal-entries/${je.body.id}/post`, { postingDate: '2026-01-15' }, { token: fc.token, company: t.companyId });
    expect(post.body.code).toBe('PERIOD_LOCKED');
  });

  it('statements: TB balanced, balance sheet balances, cash flow reconciles, invariants clean', async () => {
    await drainOutbox();
    const tb = await call('GET', '/api/v1/reports/trial-balance?from=2026-11-01&to=2026-11-30', undefined, { token: t.token, company: t.companyId });
    expect(tb.body.balanced).toBe(true);
    const bs = await call('GET', '/api/v1/reports/balance-sheet?asOf=2026-12-31', undefined, { token: t.token, company: t.companyId });
    expect(bs.body.balanced).toBe(true);
    const cf = await call('GET', '/api/v1/reports/cash-flow?from=2026-01-01&to=2026-12-31', undefined, { token: t.token, company: t.companyId });
    expect(cf.body.reconciles).toBe(true);
    const is = await call('GET', '/api/v1/reports/income-statement?from=2026-01-01&to=2026-12-31', undefined, { token: t.token, company: t.companyId });
    expect(is.status).toBe(200);
    expect(await assertInvariants(t.tenantId)).toEqual(CLEAN);
  });
});

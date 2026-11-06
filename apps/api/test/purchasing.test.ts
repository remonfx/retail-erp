import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { call, signup, userWithRole, product } from './helpers.js';
import { assertInvariants, CLEAN } from './invariants.js';
import { drainOutbox } from '../src/lib/outbox.js';
import { closePool } from '../src/lib/db.js';

afterAll(async () => { await closePool(); });
let t: Awaited<ReturnType<typeof signup>>;
beforeAll(async () => { t = await signup('pur'); });

describe('Procure-to-pay', () => {
  it('PO → approval → partial GRN → 3-way match exception → approval → post → payment → GL', async () => {
    const buyer = await userWithRole(t, 'buyer', { scopeType: 'company' });
    const pm = await userWithRole(t, 'purchasing_manager', { scopeType: 'company' });
    const fc = await userWithRole(t, 'financial_controller', { scopeType: 'company' });
    const acc = await userWithRole(t, 'accountant', { scopeType: 'company' });
    const sup = await call('POST', '/api/v1/partners', { nameAr: 'مورد الأغذية المتحدة', isSupplier: true, paymentTermsDays: 30, taxRegistrationNo: '123-456-789' }, { token: buyer.token });
    expect(sup.status).toBe(201);
    const p = await product(t, { cost: '50' });
    const po = await call('POST', '/api/v1/purchase-orders', { supplierId: sup.body.id, branchId: t.branchId, lines: [{ variantId: p.variantId, qty: '100', unitPrice: '50', taxRateId: p.vat14 }] }, { token: buyer.token, company: t.companyId });
    expect(po.status).toBe(201);
    expect(po.body.total).toBe('5700.00');
    expect((await call('POST', `/api/v1/purchase-orders/${po.body.id}/submit`, {}, { token: buyer.token, company: t.companyId })).body.state).toBe('pending_approval');
    const appr = (await call('GET', '/api/v1/approvals', undefined, { token: pm.token, company: t.companyId })).body.find((a: { doc_id: string }) => a.doc_id === po.body.id);
    expect((await call('POST', `/api/v1/approvals/${appr.id}/decide`, { decision: 'approve' }, { token: pm.token })).status).toBe(200);
    const detail = await call('GET', `/api/v1/purchase-orders/${po.body.id}`, undefined, { token: buyer.token, company: t.companyId });
    const lineId = detail.body.lines[0].id;
    const over = await call('POST', `/api/v1/purchase-orders/${po.body.id}/receive`, { lines: [{ orderLineId: lineId, qty: '101' }] }, { token: t.token, company: t.companyId });
    expect(over.body.code).toBe('OVER_RECEIPT');
    const grn = await call('POST', `/api/v1/purchase-orders/${po.body.id}/receive`, { lines: [{ orderLineId: lineId, qty: '60' }] }, { token: t.token, company: t.companyId });
    expect(grn.body.orderState).toBe('partially_received');
    // invoice for 100 @ 52: qty exceeds received AND price beyond 0.5% tolerance
    const inv = await call('POST', '/api/v1/supplier-invoices', { supplierId: sup.body.id, branchId: t.branchId, supplierInvoiceNo: 'INV-9001', invoiceDate: '2026-11-04',
      lines: [{ orderLineId: lineId, qty: '100', unitPrice: '52', taxRateId: p.vat14 }] }, { token: acc.token, company: t.companyId });
    expect(inv.body.matchStatus).toBe('exception');
    expect(inv.body.mismatches.map((m: { type: string }) => m.type).sort()).toEqual(['price', 'qty']);
    expect((await call('POST', `/api/v1/supplier-invoices/${inv.body.id}/post`, {}, { token: acc.token, company: t.companyId })).body.code).toBe('MATCH_EXCEPTION_NOT_APPROVED');
    // duplicate supplier invoice number is blocked
    const dup = await call('POST', '/api/v1/supplier-invoices', { supplierId: sup.body.id, branchId: t.branchId, supplierInvoiceNo: 'INV-9001', invoiceDate: '2026-11-04', lines: [{ orderLineId: lineId, qty: '1', unitPrice: '50' }] }, { token: acc.token, company: t.companyId });
    expect(dup.status).toBe(409);
    // receive the rest, invoice correctly instead (cancel exception invoice by rejection)
    const ex = (await call('GET', '/api/v1/approvals', undefined, { token: pm.token, company: t.companyId })).body.find((a: { doc_id: string }) => a.doc_id === inv.body.id);
    expect((await call('POST', `/api/v1/approvals/${ex.id}/decide`, { decision: 'reject', note: 'wrong qty' }, { token: pm.token })).status).toBe(200);
    await call('POST', `/api/v1/purchase-orders/${po.body.id}/receive`, { lines: [{ orderLineId: lineId, qty: '40' }] }, { token: t.token, company: t.companyId });
    const inv2 = await call('POST', '/api/v1/supplier-invoices', { supplierId: sup.body.id, branchId: t.branchId, supplierInvoiceNo: 'INV-9002', invoiceDate: '2026-11-05',
      lines: [{ orderLineId: lineId, qty: '100', unitPrice: '50.20', taxRateId: p.vat14 }] }, { token: acc.token, company: t.companyId });
    expect(inv2.body.matchStatus).toBe('matched');                    // 0.4% within tolerance
    expect((await call('POST', `/api/v1/supplier-invoices/${inv2.body.id}/post`, {}, { token: acc.token, company: t.companyId })).body.state).toBe('posted');
    await drainOutbox();
    // GRNI cleared: 100×50 received, 100×50 invoiced; PPV = 20; AP = 5,722.80
    const tb = await call('GET', '/api/v1/reports/trial-balance?from=2026-11-01&to=2026-11-30', undefined, { token: fc.token, company: t.companyId });
    const row = (code: string) => tb.body.rows.find((r: { code: string }) => r.code === code);
    expect(row('2102')?.closing ?? '0.00').toBe('0.00');
    expect(row('5102').closing).toBe('20.00');
    expect(row('2101').closing).toBe('-5722.80');
    expect(row('1141').closing).toBe('5000.00');
    // payment above threshold (0) needs approval by controller (not the creator)
    const bank = (await call('GET', '/api/v1/bank-accounts', undefined, { token: acc.token, company: t.companyId })).body.find((b: { kind: string }) => b.kind === 'bank');
    const pay = await call('POST', '/api/v1/payments', { direction: 'outbound', partnerId: sup.body.id, bankAccountId: bank.id, paymentDate: '2026-11-05', amount: '5665.57', whtAmount: '57.23', allocations: [{ invoiceId: inv2.body.id, amount: '5722.80' }] }, { token: acc.token, company: t.companyId });
    expect(pay.body.state).toBe('pending_approval');
    const pa = (await call('GET', '/api/v1/approvals', undefined, { token: fc.token, company: t.companyId })).body.find((a: { doc_id: string }) => a.doc_id === pay.body.id);
    expect((await call('POST', `/api/v1/approvals/${pa.id}/decide`, { decision: 'approve' }, { token: fc.token })).status).toBe(200);
    await drainOutbox();
    const tb2 = await call('GET', '/api/v1/reports/trial-balance?from=2026-11-01&to=2026-11-30', undefined, { token: fc.token, company: t.companyId });
    const r2 = (code: string) => tb2.body.rows.find((r: { code: string }) => r.code === code);
    expect(r2('2101').closing).toBe('0.00');
    expect(r2('2112').closing).toBe('-57.23');
    const aging = await call('GET', '/api/v1/reports/ap-aging?asOf=2026-11-30', undefined, { token: fc.token, company: t.companyId });
    expect(aging.body).toHaveLength(0);
  });

  it('purchase return splits uninvoiced (GRNI) vs invoiced (AP debit note) and stays balanced', async () => {
    const sup = await call('POST', '/api/v1/partners', { nameAr: 'مورد المنظفات', isSupplier: true }, { token: t.token });
    const p = await product(t);
    const po = await call('POST', '/api/v1/purchase-orders', { supplierId: sup.body.id, branchId: t.branchId, lines: [{ variantId: p.variantId, qty: '10', unitPrice: '30', taxRateId: p.vat14 }] }, { token: t.token, company: t.companyId });
    const pm = await userWithRole(t, 'purchasing_manager', { scopeType: 'company' });
    await call('POST', `/api/v1/purchase-orders/${po.body.id}/submit`, {}, { token: t.token, company: t.companyId });
    const a = (await call('GET', '/api/v1/approvals', undefined, { token: pm.token, company: t.companyId })).body.find((x: { doc_id: string }) => x.doc_id === po.body.id);
    await call('POST', `/api/v1/approvals/${a.id}/decide`, { decision: 'approve' }, { token: pm.token });
    const d = await call('GET', `/api/v1/purchase-orders/${po.body.id}`, undefined, { token: t.token, company: t.companyId });
    await call('POST', `/api/v1/purchase-orders/${po.body.id}/receive`, { lines: [{ orderLineId: d.body.lines[0].id, qty: '10' }] }, { token: t.token, company: t.companyId });
    const ret = await call('POST', '/api/v1/purchase-returns', { supplierId: sup.body.id, locationId: d.body.receive_location_id, orderId: po.body.id, reason: 'تالف عند الاستلام', lines: [{ variantId: p.variantId, qty: '2', orderLineId: d.body.lines[0].id }] }, { token: t.token, company: t.companyId });
    expect(ret.status, JSON.stringify(ret.body)).toBe(201);
    await drainOutbox();
    expect(await assertInvariants(t.tenantId)).toEqual(CLEAN);
    const rec = await call('GET', '/api/v1/reports/inventory-reconciliation', undefined, { token: t.token, company: t.companyId });
    expect(rec.body.reconciled).toBe(true);
  });
});

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { call, signup, product, locations, receiveOpening } from './helpers.js';
import { drainOutbox } from '../src/lib/outbox.js';
import { closePool } from '../src/lib/db.js';

afterAll(async () => { await closePool(); });
let t: Awaited<ReturnType<typeof signup>>;
beforeAll(async () => { t = await signup('nav'); });
const H = () => ({ token: t.token, company: t.companyId });

describe('Drill-down navigation', () => {
  it('every document links back to its sources (PO → GRN moves → journal; supplier card; invoice; search)', async () => {
    const sup = await call('POST', '/api/v1/partners', { nameAr: 'مورد الربط', isSupplier: true, paymentTermsDays: 15 }, { token: t.token });
    const p = await product(t, { name: 'جبنة تجربة الربط' });
    const po = await call('POST', '/api/v1/purchase-orders', { supplierId: sup.body.id, branchId: t.branchId, lines: [{ variantId: p.variantId, qty: '10', unitPrice: '20', taxRateId: p.vat14 }] }, H());
    await call('PATCH', `/api/v1/companies/${t.companyId}`, { settings: { poApprovalThreshold: '100000' } }, H());
    expect((await call('POST', `/api/v1/purchase-orders/${po.body.id}/submit`, {}, H())).body.state).toBe('approved');
    const d = await call('GET', `/api/v1/purchase-orders/${po.body.id}`, undefined, H());
    const grn = await call('POST', `/api/v1/purchase-orders/${po.body.id}/receive`, { lines: [{ orderLineId: d.body.lines[0].id, qty: '10' }] }, H());
    const inv = await call('POST', '/api/v1/supplier-invoices', { supplierId: sup.body.id, branchId: t.branchId, supplierInvoiceNo: 'NAV-1', invoiceDate: '2026-11-05', lines: [{ orderLineId: d.body.lines[0].id, qty: '10', unitPrice: '20', taxRateId: p.vat14 }] }, H());
    await call('POST', `/api/v1/supplier-invoices/${inv.body.id}/post`, {}, H());
    await drainOutbox();

    // GRN → its stock moves + header + GL entry
    const src = await call('GET', `/api/v1/stock/sources/${grn.body.id}`, undefined, H());
    expect(src.body.type).toBe('pur_receipt');
    expect(src.body.header.order_number).toBe(po.body.number);
    expect(src.body.moves[0].product_id).toBe(p.productId);
    expect(src.body.journal).toHaveLength(1);

    // invoice → lines link to PO + product; journal by source
    const id = await call('GET', `/api/v1/supplier-invoices/${inv.body.id}`, undefined, H());
    expect(id.body.lines[0]).toMatchObject({ order_id: po.body.id, product_id: p.productId });
    const je = await call('GET', `/api/v1/journal-entries/by-source/${inv.body.id}`, undefined, H());
    expect(je.body).toHaveLength(1);

    // supplier card
    const card = await call('GET', `/api/v1/partners/${sup.body.id}`, undefined, H());
    expect(card.body.orders[0].id).toBe(po.body.id);
    expect(card.body.invoices[0].id).toBe(inv.body.id);
    expect(card.body.summary.open_balance).toBe('228.0000');

    // product movements carry their source ids
    const mv = await call('GET', `/api/v1/products/${p.productId}/movements`, undefined, H());
    expect(mv.body[0]).toMatchObject({ ref_doc_type: 'pur_receipt', ref_doc_id: grn.body.id });

    // global search finds documents and products
    const s1 = await call('GET', `/api/v1/search?q=${encodeURIComponent(po.body.number)}`, undefined, H());
    if (!Array.isArray(s1.body)) throw new Error(JSON.stringify(s1.body));
    expect(s1.body.some((r: { type: string; id: string }) => r.type === 'purchase_order' && r.id === po.body.id)).toBe(true);
    const s2 = await call('GET', `/api/v1/search?q=${encodeURIComponent('جبنه الربط')}`, undefined, H());
    expect(s2.body.some((r: { type: string; id: string }) => r.type === 'product' && r.id === p.productId)).toBe(true);
  });

  it('sources are company-scoped (another tenant gets 404)', async () => {
    const other = await signup('nav2');
    const p = await product(t);
    const stock = (await locations(t)).find((l) => l.type === 'internal')!.id;
    const op = await receiveOpening(t, stock, p.variantId, '5', '3');
    expect((await call('GET', `/api/v1/stock/sources/${op.id}`, undefined, H())).status).toBe(200);
    expect((await call('GET', `/api/v1/stock/sources/${op.id}`, undefined, { token: other.token, company: other.companyId })).status).toBe(404);
  });
});

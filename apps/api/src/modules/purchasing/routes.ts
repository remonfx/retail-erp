import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { uuidv7, uuid, positiveDecimal, nonNegDecimal, isoDate, dec, fmt, ZERO, roundMoney, sum, normalizeEgyptPhone, type Dec } from '@rc/domain';
import { route, audit, emit, pageQuery, decodeCursor, page } from '../../lib/http.js';
import { require as requirePerm, branchFilter, can } from '../../lib/actor.js';
import { AppError, invalid, notFound, forbidden } from '../../lib/errors.js';
import type { Tx } from '../../lib/db.js';
import { nextNumber, branchCode } from '../../lib/numbering.js';
import { postMoves, ensureLot, currentUnitCost, type MoveInput } from '../inventory/engine.js';
import { emitInventoryValued } from '../inventory/events.js';
import { virtualLoc } from '../inventory/routes.js';

async function taxRate(tx: Tx, id: string | null | undefined): Promise<Dec> {
  if (!id) return ZERO;
  const r = (await tx.query('SELECT rate FROM tax_rate WHERE id = $1', [id])).rows[0];
  if (!r) throw notFound('TAX_RATE');
  return dec(r.rate);
}

async function companySetting(tx: Tx, companyId: string, key: string, fallback: string): Promise<Dec> {
  const s = (await tx.query('SELECT settings FROM core_company WHERE id = $1', [companyId])).rows[0]?.settings ?? {};
  return dec(s[key] ?? fallback);
}

export const poApproval = async (tx: Tx, docId: string, userId: string, approved: boolean) => {
  const r = await tx.query(`UPDATE pur_order SET state = $2, approved_by = CASE WHEN $2 = 'approved' THEN $3::uuid END, approved_at = CASE WHEN $2 = 'approved' THEN now() END WHERE id = $1 AND state = 'pending_approval'`,
    [docId, approved ? 'approved' : 'cancelled', userId]);
  if (!r.rowCount) throw new AppError('PO_NOT_PENDING', 409);
};
export const invoiceExceptionApproval = async (tx: Tx, docId: string, userId: string, approved: boolean) => {
  const r = await tx.query(`UPDATE pur_invoice SET match_status = CASE WHEN $2 THEN 'exception_approved' ELSE match_status END, state = CASE WHEN $2 THEN state ELSE 'cancelled' END, approved_by = $3 WHERE id = $1 AND match_status = 'exception' AND state = 'draft'`, [docId, approved, userId]);
  if (!r.rowCount) throw new AppError('INVOICE_NOT_PENDING', 409);
};

export default async function purchasingRoutes(app: FastifyInstance) {
  // ---------- partners ----------
  route(app, 'GET', '/api/v1/partners', { company: 'none', query: pageQuery.extend({ role: z.enum(['supplier', 'customer']).optional(), q: z.string().optional() }) }, async ({ tx, actor, query }) => {
    if (!can(actor, 'purchasing.supplier.read') && !can(actor, 'sales.customer.read') && !actor.assignments.some((a) => a.permissions.has('purchasing.supplier.read') || a.permissions.has('sales.customer.read'))) throw forbidden();
    const cur = decodeCursor(query.cursor);
    const rows = (await tx.query(`SELECT * FROM par_partner WHERE active AND ($1::text IS NULL OR ($1 = 'supplier' AND is_supplier) OR ($1 = 'customer' AND is_customer))
        AND ($2::text IS NULL OR search_norm LIKE '%' || rc_norm_ar($2) || '%' OR code ILIKE $2 || '%' OR phone_norm = $3) AND ($4::uuid IS NULL OR id > $4) ORDER BY id LIMIT $5`,
      [query.role ?? null, query.q ?? null, normalizeEgyptPhone(query.q ?? '') ?? '-', cur?.[1] ?? null, query.limit + 1])).rows;
    return page(rows, query.limit, 'id');
  });
  route(app, 'POST', '/api/v1/partners', {
    company: 'none',
    body: z.object({ code: z.string().regex(/^[A-Z0-9_-]{2,30}$/).optional(), nameAr: z.string().min(2), nameEn: z.string().optional(), isSupplier: z.boolean().default(false), isCustomer: z.boolean().default(false), kind: z.enum(['company', 'person']).default('company'),
      taxRegistrationNo: z.string().max(30).optional(), phone: z.string().max(30).optional(), email: z.string().email().optional(), address: z.string().optional(), paymentTermsDays: z.number().int().min(0).default(0),
      creditLimit: nonNegDecimal.optional(), whtCategory: z.string().optional(), consignment: z.boolean().default(false) }),
  }, async ({ tx, actor, body, reply }) => {
    if (!body.isSupplier && !body.isCustomer) throw invalid('PARTNER_ROLE_REQUIRED');
    if (body.isSupplier && !actor.assignments.some((a) => a.permissions.has('purchasing.supplier.write'))) throw forbidden('purchasing.supplier.write');
    if (body.isCustomer && !actor.assignments.some((a) => a.permissions.has('sales.customer.write'))) throw forbidden('sales.customer.write');
    const id = uuidv7();
    const code = body.code ?? `${body.isSupplier ? 'S' : 'C'}${Date.now().toString(36).toUpperCase()}`;
    await tx.query(`INSERT INTO par_partner (id, tenant_id, code, name_ar, name_en, is_supplier, is_customer, kind, tax_registration_no, phone, phone_norm, email, address, payment_terms_days, credit_limit, wht_category, consignment, created_by)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [id, actor.tenantId, code, body.nameAr, body.nameEn ?? null, body.isSupplier, body.isCustomer, body.kind, body.taxRegistrationNo ?? null, body.phone ?? null, normalizeEgyptPhone(body.phone), body.email ?? null, body.address ?? null,
       body.paymentTermsDays, body.creditLimit ?? null, body.whtCategory ?? null, body.consignment, actor.userId]);
    reply.code(201);
    return { id, code };
  });

  // ---------- purchase orders ----------
  const poLine = z.object({ variantId: uuid, qty: positiveDecimal, uomId: uuid.optional(), unitPrice: nonNegDecimal, taxRateId: uuid.nullish() });
  route(app, 'POST', '/api/v1/purchase-orders', {
    body: z.object({ supplierId: uuid, branchId: uuid, receiveLocationId: uuid.optional(), expectedDate: isoDate.optional(), notes: z.string().optional(), lines: z.array(poLine).min(1).max(2000) }),
  }, async ({ tx, actor, companyId, body, reply }) => {
    requirePerm(actor, 'purchasing.order.write', { companyId, branchId: body.branchId });
    const sup = (await tx.query('SELECT * FROM par_partner WHERE id = $1 AND is_supplier AND active', [body.supplierId])).rows[0];
    if (!sup) throw notFound('SUPPLIER');
    const locRow = body.receiveLocationId
      ? (await tx.query(`SELECT id, warehouse_id FROM inv_location WHERE id = $1 AND branch_id = $2 AND type = 'internal'`, [body.receiveLocationId, body.branchId])).rows[0]
      : (await tx.query(`SELECT l.id, l.warehouse_id FROM inv_location l WHERE l.branch_id = $1 AND l.type = 'internal' ORDER BY l.code LIMIT 1`, [body.branchId])).rows[0];
    if (!locRow) throw invalid('RECEIVE_LOCATION_INVALID');
    const id = uuidv7();
    const number = await nextNumber(tx, actor.tenantId, companyId, 'PO', await branchCode(tx, body.branchId));
    let subtotal = ZERO, taxTotal = ZERO;
    const lines = [];
    for (const [i, l] of body.lines.entries()) {
      const v = (await tx.query(`SELECT p.stock_uom_id, p.purchase_uom_id, p.blocked_for_purchase FROM cat_variant v JOIN cat_product p ON p.id = v.product_id WHERE v.id = $1`, [l.variantId])).rows[0];
      if (!v) throw notFound('VARIANT');
      if (v.blocked_for_purchase) throw invalid('PRODUCT_BLOCKED_FOR_PURCHASE', l.variantId);
      const net = roundMoney(dec(l.qty).mul(dec(l.unitPrice)));
      const tax = roundMoney(net.mul(await taxRate(tx, l.taxRateId)).div(100));
      subtotal = subtotal.add(net); taxTotal = taxTotal.add(tax);
      lines.push([uuidv7(), actor.tenantId, id, i + 1, l.variantId, l.qty, l.uomId ?? v.purchase_uom_id ?? v.stock_uom_id, l.unitPrice, l.taxRateId ?? null]);
    }
    await tx.query(`INSERT INTO pur_order (id, tenant_id, company_id, branch_id, number, supplier_id, warehouse_id, receive_location_id, expected_date, payment_terms_days, subtotal, tax_total, total, notes, created_by)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, actor.tenantId, companyId, body.branchId, number, body.supplierId, locRow.warehouse_id, locRow.id, body.expectedDate ?? null, sup.payment_terms_days, fmt(subtotal, 4), fmt(taxTotal, 4), fmt(subtotal.add(taxTotal), 4), body.notes ?? null, actor.userId]);
    for (const l of lines) await tx.query(`INSERT INTO pur_order_line (id, tenant_id, order_id, line_no, variant_id, qty, uom_id, unit_price, tax_rate_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, l);
    reply.code(201);
    return { id, number, subtotal: fmt(subtotal, 2), taxTotal: fmt(taxTotal, 2), total: fmt(subtotal.add(taxTotal), 2) };
  });

  route(app, 'GET', '/api/v1/purchase-orders', { perm: 'purchasing.supplier.read', query: pageQuery.extend({ state: z.string().optional(), supplierId: uuid.optional() }) }, async ({ tx, actor, companyId, query }) => {
    const bf = branchFilter(actor, 'purchasing.supplier.read', companyId);
    const cur = decodeCursor(query.cursor);
    const rows = (await tx.query(`SELECT o.*, s.name_ar AS supplier_name, b.code AS branch_code FROM pur_order o JOIN par_partner s ON s.id = o.supplier_id JOIN core_branch b ON b.id = o.branch_id
      WHERE o.company_id = $1 AND ($2::uuid[] IS NULL OR o.branch_id = ANY($2)) AND ($3::text IS NULL OR o.state = $3) AND ($4::uuid IS NULL OR o.supplier_id = $4)
        AND ($5::timestamptz IS NULL OR (o.created_at, o.id) < ($5, $6::uuid)) ORDER BY o.created_at DESC, o.id DESC LIMIT $7`,
      [companyId, bf, query.state ?? null, query.supplierId ?? null, cur?.[0] ?? null, cur?.[1] ?? null, query.limit + 1])).rows;
    return page(rows, query.limit, 'created_at');
  });
  route(app, 'GET', '/api/v1/purchase-orders/:id', { perm: 'purchasing.supplier.read' }, async ({ tx, companyId, params }) => {
    const o = (await tx.query(`SELECT o.*, s.name_ar AS supplier_name FROM pur_order o JOIN par_partner s ON s.id = o.supplier_id WHERE o.id = $1 AND o.company_id = $2`, [params.id, companyId])).rows[0];
    if (!o) throw notFound('PURCHASE_ORDER');
    o.lines = (await tx.query(`SELECT l.*, v.sku, p.id AS product_id, p.name_ar, p.name_en FROM pur_order_line l JOIN cat_variant v ON v.id = l.variant_id JOIN cat_product p ON p.id = v.product_id WHERE l.order_id = $1 ORDER BY l.line_no`, [params.id])).rows;
    o.receipts = (await tx.query('SELECT * FROM pur_receipt WHERE order_id = $1 ORDER BY received_at', [params.id])).rows;
    return o;
  });

  route(app, 'POST', '/api/v1/purchase-orders/:id/submit', {}, async ({ tx, actor, companyId, params }) => {
    const o = (await tx.query(`SELECT * FROM pur_order WHERE id = $1 AND company_id = $2 FOR UPDATE`, [params.id, companyId])).rows[0];
    if (!o) throw notFound('PURCHASE_ORDER');
    if (o.state !== 'draft') throw new AppError('INVALID_STATE', 409, `PO is ${o.state}`);
    requirePerm(actor, 'purchasing.order.write', { companyId, branchId: o.branch_id });
    const threshold = await companySetting(tx, companyId, 'poApprovalThreshold', '0');
    if (dec(o.total).gt(threshold)) {
      await tx.query(`UPDATE pur_order SET state = 'pending_approval' WHERE id = $1`, [o.id]);
      await tx.query(`INSERT INTO wf_approval_request (id, tenant_id, company_id, branch_id, doc_type, doc_id, summary, amount, required_permission, requested_by) VALUES ($1,$2,$3,$4,'purchase_order',$5,$6,$7,'purchasing.order.approve',$8)`,
        [uuidv7(), actor.tenantId, companyId, o.branch_id, o.id, `${o.number}`, o.total, actor.userId]);
      return { state: 'pending_approval' };
    }
    await tx.query(`UPDATE pur_order SET state = 'approved', approved_at = now() WHERE id = $1`, [o.id]);
    return { state: 'approved' };
  });
  route(app, 'POST', '/api/v1/purchase-orders/:id/cancel', {}, async ({ tx, actor, companyId, params }) => {
    const o = (await tx.query(`SELECT * FROM pur_order WHERE id = $1 AND company_id = $2 FOR UPDATE`, [params.id, companyId])).rows[0];
    if (!o) throw notFound('PURCHASE_ORDER');
    requirePerm(actor, 'purchasing.order.write', { companyId, branchId: o.branch_id });
    if (!['draft', 'pending_approval', 'approved'].includes(o.state)) throw new AppError('INVALID_STATE', 409, 'Received orders cannot be cancelled');
    await tx.query(`UPDATE pur_order SET state = 'cancelled' WHERE id = $1`, [o.id]);
    await tx.query(`UPDATE wf_approval_request SET status = 'cancelled' WHERE doc_id = $1 AND status = 'pending'`, [o.id]);
    return { state: 'cancelled' };
  });

  // ---------- goods receipt ----------
  route(app, 'POST', '/api/v1/purchase-orders/:id/receive', {
    body: z.object({ deliveryNote: z.string().optional(), lines: z.array(z.object({ orderLineId: uuid, qty: positiveDecimal, lotNo: z.string().optional(), expiryDate: isoDate.optional(), serialNos: z.array(z.string()).optional() })).min(1) }),
  }, async ({ tx, actor, companyId, params, body, reply }) => {
    const o = (await tx.query(`SELECT * FROM pur_order WHERE id = $1 AND company_id = $2 FOR UPDATE`, [params.id, companyId])).rows[0];
    if (!o) throw notFound('PURCHASE_ORDER');
    if (!['approved', 'partially_received'].includes(o.state)) throw new AppError('INVALID_STATE', 409, `PO is ${o.state}`);
    const loc = (await tx.query('SELECT * FROM inv_location WHERE id = $1', [o.receive_location_id])).rows[0];
    requirePerm(actor, 'inventory.receipt.write', { companyId, branchId: o.branch_id, warehouseId: loc.warehouse_id, warehouseBranchId: o.branch_id });
    const tolerance = await companySetting(tx, companyId, 'overReceiptPercent', '0');
    const supplierLoc = await virtualLoc(tx, companyId, 'supplier');
    const sup = (await tx.query('SELECT consignment FROM par_partner WHERE id = $1', [o.supplier_id])).rows[0];
    const receiptId = uuidv7();
    const number = await nextNumber(tx, actor.tenantId, companyId, 'GRN', await branchCode(tx, o.branch_id));
    const moves: MoveInput[] = [];
    const rlines: unknown[][] = [];
    for (const r of body.lines) {
      const l = (await tx.query(`SELECT l.*, p.stock_uom_id, p.tracking, u.factor AS uom_factor, su.factor AS stock_factor FROM pur_order_line l JOIN cat_variant v ON v.id = l.variant_id JOIN cat_product p ON p.id = v.product_id
                                 JOIN cat_uom u ON u.id = l.uom_id JOIN cat_uom su ON su.id = p.stock_uom_id WHERE l.id = $1 AND l.order_id = $2 FOR UPDATE OF l`, [r.orderLineId, o.id])).rows[0];
      if (!l) throw invalid('LINE_NOT_IN_ORDER');
      const maxQty = dec(l.qty).mul(dec(100).add(tolerance)).div(100).sub(dec(l.qty_received));
      if (dec(r.qty).gt(maxQty)) throw new AppError('OVER_RECEIPT', 422, `Line ${l.line_no}: receiving ${r.qty} exceeds remaining ${fmt(maxQty, 3)}`);
      const qtyStock = dec(r.qty).mul(dec(l.uom_factor)).div(dec(l.stock_factor));
      const unitCostStock = dec(l.unit_price).mul(dec(l.stock_factor)).div(dec(l.uom_factor)); // PO price per stock UoM (net of recoverable VAT)
      if (l.tracking === 'lot' && !r.lotNo) throw invalid('LOT_REQUIRED', `Line ${l.line_no}`);
      const lotId = r.lotNo ? await ensureLot(tx, actor.tenantId, l.variant_id, r.lotNo, r.expiryDate) : null;
      const lineId = uuidv7();
      rlines.push([lineId, actor.tenantId, receiptId, l.id, l.variant_id, r.qty, l.uom_id, fmt(qtyStock, 6), fmt(unitCostStock, 6), r.lotNo ?? null, r.expiryDate ?? null]);
      if (l.tracking === 'serial') {
        if (!r.serialNos || r.serialNos.length !== Number(qtyStock.toString())) throw invalid('SERIALS_REQUIRED', `Line ${l.line_no}: ${qtyStock} serial numbers required`);
        for (const s of r.serialNos) moves.push({ variantId: l.variant_id, fromLocationId: supplierLoc, toLocationId: o.receive_location_id, qty: '1', serialNo: s, moveType: 'receipt', unitCost: fmt(unitCostStock, 6), refLineId: lineId, ownerId: sup.consignment ? o.supplier_id : null });
      } else {
        moves.push({ variantId: l.variant_id, fromLocationId: supplierLoc, toLocationId: o.receive_location_id, qty: fmt(qtyStock, 6), uomId: l.uom_id, qtyInUom: r.qty, lotId, moveType: 'receipt', unitCost: fmt(unitCostStock, 6), refLineId: lineId, ownerId: sup.consignment ? o.supplier_id : null });
      }
      await tx.query('UPDATE pur_order_line SET qty_received = qty_received + $2 WHERE id = $1', [l.id, r.qty]);
      await tx.query(`UPDATE cat_supplier_product SET last_cost = $3 WHERE supplier_id = $1 AND variant_id = $2`, [o.supplier_id, l.variant_id, l.unit_price]);
    }
    await tx.query(`INSERT INTO pur_receipt (id, tenant_id, company_id, branch_id, number, order_id, supplier_id, location_id, supplier_delivery_note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [receiptId, actor.tenantId, companyId, o.branch_id, number, o.id, o.supplier_id, o.receive_location_id, body.deliveryNote ?? null, actor.userId]);
    for (const l of rlines) await tx.query(`INSERT INTO pur_receipt_line (id, tenant_id, receipt_id, order_line_id, variant_id, qty, uom_id, qty_stock_uom, unit_cost, lot_no, expiry_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, l);
    const res = await postMoves(tx, { tenantId: actor.tenantId, companyId, branchId: o.branch_id, refDocType: 'pur_receipt', refDocId: receiptId, userId: actor.userId, moves, negativePolicy: 'block' });
    const remaining = (await tx.query(`SELECT count(*)::int AS n FROM pur_order_line WHERE order_id = $1 AND qty_received < qty`, [o.id])).rows[0].n;
    await tx.query(`UPDATE pur_order SET state = $2 WHERE id = $1`, [o.id, remaining ? 'partially_received' : 'received']);
    if (!sup.consignment) await emitInventoryValued(tx, { tenantId: actor.tenantId, companyId, branchId: o.branch_id, docType: 'pur_receipt', docId: receiptId, date: new Date().toISOString().slice(0, 10), userId: actor.userId, memo: `${number} / ${o.number}`, moves: res.moves });
    reply.code(201);
    return { id: receiptId, number, orderState: remaining ? 'partially_received' : 'received' };
  });

  // ---------- supplier invoice with 3-way match ----------
  route(app, 'POST', '/api/v1/supplier-invoices', {
    body: z.object({ supplierId: uuid, branchId: uuid, supplierInvoiceNo: z.string().min(1).max(60), invoiceDate: isoDate, dueDate: isoDate.optional(), kind: z.enum(['invoice', 'credit_note']).default('invoice'),
      lines: z.array(z.object({ orderLineId: uuid.optional(), accountId: uuid.optional(), description: z.string().optional(), qty: positiveDecimal, unitPrice: nonNegDecimal, taxRateId: uuid.nullish() })).min(1).max(2000) }),
  }, async ({ tx, actor, companyId, body, reply }) => {
    requirePerm(actor, 'purchasing.invoice.write', { companyId, branchId: body.branchId });
    const sup = (await tx.query('SELECT * FROM par_partner WHERE id = $1 AND is_supplier', [body.supplierId])).rows[0];
    if (!sup) throw notFound('SUPPLIER');
    const tol = await companySetting(tx, companyId, 'priceTolerancePercent', '0.5');
    const id = uuidv7();
    const number = await nextNumber(tx, actor.tenantId, companyId, 'PINV', await branchCode(tx, body.branchId));
    const mismatches: { line: number; type: 'qty' | 'price' | 'no_po'; detail: string }[] = [];
    const lines: unknown[][] = [];
    const nets: Dec[] = [], taxes: Dec[] = [];
    for (const [i, l] of body.lines.entries()) {
      let variantId: string | null = null;
      if (l.orderLineId) {
        const ol = (await tx.query(`SELECT ol.*, o.supplier_id, o.company_id FROM pur_order_line ol JOIN pur_order o ON o.id = ol.order_id WHERE ol.id = $1 FOR UPDATE OF ol`, [l.orderLineId])).rows[0];
        if (!ol || ol.company_id !== companyId || ol.supplier_id !== body.supplierId) throw invalid('ORDER_LINE_INVALID', `Line ${i + 1}`);
        variantId = ol.variant_id;
        const invoicedAfter = dec(ol.qty_invoiced).add(dec(l.qty));
        if (body.kind === 'invoice' && invoicedAfter.gt(dec(ol.qty_received))) mismatches.push({ line: i + 1, type: 'qty', detail: `invoiced ${fmt(invoicedAfter, 3)} > received ${fmt(ol.qty_received, 3)}` });
        const diffPct = dec(ol.unit_price).isZero() ? (dec(l.unitPrice).isZero() ? ZERO : dec(100)) : dec(l.unitPrice).sub(dec(ol.unit_price)).abs().div(dec(ol.unit_price)).mul(100);
        if (diffPct.gt(tol)) mismatches.push({ line: i + 1, type: 'price', detail: `price ${l.unitPrice} vs PO ${fmt(ol.unit_price, 4)} (${fmt(diffPct, 2)}%)` });
      } else if (!l.accountId) throw invalid('LINE_NEEDS_ORDER_LINE_OR_ACCOUNT', `Line ${i + 1}`);
      const net = roundMoney(dec(l.qty).mul(dec(l.unitPrice)));
      const tax = roundMoney(net.mul(await taxRate(tx, l.taxRateId)).div(100));
      nets.push(net); taxes.push(tax);
      lines.push([uuidv7(), actor.tenantId, id, l.orderLineId ?? null, variantId, l.accountId ?? null, l.description ?? null, l.qty, l.unitPrice, l.taxRateId ?? null, fmt(net, 4), fmt(tax, 4)]);
    }
    const subtotal = sum(nets), taxTotal = sum(taxes);
    const due = body.dueDate ?? new Date(Date.parse(body.invoiceDate) + sup.payment_terms_days * 86400000).toISOString().slice(0, 10);
    const status = mismatches.length ? 'exception' : 'matched';
    await tx.query(`INSERT INTO pur_invoice (id, tenant_id, company_id, branch_id, number, kind, supplier_id, supplier_invoice_no, invoice_date, due_date, subtotal, tax_total, total, match_status, match_details, created_by)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [id, actor.tenantId, companyId, body.branchId, number, body.kind, body.supplierId, body.supplierInvoiceNo, body.invoiceDate, due, fmt(subtotal, 4), fmt(taxTotal, 4), fmt(subtotal.add(taxTotal), 4), status, JSON.stringify(mismatches), actor.userId]);
    for (const l of lines) await tx.query(`INSERT INTO pur_invoice_line (id, tenant_id, invoice_id, order_line_id, variant_id, account_id, description, qty, unit_price, tax_rate_id, net, tax) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, l);
    if (mismatches.length) {
      await tx.query(`INSERT INTO wf_approval_request (id, tenant_id, company_id, branch_id, doc_type, doc_id, summary, amount, required_permission, requested_by) VALUES ($1,$2,$3,$4,'supplier_invoice_exception',$5,$6,$7,'purchasing.invoice.approve',$8)`,
        [uuidv7(), actor.tenantId, companyId, body.branchId, id, `${number} / ${body.supplierInvoiceNo}: ${mismatches.map((m) => m.type).join(', ')}`, fmt(subtotal.add(taxTotal), 4), actor.userId]);
    }
    reply.code(201);
    return { id, number, matchStatus: status, mismatches, total: fmt(subtotal.add(taxTotal), 2) };
  });

  route(app, 'POST', '/api/v1/supplier-invoices/:id/post', {}, async ({ tx, actor, companyId, params }) => {
    const inv = (await tx.query(`SELECT * FROM pur_invoice WHERE id = $1 AND company_id = $2 FOR UPDATE`, [params.id, companyId])).rows[0];
    if (!inv) throw notFound('INVOICE');
    requirePerm(actor, 'purchasing.invoice.write', { companyId, branchId: inv.branch_id });
    if (inv.state !== 'draft') throw new AppError('INVALID_STATE', 409, `Invoice is ${inv.state}`);
    if (!['matched', 'exception_approved', 'unmatched'].includes(inv.match_status)) throw new AppError('MATCH_EXCEPTION_NOT_APPROVED', 409, 'Three-way match exception must be approved before posting');
    const lines = (await tx.query('SELECT * FROM pur_invoice_line WHERE invoice_id = $1', [inv.id])).rows;
    for (const l of lines) if (l.order_line_id) await tx.query(`UPDATE pur_order_line SET qty_invoiced = qty_invoiced + $2 WHERE id = $1`, [l.order_line_id, inv.kind === 'credit_note' ? dec(l.qty).neg().toString() : l.qty]);
    await tx.query(`UPDATE pur_invoice SET state = 'posted', posted_at = now() WHERE id = $1`, [inv.id]);
    await emit(tx, { id: uuidv7(), tenantId: actor.tenantId, companyId, aggregateType: 'supplier_invoice', aggregateId: inv.id, type: 'purchasing.invoice_posted', payload: { invoiceId: inv.id } });
    await audit(tx, actor, 'post', 'pur_invoice', inv.id, null, companyId);
    return { state: 'posted' };
  });

  route(app, 'GET', '/api/v1/supplier-invoices', { perm: 'purchasing.supplier.read', query: pageQuery.extend({ state: z.string().optional(), supplierId: uuid.optional(), unpaid: z.coerce.boolean().optional() }) }, async ({ tx, companyId, query }) => {
    const cur = decodeCursor(query.cursor);
    const rows = (await tx.query(`SELECT i.*, s.name_ar AS supplier_name, (i.total - i.amount_paid) AS balance FROM pur_invoice i JOIN par_partner s ON s.id = i.supplier_id
       WHERE i.company_id = $1 AND ($2::text IS NULL OR i.state = $2) AND ($3::uuid IS NULL OR i.supplier_id = $3) AND (NOT $4 OR (i.state = 'posted' AND i.amount_paid < i.total))
         AND ($5::timestamptz IS NULL OR (i.created_at, i.id) < ($5, $6::uuid)) ORDER BY i.created_at DESC, i.id DESC LIMIT $7`,
      [companyId, query.state ?? null, query.supplierId ?? null, !!query.unpaid, cur?.[0] ?? null, cur?.[1] ?? null, query.limit + 1])).rows;
    return page(rows, query.limit, 'created_at');
  });

  // ---------- purchase returns ----------
  route(app, 'POST', '/api/v1/purchase-returns', {
    body: z.object({ supplierId: uuid, locationId: uuid, orderId: uuid.optional(), reason: z.string().min(3), lines: z.array(z.object({ variantId: uuid, qty: positiveDecimal, orderLineId: uuid.optional(), unitPrice: nonNegDecimal.optional(), lotNo: z.string().optional(), serialNo: z.string().optional() })).min(1) }),
  }, async ({ tx, actor, companyId, body, reply }) => {
    const loc = (await tx.query('SELECT * FROM inv_location WHERE id = $1 AND company_id = $2', [body.locationId, companyId])).rows[0];
    if (!loc) throw notFound('LOCATION');
    requirePerm(actor, 'purchasing.order.write', { companyId, branchId: loc.branch_id });
    const supplierLoc = await virtualLoc(tx, companyId, 'supplier');
    const id = uuidv7();
    const number = await nextNumber(tx, actor.tenantId, companyId, 'PRET', await branchCode(tx, loc.branch_id));
    const moves: MoveInput[] = [];
    const eventLines: Record<string, string | null>[] = [];
    await tx.query(`INSERT INTO pur_return (id, tenant_id, company_id, branch_id, number, supplier_id, order_id, location_id, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, actor.tenantId, companyId, loc.branch_id, number, body.supplierId, body.orderId ?? null, body.locationId, body.reason, actor.userId]);
    for (const l of body.lines) {
      let unitPrice = l.unitPrice ? dec(l.unitPrice) : null, taxRateId: string | null = null, uninv = ZERO, inv = dec(l.qty);
      if (l.orderLineId) {
        const ol = (await tx.query('SELECT * FROM pur_order_line WHERE id = $1 FOR UPDATE', [l.orderLineId])).rows[0];
        if (!ol) throw invalid('ORDER_LINE_INVALID');
        unitPrice = unitPrice ?? dec(ol.unit_price); taxRateId = ol.tax_rate_id;
        const returnable = dec(ol.qty_received).sub(dec(ol.qty_returned));
        if (dec(l.qty).gt(returnable)) throw invalid('RETURN_EXCEEDS_RECEIVED');
        const notInvoiced = Decimalmax(dec(ol.qty_received).sub(dec(ol.qty_invoiced)).sub(dec(ol.qty_returned)));
        uninv = dec(l.qty).lt(notInvoiced) ? dec(l.qty) : notInvoiced;
        inv = dec(l.qty).sub(uninv);
        await tx.query('UPDATE pur_order_line SET qty_returned = qty_returned + $2 WHERE id = $1', [ol.id, l.qty]);
      }
      if (!unitPrice) unitPrice = await currentUnitCost(tx, companyId, l.variantId);
      const lineId = uuidv7();
      await tx.query(`INSERT INTO pur_return_line (id, tenant_id, return_id, variant_id, order_line_id, qty, unit_price, tax_rate_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [lineId, actor.tenantId, id, l.variantId, l.orderLineId ?? null, l.qty, fmt(unitPrice, 6), taxRateId]);
      const lotId = l.lotNo ? await ensureLot(tx, actor.tenantId, l.variantId, l.lotNo) : null;
      moves.push({ variantId: l.variantId, fromLocationId: body.locationId, toLocationId: supplierLoc, qty: l.qty, lotId, serialNo: l.serialNo, moveType: 'purchase_return', refLineId: lineId });
      eventLines.push({ qtyUninvoiced: fmt(uninv, 6), qtyInvoiced: fmt(inv, 6), unitPrice: fmt(unitPrice, 6), taxRateId, taxRate: fmt(await taxRate(tx, taxRateId), 4) });
    }
    const res = await postMoves(tx, { tenantId: actor.tenantId, companyId, branchId: loc.branch_id, refDocType: 'pur_return', refDocId: id, userId: actor.userId, moves, negativePolicy: 'block' });
    res.moves.forEach((m, i) => { eventLines[i]!.cost = fmt(m.value, 4); eventLines[i]!.categoryId = m.categoryId; });
    await emit(tx, { id: uuidv7(), tenantId: actor.tenantId, companyId, aggregateType: 'purchase_return', aggregateId: id, type: 'purchasing.return_done',
      payload: { returnId: id, date: new Date().toISOString().slice(0, 10), branchId: loc.branch_id, supplierId: body.supplierId, userId: actor.userId, lines: eventLines } });
    reply.code(201);
    return { id, number };
  });

  // replenishment suggestions (min/max & reorder point)
  route(app, 'GET', '/api/v1/replenishment/suggestions', { perm: 'inventory.stock.read', query: z.object({ branchId: uuid }) }, async ({ tx, companyId, query, actor }) => {
    requirePerm(actor, 'inventory.stock.read', { companyId, branchId: query.branchId });
    return (await tx.query(`WITH stock AS (
        SELECT q.variant_id, sum(q.qty_on_hand - q.qty_reserved) AS available FROM inv_stock_quant q JOIN inv_location l ON l.id = q.location_id WHERE l.branch_id = $2 AND l.type = 'internal' GROUP BY 1),
      on_order AS (SELECT l.variant_id, sum(l.qty - l.qty_received) AS qty FROM pur_order_line l JOIN pur_order o ON o.id = l.order_id WHERE o.branch_id = $2 AND o.state IN ('approved','partially_received') GROUP BY 1)
      SELECT a.variant_id, v.sku, p.name_ar, coalesce(s.available, 0) AS available, coalesce(oo.qty, 0) AS on_order, a.reorder_point, a.min_qty, a.max_qty,
             greatest(coalesce(a.max_qty, a.reorder_point * 2) - coalesce(s.available, 0) - coalesce(oo.qty, 0), 0) AS suggested_qty,
             sp.supplier_id, sup.name_ar AS supplier_name, sp.moq, sp.pack_multiple, sp.last_cost
        FROM cat_branch_assortment a JOIN cat_variant v ON v.id = a.variant_id JOIN cat_product p ON p.id = v.product_id
        LEFT JOIN stock s ON s.variant_id = a.variant_id LEFT JOIN on_order oo ON oo.variant_id = a.variant_id
        LEFT JOIN cat_supplier_product sp ON sp.variant_id = a.variant_id AND sp.preferred LEFT JOIN par_partner sup ON sup.id = sp.supplier_id
       WHERE a.company_id = $1 AND a.branch_id = $2 AND a.purchasable AND a.reorder_point IS NOT NULL AND coalesce(s.available, 0) + coalesce(oo.qty, 0) <= a.reorder_point
       ORDER BY sup.name_ar NULLS LAST, v.sku LIMIT 5000`, [companyId, query.branchId])).rows;
  });
}

function Decimalmax(d: Dec): Dec { return d.lt(0) ? ZERO : d; }

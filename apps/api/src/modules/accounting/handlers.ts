/**
 * GL posting handlers — one per domain event (ACCOUNTING_RULES.md §3). Each handler is idempotent:
 * the event id is the posting registry key.
 */
import { dec, ZERO, D, roundMoney, type Dec } from '@rc/domain';
import type { Tx } from '../../lib/db.js';
import { postEntry, type PostingLine } from './posting.js';
import { TENDER_MAPPING_KEY } from '../templates.js';
import { AppError } from '../../lib/errors.js';

export interface OutboxEvent { id: string; tenant_id: string; company_id: string; event_type: string; payload: any }
type Handler = (tx: Tx, e: OutboxEvent) => Promise<void>;

const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

// ---------- inventory documents ----------
interface ValuedMove { moveType: string; valuation: 'in' | 'out' | 'none'; value: string; cogsAdjustment: string; fromType: string; toType: string; fromBranchId: string | null; toBranchId: string | null; reasonKey: string | null; categoryId: string | null; variantId: string }
const assetKey = (type: string) => (type === 'transit' ? 'inventory.in_transit' : 'inventory.asset');

const inventoryValued: Handler = async (tx, e) => {
  const p = e.payload as { docType: string; docId: string; date: string; branchId: string; memo?: string; userId?: string; moves: ValuedMove[] };
  const lines: PostingLine[] = [];
  for (const m of p.moves) {
    const value = dec(m.value), adj = dec(m.cogsAdjustment);
    if (m.valuation === 'in') {
      lines.push({ key: assetKey(m.toType), amount: value.sub(adj), branchId: m.toBranchId, mapping: { categoryId: m.categoryId } });
      if (!adj.isZero()) lines.push({ key: 'inventory.cogs', amount: adj, branchId: m.toBranchId, mapping: { categoryId: m.categoryId } });
      const counter = m.moveType === 'receipt' ? 'purchase.grni' : m.moveType === 'opening' ? 'equity.opening' : m.moveType === 'sale_return' ? 'inventory.cogs' : (m.reasonKey ?? 'inventory.count_gain');
      lines.push({ key: counter, amount: value.neg(), branchId: m.toBranchId, mapping: { categoryId: m.categoryId } });
    } else if (m.valuation === 'out') {
      lines.push({ key: assetKey(m.fromType), amount: value.neg(), branchId: m.fromBranchId, mapping: { categoryId: m.categoryId } });
      const counter = m.moveType === 'sale' ? 'inventory.cogs' : m.fromType === 'transit' ? (m.reasonKey ?? 'inventory.transit_loss') : (m.reasonKey ?? 'inventory.shrinkage');
      lines.push({ key: counter, amount: value, branchId: m.fromBranchId, mapping: { categoryId: m.categoryId } });
    } else if (!value.isZero() && (m.fromBranchId !== m.toBranchId || m.fromType !== m.toType) && (m.fromType === 'transit' || m.toType === 'transit')) {
      // value shift between branches / transit (same company: avg cost unchanged)
      lines.push({ key: assetKey(m.toType), amount: value, branchId: m.toBranchId, mapping: { categoryId: m.categoryId } });
      lines.push({ key: assetKey(m.fromType), amount: value.neg(), branchId: m.fromBranchId, mapping: { categoryId: m.categoryId } });
    }
  }
  await postEntry(tx, { tenantId: e.tenant_id, companyId: e.company_id, journalCode: 'INV', date: p.date, sourceType: p.docType, sourceId: p.docId, sourceEventId: e.id, rule: `inventory.${p.docType}`, memo: p.memo ?? null, createdBy: p.userId ?? SYSTEM_USER, lines });
};

// ---------- POS session (ACCOUNTING_RULES §3.1–3.6) ----------
const posSessionClosed: Handler = async (tx, e) => {
  const s = (await tx.query('SELECT * FROM pos_session WHERE id = $1', [e.payload.sessionId])).rows[0];
  if (!s) throw new AppError('SESSION_NOT_FOUND', 404);
  const branchId = s.branch_id as string;
  const lines: PostingLine[] = [];
  // revenue / discount / returns per category; tax per rate
  const rows = (await tx.query(`SELECT o.kind, l.category_id, sum(l.net) AS net, sum(l.discount_total) AS disc_gross, sum(l.total) AS total, sum(l.cost_total) AS cost
                                  FROM pos_order o JOIN pos_order_line l ON l.order_id = o.id AND l.business_date = o.business_date
                                 WHERE o.session_id = $1 GROUP BY o.kind, l.category_id`, [s.id])).rows;
  for (const r of rows) {
    const net = dec(r.net), total = dec(r.total), discGross = dec(r.disc_gross), cost = dec(r.cost);
    // discount expressed net of tax, proportional to the line's net/total ratio
    const discNet = total.gt(0) ? roundMoney(discGross.mul(net).div(total)) : ZERO;
    const map = { categoryId: r.category_id };
    if (r.kind === 'sale') {
      lines.push({ key: 'sales.revenue', amount: net.add(discNet).neg(), branchId, mapping: map });
      if (!discNet.isZero()) lines.push({ key: 'sales.discount', amount: discNet, branchId, mapping: map });
      lines.push({ key: 'inventory.cogs', amount: cost, branchId, mapping: map });
      lines.push({ key: 'inventory.asset', amount: cost.neg(), branchId, mapping: map });
    } else {
      lines.push({ key: 'sales.returns', amount: net, branchId, mapping: map });
      lines.push({ key: 'inventory.asset', amount: cost, branchId, mapping: map });
      lines.push({ key: 'inventory.cogs', amount: cost.neg(), branchId, mapping: map });
    }
  }
  const taxes = (await tx.query(`SELECT o.kind, (t->>'taxRateId') AS tax_rate_id, sum((t->>'amount')::numeric) AS amount, sum((t->>'base')::numeric) AS base
                                   FROM pos_order o JOIN pos_order_line l ON l.order_id = o.id AND l.business_date = o.business_date, jsonb_array_elements(l.tax_lines) t
                                  WHERE o.session_id = $1 GROUP BY 1, 2`, [s.id])).rows;
  // tax on lines without explicit tax_lines
  for (const t of taxes) {
    const sign = t.kind === 'sale' ? -1 : 1;
    lines.push({ key: 'tax.vat_output', amount: dec(t.amount).mul(sign), branchId, taxRateId: t.tax_rate_id, taxBase: dec(t.base).mul(sign) });
  }
  const pays = (await tx.query(`SELECT method, sum(amount) AS amount FROM pos_payment WHERE session_id = $1 GROUP BY method`, [s.id])).rows;
  for (const p of pays) lines.push({ key: TENDER_MAPPING_KEY[p.method] ?? 'pos.cash', amount: dec(p.amount), branchId, mapping: { tenderMethod: p.method } });
  const rounding = (await tx.query(`SELECT coalesce(sum(CASE WHEN kind = 'sale' THEN rounding ELSE -rounding END), 0) AS r FROM pos_order WHERE session_id = $1`, [s.id])).rows[0].r;
  if (!dec(rounding).isZero()) lines.push({ key: 'pos.rounding', amount: dec(rounding).neg(), branchId });
  // cash movements & over/short
  const cm = (await tx.query(`SELECT kind, sum(amount) AS amount FROM pos_cash_movement WHERE session_id = $1 GROUP BY kind`, [s.id])).rows;
  for (const c of cm) {
    const amt = dec(c.amount);
    if (c.kind === 'safe_drop') { lines.push({ key: 'pos.safe', amount: amt, branchId }); lines.push({ key: 'pos.cash', amount: amt.neg(), branchId }); }
    // cash_in / cash_out are float top-ups/withdrawals from the main safe
    if (c.kind === 'cash_in') { lines.push({ key: 'pos.cash', amount: amt, branchId }); lines.push({ key: 'pos.safe', amount: amt.neg(), branchId }); }
    if (c.kind === 'cash_out') { lines.push({ key: 'pos.safe', amount: amt, branchId }); lines.push({ key: 'pos.cash', amount: amt.neg(), branchId }); }
  }
  const diff = dec(s.cash_difference ?? 0);
  if (diff.lt(0)) { lines.push({ key: 'pos.cash_short', amount: diff.neg(), branchId }); lines.push({ key: 'pos.cash', amount: diff, branchId }); }
  if (diff.gt(0)) { lines.push({ key: 'pos.cash', amount: diff, branchId }); lines.push({ key: 'pos.cash_over', amount: diff.neg(), branchId }); }

  const r = await postEntry(tx, { tenantId: e.tenant_id, companyId: e.company_id, journalCode: 'SAL', date: s.business_date, sourceType: 'pos_session', sourceId: s.id, sourceEventId: e.id, rule: 'pos.session', memo: `وردية ${s.number}`, createdBy: s.closed_by ?? SYSTEM_USER, lines });
  if (r.entryId) await tx.query(`UPDATE pos_session SET state = 'posted', journal_entry_id = $2 WHERE id = $1`, [s.id, r.entryId]);
  else await tx.query(`UPDATE pos_session SET state = 'posted' WHERE id = $1`, [s.id]);
};

// ---------- Supplier invoice (§3.8) ----------
const supplierInvoicePosted: Handler = async (tx, e) => {
  const inv = (await tx.query('SELECT * FROM pur_invoice WHERE id = $1', [e.payload.invoiceId])).rows[0];
  const lines = (await tx.query(`SELECT il.*, ol.unit_price AS po_price, p.category_id FROM pur_invoice_line il LEFT JOIN pur_order_line ol ON ol.id = il.order_line_id
                                   LEFT JOIN cat_variant v ON v.id = il.variant_id LEFT JOIN cat_product p ON p.id = v.product_id WHERE il.invoice_id = $1`, [inv.id])).rows;
  const sign = inv.kind === 'credit_note' ? -1 : 1;
  const out: PostingLine[] = [];
  for (const l of lines) {
    const net = dec(l.net), tax = dec(l.tax);
    if (l.variant_id && l.order_line_id) {
      const grni = roundMoney(dec(l.qty).mul(dec(l.po_price)));
      out.push({ key: 'purchase.grni', amount: grni.mul(sign), branchId: inv.branch_id, partnerId: inv.supplier_id, variantId: l.variant_id, quantity: l.qty });
      const variance = net.sub(grni);
      if (!variance.isZero()) out.push({ key: 'purchase.price_variance', amount: variance.mul(sign), branchId: inv.branch_id, mapping: { categoryId: l.category_id }, label: 'PPV' });
    } else {
      out.push({ accountId: l.account_id, amount: net.mul(sign), branchId: inv.branch_id, label: l.description });
    }
    if (!tax.isZero()) out.push({ key: 'tax.vat_input', amount: tax.mul(sign), branchId: inv.branch_id, taxRateId: l.tax_rate_id, taxBase: net.mul(sign) });
  }
  out.push({ key: 'ap.trade', amount: dec(inv.total).mul(-sign), branchId: inv.branch_id, partnerId: inv.supplier_id, dueDate: inv.due_date, label: inv.supplier_invoice_no });
  const r = await postEntry(tx, { tenantId: e.tenant_id, companyId: e.company_id, journalCode: 'PUR', date: inv.invoice_date, sourceType: 'supplier_invoice', sourceId: inv.id, sourceEventId: e.id, rule: 'purchase.invoice', memo: `فاتورة مورد ${inv.supplier_invoice_no}`, createdBy: inv.created_by, lines: out });
  await tx.query('UPDATE pur_invoice SET journal_entry_id = $2 WHERE id = $1', [inv.id, r.entryId || null]);
};

// ---------- Purchase return (§3.9) ----------
const purchaseReturnDone: Handler = async (tx, e) => {
  const p = e.payload as { returnId: string; date: string; branchId: string; supplierId: string; userId: string; lines: { qtyUninvoiced: string; qtyInvoiced: string; unitPrice: string; taxRate: string; taxRateId: string | null; cost: string; categoryId: string | null }[] };
  const out: PostingLine[] = [];
  for (const l of p.lines) {
    const uninv = roundMoney(dec(l.qtyUninvoiced).mul(dec(l.unitPrice)));
    const invNet = roundMoney(dec(l.qtyInvoiced).mul(dec(l.unitPrice)));
    const invTax = roundMoney(invNet.mul(dec(l.taxRate)).div(100));
    const cost = dec(l.cost);
    if (!uninv.isZero()) out.push({ key: 'purchase.grni', amount: uninv, branchId: p.branchId, partnerId: p.supplierId });
    if (!invNet.isZero()) {
      out.push({ key: 'ap.trade', amount: invNet.add(invTax), branchId: p.branchId, partnerId: p.supplierId, label: 'Debit note' });
      if (!invTax.isZero()) out.push({ key: 'tax.vat_input', amount: invTax.neg(), branchId: p.branchId, taxRateId: l.taxRateId, taxBase: invNet.neg() });
    }
    out.push({ key: 'inventory.asset', amount: cost.neg(), branchId: p.branchId, mapping: { categoryId: l.categoryId } });
    const variance = cost.sub(uninv).sub(invNet);
    if (!variance.isZero()) out.push({ key: 'purchase.price_variance', amount: variance, branchId: p.branchId, mapping: { categoryId: l.categoryId }, label: 'PPV' });
  }
  await postEntry(tx, { tenantId: e.tenant_id, companyId: e.company_id, journalCode: 'PUR', date: p.date, sourceType: 'purchase_return', sourceId: p.returnId, sourceEventId: e.id, rule: 'purchase.return', createdBy: p.userId, lines: out });
};

// ---------- Payments (§3.10–3.11) ----------
const paymentPosted: Handler = async (tx, e) => {
  const pay = (await tx.query('SELECT p.*, b.account_id AS bank_gl FROM acc_payment p JOIN acc_bank_account b ON b.id = p.bank_account_id WHERE p.id = $1', [e.payload.paymentId])).rows[0];
  const amt = dec(pay.amount), wht = dec(pay.wht_amount);
  const lines: PostingLine[] = pay.direction === 'outbound'
    ? [{ key: 'ap.trade', amount: amt.add(wht), partnerId: pay.partner_id, branchId: pay.branch_id }, { accountId: pay.bank_gl, amount: amt.neg(), branchId: pay.branch_id }, { key: 'tax.wht_payable', amount: wht.neg(), partnerId: pay.partner_id, branchId: pay.branch_id }]
    : [{ accountId: pay.bank_gl, amount: amt, branchId: pay.branch_id }, { key: 'tax.wht_receivable', amount: wht, partnerId: pay.partner_id, branchId: pay.branch_id }, { key: 'ar.trade', amount: amt.add(wht).neg(), partnerId: pay.partner_id, branchId: pay.branch_id }];
  const r = await postEntry(tx, { tenantId: e.tenant_id, companyId: e.company_id, journalCode: 'BNK', date: pay.payment_date, sourceType: 'payment', sourceId: pay.id, sourceEventId: e.id, rule: `payment.${pay.direction}`, memo: pay.reference, createdBy: pay.created_by, lines });
  await tx.query('UPDATE acc_payment SET journal_entry_id = $2 WHERE id = $1', [pay.id, r.entryId]);
};

// ---------- Expenses (§3.15) ----------
const expensePosted: Handler = async (tx, e) => {
  const x = (await tx.query('SELECT x.*, b.account_id AS bank_gl FROM acc_expense x LEFT JOIN acc_bank_account b ON b.id = x.paid_from_bank_account_id WHERE x.id = $1', [e.payload.expenseId])).rows[0];
  const net = dec(x.net_amount), tax = dec(x.tax_amount);
  const lines: PostingLine[] = [
    { accountId: x.account_id, amount: net, branchId: x.branch_id, costCenterId: x.cost_center_id, label: x.description },
    { key: 'tax.vat_input', amount: tax, branchId: x.branch_id, taxRateId: x.tax_rate_id, taxBase: net },
    x.bank_gl ? { accountId: x.bank_gl, amount: net.add(tax).neg(), branchId: x.branch_id } : { key: 'ap.trade', amount: net.add(tax).neg(), branchId: x.branch_id, partnerId: x.partner_id },
  ];
  const r = await postEntry(tx, { tenantId: e.tenant_id, companyId: e.company_id, journalCode: x.bank_gl ? 'BNK' : 'PUR', date: x.expense_date, sourceType: 'expense', sourceId: x.id, sourceEventId: e.id, rule: 'expense', memo: x.description, createdBy: x.created_by, lines });
  await tx.query(`UPDATE acc_expense SET journal_entry_id = $2, state = 'posted' WHERE id = $1`, [x.id, r.entryId]);
};

// ---------- Payroll import (§3.16) ----------
const payrollPosted: Handler = async (tx, e) => {
  const run = (await tx.query('SELECT * FROM hr_payroll_run WHERE id = $1', [e.payload.runId])).rows[0];
  const lines: PostingLine[] = [];
  for (const l of run.lines as { branchId: string | null; costCenterId: string | null; gross: string; employerSi: string; employeeSi: string; incomeTax: string; deductions: string; net: string }[]) {
    const gross = dec(l.gross), er = dec(l.employerSi), ee = dec(l.employeeSi), it = dec(l.incomeTax), ded = dec(l.deductions), net = dec(l.net);
    if (!gross.sub(ee).sub(it).sub(ded).eq(net)) throw new AppError('PAYROLL_LINE_INCONSISTENT', 422, 'gross - employee SI - tax - deductions must equal net');
    lines.push({ key: 'payroll.salaries', amount: gross, branchId: l.branchId, costCenterId: l.costCenterId });
    lines.push({ key: 'payroll.employer_si', amount: er, branchId: l.branchId, costCenterId: l.costCenterId });
    lines.push({ key: 'payroll.si_payable', amount: ee.add(er).neg(), branchId: l.branchId });
    lines.push({ key: 'payroll.tax_payable', amount: it.neg(), branchId: l.branchId });
    lines.push({ key: 'payroll.advances', amount: ded.neg(), branchId: l.branchId });
    lines.push({ key: 'payroll.salaries_payable', amount: net.neg(), branchId: l.branchId });
  }
  const lastDay = new Date(Date.UTC(Number(String(run.period_month).slice(0, 4)), Number(String(run.period_month).slice(5, 7)), 0)).toISOString().slice(0, 10);
  const r = await postEntry(tx, { tenantId: e.tenant_id, companyId: e.company_id, journalCode: 'PAY', date: lastDay, sourceType: 'payroll', sourceId: run.id, sourceEventId: e.id, rule: 'payroll.import', createdBy: run.created_by, lines });
  await tx.query(`UPDATE hr_payroll_run SET state = 'posted', journal_entry_id = $2 WHERE id = $1`, [run.id, r.entryId]);
};

export const HANDLERS: Record<string, Handler> = {
  'inventory.valued': inventoryValued,
  'pos.session_closed': posSessionClosed,
  'purchasing.invoice_posted': supplierInvoicePosted,
  'purchasing.return_done': purchaseReturnDone,
  'accounting.payment_posted': paymentPosted,
  'accounting.expense_posted': expensePosted,
  'hr.payroll_posted': payrollPosted,
};
export { D };

/**
 * Navigation / drill-down endpoints: global search, document resolvers and partner cards.
 * Every response carries enough type+id pairs for the UI to link each value to its source document.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeArabic, uuid, UUID_RE } from '@rc/domain';
import { route } from '../lib/http.js';
import { branchFilter, can } from '../lib/actor.js';
import { notFound } from '../lib/errors.js';

export default async function navigationRoutes(app: FastifyInstance) {
  // ---------- global search (Ctrl+K) ----------
  route(app, 'GET', '/api/v1/search', { query: z.object({ q: z.string().min(1).max(100) }) }, async ({ tx, actor, companyId, query }) => {
    const q = query.q.trim();
    const out: { type: string; id: string; title: string; subtitle?: string }[] = [];
    if (can(actor, 'catalog.product.read') || actor.assignments.some((a) => a.permissions.has('catalog.product.read'))) {
      const words = normalizeArabic(q).split(' ').filter((w) => w.length >= 2).slice(0, 5);
      const ids = [
        ...(await tx.query('SELECT variant_id FROM catalog_code_ids($1, 5)', [q])).rows.map((r) => r.variant_id),
        ...(words.length ? (await tx.query('SELECT variant_id FROM catalog_search_ids($1::text[], 8)', [words])).rows.map((r) => r.variant_id) : []),
      ].slice(0, 8);
      if (ids.length) {
        for (const r of (await tx.query(`SELECT v.id, v.sku, p.id AS product_id, p.name_ar FROM cat_variant v JOIN cat_product p ON p.id = v.product_id WHERE v.id = ANY($1::uuid[])`, [ids])).rows) {
          out.push({ type: 'product', id: r.product_id, title: r.name_ar, subtitle: r.sku });
        }
      }
    }
    const like = `${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    const docs: [string, string, string][] = [
      ['purchase_order', `SELECT id, number AS title, state AS subtitle FROM pur_order WHERE company_id = $1 AND number ILIKE $2 AND $3::text IS NOT NULL ORDER BY created_at DESC LIMIT 5`, 'purchasing.supplier.read'],
      ['supplier_invoice', `SELECT id, number AS title, supplier_invoice_no AS subtitle FROM pur_invoice WHERE company_id = $1 AND $3::text IS NOT NULL AND (number ILIKE $2 OR supplier_invoice_no ILIKE $2) ORDER BY created_at DESC LIMIT 5`, 'purchasing.supplier.read'],
      ['stock_document', `SELECT id, number AS title, kind AS subtitle FROM inv_stock_document WHERE company_id = $1 AND $3::text IS NOT NULL AND number ILIKE $2 ORDER BY created_at DESC LIMIT 5`, 'inventory.stock.read'],
      ['journal_entry', `SELECT id, number AS title, memo AS subtitle FROM acc_journal_entry WHERE company_id = $1 AND $3::text IS NOT NULL AND number ILIKE $2 ORDER BY posting_date DESC LIMIT 5`, 'accounting.read'],
      ['pos_session', `SELECT id, number AS title, state AS subtitle FROM pos_session WHERE company_id = $1 AND $3::text IS NOT NULL AND number ILIKE $2 ORDER BY opened_at DESC LIMIT 5`, 'sales.order.read'],
      ['pos_order', `SELECT id, receipt_no AS title, grand_total::text AS subtitle FROM pos_order WHERE company_id = $1 AND $2::text IS NOT NULL AND receipt_no = $3 AND business_date > current_date - 400 LIMIT 5`, 'sales.order.read'],
      ['supplier', `SELECT id, name_ar AS title, code AS subtitle FROM par_partner WHERE is_supplier AND $1::uuid IS NOT NULL AND (code ILIKE $2 OR name_ar ILIKE '%' || $3 || '%') ORDER BY name_ar LIMIT 5`, 'purchasing.supplier.read'],
    ];
    for (const [type, sql, perm] of docs) {
      if (!actor.assignments.some((a) => a.permissions.has(perm))) continue;
      for (const r of (await tx.query(sql, [companyId, like, q])).rows) out.push({ type, id: r.id, title: r.title ?? '—', subtitle: r.subtitle ?? undefined });
    }
    return out;
  });

  // ---------- resolve any stock-movement source (document, count, receipt, return, POS order) ----------
  route(app, 'GET', '/api/v1/stock/sources/:id', { perm: 'inventory.stock.read' }, async ({ tx, actor, companyId, params }) => {
    if (!UUID_RE.test(params.id)) throw notFound('SOURCE');
    const bf = branchFilter(actor, 'inventory.stock.read', companyId);
    const moves = (await tx.query(`SELECT m.id, m.moved_at, m.move_type, m.variant_id, v.sku, p.id AS product_id, p.name_ar, m.qty_stock_uom, m.unit_cost, m.value,
        fl.code AS from_code, fl.type AS from_type, tl.code AS to_code, tl.type AS to_type, m.negative_exception, m.ref_doc_type, u.full_name AS user_name
      FROM inv_stock_move m JOIN cat_variant v ON v.id = m.variant_id JOIN cat_product p ON p.id = v.product_id JOIN inv_location fl ON fl.id = m.from_location_id JOIN inv_location tl ON tl.id = m.to_location_id
      LEFT JOIN core_user u ON u.id = m.user_id WHERE m.company_id = $1 AND m.ref_doc_id = $2 AND ($3::uuid[] IS NULL OR m.branch_id = ANY($3)) ORDER BY m.moved_at, m.id`, [companyId, params.id, bf])).rows;
    let header: Record<string, unknown> | null = null, type = moves[0]?.ref_doc_type ?? null;
    const tries: [string, string][] = [
      ['stock_document', `SELECT d.*, d.number AS title FROM inv_stock_document d WHERE d.id = $1 AND d.company_id = $2`],
      ['stock_count', `SELECT c.*, c.number AS title FROM inv_stock_count c WHERE c.id = $1 AND c.company_id = $2`],
      ['pur_receipt', `SELECT r.*, r.number AS title, o.number AS order_number, s.name_ar AS supplier_name FROM pur_receipt r JOIN pur_order o ON o.id = r.order_id JOIN par_partner s ON s.id = r.supplier_id WHERE r.id = $1 AND r.company_id = $2`],
      ['pur_return', `SELECT r.*, r.number AS title, s.name_ar AS supplier_name FROM pur_return r JOIN par_partner s ON s.id = r.supplier_id WHERE r.id = $1 AND r.company_id = $2`],
    ];
    for (const [t, sql] of tries) {
      if (type && type !== t && type !== 'stock_document') continue;
      const h = (await tx.query(sql, [params.id, companyId])).rows[0];
      if (h) { header = h; type = t; break; }
    }
    if (!header && !moves.length) throw notFound('SOURCE');
    const journal = (await tx.query(`SELECT e.id, e.number, e.posting_date, e.state, e.total_debit FROM acc_journal_entry e WHERE e.company_id = $1 AND e.source_id = $2 ORDER BY e.posting_date`, [companyId, params.id])).rows;
    return { type, header, moves, journal };
  });

  // ---------- supplier invoice detail ----------
  route(app, 'GET', '/api/v1/supplier-invoices/:id', { perm: 'purchasing.supplier.read' }, async ({ tx, companyId, params }) => {
    const inv = (await tx.query(`SELECT i.*, s.name_ar AS supplier_name, (i.total - i.amount_paid) AS balance FROM pur_invoice i JOIN par_partner s ON s.id = i.supplier_id WHERE i.id = $1 AND i.company_id = $2`, [params.id, companyId])).rows[0];
    if (!inv) throw notFound('INVOICE');
    inv.lines = (await tx.query(`SELECT l.*, v.sku, p.id AS product_id, p.name_ar, o.id AS order_id, o.number AS order_number, a.code AS account_code, a.name_ar AS account_name
      FROM pur_invoice_line l LEFT JOIN cat_variant v ON v.id = l.variant_id LEFT JOIN cat_product p ON p.id = v.product_id LEFT JOIN pur_order_line ol ON ol.id = l.order_line_id LEFT JOIN pur_order o ON o.id = ol.order_id
      LEFT JOIN acc_account a ON a.id = l.account_id WHERE l.invoice_id = $1`, [params.id])).rows;
    inv.payments = (await tx.query(`SELECT p.id, p.number, p.payment_date, p.state, a.amount, p.journal_entry_id FROM acc_payment_allocation a JOIN acc_payment p ON p.id = a.payment_id WHERE a.invoice_id = $1 ORDER BY p.payment_date`, [params.id])).rows;
    return inv;
  });

  // ---------- partner card (supplier / customer) ----------
  route(app, 'GET', '/api/v1/partners/:id', { company: 'optional' }, async ({ tx, actor, companyId, params }) => {
    const p = (await tx.query('SELECT * FROM par_partner WHERE id = $1', [params.id])).rows[0];
    if (!p) throw notFound('PARTNER');
    const isSup = actor.assignments.some((a) => a.permissions.has('purchasing.supplier.read'));
    const isCus = actor.assignments.some((a) => a.permissions.has('sales.customer.read'));
    if (!(p.is_supplier && isSup) && !(p.is_customer && isCus)) throw notFound('PARTNER');
    if (!companyId || !isSup) return { partner: p };
    const [orders, invoices, payments, returns, balance, products] = await Promise.all([
      tx.query(`SELECT id, number, order_date, state, total FROM pur_order WHERE company_id = $1 AND supplier_id = $2 ORDER BY created_at DESC LIMIT 50`, [companyId, p.id]),
      tx.query(`SELECT id, number, supplier_invoice_no, invoice_date, due_date, total, amount_paid, state, match_status FROM pur_invoice WHERE company_id = $1 AND supplier_id = $2 ORDER BY invoice_date DESC LIMIT 50`, [companyId, p.id]),
      tx.query(`SELECT id, number, payment_date, amount, wht_amount, state, journal_entry_id FROM acc_payment WHERE company_id = $1 AND partner_id = $2 ORDER BY payment_date DESC LIMIT 50`, [companyId, p.id]),
      tx.query(`SELECT id, number, created_at, reason FROM pur_return WHERE company_id = $1 AND supplier_id = $2 ORDER BY created_at DESC LIMIT 50`, [companyId, p.id]),
      tx.query(`SELECT coalesce(sum(total - amount_paid) FILTER (WHERE state = 'posted' AND kind = 'invoice'), 0) AS open_balance,
                       coalesce(sum(total - amount_paid) FILTER (WHERE state = 'posted' AND kind = 'invoice' AND due_date < current_date), 0) AS overdue,
                       coalesce(sum(total) FILTER (WHERE state = 'posted' AND invoice_date >= date_trunc('year', current_date)), 0) AS purchases_ytd
                FROM pur_invoice WHERE company_id = $1 AND supplier_id = $2`, [companyId, p.id]),
      tx.query(`SELECT sp.variant_id, v.sku, pr.id AS product_id, pr.name_ar, sp.last_cost, sp.preferred FROM cat_supplier_product sp JOIN cat_variant v ON v.id = sp.variant_id JOIN cat_product pr ON pr.id = v.product_id WHERE sp.supplier_id = $1 ORDER BY pr.name_ar LIMIT 200`, [p.id]),
    ]);
    return { partner: p, summary: balance.rows[0], orders: orders.rows, invoices: invoices.rows, payments: payments.rows, returns: returns.rows, products: products.rows };
  });

  // ---------- journal entries for any source document ----------
  route(app, 'GET', '/api/v1/journal-entries/by-source/:id', { perm: 'accounting.read' }, async ({ tx, companyId, params }) =>
    (await tx.query(`SELECT e.id, e.number, e.posting_date, e.state, e.total_debit, e.source_type FROM acc_journal_entry e WHERE e.company_id = $1 AND e.source_id = $2 ORDER BY e.posting_date`, [companyId, params.id])).rows);

  // ---------- product movement history (with sources) ----------
  route(app, 'GET', '/api/v1/products/:id/movements', { perm: 'inventory.stock.read', query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }) }, async ({ tx, actor, companyId, params, query }) => {
    const bf = branchFilter(actor, 'inventory.stock.read', companyId);
    return (await tx.query(`SELECT m.id, m.moved_at, m.move_type, m.ref_doc_type, m.ref_doc_id, v.sku, m.qty_stock_uom, m.unit_cost, m.value, fl.code AS from_code, tl.code AS to_code, b.code AS branch_code, m.negative_exception
      FROM inv_stock_move m JOIN cat_variant v ON v.id = m.variant_id JOIN inv_location fl ON fl.id = m.from_location_id JOIN inv_location tl ON tl.id = m.to_location_id JOIN core_branch b ON b.id = m.branch_id
      WHERE m.company_id = $1 AND v.product_id = $2 AND ($3::uuid[] IS NULL OR m.branch_id = ANY($3)) ORDER BY m.moved_at DESC LIMIT $4`, [companyId, params.id, bf, query.limit])).rows;
  });
}
export { uuid };

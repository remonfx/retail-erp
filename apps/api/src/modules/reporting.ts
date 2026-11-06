import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { uuid, isoDate, dec, fmt } from '@rc/domain';
import { route } from '../lib/http.js';
import { branchFilter, can, require as requirePerm } from '../lib/actor.js';

const range = z.object({ from: isoDate, to: isoDate, branchId: uuid.optional() });

export default async function reportingRoutes(app: FastifyInstance) {
  // Operational dashboard (read model; NOT audited statements)
  route(app, 'GET', '/api/v1/dashboard', { perm: 'reporting.dashboard.read', query: range }, async ({ tx, actor, companyId, query }) => {
    const bf = branchFilter(actor, 'reporting.dashboard.read', companyId);
    if (query.branchId) requirePerm(actor, 'reporting.dashboard.read', { companyId, branchId: query.branchId });
    const p = [companyId, query.from, query.to, bf, query.branchId ?? null];
    const where = `company_id = $1 AND business_date BETWEEN $2 AND $3 AND ($4::uuid[] IS NULL OR branch_id = ANY($4)) AND ($5::uuid IS NULL OR branch_id = $5)`;
    const kpi = (await tx.query(`SELECT coalesce(sum(gross), 0) AS gross_sales, coalesce(sum(discount), 0) AS discounts, coalesce(sum(net), 0) AS net_sales, coalesce(sum(tax), 0) AS tax,
        coalesce(sum(cost), 0) AS cogs, coalesce(sum(net - cost), 0) AS gross_profit FROM rep_sales_daily WHERE ${where}`, p)).rows[0];
    const orders = (await tx.query(`SELECT count(*) FILTER (WHERE kind = 'sale')::int AS orders, count(*) FILTER (WHERE kind = 'return')::int AS returns,
        coalesce(avg(grand_total) FILTER (WHERE kind = 'sale'), 0) AS avg_basket FROM pos_order WHERE ${where}`, p)).rows[0];
    const byBranch = (await tx.query(`SELECT r.branch_id, b.code, b.name_ar, sum(r.net) AS net_sales, sum(r.net - r.cost) AS gross_profit FROM rep_sales_daily r JOIN core_branch b ON b.id = r.branch_id
        WHERE r.company_id = $1 AND r.business_date BETWEEN $2 AND $3 AND ($4::uuid[] IS NULL OR r.branch_id = ANY($4)) AND ($5::uuid IS NULL OR r.branch_id = $5) GROUP BY 1, 2, 3 ORDER BY 4 DESC`, p)).rows;
    const byDay = (await tx.query(`SELECT business_date, sum(net) AS net_sales, sum(net - cost) AS gross_profit FROM rep_sales_daily WHERE ${where} GROUP BY 1 ORDER BY 1`, p)).rows;
    const byCategory = (await tx.query(`SELECT r.category_id, c.name_ar, sum(r.net) AS net_sales, sum(r.net - r.cost) AS gross_profit FROM rep_sales_daily r LEFT JOIN cat_category c ON c.id = r.category_id
        WHERE r.company_id = $1 AND r.business_date BETWEEN $2 AND $3 AND ($4::uuid[] IS NULL OR r.branch_id = ANY($4)) AND ($5::uuid IS NULL OR r.branch_id = $5) GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`, p)).rows;
    const topProducts = (await tx.query(`SELECT r.variant_id, v.sku, pr.id AS product_id, pr.name_ar, sum(r.qty) AS qty, sum(r.net) AS net_sales, sum(r.net - r.cost) AS gross_profit FROM rep_sales_daily r JOIN cat_variant v ON v.id = r.variant_id JOIN cat_product pr ON pr.id = v.product_id
        WHERE r.company_id = $1 AND r.business_date BETWEEN $2 AND $3 AND ($4::uuid[] IS NULL OR r.branch_id = ANY($4)) AND ($5::uuid IS NULL OR r.branch_id = $5) GROUP BY 1, 2, 3, 4 ORDER BY 6 DESC LIMIT 20`, p)).rows;
    const showFinance = can(actor, 'accounting.reports.read', { companyId });
    const finance = showFinance ? (await tx.query(`SELECT
        (SELECT coalesce(sum(b.debit - b.credit), 0) FROM acc_account_balance b JOIN acc_account a ON a.id = b.account_id WHERE b.company_id = $1 AND a.subtype IN ('cash','bank')) AS cash_position,
        (SELECT coalesce(sum(value), 0) FROM inv_product_cost WHERE company_id = $1) AS inventory_value,
        (SELECT coalesce(sum(total - amount_paid), 0) FROM pur_invoice WHERE company_id = $1 AND state = 'posted' AND kind = 'invoice') AS payables,
        (SELECT coalesce(sum(b.debit - b.credit), 0) FROM acc_account_balance b JOIN acc_account a ON a.id = b.account_id WHERE b.company_id = $1 AND a.subtype = 'receivable') AS receivables,
        (SELECT coalesce(sum(b.debit - b.credit), 0) FROM acc_account_balance b JOIN acc_account a ON a.id = b.account_id WHERE b.company_id = $1 AND a.type = 'expense' AND a.subtype NOT IN ('cogs') AND b.period_month BETWEEN date_trunc('month', $2::date) AND $3) AS operating_expenses`, [companyId, query.from, query.to])).rows[0] : null;
    const margin = dec(kpi.net_sales).isZero() ? '0.00' : fmt(dec(kpi.gross_profit).div(dec(kpi.net_sales)).mul(100), 2);
    return { label: 'operational', kpi: { ...kpi, ...orders, gross_margin_pct: margin }, finance, byBranch, byDay, byCategory, topProducts };
  });

  route(app, 'GET', '/api/v1/reports/sales', { perm: 'reporting.dashboard.read', query: range.extend({ groupBy: z.enum(['branch', 'category', 'product', 'day', 'month', 'cashier']).default('day'), categoryId: uuid.optional() }) }, async ({ tx, actor, companyId, query }) => {
    const bf = branchFilter(actor, 'reporting.dashboard.read', companyId);
    if (query.groupBy === 'cashier') {
      return (await tx.query(`SELECT o.cashier_id AS key, u.full_name AS label, count(*) FILTER (WHERE o.kind = 'sale')::int AS orders, count(*) FILTER (WHERE o.kind = 'return')::int AS returns,
          sum(CASE WHEN o.kind = 'sale' THEN o.grand_total ELSE -o.grand_total END) AS total, sum(o.discount_total) AS discounts, count(*) FILTER (WHERE o.offline)::int AS offline_orders
        FROM pos_order o LEFT JOIN core_user u ON u.id = o.cashier_id WHERE o.company_id = $1 AND o.business_date BETWEEN $2 AND $3 AND ($4::uuid[] IS NULL OR o.branch_id = ANY($4)) AND ($5::uuid IS NULL OR o.branch_id = $5)
        GROUP BY 1, 2 ORDER BY total DESC`, [companyId, query.from, query.to, bf, query.branchId ?? null])).rows;
    }
    const key = { branch: 'r.branch_id::text', category: 'r.category_id::text', product: 'r.variant_id::text', day: 'r.business_date::text', month: "to_char(r.business_date, 'YYYY-MM')", cashier: '' }[query.groupBy];
    const label = { branch: 'max(b.name_ar)', category: 'max(c.name_ar)', product: "max(v.sku || ' — ' || p.name_ar)", day: 'r.business_date::text', month: "to_char(r.business_date, 'YYYY-MM')", cashier: '' }[query.groupBy];
    return (await tx.query(`SELECT ${key} AS key, ${label} AS label, sum(r.qty) AS qty, sum(r.gross) AS gross, sum(r.discount) AS discount, sum(r.net) AS net, sum(r.tax) AS tax, sum(r.cost) AS cost, sum(r.net - r.cost) AS gross_profit,
        CASE WHEN sum(r.net) = 0 THEN 0 ELSE round(sum(r.net - r.cost) / sum(r.net) * 100, 2) END AS margin_pct
      FROM rep_sales_daily r JOIN core_branch b ON b.id = r.branch_id LEFT JOIN cat_category c ON c.id = r.category_id JOIN cat_variant v ON v.id = r.variant_id JOIN cat_product p ON p.id = v.product_id
      WHERE r.company_id = $1 AND r.business_date BETWEEN $2 AND $3 AND ($4::uuid[] IS NULL OR r.branch_id = ANY($4)) AND ($5::uuid IS NULL OR r.branch_id = $5)
        AND ($6::uuid IS NULL OR r.category_id IN (SELECT id FROM cat_category WHERE $6 = ANY(path)))
      GROUP BY 1 ${query.groupBy === 'day' || query.groupBy === 'month' ? ', 2' : ''} ORDER BY ${query.groupBy === 'day' || query.groupBy === 'month' ? '1' : 'net DESC'} LIMIT 5000`,
      [companyId, query.from, query.to, bf, query.branchId ?? null, query.categoryId ?? null])).rows;
  });

  route(app, 'GET', '/api/v1/reports/inventory-valuation', { perm: 'inventory.stock.read', query: z.object({ branchId: uuid.optional(), groupBy: z.enum(['branch', 'category', 'product']).default('branch') }) }, async ({ tx, actor, companyId, query }) => {
    if (!can(actor, 'catalog.cost.view', { companyId })) return { rows: [], note: 'cost hidden' };
    const key = { branch: 'l.branch_id::text', category: 'p.category_id::text', product: 'q.variant_id::text' }[query.groupBy];
    const label = { branch: "coalesce(max(b.name_ar), 'بالطريق')", category: 'max(c.name_ar)', product: "max(v.sku || ' — ' || p.name_ar)" }[query.groupBy];
    const rows = (await tx.query(`SELECT ${key} AS key, ${label} AS label, sum(q.qty_on_hand) AS qty, round(sum(q.qty_on_hand * CASE WHEN pc.qty > 0 THEN pc.value / pc.qty ELSE pc.last_avg END), 2) AS value
      FROM inv_stock_quant q JOIN inv_location l ON l.id = q.location_id JOIN cat_variant v ON v.id = q.variant_id JOIN cat_product p ON p.id = v.product_id LEFT JOIN cat_category c ON c.id = p.category_id
      LEFT JOIN core_branch b ON b.id = l.branch_id JOIN inv_product_cost pc ON pc.company_id = q.company_id AND pc.variant_id = q.variant_id
      WHERE q.company_id = $1 AND l.type IN ('internal','quarantine','transit') AND q.owner_id = '00000000-0000-0000-0000-000000000000' AND q.qty_on_hand <> 0 AND ($2::uuid IS NULL OR l.branch_id = $2)
      GROUP BY 1 ORDER BY 4 DESC LIMIT 5000`, [companyId, query.branchId ?? null])).rows;
    const total = (await tx.query('SELECT coalesce(sum(value), 0) AS v FROM inv_product_cost WHERE company_id = $1', [companyId])).rows[0].v;
    return { rows, subledgerTotal: total };
  });

  route(app, 'GET', '/api/v1/reports/inventory-analytics', { perm: 'inventory.stock.read', query: z.object({ branchId: uuid.optional(), days: z.coerce.number().int().min(7).max(730).default(90) }) }, async ({ tx, companyId, query }) => {
    const p = [companyId, query.branchId ?? null, query.days];
    const abc = (await tx.query(`WITH s AS (SELECT variant_id, sum(cost) AS cogs FROM rep_sales_daily WHERE company_id = $1 AND ($2::uuid IS NULL OR branch_id = $2) AND business_date >= current_date - $3::int GROUP BY 1),
        r AS (SELECT variant_id, cogs, sum(cogs) OVER (ORDER BY cogs DESC, variant_id) / nullif(sum(cogs) OVER (), 0) AS cum FROM s WHERE cogs > 0)
      SELECT CASE WHEN cum <= 0.8 THEN 'A' WHEN cum <= 0.95 THEN 'B' ELSE 'C' END AS class, count(*)::int AS skus, sum(cogs) AS cogs FROM r GROUP BY 1 ORDER BY 1`, p)).rows;
    const dead = (await tx.query(`SELECT q.variant_id, v.sku, pr.name_ar, sum(q.qty_on_hand) AS qty, max(m.last_out) AS last_movement
      FROM inv_stock_quant q JOIN inv_location l ON l.id = q.location_id JOIN cat_variant v ON v.id = q.variant_id JOIN cat_product pr ON pr.id = v.product_id
      LEFT JOIN LATERAL (SELECT max(moved_at) AS last_out FROM inv_stock_move mm WHERE mm.variant_id = q.variant_id AND mm.from_location_id = q.location_id AND mm.moved_at >= now() - ($3::int || ' days')::interval) m ON true
      WHERE q.company_id = $1 AND l.type = 'internal' AND ($2::uuid IS NULL OR l.branch_id = $2) AND q.qty_on_hand > 0 GROUP BY 1, 2, 3 HAVING max(m.last_out) IS NULL ORDER BY 4 DESC LIMIT 500`, p)).rows;
    const turnover = (await tx.query(`SELECT (SELECT coalesce(sum(cost), 0) FROM rep_sales_daily WHERE company_id = $1 AND ($2::uuid IS NULL OR branch_id = $2) AND business_date >= current_date - $3::int) AS cogs,
        (SELECT coalesce(sum(value), 0) FROM inv_product_cost WHERE company_id = $1) AS inventory_value`, p)).rows[0];
    const ratio = dec(turnover.inventory_value).isZero() ? '0' : fmt(dec(turnover.cogs).div(dec(turnover.inventory_value)), 2);
    const aging = (await tx.query(`SELECT CASE WHEN age <= 30 THEN '0-30' WHEN age <= 60 THEN '31-60' WHEN age <= 90 THEN '61-90' WHEN age <= 180 THEN '91-180' ELSE '180+' END AS bucket, sum(remaining_value) AS value, count(DISTINCT variant_id)::int AS skus
      FROM (SELECT variant_id, remaining_value, extract(day FROM now() - created_at) AS age FROM inv_valuation_layer WHERE company_id = $1 AND remaining_qty > 0) x GROUP BY 1 ORDER BY min(age)`, [companyId])).rows;
    const expiring = (await tx.query(`SELECT lot.lot_no, lot.expiry_date, v.sku, pr.name_ar, sum(q.qty_on_hand) AS qty FROM inv_stock_quant q JOIN inv_lot lot ON lot.id = q.lot_id JOIN cat_variant v ON v.id = q.variant_id JOIN cat_product pr ON pr.id = v.product_id JOIN inv_location l ON l.id = q.location_id
      WHERE q.company_id = $1 AND ($2::uuid IS NULL OR l.branch_id = $2) AND q.qty_on_hand > 0 AND lot.expiry_date <= current_date + 30 GROUP BY 1, 2, 3, 4 ORDER BY 2 LIMIT 500`, [companyId, query.branchId ?? null])).rows;
    return { abc, deadStock: dead, turnover: { ...turnover, periodDays: query.days, ratio }, fifoAging: aging, expiringLots: expiring };
  });
}

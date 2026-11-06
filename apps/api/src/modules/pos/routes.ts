import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { uuid, syncPushSchema, dec, fmt } from '@rc/domain';
import { route, audit, pageQuery, decodeCursor, page } from '../../lib/http.js';
import { require as requirePerm, branchFilter } from '../../lib/actor.js';
import { AppError, notFound, forbidden } from '../../lib/errors.js';
import { applySyncBatch } from './sync.js';

const STREAMS = ['catalog', 'barcodes', 'prices', 'promotions', 'users', 'tax', 'customers', 'assortment'] as const;

export default async function posRoutes(app: FastifyInstance) {
  // ---------- device sync ----------
  route(app, 'POST', '/api/v1/sync/push', { auth: 'device', company: 'none', tx: false, body: syncPushSchema, rateLimit: { max: 600, timeWindow: '1 minute' } }, async ({ actor, body }) => {
    const results = await applySyncBatch(actor, body.items);
    return { batchId: body.batchId, results, serverTime: new Date().toISOString() };
  });

  route(app, 'GET', '/api/v1/sync/pull', { auth: 'device', company: 'none', query: z.object({ stream: z.enum(STREAMS), since: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(5000).default(2000) }) }, async ({ tx, actor, query }) => {
    const t = (await tx.query('SELECT * FROM pos_terminal WHERE device_id = $1 AND active', [actor.deviceId])).rows[0];
    if (!t) throw new AppError('DEVICE_HAS_NO_TERMINAL', 409);
    const changes = (await tx.query(`SELECT max(version) AS version, entity_id FROM core_change_log WHERE stream = $1 AND version > $2 GROUP BY entity_id ORDER BY 1 LIMIT $3`, [query.stream, query.since, query.limit])).rows;
    const ids = changes.map((c) => c.entity_id);
    const nextVersion = changes.length ? Number(changes[changes.length - 1].version) : query.since;
    const hasMore = changes.length === query.limit;
    let items: Record<string, unknown>[] = [];
    switch (query.stream) {
      case 'catalog':
        items = (await tx.query(`SELECT v.id, v.sku, v.status, v.name_suffix_ar, v.name_suffix_en, p.id AS product_id, p.name_ar, p.name_en, p.category_id, c.path AS category_path, p.brand_id, p.tax_class_id, p.stock_uom_id, coalesce(p.sales_uom_id, p.stock_uom_id) AS sales_uom_id,
            p.tracking, p.is_weighted, p.blocked_for_sale, (p.status = 'active' AND v.status = 'active' AND v.merged_into_id IS NULL) AS sellable
          FROM cat_variant v JOIN cat_product p ON p.id = v.product_id JOIN cat_category c ON c.id = p.category_id WHERE v.id = ANY($1::uuid[]) OR v.product_id = ANY($1::uuid[])`, [ids])).rows;
        break;
      case 'barcodes':
        items = (await tx.query(`SELECT id, variant_id, code, pack_qty, uom_id, status FROM cat_barcode WHERE id = ANY($1::uuid[])`, [ids])).rows;
        break;
      case 'prices':
        items = (await tx.query(`SELECT i.id, i.price_list_id, pl.scope, pl.priority, i.variant_id, i.uom_id, i.price, i.min_qty, i.valid_from, i.valid_to
          FROM prc_price_list_item i JOIN prc_price_list pl ON pl.id = i.price_list_id
          WHERE i.id = ANY($1::uuid[]) AND pl.company_id = $2 AND pl.active AND (pl.scope = 'company' OR (pl.scope = 'branch' AND pl.branch_id = $3)
            OR (pl.scope = 'branch_group' AND EXISTS (SELECT 1 FROM prc_branch_group_member m WHERE m.group_id = pl.branch_group_id AND m.branch_id = $3)))`, [ids, t.company_id, t.branch_id])).rows;
        break;
      case 'promotions':
        items = (await tx.query(`SELECT p.id, p.code, p.name_ar, p.name_en, p.priority, p.exclusive, p.stackable, p.valid_from, p.valid_to, p.time_from, p.time_to, p.coupon_code, p.customer_group_ids, p.targets, p.rule,
            (p.status = 'active' AND (p.all_branches OR EXISTS (SELECT 1 FROM prc_promotion_branch b WHERE b.promotion_id = p.id AND b.branch_id = $2))) AS applicable
          FROM prc_promotion p WHERE p.id = ANY($1::uuid[]) AND p.company_id = $3`, [ids, t.branch_id, t.company_id])).rows;
        break;
      case 'users':
        items = (await tx.query(`SELECT u.id, u.full_name, u.locale, u.status, u.pos_pin_hash,
            coalesce((SELECT array_agg(DISTINCT rp.permission) FROM core_role_assignment a JOIN core_role_permission rp ON rp.role_id = a.role_id
              WHERE a.user_id = u.id AND rp.permission LIKE 'pos.%' AND (a.scope_type = 'tenant' OR (a.scope_type = 'company' AND a.company_id = $2) OR (a.scope_type = 'branch' AND a.branch_id = $3))), '{}') AS pos_permissions,
            coalesce((SELECT jsonb_agg(a.limits) FROM core_role_assignment a WHERE a.user_id = u.id AND (a.scope_type = 'tenant' OR a.company_id = $2)), '[]') AS limits
          FROM core_user u WHERE u.id = ANY($1::uuid[])`, [ids, t.company_id, t.branch_id])).rows
          .map((u) => ({ ...u, pos_pin_hash: u.status === 'active' && u.pos_permissions.length ? u.pos_pin_hash : null, active: u.status === 'active' && u.pos_permissions.length > 0 }));
        break;
      case 'tax':
        items = (await tx.query(`SELECT r.id, r.code, r.rate, r.kind, r.sequence, coalesce((SELECT array_agg(tax_class_id) FROM tax_class_rate cr WHERE cr.tax_rate_id = r.id), '{}') AS tax_class_ids FROM tax_rate r WHERE r.id = ANY($1::uuid[])`, [ids])).rows;
        break;
      case 'customers':
        items = (await tx.query(`SELECT id, code, name_ar, name_en, phone_norm, customer_group_id, active FROM par_partner WHERE id = ANY($1::uuid[]) AND is_customer`, [ids])).rows;
        break;
      case 'assortment':
        items = (await tx.query(`SELECT variant_id, sellable FROM cat_branch_assortment WHERE branch_id = $2 AND variant_id = ANY($1::uuid[])`, [ids, t.branch_id])).rows;
        break;
    }
    const found = new Set(items.map((i) => (i.id ?? i.variant_id) as string));
    const deleted = ids.filter((id) => !found.has(id) && query.stream !== 'catalog');
    return { stream: query.stream, items, deleted, nextVersion, hasMore };
  });

  route(app, 'GET', '/api/v1/sync/config', { auth: 'device', company: 'none' }, async ({ tx, actor }) => {
    const t = (await tx.query(`SELECT t.*, b.code AS branch_code, b.name_ar AS branch_name_ar, b.name_en AS branch_name_en, b.address, b.phone, b.timezone, c.legal_name_ar, c.legal_name_en, c.tax_registration_no, c.prices_include_tax, c.allow_negative_stock
      FROM pos_terminal t JOIN core_branch b ON b.id = t.branch_id JOIN core_company c ON c.id = t.company_id WHERE t.device_id = $1`, [actor.deviceId])).rows[0];
    if (!t) throw new AppError('DEVICE_HAS_NO_TERMINAL', 409);
    const rules = (await tx.query('SELECT prefix, item_code_length AS "itemCodeLength", value_length AS "valueLength", value_type AS "valueType", value_decimals AS "valueDecimals" FROM cat_embedded_barcode_rule')).rows;
    const plu = (await tx.query('SELECT item_code, variant_id FROM cat_scale_plu')).rows;
    const open = (await tx.query(`SELECT id, number, business_date, opening_float FROM pos_session WHERE terminal_id = $1 AND state = 'open'`, [t.id])).rows[0] ?? null;
    const lastSeq = (await tx.query('SELECT coalesce(max(device_seq), 0) AS s FROM pos_sync_inbox WHERE device_id = $1', [actor.deviceId])).rows[0].s;
    return { terminal: t, embeddedBarcodeRules: rules, scalePlu: plu, openSession: open, lastAckedSeq: Number(lastSeq), serverTime: new Date().toISOString() };
  });

  route(app, 'POST', '/api/v1/sync/heartbeat', { auth: 'device', company: 'none', body: z.object({ queueDepth: z.number().int().min(0), oldestPendingAt: z.string().nullish(), appVersion: z.string().max(40), printer: z.string().max(40).optional(), lastError: z.string().max(500).optional() }) }, async ({ tx, actor, body }) => {
    await tx.query(`UPDATE core_device SET last_seen_at = now(), app_version = $2, last_heartbeat = $3 WHERE id = $1`, [actor.deviceId, body.appVersion, JSON.stringify({ ...body, at: new Date().toISOString() })]);
    return { ok: true, serverTime: new Date().toISOString() };
  });

  // ---------- back-office ----------
  route(app, 'GET', '/api/v1/pos/sessions', { perm: 'sales.order.read', query: pageQuery.extend({ branchId: uuid.optional(), state: z.string().optional() }) }, async ({ tx, actor, companyId, query }) => {
    const bf = branchFilter(actor, 'sales.order.read', companyId);
    const cur = decodeCursor(query.cursor);
    const rows = (await tx.query(`SELECT s.*, t.code AS terminal_code, b.code AS branch_code, u.full_name AS opened_by_name FROM pos_session s JOIN pos_terminal t ON t.id = s.terminal_id JOIN core_branch b ON b.id = s.branch_id LEFT JOIN core_user u ON u.id = s.opened_by
      WHERE s.company_id = $1 AND ($2::uuid[] IS NULL OR s.branch_id = ANY($2)) AND ($3::uuid IS NULL OR s.branch_id = $3) AND ($4::text IS NULL OR s.state = $4)
        AND ($5::timestamptz IS NULL OR (s.opened_at, s.id) < ($5, $6::uuid)) ORDER BY s.opened_at DESC, s.id DESC LIMIT $7`,
      [companyId, bf, query.branchId ?? null, query.state ?? null, cur?.[0] ?? null, cur?.[1] ?? null, query.limit + 1])).rows;
    return page(rows, query.limit, 'opened_at');
  });

  route(app, 'GET', '/api/v1/pos/sessions/:id/z-report', { perm: 'sales.order.read' }, async ({ tx, actor, companyId, params }) => {
    const s = (await tx.query('SELECT s.*, t.code AS terminal_code FROM pos_session s JOIN pos_terminal t ON t.id = s.terminal_id WHERE s.id = $1 AND s.company_id = $2', [params.id, companyId])).rows[0];
    if (!s) throw notFound('SESSION');
    requirePerm(actor, 'sales.order.read', { companyId, branchId: s.branch_id });
    const byKind = (await tx.query(`SELECT kind, count(*)::int AS orders, sum(grand_total) AS total, sum(tax_total) AS tax, sum(discount_total) AS discount FROM pos_order WHERE session_id = $1 GROUP BY kind`, [s.id])).rows;
    const tenders = (await tx.query(`SELECT method, count(*)::int AS count, sum(amount) AS amount FROM pos_payment WHERE session_id = $1 GROUP BY method ORDER BY method`, [s.id])).rows;
    const taxes = (await tx.query(`SELECT t->>'code' AS code, sum(CASE WHEN o.kind = 'sale' THEN (t->>'base')::numeric ELSE -(t->>'base')::numeric END) AS base, sum(CASE WHEN o.kind = 'sale' THEN (t->>'amount')::numeric ELSE -(t->>'amount')::numeric END) AS amount
      FROM pos_order o JOIN pos_order_line l ON l.order_id = o.id AND l.business_date = o.business_date, jsonb_array_elements(l.tax_lines) t WHERE o.session_id = $1 GROUP BY 1`, [s.id])).rows;
    const cash = (await tx.query(`SELECT kind, sum(amount) AS amount FROM pos_cash_movement WHERE session_id = $1 GROUP BY kind`, [s.id])).rows;
    const quarantined = (await tx.query(`SELECT count(*)::int AS n FROM pos_sync_inbox WHERE status = 'quarantined' AND payload->'payload'->>'sessionId' = $1`, [s.id])).rows[0].n;
    return { session: s, byKind, tenders, taxes, cashMovements: cash, quarantinedItems: quarantined };
  });

  route(app, 'GET', '/api/v1/pos/orders', { perm: 'sales.order.read', query: pageQuery.extend({ branchId: uuid.optional(), sessionId: uuid.optional(), from: z.string().optional(), to: z.string().optional(), receiptNo: z.string().optional() }) }, async ({ tx, actor, companyId, query }) => {
    const bf = branchFilter(actor, 'sales.order.read', companyId);
    const cur = decodeCursor(query.cursor);
    const rows = (await tx.query(`SELECT o.*, b.code AS branch_code, t.code AS terminal_code, u.full_name AS cashier_name FROM pos_order o JOIN core_branch b ON b.id = o.branch_id JOIN pos_terminal t ON t.id = o.terminal_id LEFT JOIN core_user u ON u.id = o.cashier_id
      WHERE o.company_id = $1 AND ($2::uuid[] IS NULL OR o.branch_id = ANY($2)) AND ($3::uuid IS NULL OR o.branch_id = $3) AND ($4::uuid IS NULL OR o.session_id = $4)
        AND ($5::date IS NULL OR o.business_date >= $5) AND ($6::date IS NULL OR o.business_date <= $6) AND ($7::text IS NULL OR o.receipt_no = $7)
        AND ($8::timestamptz IS NULL OR (o.sold_at, o.id) < ($8, $9::uuid)) ORDER BY o.sold_at DESC, o.id DESC LIMIT $10`,
      [companyId, bf, query.branchId ?? null, query.sessionId ?? null, query.from ?? null, query.to ?? null, query.receiptNo ?? null, cur?.[0] ?? null, cur?.[1] ?? null, query.limit + 1])).rows;
    return page(rows, query.limit, 'sold_at');
  });
  route(app, 'GET', '/api/v1/pos/orders/:id', { perm: 'sales.order.read', auth: 'user_or_device' }, async ({ tx, actor, companyId, params }) => {
    const o = (await tx.query('SELECT * FROM pos_order WHERE id = $1 AND company_id = $2', [params.id, companyId])).rows[0];
    if (!o) throw notFound('ORDER');
    const bf = actor.kind === 'device' ? [actor.deviceBranchId!] : branchFilter(actor, 'sales.order.read', companyId);
    if (bf && !bf.includes(o.branch_id)) throw notFound('ORDER');
    o.lines = (await tx.query(`SELECT l.*, v.sku, p.name_ar, p.name_en, coalesce((SELECT sum(r.qty) FROM pos_order_line r WHERE r.return_of_line_id = l.id), 0) AS returned_qty FROM pos_order_line l JOIN cat_variant v ON v.id = l.variant_id JOIN cat_product p ON p.id = v.product_id WHERE l.order_id = $1 AND l.business_date = $2`, [o.id, o.business_date])).rows;
    o.payments = (await tx.query('SELECT * FROM pos_payment WHERE order_id = $1 AND business_date = $2', [o.id, o.business_date])).rows;
    return o;
  });

  // sync monitoring & quarantine resolution
  route(app, 'GET', '/api/v1/pos/sync-status', { perm: 'pos.sync.monitor' }, async ({ tx, companyId }) => ({
    devices: (await tx.query(`SELECT d.id, d.name, d.status, d.branch_id, b.code AS branch_code, d.last_seen_at, d.app_version, d.last_heartbeat, t.code AS terminal_code,
        extract(epoch FROM now() - d.last_seen_at)::int AS seconds_since_seen,
        (SELECT count(*) FROM pos_sync_inbox i WHERE i.device_id = d.id AND i.status = 'quarantined' AND i.resolved_at IS NULL)::int AS quarantined
      FROM core_device d JOIN core_branch b ON b.id = d.branch_id LEFT JOIN pos_terminal t ON t.device_id = d.id WHERE d.company_id = $1 AND d.kind = 'pos' ORDER BY b.code, t.code`, [companyId])).rows,
    quarantine: (await tx.query(`SELECT i.client_id, i.device_id, i.item_type, i.device_seq, i.error, i.received_at, i.payload->'payload'->>'receiptNo' AS receipt_no, i.payload->'payload'->>'grandTotal' AS grand_total
      FROM pos_sync_inbox i JOIN core_device d ON d.id = i.device_id WHERE d.company_id = $1 AND i.status = 'quarantined' AND i.resolved_at IS NULL ORDER BY i.received_at DESC LIMIT 500`, [companyId])).rows,
  }));
  route(app, 'POST', '/api/v1/pos/quarantine/:clientId/resolve', { body: z.object({ resolution: z.enum(['accepted_manually', 'duplicate', 'voided']), note: z.string().min(3) }) }, async ({ tx, actor, companyId, params, body }) => {
    const q = (await tx.query(`SELECT i.*, d.branch_id FROM pos_sync_inbox i JOIN core_device d ON d.id = i.device_id WHERE i.client_id = $1 AND d.company_id = $2 AND i.status = 'quarantined'`, [params.clientId, companyId])).rows[0];
    if (!q) throw notFound('QUARANTINE_ITEM');
    requirePerm(actor, 'pos.session.approve', { companyId, branchId: q.branch_id });
    await tx.query(`UPDATE pos_sync_inbox SET resolved_by = $2, resolved_at = now(), error = error || ' | resolved: ' || $3 || ' — ' || $4 WHERE client_id = $1`, [q.client_id, actor.userId, body.resolution, body.note]);
    await audit(tx, actor, 'resolve_quarantine', 'pos_sync_inbox', q.client_id, body, companyId);
    return { ok: true };
  });
  route(app, 'GET', '/api/v1/pos/pricing-discrepancies', { perm: 'pos.sync.monitor' }, async ({ tx, companyId }) =>
    (await tx.query('SELECT * FROM pos_pricing_discrepancy WHERE company_id = $1 ORDER BY created_at DESC LIMIT 500', [companyId])).rows);
}
export { dec, fmt, forbidden };

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { uuidv7, uuid, positiveDecimal, decimalStr, dec, fmt, ZERO, type Dec } from '@rc/domain';
import { route, audit, pageQuery, decodeCursor, page } from '../../lib/http.js';
import { require as requirePerm, can, branchFilter } from '../../lib/actor.js';
import { AppError, invalid, notFound, forbidden } from '../../lib/errors.js';
import type { Tx } from '../../lib/db.js';
import { nextNumber, branchCode } from '../../lib/numbering.js';
import { postMoves, currentUnitCost, ensureLot, type MoveInput } from './engine.js';
import { emitInventoryValued } from './events.js';

async function loc(tx: Tx, companyId: string, id: string) {
  const l = (await tx.query('SELECT * FROM inv_location WHERE id = $1 AND company_id = $2', [id, companyId])).rows[0];
  if (!l) throw notFound('LOCATION');
  return l;
}
async function virtualLoc(tx: Tx, companyId: string, type: 'supplier' | 'customer' | 'inventory_loss' | 'transit') {
  return (await tx.query('SELECT id FROM inv_location WHERE company_id = $1 AND type = $2 AND warehouse_id IS NULL ORDER BY code LIMIT 1', [companyId, type])).rows[0].id as string;
}
export { virtualLoc };

const adjustmentSchema = z.object({
  kind: z.enum(['adjustment', 'scrap']),
  locationId: uuid,
  reasonCodeId: uuid,
  notes: z.string().max(500).optional(),
  lines: z.array(z.object({ variantId: uuid, qty: decimalStr.refine((s) => Number(s) !== 0, 'QTY_ZERO'), lotNo: z.string().optional(), serialNo: z.string().optional(), unitCost: decimalStr.optional() })).min(1).max(1000),
});

async function executeAdjustment(tx: Tx, doc: Record<string, any>, userId: string) {
  const lines = (await tx.query('SELECT * FROM inv_stock_document_line WHERE document_id = $1 ORDER BY id', [doc.id])).rows;
  const lossLoc = await virtualLoc(tx, doc.company_id, 'inventory_loss');
  const scrapLoc = doc.kind === 'scrap' ? (await tx.query(`SELECT l.id FROM inv_location l JOIN inv_location s ON s.warehouse_id = l.warehouse_id WHERE s.id = $1 AND l.type = 'scrap' LIMIT 1`, [doc.from_location_id])).rows[0]?.id : null;
  if (doc.kind === 'scrap' && !scrapLoc) throw invalid('NO_SCRAP_LOCATION');
  const moves: MoveInput[] = [];
  for (const l of lines) {
    const q = dec(l.qty);
    const gain = (l.notes ?? '') === 'gain';
    const lotId = l.lot_no ? await ensureLot(tx, doc.tenant_id, l.variant_id, l.lot_no, l.expiry_date) : null;
    if (doc.kind === 'scrap') moves.push({ variantId: l.variant_id, fromLocationId: doc.from_location_id, toLocationId: scrapLoc, qty: fmt(q, 6), lotId, serialNo: l.serial_no, moveType: 'scrap', reasonCodeId: doc.reason_code_id, refLineId: l.id });
    else if (gain) moves.push({ variantId: l.variant_id, fromLocationId: lossLoc, toLocationId: doc.from_location_id, qty: fmt(q, 6), lotId, serialNo: l.serial_no, moveType: doc.source_type === 'opening' ? 'opening' : 'adjustment_gain', reasonCodeId: doc.reason_code_id, refLineId: l.id, unitCost: l.unit_cost });
    else moves.push({ variantId: l.variant_id, fromLocationId: doc.from_location_id, toLocationId: lossLoc, qty: fmt(q, 6), lotId, serialNo: l.serial_no, moveType: 'adjustment_loss', reasonCodeId: doc.reason_code_id, refLineId: l.id });
  }
  const res = await postMoves(tx, { tenantId: doc.tenant_id, companyId: doc.company_id, branchId: doc.branch_id, refDocType: 'stock_document', refDocId: doc.id, userId, moves, negativePolicy: 'block', approved: true });
  const total = res.moves.reduce<Dec>((s, m) => s.add(m.valuation === 'in' ? m.value : m.value.neg()), ZERO);
  await tx.query(`UPDATE inv_stock_document SET state = 'done', done_by = $2, done_at = now(), total_value = $3 WHERE id = $1`, [doc.id, userId, fmt(total, 4)]);
  await tx.query('UPDATE inv_stock_document_line SET qty_done = qty WHERE document_id = $1', [doc.id]);
  await emitInventoryValued(tx, { tenantId: doc.tenant_id, companyId: doc.company_id, branchId: doc.branch_id, docType: 'stock_document', docId: doc.id, date: new Date().toISOString().slice(0, 10), userId, memo: doc.number, moves: res.moves });
  return res;
}

export const approvalHandlers: Record<string, (tx: Tx, docId: string, userId: string, approved: boolean) => Promise<void>> = {
  stock_adjustment: async (tx, docId, userId, approved) => {
    const doc = (await tx.query(`SELECT * FROM inv_stock_document WHERE id = $1 AND state = 'pending_approval' FOR UPDATE`, [docId])).rows[0];
    if (!doc) throw new AppError('DOCUMENT_NOT_PENDING', 409);
    if (!approved) { await tx.query(`UPDATE inv_stock_document SET state = 'cancelled' WHERE id = $1`, [docId]); return; }
    await tx.query(`UPDATE inv_stock_document SET state = 'approved', approved_by = $2 WHERE id = $1`, [docId, userId]);
    await executeAdjustment(tx, doc, userId);
  },
};

export default async function inventoryRoutes(app: FastifyInstance) {
  // ---------- stock queries ----------
  route(app, 'GET', '/api/v1/stock', {
    perm: 'inventory.stock.read',
    query: pageQuery.extend({ warehouseId: uuid.optional(), locationId: uuid.optional(), variantId: uuid.optional(), q: z.string().optional(), onlyNegative: z.coerce.boolean().optional(), branchId: uuid.optional() }),
  }, async ({ tx, actor, companyId, query }) => {
    const bf = branchFilter(actor, 'inventory.stock.read', companyId);
    const cur = decodeCursor(query.cursor);
    const showCost = can(actor, 'catalog.cost.view', { companyId });
    const rows = (await tx.query(`SELECT (q.location_id::text || q.variant_id::text || q.lot_id::text || q.owner_id::text) AS id, q.location_id, l.code AS location_code, l.branch_id, q.variant_id, v.sku, p.name_ar, p.name_en,
        q.lot_id, lot.lot_no, lot.expiry_date, q.owner_id, q.qty_on_hand, q.qty_reserved, (q.qty_on_hand - q.qty_reserved) AS qty_available,
        CASE WHEN $9 THEN round(q.qty_on_hand * CASE WHEN c.qty > 0 THEN c.value / c.qty ELSE c.last_avg END, 2) END AS value
      FROM inv_stock_quant q JOIN inv_location l ON l.id = q.location_id JOIN cat_variant v ON v.id = q.variant_id JOIN cat_product p ON p.id = v.product_id
      LEFT JOIN inv_lot lot ON lot.id = q.lot_id LEFT JOIN inv_product_cost c ON c.company_id = q.company_id AND c.variant_id = q.variant_id
      WHERE q.company_id = $1 AND l.type IN ('internal','quarantine','transit') AND q.qty_on_hand <> 0
        AND ($2::uuid[] IS NULL OR l.branch_id = ANY($2) OR l.type = 'transit')
        AND ($3::uuid IS NULL OR l.warehouse_id = $3) AND ($4::uuid IS NULL OR q.location_id = $4) AND ($5::uuid IS NULL OR q.variant_id = $5)
        AND ($6::text IS NULL OR p.search_norm LIKE '%' || rc_norm_ar($6) || '%' OR v.sku ILIKE $6 || '%')
        AND (NOT $7 OR q.qty_on_hand < 0) AND ($10::uuid IS NULL OR l.branch_id = $10)
        AND ($8::text IS NULL OR (q.location_id::text || q.variant_id::text || q.lot_id::text || q.owner_id::text) > $8)
      ORDER BY 1 LIMIT $11`,
      [companyId, bf, query.warehouseId ?? null, query.locationId ?? null, query.variantId ?? null, query.q ?? null, !!query.onlyNegative, cur?.[1] ?? null, showCost, query.branchId ?? null, query.limit + 1])).rows;
    return page(rows, query.limit, 'id');
  });

  route(app, 'GET', '/api/v1/stock/availability', { perm: 'inventory.stock.read', query: z.object({ variantIds: z.string() }) }, async ({ tx, companyId, query }) => {
    const ids = query.variantIds.split(',').filter(Boolean).slice(0, 500);
    return (await tx.query(`SELECT q.variant_id, l.branch_id, l.warehouse_id, sum(q.qty_on_hand) AS on_hand, sum(q.qty_reserved) AS reserved,
        sum(CASE WHEN l.type = 'internal' THEN q.qty_on_hand - q.qty_reserved ELSE 0 END) AS available, sum(CASE WHEN l.type = 'quarantine' THEN q.qty_on_hand ELSE 0 END) AS quarantined
      FROM inv_stock_quant q JOIN inv_location l ON l.id = q.location_id WHERE q.company_id = $1 AND q.variant_id = ANY($2::uuid[]) AND l.type IN ('internal','quarantine')
      GROUP BY 1, 2, 3`, [companyId, ids])).rows;
  });

  route(app, 'GET', '/api/v1/stock/moves', {
    perm: 'inventory.stock.read',
    query: z.object({ variantId: uuid.optional(), locationId: uuid.optional(), refDocId: uuid.optional(), from: z.string().optional(), to: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100), before: z.string().optional() }),
  }, async ({ tx, companyId, query, actor }) => {
    const bf = branchFilter(actor, 'inventory.stock.read', companyId);
    return (await tx.query(`SELECT m.*, v.sku, p.name_ar, fl.code AS from_code, fl.type AS from_type, tl.code AS to_code, tl.type AS to_type, u.full_name AS user_name
      FROM inv_stock_move m JOIN cat_variant v ON v.id = m.variant_id JOIN cat_product p ON p.id = v.product_id
      JOIN inv_location fl ON fl.id = m.from_location_id JOIN inv_location tl ON tl.id = m.to_location_id LEFT JOIN core_user u ON u.id = m.user_id
      WHERE m.company_id = $1 AND ($2::uuid[] IS NULL OR m.branch_id = ANY($2)) AND ($3::uuid IS NULL OR m.variant_id = $3)
        AND ($4::uuid IS NULL OR m.from_location_id = $4 OR m.to_location_id = $4) AND ($5::uuid IS NULL OR m.ref_doc_id = $5)
        AND ($6::timestamptz IS NULL OR m.moved_at >= $6) AND ($7::timestamptz IS NULL OR m.moved_at < $7) AND ($8::timestamptz IS NULL OR m.moved_at < $8)
      ORDER BY m.moved_at DESC, m.id DESC LIMIT $9`,
      [companyId, bf, query.variantId ?? null, query.locationId ?? null, query.refDocId ?? null, query.from ?? null, query.to ?? null, query.before ?? null, query.limit])).rows;
  });

  route(app, 'GET', '/api/v1/inventory/reason-codes', { perm: 'inventory.stock.read', company: 'none' }, async ({ tx }) => (await tx.query('SELECT * FROM inv_reason_code ORDER BY code')).rows);

  // ---------- adjustments & scrap (with threshold approval) ----------
  route(app, 'POST', '/api/v1/stock-adjustments', { body: adjustmentSchema.extend({ opening: z.boolean().optional() }) }, async ({ tx, actor, companyId, body, reply }) => {
    const l = await loc(tx, companyId, body.locationId);
    if (l.type !== 'internal' && l.type !== 'quarantine') throw invalid('LOCATION_NOT_STOCKABLE');
    requirePerm(actor, 'inventory.adjustment.write', { companyId, branchId: l.branch_id, warehouseId: l.warehouse_id, warehouseBranchId: l.branch_id });
    const reason = (await tx.query('SELECT * FROM inv_reason_code WHERE id = $1', [body.reasonCodeId])).rows[0];
    if (!reason) throw notFound('REASON_CODE');
    if (body.kind === 'scrap' && body.lines.some((x) => dec(x.qty).lt(0))) throw invalid('SCRAP_QTY_MUST_BE_POSITIVE');
    const id = uuidv7();
    const number = await nextNumber(tx, actor.tenantId, companyId, body.kind === 'scrap' ? 'SCR' : 'ADJ', await branchCode(tx, l.branch_id));
    let estValue = ZERO;
    for (const x of body.lines) estValue = estValue.add(dec(x.qty).abs().mul(x.unitCost ? dec(x.unitCost) : await currentUnitCost(tx, companyId, x.variantId)));
    const threshold = reason.requires_approval_above === null ? null : dec(reason.requires_approval_above);
    const needsApproval = threshold !== null && estValue.gt(threshold);
    await tx.query(`INSERT INTO inv_stock_document (id, tenant_id, company_id, branch_id, number, kind, state, from_location_id, reason_code_id, notes, total_value, requested_by, created_by, source_type)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13)`,
      [id, actor.tenantId, companyId, l.branch_id, number, body.kind, needsApproval ? 'pending_approval' : 'approved', body.locationId, body.reasonCodeId, body.notes ?? null, fmt(estValue, 4), actor.userId, body.opening ? 'opening' : null]);
    for (const x of body.lines) {
      const v = (await tx.query('SELECT p.stock_uom_id FROM cat_variant v JOIN cat_product p ON p.id = v.product_id WHERE v.id = $1', [x.variantId])).rows[0];
      if (!v) throw notFound('VARIANT');
      await tx.query(`INSERT INTO inv_stock_document_line (id, tenant_id, document_id, variant_id, qty, uom_id, lot_no, serial_no, unit_cost, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [uuidv7(), actor.tenantId, id, x.variantId, fmt(dec(x.qty).abs(), 6), v.stock_uom_id, x.lotNo ?? null, x.serialNo ?? null, x.unitCost ?? null, dec(x.qty).gt(0) && body.kind === 'adjustment' ? 'gain' : 'loss']);
    }
    reply.code(201);
    if (needsApproval) {
      await tx.query(`INSERT INTO wf_approval_request (id, tenant_id, company_id, branch_id, doc_type, doc_id, summary, amount, required_permission, requested_by) VALUES ($1,$2,$3,$4,'stock_adjustment',$5,$6,$7,'inventory.adjustment.approve',$8)`,
        [uuidv7(), actor.tenantId, companyId, l.branch_id, id, `${number} — ${reason.name_ar}`, fmt(estValue, 4), actor.userId]);
      return { id, number, state: 'pending_approval', estimatedValue: fmt(estValue, 2) };
    }
    const doc = (await tx.query('SELECT * FROM inv_stock_document WHERE id = $1', [id])).rows[0];
    await executeAdjustment(tx, doc, actor.userId);
    return { id, number, state: 'done', estimatedValue: fmt(estValue, 2) };
  });

  route(app, 'GET', '/api/v1/stock-documents', { perm: 'inventory.stock.read', query: pageQuery.extend({ kind: z.string().optional(), state: z.string().optional() }) }, async ({ tx, actor, companyId, query }) => {
    const bf = branchFilter(actor, 'inventory.stock.read', companyId);
    const cur = decodeCursor(query.cursor);
    const rows = (await tx.query(`SELECT d.*, b.code AS branch_code, r.name_ar AS reason_name FROM inv_stock_document d JOIN core_branch b ON b.id = d.branch_id LEFT JOIN inv_reason_code r ON r.id = d.reason_code_id
      WHERE d.company_id = $1 AND ($2::uuid[] IS NULL OR d.branch_id = ANY($2) OR d.dest_branch_id = ANY($2)) AND ($3::text IS NULL OR d.kind = $3) AND ($4::text IS NULL OR d.state = $4)
        AND ($5::timestamptz IS NULL OR (d.created_at, d.id) < ($5, $6::uuid)) ORDER BY d.created_at DESC, d.id DESC LIMIT $7`,
      [companyId, bf, query.kind ?? null, query.state ?? null, cur?.[0] ?? null, cur?.[1] ?? null, query.limit + 1])).rows;
    return page(rows, query.limit, 'created_at');
  });
  route(app, 'GET', '/api/v1/stock-documents/:id', { perm: 'inventory.stock.read' }, async ({ tx, companyId, params }) => {
    const d = (await tx.query('SELECT * FROM inv_stock_document WHERE id = $1 AND company_id = $2', [params.id, companyId])).rows[0];
    if (!d) throw notFound('DOCUMENT');
    d.lines = (await tx.query(`SELECT l.*, v.sku, p.name_ar, p.name_en FROM inv_stock_document_line l JOIN cat_variant v ON v.id = l.variant_id JOIN cat_product p ON p.id = v.product_id WHERE l.document_id = $1`, [params.id])).rows;
    d.moves = (await tx.query('SELECT * FROM inv_stock_move WHERE ref_doc_id = $1 ORDER BY moved_at', [params.id])).rows;
    return d;
  });

  // ---------- inter-branch / internal transfers (2-step via transit) ----------
  route(app, 'POST', '/api/v1/transfers', {
    body: z.object({ fromLocationId: uuid, toLocationId: uuid, notes: z.string().optional(), lines: z.array(z.object({ variantId: uuid, qty: positiveDecimal, lotNo: z.string().optional(), serialNo: z.string().optional() })).min(1).max(1000) }),
  }, async ({ tx, actor, companyId, body, reply }) => {
    const from = await loc(tx, companyId, body.fromLocationId), to = await loc(tx, companyId, body.toLocationId);
    if (from.type !== 'internal' || to.type !== 'internal') throw invalid('TRANSFER_LOCATIONS_MUST_BE_INTERNAL');
    requirePerm(actor, 'inventory.transfer.write', { companyId, branchId: from.branch_id, warehouseId: from.warehouse_id, warehouseBranchId: from.branch_id });
    const id = uuidv7();
    const number = await nextNumber(tx, actor.tenantId, companyId, 'TRF', await branchCode(tx, from.branch_id));
    await tx.query(`INSERT INTO inv_stock_document (id, tenant_id, company_id, branch_id, number, kind, state, from_location_id, to_location_id, dest_branch_id, notes, requested_by, created_by)
                    VALUES ($1,$2,$3,$4,$5,'transfer','draft',$6,$7,$8,$9,$10,$10)`, [id, actor.tenantId, companyId, from.branch_id, number, from.id, to.id, to.branch_id, body.notes ?? null, actor.userId]);
    for (const x of body.lines) {
      const v = (await tx.query('SELECT p.stock_uom_id FROM cat_variant v JOIN cat_product p ON p.id = v.product_id WHERE v.id = $1', [x.variantId])).rows[0];
      if (!v) throw notFound('VARIANT');
      await tx.query(`INSERT INTO inv_stock_document_line (id, tenant_id, document_id, variant_id, qty, uom_id, lot_no, serial_no) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [uuidv7(), actor.tenantId, id, x.variantId, x.qty, v.stock_uom_id, x.lotNo ?? null, x.serialNo ?? null]);
    }
    reply.code(201);
    return { id, number, state: 'draft' };
  });

  route(app, 'POST', '/api/v1/transfers/:id/dispatch', {}, async ({ tx, actor, companyId, params }) => {
    const d = (await tx.query(`SELECT * FROM inv_stock_document WHERE id = $1 AND company_id = $2 AND kind = 'transfer' FOR UPDATE`, [params.id, companyId])).rows[0];
    if (!d) throw notFound('TRANSFER');
    if (d.state !== 'draft' && d.state !== 'approved') throw new AppError('INVALID_STATE', 409, `Transfer is ${d.state}`);
    requirePerm(actor, 'inventory.transfer.write', { companyId, branchId: d.branch_id });
    const transit = await virtualLoc(tx, companyId, 'transit');
    const lines = (await tx.query('SELECT * FROM inv_stock_document_line WHERE document_id = $1', [d.id])).rows;
    const moves: MoveInput[] = [];
    for (const l of lines) moves.push({ variantId: l.variant_id, fromLocationId: d.from_location_id, toLocationId: transit, qty: l.qty, lotId: l.lot_no ? await ensureLot(tx, actor.tenantId, l.variant_id, l.lot_no) : null, serialNo: l.serial_no, moveType: 'transfer_out', refLineId: l.id });
    const res = await postMoves(tx, { tenantId: actor.tenantId, companyId, branchId: d.branch_id, refDocType: 'stock_document', refDocId: d.id, userId: actor.userId, moves, negativePolicy: 'block' });
    await tx.query(`UPDATE inv_stock_document SET state = 'in_transit', total_value = $2 WHERE id = $1`, [d.id, fmt(res.moves.reduce<Dec>((s, m) => s.add(m.value), ZERO), 4)]);
    await emitInventoryValued(tx, { tenantId: actor.tenantId, companyId, branchId: d.branch_id, docType: 'stock_document', docId: d.id, date: new Date().toISOString().slice(0, 10), userId: actor.userId, memo: `${d.number} dispatch`, moves: res.moves });
    await audit(tx, actor, 'dispatch', 'inv_stock_document', d.id, null, companyId);
    return { id: d.id, state: 'in_transit' };
  });

  route(app, 'POST', '/api/v1/transfers/:id/receive', {
    body: z.object({ lines: z.array(z.object({ lineId: uuid, qtyReceived: decimalStr })).min(1), shortageReasonCodeId: uuid.optional() }),
  }, async ({ tx, actor, companyId, params, body }) => {
    const d = (await tx.query(`SELECT * FROM inv_stock_document WHERE id = $1 AND company_id = $2 AND kind = 'transfer' FOR UPDATE`, [params.id, companyId])).rows[0];
    if (!d) throw notFound('TRANSFER');
    if (d.state !== 'in_transit') throw new AppError('INVALID_STATE', 409, `Transfer is ${d.state}`);
    requirePerm(actor, 'inventory.transfer.write', { companyId, branchId: d.dest_branch_id });
    if (!can(actor, 'inventory.transfer.write', { companyId, branchId: d.dest_branch_id })) throw forbidden();
    const transit = await virtualLoc(tx, companyId, 'transit'), lossLoc = await virtualLoc(tx, companyId, 'inventory_loss');
    const lines = new Map((await tx.query('SELECT * FROM inv_stock_document_line WHERE document_id = $1', [d.id])).rows.map((l) => [l.id, l]));
    const moves: MoveInput[] = [];
    let shortage = false;
    for (const r of body.lines) {
      const l = lines.get(r.lineId);
      if (!l) throw invalid('LINE_NOT_IN_TRANSFER');
      const rec = dec(r.qtyReceived), sent = dec(l.qty);
      if (rec.lt(0) || rec.gt(sent)) throw invalid('RECEIVED_QTY_INVALID', 'Received quantity must be between 0 and dispatched quantity');
      const lotId = l.lot_no ? await ensureLot(tx, actor.tenantId, l.variant_id, l.lot_no) : null;
      if (rec.gt(0)) moves.push({ variantId: l.variant_id, fromLocationId: transit, toLocationId: d.to_location_id, qty: fmt(rec, 6), lotId, serialNo: l.serial_no, moveType: 'transfer_in', refLineId: l.id });
      if (rec.lt(sent)) { shortage = true; moves.push({ variantId: l.variant_id, fromLocationId: transit, toLocationId: lossLoc, qty: fmt(sent.sub(rec), 6), lotId, serialNo: l.serial_no, moveType: 'adjustment_loss', reasonCodeId: body.shortageReasonCodeId ?? null, refLineId: l.id }); }
      await tx.query('UPDATE inv_stock_document_line SET qty_done = $2 WHERE id = $1', [l.id, fmt(rec, 6)]);
    }
    if (body.lines.length !== lines.size) throw invalid('ALL_LINES_REQUIRED');
    if (shortage && !body.shortageReasonCodeId) throw invalid('SHORTAGE_REASON_REQUIRED');
    const res = await postMoves(tx, { tenantId: actor.tenantId, companyId, branchId: d.dest_branch_id, refDocType: 'stock_document', refDocId: d.id, userId: actor.userId, moves, negativePolicy: 'block' });
    await tx.query(`UPDATE inv_stock_document SET state = 'done', done_by = $2, done_at = now() WHERE id = $1`, [d.id, actor.userId]);
    await emitInventoryValued(tx, { tenantId: actor.tenantId, companyId, branchId: d.branch_id, docType: 'stock_document', docId: d.id, date: new Date().toISOString().slice(0, 10), userId: actor.userId, memo: `${d.number} receive`, moves: res.moves });
    return { id: d.id, state: 'done', shortage };
  });

  // ---------- stock counts ----------
  route(app, 'POST', '/api/v1/stock-counts', { body: z.object({ locationId: uuid, kind: z.enum(['full', 'cycle', 'blind']).default('cycle'), categoryId: uuid.optional(), variantIds: z.array(uuid).max(5000).optional() }) }, async ({ tx, actor, companyId, body, reply }) => {
    const l = await loc(tx, companyId, body.locationId);
    requirePerm(actor, 'inventory.count.write', { companyId, branchId: l.branch_id, warehouseId: l.warehouse_id, warehouseBranchId: l.branch_id });
    const id = uuidv7();
    const number = await nextNumber(tx, actor.tenantId, companyId, 'CNT', await branchCode(tx, l.branch_id));
    await tx.query(`INSERT INTO inv_stock_count (id, tenant_id, company_id, branch_id, number, warehouse_id, location_id, kind, category_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, actor.tenantId, companyId, l.branch_id, number, l.warehouse_id, l.id, body.kind, body.categoryId ?? null, actor.userId]);
    // snapshot: current quants (plus requested variants with zero stock)
    const r = await tx.query(`INSERT INTO inv_stock_count_line (id, tenant_id, count_id, variant_id, lot_id, snapshot_qty)
      SELECT gen_random_uuid(), $1, $2, x.variant_id, x.lot_id, x.qty FROM (
        SELECT q.variant_id, q.lot_id, sum(q.qty_on_hand) AS qty FROM inv_stock_quant q JOIN cat_variant v ON v.id = q.variant_id JOIN cat_product p ON p.id = v.product_id
         WHERE q.location_id = $3 AND q.owner_id = '00000000-0000-0000-0000-000000000000' AND ($4::uuid IS NULL OR p.category_id IN (SELECT id FROM cat_category WHERE $4 = ANY(path)))
           AND ($5::uuid[] IS NULL OR q.variant_id = ANY($5)) AND (q.qty_on_hand <> 0 OR $5::uuid[] IS NOT NULL)
         GROUP BY 1, 2
        UNION ALL SELECT vid, '00000000-0000-0000-0000-000000000000'::uuid, 0 FROM unnest(coalesce($5::uuid[], '{}')) vid
         WHERE NOT EXISTS (SELECT 1 FROM inv_stock_quant q2 WHERE q2.location_id = $3 AND q2.variant_id = vid)) x
      ON CONFLICT DO NOTHING`, [actor.tenantId, id, l.id, body.categoryId ?? null, body.variantIds ?? null]);
    reply.code(201);
    return { id, number, lines: r.rowCount };
  });
  route(app, 'GET', '/api/v1/stock-counts/:id', { perm: 'inventory.stock.read' }, async ({ tx, actor, companyId, params }) => {
    const c = (await tx.query('SELECT * FROM inv_stock_count WHERE id = $1 AND company_id = $2', [params.id, companyId])).rows[0];
    if (!c) throw notFound('COUNT');
    const blind = c.kind === 'blind' && !can(actor, 'inventory.count.approve', { companyId, branchId: c.branch_id });
    c.lines = (await tx.query(`SELECT l.id, l.variant_id, v.sku, p.name_ar, p.name_en, l.lot_id, CASE WHEN $2 THEN NULL ELSE l.snapshot_qty END AS snapshot_qty, l.counted_qty, l.counted_at
      FROM inv_stock_count_line l JOIN cat_variant v ON v.id = l.variant_id JOIN cat_product p ON p.id = v.product_id WHERE l.count_id = $1 ORDER BY v.sku`, [params.id, blind])).rows;
    return c;
  });
  route(app, 'POST', '/api/v1/stock-counts/:id/entries', {
    body: z.object({ entries: z.array(z.object({ variantId: uuid, countedQty: decimalStr.refine((s) => Number(s) >= 0, 'NEGATIVE_COUNT'), mode: z.enum(['set', 'add']).default('set') })).min(1).max(5000) }),
    idempotent: true,
  }, async ({ tx, actor, companyId, params, body }) => {
    const c = (await tx.query(`SELECT * FROM inv_stock_count WHERE id = $1 AND company_id = $2 FOR UPDATE`, [params.id, companyId])).rows[0];
    if (!c) throw notFound('COUNT');
    if (c.state !== 'counting') throw new AppError('INVALID_STATE', 409);
    requirePerm(actor, 'inventory.count.write', { companyId, branchId: c.branch_id, warehouseId: c.warehouse_id, warehouseBranchId: c.branch_id });
    for (const e of body.entries) {
      const r = await tx.query(`UPDATE inv_stock_count_line SET counted_qty = CASE WHEN $4 = 'add' THEN coalesce(counted_qty, 0) + $3 ELSE $3 END, counted_by = $5, counted_at = now()
                                WHERE count_id = $1 AND variant_id = $2 AND lot_id = '00000000-0000-0000-0000-000000000000'`, [c.id, e.variantId, e.countedQty, e.mode, actor.userId]);
      if (!r.rowCount) await tx.query(`INSERT INTO inv_stock_count_line (id, tenant_id, count_id, variant_id, snapshot_qty, counted_qty, counted_by, counted_at)
                                       VALUES ($1,$2,$3,$4, coalesce((SELECT sum(qty_on_hand) FROM inv_stock_quant WHERE location_id = $5 AND variant_id = $4 AND owner_id = '00000000-0000-0000-0000-000000000000'), 0), $6, $7, now())`,
        [uuidv7(), actor.tenantId, c.id, e.variantId, c.location_id, e.countedQty, actor.userId]);
    }
    return { ok: true, updated: body.entries.length };
  });
  route(app, 'POST', '/api/v1/stock-counts/:id/post', { body: z.object({ uncountedAsZero: z.boolean().default(false) }) }, async ({ tx, actor, companyId, params, body }) => {
    const c = (await tx.query(`SELECT * FROM inv_stock_count WHERE id = $1 AND company_id = $2 FOR UPDATE`, [params.id, companyId])).rows[0];
    if (!c) throw notFound('COUNT');
    if (c.state !== 'counting' && c.state !== 'review') throw new AppError('INVALID_STATE', 409);
    requirePerm(actor, 'inventory.count.approve', { companyId, branchId: c.branch_id });
    if (c.created_by === actor.userId && !actor.isOwner) {
      // counter cannot approve own count variances (SoD)
      const hasCounts = (await tx.query('SELECT 1 FROM inv_stock_count_line WHERE count_id = $1 AND counted_by = $2 LIMIT 1', [c.id, actor.userId])).rowCount;
      if (hasCounts) throw new AppError('SELF_APPROVAL_FORBIDDEN', 403, 'Counter cannot post own count');
    }
    // expected at close = snapshot + net moves into the location since snapshot (excluding this count)
    const lines = (await tx.query(`SELECT l.*, coalesce((SELECT sum(CASE WHEN m.to_location_id = $2 THEN m.qty_stock_uom ELSE -m.qty_stock_uom END) FROM inv_stock_move m
         WHERE m.variant_id = l.variant_id AND (m.to_location_id = $2 OR m.from_location_id = $2) AND m.moved_at >= $3 AND coalesce(m.lot_id, '00000000-0000-0000-0000-000000000000') = l.lot_id), 0) AS since
       FROM inv_stock_count_line l WHERE l.count_id = $1`, [c.id, c.location_id, c.snapshot_at])).rows;
    const lossLoc = await virtualLoc(tx, companyId, 'inventory_loss');
    const reason = (await tx.query(`SELECT id FROM inv_reason_code WHERE code = 'COUNT'`)).rows[0]?.id ?? null;
    const moves: MoveInput[] = [];
    const variances: { variantId: string; expected: string; counted: string; diff: string }[] = [];
    for (const l of lines) {
      if (l.counted_qty === null && !body.uncountedAsZero) continue;
      const expected = dec(l.snapshot_qty).add(dec(l.since));
      const diff = dec(l.counted_qty ?? 0).sub(expected);
      if (diff.isZero()) continue;
      variances.push({ variantId: l.variant_id, expected: fmt(expected, 6), counted: fmt(l.counted_qty ?? 0, 6), diff: fmt(diff, 6) });
      const lotId = l.lot_id === '00000000-0000-0000-0000-000000000000' ? null : l.lot_id;
      moves.push(diff.gt(0)
        ? { variantId: l.variant_id, fromLocationId: lossLoc, toLocationId: c.location_id, qty: fmt(diff, 6), lotId, moveType: 'count_gain', reasonCodeId: reason, refLineId: l.id }
        : { variantId: l.variant_id, fromLocationId: c.location_id, toLocationId: lossLoc, qty: fmt(diff.neg(), 6), lotId, moveType: 'count_loss', reasonCodeId: reason, refLineId: l.id });
    }
    const res = await postMoves(tx, { tenantId: actor.tenantId, companyId, branchId: c.branch_id, refDocType: 'stock_count', refDocId: c.id, userId: actor.userId, moves, negativePolicy: 'allow_with_exception', approved: true });
    await tx.query(`UPDATE inv_stock_count SET state = 'posted' WHERE id = $1`, [c.id]);
    await emitInventoryValued(tx, { tenantId: actor.tenantId, companyId, branchId: c.branch_id, docType: 'stock_count', docId: c.id, date: new Date().toISOString().slice(0, 10), userId: actor.userId, memo: c.number, moves: res.moves });
    return { id: c.id, state: 'posted', variances, value: fmt(res.moves.reduce<Dec>((s, m) => s.add(m.valuation === 'in' ? m.value : m.value.neg()), ZERO), 2) };
  });

  route(app, 'GET', '/api/v1/inventory/negative-exceptions', { perm: 'inventory.stock.read', query: z.object({ status: z.enum(['open', 'resolved']).default('open') }) }, async ({ tx, companyId, query }) =>
    (await tx.query(`SELECT e.*, v.sku, p.name_ar, l.code AS location_code FROM inv_negative_exception e JOIN cat_variant v ON v.id = e.variant_id JOIN cat_product p ON p.id = v.product_id JOIN inv_location l ON l.id = e.location_id
                     WHERE e.company_id = $1 AND e.status = $2 ORDER BY e.created_at DESC LIMIT 500`, [companyId, query.status])).rows);
  route(app, 'POST', '/api/v1/inventory/negative-exceptions/:id/resolve', { body: z.object({ resolution: z.string().min(3) }) }, async ({ tx, actor, companyId, params, body }) => {
    const e = (await tx.query('SELECT * FROM inv_negative_exception WHERE id = $1 AND company_id = $2', [params.id, companyId])).rows[0];
    if (!e) throw notFound('EXCEPTION');
    requirePerm(actor, 'inventory.adjustment.approve', { companyId, branchId: e.branch_id });
    await tx.query(`UPDATE inv_negative_exception SET status = 'resolved', resolved_by = $2, resolved_at = now(), resolution = $3 WHERE id = $1`, [e.id, actor.userId, body.resolution]);
    return { ok: true };
  });
}

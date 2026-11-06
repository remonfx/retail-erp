/**
 * Inventory engine — the ONLY code path that changes stock (INVENTORY_RULES.md).
 * One call = one atomic batch of immutable moves for a single source document:
 *   locks cost rows + quants in deterministic order → values each move (average/FIFO) →
 *   checks negative stock policy → writes moves, layers, quants, cost state.
 */
import { uuidv7, dec, D, ZERO, NIL_UUID, avgReceive, avgIssue, fifoConsume, fmt, type AvgState, type Dec } from '@rc/domain';
import type { Tx } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';

export type MoveType = 'receipt' | 'purchase_return' | 'sale' | 'sale_return' | 'transfer_out' | 'transfer_in' | 'internal'
  | 'adjustment_gain' | 'adjustment_loss' | 'scrap' | 'count_gain' | 'count_loss' | 'opening';

export interface MoveInput {
  variantId: string;
  fromLocationId: string;
  toLocationId: string;
  qty: string;                  // in stock UoM
  uomId?: string;               // UoM of the document line (defaults to stock UoM)
  qtyInUom?: string;
  lotId?: string | null;
  serialNo?: string | null;
  ownerId?: string | null;      // consignment owner (supplier) — not valued
  moveType: MoveType;
  reasonCodeId?: string | null;
  refLineId?: string | null;
  unitCost?: string | null;     // required for valued receipts (supplier/customer → stock) unless current cost applies
  reversalOfId?: string | null;
}

export interface PostMovesInput {
  tenantId: string; companyId: string; branchId: string;
  refDocType: string; refDocId: string;
  userId: string; deviceId?: string | null;
  movedAt?: Date;
  moves: MoveInput[];
  negativePolicy: 'block' | 'allow_with_exception';
  approved?: boolean;
}

export interface PostedMove {
  id: string; variantId: string; moveType: MoveType; qty: Dec; unitCost: Dec; value: Dec; cogsAdjustment: Dec;
  valuation: 'in' | 'out' | 'none'; fromLocationId: string; toLocationId: string; fromType: string; toType: string; fromBranchId: string | null; toBranchId: string | null;
  reasonCodeId: string | null; categoryId: string;
}
export interface PostMovesResult { moves: PostedMove[]; negativeExceptions: { locationId: string; variantId: string; qtyAfter: string }[] }

const PHYSICAL_VALUED = new Set(['internal', 'transit', 'quarantine']);
const PHYSICAL = new Set(['internal', 'transit', 'quarantine', 'scrap']);
const qkey = (loc: string, v: string, lot: string, owner: string) => `${loc}|${v}|${lot}|${owner}`;

export async function postMoves(tx: Tx, input: PostMovesInput): Promise<PostMovesResult> {
  if (!input.moves.length) return { moves: [], negativeExceptions: [] };
  const movedAt = input.movedAt ?? new Date();
  const company = (await tx.query(`SELECT costing_method FROM core_company WHERE id = $1`, [input.companyId])).rows[0];
  if (!company) throw new AppError('COMPANY_NOT_FOUND', 404);
  const fifo = company.costing_method === 'fifo';

  // ---- locations & variants ----
  const locIds = [...new Set(input.moves.flatMap((m) => [m.fromLocationId, m.toLocationId]))];
  const locs = new Map((await tx.query(`SELECT id, type, company_id, branch_id FROM inv_location WHERE id = ANY($1::uuid[])`, [locIds])).rows.map((r) => [r.id as string, r]));
  for (const id of locIds) {
    const l = locs.get(id);
    if (!l) throw new AppError('LOCATION_NOT_FOUND', 422, id);
    if (l.company_id !== input.companyId) throw new AppError('LOCATION_COMPANY_MISMATCH', 422, id);
  }
  const variantIds = [...new Set(input.moves.map((m) => m.variantId))].sort();
  const variants = new Map((await tx.query(
    `SELECT v.id, v.status, p.tracking, p.is_stockable, p.stock_uom_id, p.category_id FROM cat_variant v JOIN cat_product p ON p.id = v.product_id WHERE v.id = ANY($1::uuid[])`, [variantIds])).rows.map((r) => [r.id as string, r]));
  for (const m of input.moves) {
    const v = variants.get(m.variantId);
    if (!v) throw new AppError('VARIANT_NOT_FOUND', 422, m.variantId);
    if (!v.is_stockable) throw new AppError('VARIANT_NOT_STOCKABLE', 422, m.variantId);
    if (dec(m.qty).lte(0)) throw new AppError('MOVE_QTY_NOT_POSITIVE', 422);
    if (m.fromLocationId === m.toLocationId) throw new AppError('MOVE_SAME_LOCATION', 422);
    const ft = locs.get(m.fromLocationId)!.type, tt = locs.get(m.toLocationId)!.type;
    if (!PHYSICAL.has(ft) && !PHYSICAL.has(tt)) throw new AppError('MOVE_VIRTUAL_TO_VIRTUAL', 422);
    if (v.tracking === 'serial') {
      if (!m.serialNo) throw new AppError('SERIAL_REQUIRED', 422, m.variantId);
      if (!dec(m.qty).eq(1)) throw new AppError('SERIAL_QTY_MUST_BE_ONE', 422);
    }
  }

  // ---- lock cost state (sorted) ----
  const costRows = new Map<string, AvgState>();
  await tx.query(`INSERT INTO inv_product_cost (tenant_id, company_id, variant_id) SELECT $1, $2, unnest($3::uuid[]) ON CONFLICT DO NOTHING`, [input.tenantId, input.companyId, variantIds]);
  for (const r of (await tx.query(`SELECT variant_id, qty, value, last_avg FROM inv_product_cost WHERE company_id = $1 AND variant_id = ANY($2::uuid[]) ORDER BY variant_id FOR UPDATE`, [input.companyId, variantIds])).rows) {
    costRows.set(r.variant_id, { qty: dec(r.qty), value: dec(r.value), lastAvg: dec(r.last_avg) });
  }
  const costBefore = new Map([...costRows].map(([k, v]) => [k, { ...v }]));

  // ---- lock quants (sorted) ----
  const keys = new Map<string, { loc: string; v: string; lot: string; owner: string }>();
  for (const m of input.moves) {
    const lot = m.lotId ?? NIL_UUID, owner = m.ownerId ?? NIL_UUID;
    for (const loc of [m.fromLocationId, m.toLocationId]) keys.set(qkey(loc, m.variantId, lot, owner), { loc, v: m.variantId, lot, owner });
  }
  const sorted = [...keys.values()].sort((a, b) => (a.loc + a.v + a.lot + a.owner).localeCompare(b.loc + b.v + b.lot + b.owner));
  await tx.query(`INSERT INTO inv_stock_quant (tenant_id, company_id, location_id, variant_id, lot_id, owner_id)
                  SELECT $1, $2, x.l, x.v, x.lot, x.o FROM unnest($3::uuid[], $4::uuid[], $5::uuid[], $6::uuid[]) AS x(l, v, lot, o) ON CONFLICT DO NOTHING`,
    [input.tenantId, input.companyId, sorted.map((k) => k.loc), sorted.map((k) => k.v), sorted.map((k) => k.lot), sorted.map((k) => k.owner)]);
  const quants = new Map<string, Dec>();
  const quantRows = (await tx.query(`SELECT q.location_id, q.variant_id, q.lot_id, q.owner_id, q.qty_on_hand FROM inv_stock_quant q
      JOIN unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[]) AS x(l, v, lot, o) ON q.location_id = x.l AND q.variant_id = x.v AND q.lot_id = x.lot AND q.owner_id = x.o
      ORDER BY q.location_id, q.variant_id, q.lot_id, q.owner_id FOR UPDATE OF q`,
    [sorted.map((k) => k.loc), sorted.map((k) => k.v), sorted.map((k) => k.lot), sorted.map((k) => k.owner)])).rows;
  for (const r of quantRows) quants.set(qkey(r.location_id, r.variant_id, r.lot_id, r.owner_id), dec(r.qty_on_hand));

  // ---- FIFO layers (locked lazily per variant) ----
  const fifoLayers = new Map<string, { id: string; remainingQty: Dec; remainingValue: Dec }[]>();
  async function layersFor(variantId: string) {
    if (!fifoLayers.has(variantId)) {
      const rows = (await tx.query(`SELECT id, remaining_qty, remaining_value FROM inv_valuation_layer WHERE company_id = $1 AND variant_id = $2 AND remaining_qty > 0 ORDER BY created_at, id FOR UPDATE`, [input.companyId, variantId])).rows;
      fifoLayers.set(variantId, rows.map((r) => ({ id: r.id, remainingQty: dec(r.remaining_qty), remainingValue: dec(r.remaining_value) })));
    }
    return fifoLayers.get(variantId)!;
  }

  const moveRows: Record<string, unknown>[] = [];
  const layerRows: Record<string, unknown>[] = [];
  const consumptionRows: Record<string, unknown>[] = [];
  const layerUpdates = new Map<string, { remainingQty: Dec; remainingValue: Dec }>();
  const posted: PostedMove[] = [];
  const serialOps: { variantId: string; serialNo: string; dir: 'in' | 'out'; locationId: string; moveType: MoveType }[] = [];

  for (const m of input.moves) {
    const v = variants.get(m.variantId)!;
    const q = dec(m.qty);
    const from = locs.get(m.fromLocationId)!, to = locs.get(m.toLocationId)!;
    const owned = !m.ownerId || m.ownerId === NIL_UUID;
    const fromValued = PHYSICAL_VALUED.has(from.type), toValued = PHYSICAL_VALUED.has(to.type);
    const valuation: PostedMove['valuation'] = !owned || fromValued === toValued ? 'none' : toValued ? 'in' : 'out';
    const st = costRows.get(m.variantId)!;
    const id = uuidv7();
    let unitCost = ZERO, value = ZERO, cogsAdj = ZERO;

    if (valuation === 'in') {
      const explicit = m.unitCost !== undefined && m.unitCost !== null;
      const uc = explicit ? dec(m.unitCost!) : (st.qty.gt(0) ? st.value.div(st.qty) : st.lastAvg);
      if (uc.lt(0)) throw new AppError('NEGATIVE_UNIT_COST', 422);
      const r = avgReceive(st, q, uc);
      costRows.set(m.variantId, r.state);
      unitCost = uc; value = r.value; cogsAdj = r.cogsAdjustment;
      // FIFO: units that only cover previously-negative stock are already consumed
      const remQty = st.qty.lt(0) ? D.max(st.qty.add(q), ZERO) : q;
      const remValue = remQty.eq(q) ? value : remQty.mul(uc).toDecimalPlaces(4);
      layerRows.push({ id: uuidv7(), tenant_id: input.tenantId, company_id: input.companyId, variant_id: m.variantId, stock_move_id: id, moved_at: movedAt.toISOString(),
        qty: fmt(q, 6), unit_cost: fmt(uc, 6), value: fmt(value, 4), remaining_qty: fifo ? fmt(remQty, 6) : '0', remaining_value: fifo ? fmt(remValue, 4) : '0', cogs_adjustment: fmt(cogsAdj, 4), created_at: new Date().toISOString() });
      if (fifo && remQty.gt(0)) (await layersFor(m.variantId)).push({ id: layerRows[layerRows.length - 1]!.id as string, remainingQty: remQty, remainingValue: remValue });
    } else if (valuation === 'out') {
      if (fifo) {
        const layers = await layersFor(m.variantId);
        const r = fifoConsume(layers, q, st.lastAvg);
        for (const c of r.consumed) {
          const l = layers.find((x) => x.id === c.layerId)!;
          l.remainingQty = l.remainingQty.sub(c.qty); l.remainingValue = l.remainingValue.sub(c.value);
          layerUpdates.set(l.id, { remainingQty: l.remainingQty, remainingValue: l.remainingValue });
          consumptionRows.push({ tenant_id: input.tenantId, layer_id: c.layerId, stock_move_id: id, qty: fmt(c.qty, 6), value: fmt(c.value, 4) });
        }
        value = r.value;
        const newQty = st.qty.sub(q);
        costRows.set(m.variantId, { qty: newQty, value: st.value.sub(value), lastAvg: q.gt(0) ? value.div(q) : st.lastAvg });
      } else {
        const r = avgIssue(st, q);
        costRows.set(m.variantId, r.state);
        value = r.value;
      }
      unitCost = q.gt(0) ? value.div(q) : ZERO;
      layerRows.push({ id: uuidv7(), tenant_id: input.tenantId, company_id: input.companyId, variant_id: m.variantId, stock_move_id: id, moved_at: movedAt.toISOString(),
        qty: fmt(q.neg(), 6), unit_cost: fmt(unitCost, 6), value: fmt(value.neg(), 4), remaining_qty: '0', remaining_value: '0', cogs_adjustment: '0', created_at: new Date().toISOString() });
    } else {
      // internal / transfer / consignment: informational cost only
      unitCost = st.qty.gt(0) ? st.value.div(st.qty) : st.lastAvg;
      value = owned ? q.mul(unitCost).toDecimalPlaces(4) : ZERO;
    }

    const lot = m.lotId ?? NIL_UUID, owner = m.ownerId ?? NIL_UUID;
    const fk = qkey(m.fromLocationId, m.variantId, lot, owner), tk = qkey(m.toLocationId, m.variantId, lot, owner);
    quants.set(fk, quants.get(fk)!.sub(q));
    quants.set(tk, quants.get(tk)!.add(q));
    if (v.tracking === 'serial' && m.serialNo) {
      if (PHYSICAL.has(to.type)) serialOps.push({ variantId: m.variantId, serialNo: m.serialNo, dir: 'in', locationId: m.toLocationId, moveType: m.moveType });
      if (PHYSICAL.has(from.type)) serialOps.push({ variantId: m.variantId, serialNo: m.serialNo, dir: 'out', locationId: m.fromLocationId, moveType: m.moveType });
    }

    moveRows.push({
      id, moved_at: movedAt.toISOString(), tenant_id: input.tenantId, company_id: input.companyId, branch_id: input.branchId,
      variant_id: m.variantId, from_location_id: m.fromLocationId, to_location_id: m.toLocationId,
      lot_id: m.lotId ?? null, serial_no: m.serialNo ?? null, owner_id: owned ? null : m.ownerId,
      qty: fmt(m.qtyInUom ?? q, 6), uom_id: m.uomId ?? v.stock_uom_id, qty_stock_uom: fmt(q, 6),
      unit_cost: fmt(unitCost, 6), value: fmt(value, 4), move_type: m.moveType, reason_code_id: m.reasonCodeId ?? null,
      ref_doc_type: input.refDocType, ref_doc_id: input.refDocId, ref_line_id: m.refLineId ?? null,
      approval_state: input.approved ? 'approved' : 'not_required', user_id: input.userId, device_id: input.deviceId ?? null,
      reversal_of_id: m.reversalOfId ?? null, negative_exception: false, created_at: new Date().toISOString(),
    });
    posted.push({ id, variantId: m.variantId, moveType: m.moveType, qty: q, unitCost, value, cogsAdjustment: cogsAdj, valuation,
      fromLocationId: m.fromLocationId, toLocationId: m.toLocationId, fromType: from.type, toType: to.type, fromBranchId: from.branch_id, toBranchId: to.branch_id, reasonCodeId: m.reasonCodeId ?? null, categoryId: v.category_id });
  }

  // ---- negative stock policy ----
  const negativeExceptions: PostMovesResult['negativeExceptions'] = [];
  for (const [k, qty] of quants) {
    const [loc, variantId] = k.split('|') as [string, string];
    if (!PHYSICAL.has(locs.get(loc)!.type) || qty.gte(0)) continue;
    const v = variants.get(variantId)!;
    if (input.negativePolicy === 'block' || v.tracking === 'serial') {
      throw new AppError('INSUFFICIENT_STOCK', 409, `Insufficient stock for variant ${variantId} at location ${loc}`, { variantId, locationId: loc, shortBy: fmt(qty.neg(), 6) });
    }
    negativeExceptions.push({ locationId: loc, variantId, qtyAfter: fmt(qty, 6) });
    const mv = moveRows.find((r) => r.variant_id === variantId && r.from_location_id === loc);
    if (mv) mv.negative_exception = true;
  }

  // ---- serials ----
  for (const s of serialOps) {
    if (s.dir === 'out') {
      const r = await tx.query(`UPDATE inv_serial SET status = $4, location_id = NULL WHERE variant_id = $1 AND serial_no = $2 AND status IN ('in_stock','in_transit') AND (location_id = $3 OR status = 'in_transit') RETURNING id`,
        [s.variantId, s.serialNo, s.locationId, s.moveType === 'sale' ? 'sold' : s.moveType === 'scrap' ? 'scrapped' : s.moveType === 'transfer_out' ? 'in_transit' : 'returned']);
      if (!r.rowCount) throw new AppError('SERIAL_NOT_IN_STOCK', 409, `Serial ${s.serialNo} not in stock at source`);
    }
  }
  for (const s of serialOps) {
    if (s.dir === 'in') {
      const status = locs.get(s.locationId)!.type === 'transit' ? 'in_transit' : 'in_stock';
      const r = await tx.query(`INSERT INTO inv_serial (id, tenant_id, variant_id, serial_no, status, location_id) VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (variant_id, serial_no) DO UPDATE SET status = EXCLUDED.status, location_id = EXCLUDED.location_id
          WHERE inv_serial.status NOT IN ('in_stock') OR inv_serial.location_id IS NULL RETURNING id`, [uuidv7(), input.tenantId, s.variantId, s.serialNo, status, s.locationId]);
      if (!r.rowCount) throw new AppError('DUPLICATE_SERIAL', 409, `Serial ${s.serialNo} already in stock`);
    }
  }

  // ---- persist ----
  await tx.query(`INSERT INTO inv_stock_move SELECT * FROM json_populate_recordset(NULL::inv_stock_move, $1::json)`, [JSON.stringify(moveRows)]);
  if (layerRows.length) await tx.query(`INSERT INTO inv_valuation_layer SELECT * FROM json_populate_recordset(NULL::inv_valuation_layer, $1::json)`, [JSON.stringify(layerRows)]);
  if (consumptionRows.length) {
    // merge duplicate (layer, move) pairs
    const merged = new Map<string, Record<string, unknown>>();
    for (const c of consumptionRows) {
      const k = `${c.layer_id}|${c.stock_move_id}`;
      const prev = merged.get(k);
      if (prev) { prev.qty = fmt(dec(prev.qty as string).add(dec(c.qty as string)), 6); prev.value = fmt(dec(prev.value as string).add(dec(c.value as string)), 4); } else merged.set(k, { ...c });
    }
    await tx.query(`INSERT INTO inv_valuation_consumption SELECT * FROM json_populate_recordset(NULL::inv_valuation_consumption, $1::json)`, [JSON.stringify([...merged.values()])]);
  }
  for (const [id, u] of layerUpdates) await tx.query(`UPDATE inv_valuation_layer SET remaining_qty = $2, remaining_value = $3 WHERE id = $1`, [id, fmt(u.remainingQty, 6), fmt(u.remainingValue, 4)]);
  const qk = [...quants.entries()];
  await tx.query(`UPDATE inv_stock_quant q SET qty_on_hand = x.qty, updated_at = now() FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::numeric[]) AS x(l, v, lot, o, qty)
                  WHERE q.location_id = x.l AND q.variant_id = x.v AND q.lot_id = x.lot AND q.owner_id = x.o`,
    [qk.map(([k]) => k.split('|')[0]), qk.map(([k]) => k.split('|')[1]), qk.map(([k]) => k.split('|')[2]), qk.map(([k]) => k.split('|')[3]), qk.map(([, v]) => fmt(v, 6))]);
  const changed = [...costRows].filter(([k, s]) => { const b = costBefore.get(k)!; return !b.qty.eq(s.qty) || !b.value.eq(s.value) || !b.lastAvg.eq(s.lastAvg); });
  if (changed.length) {
    await tx.query(`UPDATE inv_product_cost c SET qty = x.qty, value = x.value, last_avg = x.avg, updated_at = now() FROM unnest($2::uuid[], $3::numeric[], $4::numeric[], $5::numeric[]) AS x(v, qty, value, avg)
                    WHERE c.company_id = $1 AND c.variant_id = x.v`,
      [input.companyId, changed.map(([k]) => k), changed.map(([, s]) => fmt(s.qty, 6)), changed.map(([, s]) => fmt(s.value, 4)), changed.map(([, s]) => fmt(s.lastAvg, 6))]);
    await tx.query(`UPDATE core_company SET costing_locked = true WHERE id = $1 AND NOT costing_locked`, [input.companyId]);
  }
  for (const e of negativeExceptions) {
    await tx.query(`INSERT INTO inv_negative_exception (id, tenant_id, company_id, branch_id, location_id, variant_id, qty_after, source_type, source_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [uuidv7(), input.tenantId, input.companyId, input.branchId, e.locationId, e.variantId, e.qtyAfter, input.refDocType, input.refDocId]);
  }
  return { moves: posted, negativeExceptions };
}

/** Current avg (or FIFO-equivalent) unit cost for valuing estimates/approvals. */
export async function currentUnitCost(tx: Tx, companyId: string, variantId: string): Promise<Dec> {
  const r = (await tx.query('SELECT qty, value, last_avg FROM inv_product_cost WHERE company_id = $1 AND variant_id = $2', [companyId, variantId])).rows[0];
  if (!r) return ZERO;
  return dec(r.qty).gt(0) ? dec(r.value).div(dec(r.qty)) : dec(r.last_avg);
}

export async function ensureLot(tx: Tx, tenantId: string, variantId: string, lotNo: string, expiry?: string | null): Promise<string> {
  const r = await tx.query(`INSERT INTO inv_lot (id, tenant_id, variant_id, lot_no, expiry_date) VALUES ($1,$2,$3,$4,$5)
                            ON CONFLICT (variant_id, lot_no) DO UPDATE SET expiry_date = coalesce(inv_lot.expiry_date, EXCLUDED.expiry_date) RETURNING id`, [uuidv7(), tenantId, variantId, lotNo, expiry ?? null]);
  return r.rows[0].id;
}

export function sumValue(moves: PostedMove[], pred: (m: PostedMove) => boolean): Dec {
  return moves.filter(pred).reduce<Dec>((s, m) => s.add(m.value), ZERO);
}
export { D };

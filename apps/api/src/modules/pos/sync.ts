/**
 * POS synchronization (ARCHITECTURE.md §6). Exactly-once application of device transactions:
 *  - pos_sync_inbox(client_id PK) is the global idempotency registry;
 *  - same id + same payload hash  → duplicate_ack (safe replay);
 *  - same id + different hash      → quarantined conflict (never applied twice);
 *  - business validation failures  → quarantined with full payload (never discarded);
 *  - transient/unexpected errors   → rejected_retry (device keeps the item and retries).
 */
import { createHash } from 'node:crypto';
import { uuidv7, dec, fmt, ZERO, sum, computeCart, stableStringify, OFFLINE_ALLOWED_TENDERS, type SyncItem, type SyncItemResult, type PosTransactionPayload, type TaxRate } from '@rc/domain';
import { withTx, type Tx } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { emit } from '../../lib/http.js';
import { postMoves, type MoveInput } from '../inventory/engine.js';
import { activePromotions } from '../pricing/routes.js';
import type { Actor } from '../../lib/actor.js';

class Quarantine extends Error { constructor(public code: string, msg?: string) { super(msg ?? code); } }

export const payloadHash = (item: SyncItem) => createHash('sha256').update(stableStringify({ type: item.type, payload: item.payload })).digest('hex');

interface Terminal { id: string; company_id: string; branch_id: string; stock_location_id: string; code: string; settings: Record<string, unknown> }

async function terminalForDevice(tx: Tx, deviceId: string): Promise<Terminal> {
  const t = (await tx.query('SELECT * FROM pos_terminal WHERE device_id = $1 AND active', [deviceId])).rows[0];
  if (!t) throw new AppError('DEVICE_HAS_NO_TERMINAL', 409);
  return t;
}

export async function applySyncBatch(actor: Actor, items: SyncItem[]): Promise<SyncItemResult[]> {
  const results: SyncItemResult[] = [];
  const ctx = { tenantId: actor.tenantId, companyIds: [actor.deviceCompanyId!], deviceId: actor.deviceId!, requestId: actor.requestId };
  // seq order per device; stop at first retryable failure to preserve ordering (session open → sales → close)
  const sorted = [...items].sort((a, b) => a.seq - b.seq);
  let blocked = false;
  for (const item of sorted) {
    if (blocked) { results.push({ id: item.id, status: 'rejected_retry', error: 'BLOCKED_BY_EARLIER_ITEM' }); continue; }
    const hash = payloadHash(item);
    try {
      const r = await withTx(ctx, async (tx) => {
        const ins = await tx.query(`INSERT INTO pos_sync_inbox (client_id, tenant_id, device_id, item_type, device_seq, payload_hash, status) VALUES ($1,$2,$3,$4,$5,$6,'applied')
                                    ON CONFLICT DO NOTHING RETURNING client_id`, [item.id, actor.tenantId, actor.deviceId, item.type, item.seq, hash]);
        if (!ins.rowCount) {
          const prev = (await tx.query('SELECT payload_hash, status, server_ref, device_id, device_seq FROM pos_sync_inbox WHERE client_id = $1', [item.id])).rows[0];
          if (!prev) {
            // conflict on (device_id, device_seq) with a different client id: device sequence reuse
            const bySeq = (await tx.query('SELECT client_id FROM pos_sync_inbox WHERE device_id = $1 AND device_seq = $2', [actor.deviceId, item.seq])).rows[0];
            throw new Quarantine('DEVICE_SEQ_REUSED', `seq ${item.seq} already used by ${bySeq?.client_id}`);
          }
          if (prev.payload_hash !== hash) return { id: item.id, status: 'quarantined' as const, error: 'PAYLOAD_HASH_MISMATCH', serverRef: prev.server_ref ?? undefined };
          return { id: item.id, status: prev.status === 'applied' ? 'duplicate_ack' as const : 'quarantined' as const, serverRef: prev.server_ref ?? undefined };
        }
        const terminal = await terminalForDevice(tx, actor.deviceId!);
        const out = await applyItem(tx, actor, terminal, item);
        await tx.query('UPDATE pos_sync_inbox SET server_ref = $2, exceptions = $3 WHERE client_id = $1', [item.id, out.serverRef, out.exceptions.length ? out.exceptions : null]);
        return { id: item.id, status: 'applied' as const, serverRef: out.serverRef, exceptions: out.exceptions };
      });
      results.push(r);
    } catch (e) {
      if (e instanceof Quarantine || (e instanceof AppError && e.status < 500 && e.code !== 'RETRY')) {
        const code = e instanceof Quarantine ? e.code : (e as AppError).code;
        // record in its own transaction so the payload is never lost
        try {
          await withTx(ctx, (tx) => tx.query(`INSERT INTO pos_sync_inbox (client_id, tenant_id, device_id, item_type, device_seq, payload_hash, status, payload, error)
                                               VALUES ($1,$2,$3,$4,$5,$6,'quarantined',$7,$8) ON CONFLICT DO NOTHING`,
            [item.id, actor.tenantId, actor.deviceId, item.type, code === 'DEVICE_SEQ_REUSED' ? -Date.now() : item.seq, hash, JSON.stringify(item), `${code}: ${(e as Error).message}`.slice(0, 1000)]));
          results.push({ id: item.id, status: 'quarantined', error: code });
        } catch {
          results.push({ id: item.id, status: 'rejected_retry', error: code });
          blocked = true;
        }
      } else {
        results.push({ id: item.id, status: 'rejected_retry', error: (e as Error).message.slice(0, 200) });
        blocked = true;
      }
    }
  }
  await withTx(ctx, (tx) => tx.query('UPDATE core_device SET last_seen_at = now() WHERE id = $1', [actor.deviceId])).catch(() => undefined);
  return results;
}

async function applyItem(tx: Tx, actor: Actor, t: Terminal, item: SyncItem): Promise<{ serverRef: string; exceptions: string[] }> {
  switch (item.type) {
    case 'session_open': {
      const p = item.payload;
      if (p.terminalId !== t.id) throw new Quarantine('TERMINAL_MISMATCH');
      const open = (await tx.query(`SELECT id FROM pos_session WHERE terminal_id = $1 AND state = 'open'`, [t.id])).rows[0];
      if (open && open.id !== p.id) throw new Quarantine('SESSION_ALREADY_OPEN', `terminal has open session ${open.id}`);
      const number = `SES-${t.code}-${p.businessDate.replace(/-/g, '')}-${p.id.slice(-6)}`;
      await tx.query(`INSERT INTO pos_session (id, tenant_id, company_id, branch_id, terminal_id, number, business_date, opened_by, opened_at, opening_float) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [p.id, actor.tenantId, t.company_id, t.branch_id, t.id, number, p.businessDate, p.openedBy, p.openedAt, p.openingFloat]);
      return { serverRef: p.id, exceptions: [] };
    }
    case 'cash_movement': {
      const p = item.payload;
      const s = (await tx.query('SELECT state, terminal_id FROM pos_session WHERE id = $1', [p.sessionId])).rows[0];
      if (!s || s.terminal_id !== t.id) throw new Quarantine('SESSION_NOT_FOUND');
      if (s.state !== 'open') throw new Quarantine('SESSION_NOT_OPEN');
      await tx.query(`INSERT INTO pos_cash_movement (id, tenant_id, company_id, session_id, kind, amount, reason, user_id, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [p.id, actor.tenantId, t.company_id, p.sessionId, p.kind, p.amount, p.reason, p.userId, p.at]);
      return { serverRef: p.id, exceptions: [] };
    }
    case 'session_close': {
      const p = item.payload;
      const s = (await tx.query('SELECT * FROM pos_session WHERE id = $1 FOR UPDATE', [p.id])).rows[0];
      if (!s || s.terminal_id !== t.id) throw new Quarantine('SESSION_NOT_FOUND');
      if (s.state !== 'open') throw new Quarantine('SESSION_NOT_OPEN');
      const cash = (await tx.query(`SELECT coalesce(sum(amount), 0) AS c FROM pos_payment WHERE session_id = $1 AND method = 'cash'`, [s.id])).rows[0].c;
      const mv = (await tx.query(`SELECT coalesce(sum(CASE kind WHEN 'cash_in' THEN amount ELSE -amount END), 0) AS m FROM pos_cash_movement WHERE session_id = $1`, [s.id])).rows[0].m;
      const expected = dec(s.opening_float).add(dec(cash)).add(dec(mv));
      const diff = dec(p.countedCash).sub(expected);
      await tx.query(`UPDATE pos_session SET state = 'closed', closed_by = $2, closed_at = $3, expected_cash = $4, counted_cash = $5, cash_difference = $6, notes = $7 WHERE id = $1`,
        [s.id, p.closedBy, p.closedAt, fmt(expected, 4), p.countedCash, fmt(diff, 4), p.notes ?? null]);
      await emit(tx, { id: uuidv7(), tenantId: actor.tenantId, companyId: t.company_id, aggregateType: 'pos_session', aggregateId: s.id, type: 'pos.session_closed', payload: { sessionId: s.id } });
      return { serverRef: s.id, exceptions: diff.isZero() ? [] : [`CASH_DIFFERENCE:${fmt(diff, 2)}`] };
    }
    case 'pos_txn':
      return applyPosTransaction(tx, actor, t, item.payload);
  }
}

async function applyPosTransaction(tx: Tx, actor: Actor, t: Terminal, p: PosTransactionPayload): Promise<{ serverRef: string; exceptions: string[] }> {
  const exceptions: string[] = [];
  const s = (await tx.query('SELECT * FROM pos_session WHERE id = $1 FOR UPDATE', [p.sessionId])).rows[0];
  if (!s || s.terminal_id !== t.id) throw new Quarantine('SESSION_NOT_FOUND');
  if (s.state !== 'open') throw new Quarantine('SESSION_NOT_OPEN', 'transaction arrived after session close');
  const company = (await tx.query('SELECT prices_include_tax FROM core_company WHERE id = $1', [t.company_id])).rows[0];

  // ---- integrity of device totals ----
  const lineTotals = sum(p.lines.map((l) => l.total));
  if (!lineTotals.eq(dec(p.grandTotal))) throw new Quarantine('TOTALS_INCONSISTENT', `lines ${lineTotals} != grand ${p.grandTotal}`);
  const paid = sum(p.payments.map((x) => x.amount)).sub(dec(p.change));
  if (!paid.eq(dec(p.grandTotal).add(dec(p.rounding)))) throw new Quarantine('PAYMENTS_INCONSISTENT', `paid ${paid} != due ${dec(p.grandTotal).add(dec(p.rounding))}`);
  if (p.offline) for (const pay of p.payments) if (!(OFFLINE_ALLOWED_TENDERS as readonly string[]).includes(pay.method)) exceptions.push(`OFFLINE_TENDER_NOT_ALLOWED:${pay.method}`);

  // ---- master data ----
  const variantIds = [...new Set(p.lines.map((l) => l.variantId))];
  const vrows = (await tx.query(`SELECT v.id, p.category_id, p.brand_id, p.tax_class_id, p.is_weighted, c.path, p.blocked_for_sale FROM cat_variant v JOIN cat_product p ON p.id = v.product_id JOIN cat_category c ON c.id = p.category_id WHERE v.id = ANY($1::uuid[])`, [variantIds])).rows;
  if (vrows.length !== variantIds.length) throw new Quarantine('UNKNOWN_VARIANT');
  const vmap = new Map(vrows.map((r) => [r.id, r]));
  const taxByClass = new Map<string, TaxRate[]>();
  for (const r of (await tx.query(`SELECT cr.tax_class_id, r.id, r.code, r.rate, r.kind, r.sequence FROM tax_class_rate cr JOIN tax_rate r ON r.id = cr.tax_rate_id`)).rows) {
    const list = taxByClass.get(r.tax_class_id) ?? [];
    list.push({ id: r.id, code: r.code, rate: r.rate, kind: r.kind, sequence: r.sequence });
    taxByClass.set(r.tax_class_id, list);
  }

  // ---- server recompute (detect discrepancies; device receipt stands) ----
  const promos = await activePromotions(tx, t.company_id, t.branch_id, new Date(p.soldAt));
  const local = new Date(p.soldAt).toLocaleTimeString('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: false });
  let serverTotal = dec(p.grandTotal);
  const serverLines = new Map<string, { tax: ReturnType<typeof computeCart>['lines'][number] }>();
  try {
    const cart = computeCart({
      lines: p.lines.map((l) => {
        const v = vmap.get(l.variantId)!;
        return { lineId: l.lineId, variantId: l.variantId, qty: l.qty, unitPrice: l.unitPrice, priceIncludesTax: company.prices_include_tax, taxRates: taxByClass.get(v.tax_class_id) ?? [],
          categoryPath: v.path, brandId: v.brand_id, isWeighted: v.is_weighted, manualDiscountPercent: l.manualDiscountPercent, manualDiscountAmount: l.manualDiscountAmount };
      }),
      promotions: p.kind === 'sale' ? promos : [],
      context: { at: new Date(p.soldAt), localTime: local, couponCodes: p.couponCodes ?? [], customerGroupIds: [] },
      basketManualDiscountPercent: p.basketManualDiscountPercent, basketManualDiscountAmount: p.basketManualDiscountAmount,
    });
    serverTotal = cart.grandTotal;
    cart.lines.forEach((l) => serverLines.set(l.lineId, { tax: l }));
  } catch (e) { exceptions.push(`RECALC_FAILED:${(e as Error).message}`); }
  const delta = dec(p.grandTotal).sub(serverTotal);
  if (!delta.isZero()) {
    exceptions.push(`PRICING_DELTA:${fmt(delta, 2)}`);
    await tx.query(`INSERT INTO pos_pricing_discrepancy (id, tenant_id, company_id, branch_id, order_id, business_date, device_total, server_total, delta, details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [uuidv7(), actor.tenantId, t.company_id, t.branch_id, p.id, p.businessDate, p.grandTotal, fmt(serverTotal, 4), fmt(delta, 4), JSON.stringify({ engineVersion: p.engineVersion })]);
  }
  for (const v of vrows) if (v.blocked_for_sale && p.kind === 'sale') exceptions.push(`SOLD_BLOCKED_PRODUCT:${v.id}`);

  // ---- returns: validate against original ----
  let originalCosts = new Map<string, string>();
  if (p.kind === 'return') {
    if (p.returnOfId) {
      const orig = (await tx.query(`SELECT id, business_date FROM pos_order WHERE id = $1 AND kind = 'sale'`, [p.returnOfId])).rows[0];
      if (!orig) throw new Quarantine('ORIGINAL_SALE_NOT_FOUND');
      const olines = (await tx.query(`SELECT l.id, l.variant_id, l.qty, l.unit_cost, coalesce((SELECT sum(r.qty) FROM pos_order_line r WHERE r.return_of_line_id = l.id), 0) AS returned
                                       FROM pos_order_line l WHERE l.order_id = $1 AND l.business_date = $2`, [orig.id, orig.business_date])).rows;
      const om = new Map(olines.map((l) => [l.id, l]));
      for (const l of p.lines) {
        const o = l.returnOfLineId ? om.get(l.returnOfLineId) : undefined;
        if (!o || o.variant_id !== l.variantId) throw new Quarantine('RETURN_LINE_MISMATCH');
        if (dec(l.qty).add(dec(o.returned)).gt(dec(o.qty))) throw new Quarantine('RETURN_EXCEEDS_SOLD');
        originalCosts.set(l.lineId, o.unit_cost);
      }
    } else exceptions.push('RETURN_WITHOUT_RECEIPT');
  }

  // ---- stock moves (sale is a fact: negative stock → exception, never rejection) ----
  const customerLoc = (await tx.query(`SELECT id FROM inv_location WHERE company_id = $1 AND type = 'customer' AND warehouse_id IS NULL LIMIT 1`, [t.company_id])).rows[0].id;
  const moves: MoveInput[] = p.lines.map((l) => p.kind === 'sale'
    ? { variantId: l.variantId, fromLocationId: t.stock_location_id, toLocationId: customerLoc, qty: l.qty, uomId: l.uomId, lotId: l.lotId ?? null, serialNo: l.serialNo ?? null, moveType: 'sale' as const, refLineId: l.lineId }
    : { variantId: l.variantId, fromLocationId: customerLoc, toLocationId: t.stock_location_id, qty: l.qty, uomId: l.uomId, lotId: l.lotId ?? null, serialNo: l.serialNo ?? null, moveType: 'sale_return' as const, refLineId: l.lineId, unitCost: originalCosts.get(l.lineId) ?? null });
  let res;
  try {
    res = await postMoves(tx, { tenantId: actor.tenantId, companyId: t.company_id, branchId: t.branch_id, refDocType: 'pos_order', refDocId: p.id, userId: p.cashierId, deviceId: actor.deviceId, movedAt: new Date(p.soldAt), moves, negativePolicy: 'allow_with_exception' });
  } catch (e) {
    if (e instanceof AppError && ['SERIAL_NOT_IN_STOCK', 'DUPLICATE_SERIAL', 'INSUFFICIENT_STOCK'].includes(e.code)) throw new Quarantine(e.code, e.message);
    throw e;
  }
  if (res.negativeExceptions.length) exceptions.push(`NEGATIVE_STOCK:${res.negativeExceptions.length}`);
  const costByLine = new Map(res.moves.map((m, i) => [p.lines[i]!.lineId, m]));

  // ---- sub-ledger ----
  const net = sum(p.lines.map((l) => l.net)), tax = sum(p.lines.map((l) => l.tax));
  const costTotal = res.moves.reduce((s2, m) => s2.add(m.value), ZERO);
  await tx.query(`INSERT INTO pos_order (id, business_date, tenant_id, company_id, branch_id, terminal_id, session_id, receipt_no, kind, return_of_id, customer_id, cashier_id, sold_at,
                    subtotal, discount_total, net_total, tax_total, grand_total, rounding, cost_total, engine_version, server_recalc_delta, offline, eta_status)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'pending')`,
    [p.id, p.businessDate, actor.tenantId, t.company_id, t.branch_id, t.id, p.sessionId, p.receiptNo, p.kind, p.returnOfId ?? null, p.customerId ?? null, p.cashierId, p.soldAt,
     p.subtotal, p.discountTotal, fmt(net, 4), fmt(tax, 4), p.grandTotal, p.rounding, fmt(costTotal, 4), p.engineVersion, fmt(delta, 4), p.offline]);
  const lineRows = p.lines.map((l) => {
    const m = costByLine.get(l.lineId)!;
    const v = vmap.get(l.variantId)!;
    // device tax split per rate: use server split proportionally scaled to device tax
    const srv = serverLines.get(l.lineId)?.tax;
    const taxLines = srv && srv.tax.eq(dec(l.tax)) ? srv.taxLines.map((x) => ({ taxRateId: x.taxRateId, code: x.code, base: fmt(x.base, 4), amount: fmt(x.amount, 4) }))
      : (taxByClass.get(v.tax_class_id) ?? []).slice(0, 1).map((r) => ({ taxRateId: r.id, code: r.code, base: fmt(l.net, 4), amount: fmt(l.tax, 4) }));
    if (!taxLines.length && !dec(l.tax).isZero()) throw new Quarantine('TAX_WITHOUT_RATE');
    return { id: l.lineId, business_date: p.businessDate, order_id: p.id, tenant_id: actor.tenantId, company_id: t.company_id, branch_id: t.branch_id, variant_id: l.variantId, qty: l.qty, uom_id: l.uomId,
      unit_price: l.unitPrice, price_list_item_id: l.priceListItemId ?? null, discount_total: l.discountTotal, net: l.net, tax: l.tax, total: l.total, tax_lines: taxLines,
      unit_cost: fmt(m.unitCost, 6), cost_total: fmt(m.value, 4), category_id: v.category_id, lot_id: l.lotId ?? null, serial_no: l.serialNo ?? null, return_of_line_id: l.returnOfLineId ?? null, override_by: l.overrideBy ?? null };
  });
  await tx.query(`INSERT INTO pos_order_line SELECT * FROM json_populate_recordset(NULL::pos_order_line, $1::json)`, [JSON.stringify(lineRows)]);
  // payments: cash stored net of change; refunds negative
  const sign = p.kind === 'sale' ? 1 : -1;
  let changeLeft = dec(p.change);
  const payRows = p.payments.map((x) => {
    let amt = dec(x.amount);
    if (x.method === 'cash' && changeLeft.gt(0)) { const take = changeLeft.gt(amt) ? amt : changeLeft; amt = amt.sub(take); changeLeft = changeLeft.sub(take); }
    return { id: x.id, business_date: p.businessDate, order_id: p.id, tenant_id: actor.tenantId, company_id: t.company_id, branch_id: t.branch_id, session_id: p.sessionId, method: x.method,
      amount: fmt(amt.mul(sign), 4), reference: x.reference ?? null, card_last4: x.cardLast4 ?? null, approval_code: x.approvalCode ?? null, settled: false };
  }).filter((x) => !dec(x.amount).isZero());
  await tx.query(`INSERT INTO pos_payment SELECT * FROM json_populate_recordset(NULL::pos_payment, $1::json)`, [JSON.stringify(payRows)]);

  // ---- operational read model ----
  await tx.query(`INSERT INTO rep_sales_daily AS r (tenant_id, company_id, branch_id, business_date, variant_id, category_id, qty, gross, discount, net, tax, cost, orders)
                  SELECT $1, $2, $3, $4, x.variant_id, x.category_id, sum(x.qty) * $5, sum(x.total + x.discount_total) * $5, sum(x.discount_total) * $5, sum(x.net) * $5, sum(x.tax) * $5, sum(x.cost_total) * $5, count(DISTINCT x.order_id) * $5
                    FROM json_to_recordset($6::json) AS x(variant_id uuid, category_id uuid, qty numeric, total numeric, discount_total numeric, net numeric, tax numeric, cost_total numeric, order_id uuid) GROUP BY x.variant_id, x.category_id
                  ON CONFLICT (branch_id, business_date, variant_id) DO UPDATE SET qty = r.qty + EXCLUDED.qty, gross = r.gross + EXCLUDED.gross, discount = r.discount + EXCLUDED.discount,
                    net = r.net + EXCLUDED.net, tax = r.tax + EXCLUDED.tax, cost = r.cost + EXCLUDED.cost, orders = r.orders + EXCLUDED.orders`,
    [actor.tenantId, t.company_id, t.branch_id, p.businessDate, sign, JSON.stringify(lineRows)]);
  await tx.query(`UPDATE pos_session SET orders_count = orders_count + 1, sales_total = sales_total + CASE WHEN $2 = 'sale' THEN $3::numeric ELSE 0 END, returns_total = returns_total + CASE WHEN $2 = 'return' THEN $3::numeric ELSE 0 END WHERE id = $1`,
    [p.sessionId, p.kind, p.grandTotal]);
  return { serverRef: p.id, exceptions };
}

import { ownerPool } from './helpers.js';

/** Financial & inventory invariants from TESTING.md §2 — run against the whole database as owner. */
export async function assertInvariants(tenantId?: string) {
  const pool = ownerPool();
  try {
    const t = tenantId ? 'AND tenant_id = $1' : '';
    const p = tenantId ? [tenantId] : [];
    const unbalanced = await pool.query(`SELECT e.id FROM acc_journal_entry e JOIN acc_journal_line l ON l.entry_id = e.id AND l.posting_date = e.posting_date
                                         WHERE e.state <> 'draft' ${t.replace('tenant_id', 'e.tenant_id')} GROUP BY e.id HAVING sum(l.debit) <> sum(l.credit)`, p);
    const quantVsMoves = await pool.query(`WITH m AS (
        SELECT to_location_id AS loc, variant_id, coalesce(lot_id, '00000000-0000-0000-0000-000000000000') AS lot, coalesce(owner_id, '00000000-0000-0000-0000-000000000000') AS owner, qty_stock_uom AS q FROM inv_stock_move WHERE true ${t}
        UNION ALL SELECT from_location_id, variant_id, coalesce(lot_id, '00000000-0000-0000-0000-000000000000'), coalesce(owner_id, '00000000-0000-0000-0000-000000000000'), -qty_stock_uom FROM inv_stock_move WHERE true ${t}),
      s AS (SELECT loc, variant_id, lot, owner, sum(q) AS q FROM m GROUP BY 1, 2, 3, 4)
      SELECT q.location_id, q.variant_id FROM inv_stock_quant q LEFT JOIN s ON s.loc = q.location_id AND s.variant_id = q.variant_id AND s.lot = q.lot_id AND s.owner = q.owner_id
      WHERE coalesce(s.q, 0) <> q.qty_on_hand ${t.replace('tenant_id', 'q.tenant_id')}`, p);
    const conservation = await pool.query(`SELECT variant_id FROM inv_stock_quant WHERE true ${t} GROUP BY variant_id HAVING sum(qty_on_hand) <> 0`, p);
    const orphans = await pool.query(`SELECT id FROM inv_stock_move WHERE (ref_doc_id IS NULL OR ref_doc_type IS NULL) ${t}`, p);
    const costVsQuant = await pool.query(`SELECT c.variant_id FROM inv_product_cost c LEFT JOIN (
        SELECT q.company_id, q.variant_id, sum(q.qty_on_hand) AS qty FROM inv_stock_quant q JOIN inv_location l ON l.id = q.location_id
         WHERE l.type IN ('internal','transit','quarantine') AND q.owner_id = '00000000-0000-0000-0000-000000000000' GROUP BY 1, 2) s ON s.company_id = c.company_id AND s.variant_id = c.variant_id
       WHERE coalesce(s.qty, 0) <> c.qty ${t.replace('tenant_id', 'c.tenant_id')}`, p);
    return {
      unbalancedEntries: unbalanced.rowCount,
      quantMismatches: quantVsMoves.rowCount,
      conservationViolations: conservation.rowCount,
      orphanMoves: orphans.rowCount,
      costQtyMismatches: costVsQuant.rowCount,
    };
  } finally { await pool.end(); }
}
export const CLEAN = { unbalancedEntries: 0, quantMismatches: 0, conservationViolations: 0, orphanMoves: 0, costQtyMismatches: 0 };

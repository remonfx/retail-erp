import { uuidv7, fmt } from '@rc/domain';
import type { Tx } from '../../lib/db.js';
import { emit } from '../../lib/http.js';
import type { PostedMove } from './engine.js';

/** Emit inventory.valued for GL posting (only moves with a financial effect). */
export async function emitInventoryValued(tx: Tx, a: { tenantId: string; companyId: string; branchId: string; docType: string; docId: string; date: string; userId: string; memo?: string; moves: PostedMove[] }) {
  const reasonIds = [...new Set(a.moves.map((m) => m.reasonCodeId).filter(Boolean))] as string[];
  const reasons = new Map(reasonIds.length ? (await tx.query('SELECT id, account_mapping_key FROM inv_reason_code WHERE id = ANY($1::uuid[])', [reasonIds])).rows.map((r) => [r.id, r.account_mapping_key]) : []);
  const moves = a.moves
    .filter((m) => !m.value.isZero() && (m.valuation !== 'none' || m.fromType === 'transit' || m.toType === 'transit'))
    .map((m) => ({ moveType: m.moveType, valuation: m.valuation, value: fmt(m.value, 4), cogsAdjustment: fmt(m.cogsAdjustment, 4), fromType: m.fromType, toType: m.toType,
      fromBranchId: m.fromBranchId ?? a.branchId, toBranchId: m.toBranchId ?? a.branchId, reasonKey: m.reasonCodeId ? reasons.get(m.reasonCodeId) ?? null : null, categoryId: m.categoryId, variantId: m.variantId }));
  if (!moves.length) return;
  await emit(tx, { id: uuidv7(), tenantId: a.tenantId, companyId: a.companyId, aggregateType: a.docType, aggregateId: a.docId, type: 'inventory.valued',
    payload: { docType: a.docType, docId: a.docId, date: a.date, branchId: a.branchId, memo: a.memo, userId: a.userId, moves } });
}

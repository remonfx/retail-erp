import type { Tx } from './db.js';
import { forbidden } from './errors.js';

export interface Assignment {
  roleId: string; scopeType: 'tenant' | 'company' | 'branch' | 'warehouse';
  companyId: string | null; branchId: string | null; warehouseId: string | null;
  permissions: Set<string>; limits: Record<string, unknown>;
}
export interface Actor {
  kind: 'user' | 'device';
  tenantId: string; userId: string; email?: string; isOwner: boolean; mfa: boolean;
  deviceId?: string; deviceBranchId?: string; deviceCompanyId?: string;
  assignments: Assignment[];
  requestId: string;
}
export interface Scope { companyId?: string | null; branchId?: string | null; warehouseId?: string | null; warehouseBranchId?: string | null }

function covers(a: Assignment, s: Scope): boolean {
  switch (a.scopeType) {
    case 'tenant': return true;
    case 'company': return !s.companyId || a.companyId === s.companyId;
    case 'branch': return (!s.companyId || a.companyId === s.companyId) && (s.branchId ? a.branchId === s.branchId : s.warehouseBranchId ? a.branchId === s.warehouseBranchId : false);
    case 'warehouse': return (!s.companyId || a.companyId === s.companyId) && !!s.warehouseId && a.warehouseId === s.warehouseId;
  }
}

export function can(actor: Actor, perm: string, scope: Scope = {}): boolean {
  return actor.assignments.some((a) => a.permissions.has(perm) && covers(a, scope));
}

export function require(actor: Actor, perm: string, scope: Scope = {}): void {
  if (!can(actor, perm, scope)) throw forbidden(perm);
}

/** Does the actor hold `perm` anywhere (used for list endpoints which then filter by branchFilter). */
export function holdsAnywhere(actor: Actor, perm: string, companyId?: string): boolean {
  return actor.assignments.some((a) => a.permissions.has(perm) && (a.scopeType === 'tenant' || !companyId || a.companyId === companyId));
}

/** Branch ids the actor may see for perm in company; null = all branches. */
export function branchFilter(actor: Actor, perm: string, companyId: string): string[] | null {
  const rel = actor.assignments.filter((a) => a.permissions.has(perm));
  if (rel.some((a) => a.scopeType === 'tenant' || (a.scopeType === 'company' && a.companyId === companyId))) return null;
  return [...new Set(rel.filter((a) => a.companyId === companyId && a.branchId).map((a) => a.branchId!))];
}

export function companyIds(actor: Actor): string[] | '*' {
  if (actor.assignments.some((a) => a.scopeType === 'tenant')) return '*';
  return [...new Set(actor.assignments.map((a) => a.companyId).filter((x): x is string => !!x))];
}

/** Numeric limit across assignments covering scope (max wins). */
export function limitOf(actor: Actor, key: string, scope: Scope, fallback: number): number {
  const vals = actor.assignments.filter((a) => covers(a, scope)).map((a) => Number(a.limits[key])).filter((n) => Number.isFinite(n));
  return vals.length ? Math.max(...vals) : fallback;
}

export function allPermissions(actor: Actor): Set<string> {
  const s = new Set<string>();
  actor.assignments.forEach((a) => a.permissions.forEach((p) => s.add(p)));
  return s;
}

const cache = new Map<string, { at: number; assignments: Assignment[] }>();
export function invalidateActorCache(userId?: string) { if (userId) cache.delete(userId); else cache.clear(); }

export async function loadAssignments(tx: Tx, userId: string): Promise<Assignment[]> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < 30_000) return hit.assignments;
  const rows = (await tx.query(
    `SELECT a.role_id, a.scope_type, a.company_id, a.branch_id, a.warehouse_id, a.limits,
            coalesce(array_agg(rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS perms
       FROM core_role_assignment a LEFT JOIN core_role_permission rp ON rp.role_id = a.role_id
      WHERE a.user_id = $1 AND a.valid_from <= current_date AND (a.valid_to IS NULL OR a.valid_to >= current_date)
      GROUP BY a.id`, [userId])).rows;
  const assignments: Assignment[] = rows.map((r) => ({
    roleId: r.role_id, scopeType: r.scope_type, companyId: r.company_id, branchId: r.branch_id, warehouseId: r.warehouse_id,
    permissions: new Set<string>(r.perms), limits: r.limits ?? {},
  }));
  cache.set(userId, { at: Date.now(), assignments });
  return assignments;
}

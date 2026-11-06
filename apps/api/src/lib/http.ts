import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError, type ZodType } from 'zod';
import { createHash } from 'node:crypto';
import { stableStringify } from '@rc/domain';
import { AppError, forbidden, fromPg } from './errors.js';
import { withTx, type Tx } from './db.js';
import { companyIds, holdsAnywhere, loadAssignments, type Actor } from './actor.js';
import { verifyAccessToken, sha256, safeEqual } from './security.js';

export type AuthMode = 'user' | 'device' | 'public' | 'user_or_device';

export interface RouteOpts<B extends ZodType | undefined, Q extends ZodType | undefined> {
  auth?: AuthMode;
  perm?: string;                 // must be held somewhere in the selected company
  body?: B;
  query?: Q;
  company?: 'required' | 'optional' | 'none';
  idempotent?: boolean;          // default: true for mutating user routes
  tx?: boolean;                  // default true: run inside RLS transaction
  isolation?: 'read committed' | 'repeatable read' | 'serializable';
  raw?: boolean;                 // handler writes reply itself (streams)
  rateLimit?: { max: number; timeWindow: string };
}

export type Params = { id: string; branchId: string; clientId: string; aid: string; code: string } & Record<string, string>;
export interface Ctx<B, Q> {
  actor: Actor;
  body: B;
  query: Q;
  params: Params;
  companyId: string;             // '' when company: 'none'
  tx: Tx;
  req: FastifyRequest;
  reply: FastifyReply;
}

type Infer<T> = T extends ZodType ? z.infer<T> : undefined;

declare module 'fastify' { interface FastifyRequest { actor?: Actor } }

async function authenticate(req: FastifyRequest, mode: AuthMode): Promise<Actor | null> {
  const h = req.headers.authorization ?? '';
  const requestId = String(req.id);
  if (mode === 'public') return null;
  if (h.startsWith('Bearer ') && mode !== 'device') {
    let claims;
    try { claims = await verifyAccessToken(h.slice(7)); } catch { throw new AppError('UNAUTHENTICATED', 401, 'Invalid or expired token'); }
    const assignments = await withTx({ tenantId: claims.tid }, (tx) => loadAssignments(tx, claims.sub));
    const status = await withTx({ tenantId: claims.tid }, async (tx) => (await tx.query(
      `SELECT u.status, u.is_tenant_owner, u.email, t.status AS tenant_status FROM core_user u JOIN core_tenant t ON t.id = u.tenant_id WHERE u.id = $1`, [claims.sub])).rows[0]);
    if (!status || status.status !== 'active') throw new AppError('UNAUTHENTICATED', 401, 'User inactive');
    if (['suspended', 'cancelled'].includes(status.tenant_status) && req.method !== 'GET') throw new AppError('TENANT_SUSPENDED', 402, 'Subscription inactive: read-only mode');
    return { kind: 'user', tenantId: claims.tid, userId: claims.sub, email: status.email, isOwner: status.is_tenant_owner, mfa: claims.mfa, assignments, requestId };
  }
  if (h.startsWith('Device ') && mode !== 'user') {
    const [deviceId, secret] = h.slice(7).split(':');
    if (!deviceId || !secret) throw new AppError('UNAUTHENTICATED', 401);
    const d = await withTx(null, async (tx) => (await tx.query('SELECT * FROM auth_lookup_device($1::uuid)', [deviceId]).catch(() => ({ rows: [] }))).rows[0]);
    if (!d || d.status !== 'active' || !d.secret_hash || !safeEqual(sha256(secret), d.secret_hash)) throw new AppError('DEVICE_UNAUTHENTICATED', 401);
    // devices act with the permissions of a synthetic POS role (sell/sync) scoped to their branch
    return {
      kind: 'device', tenantId: d.tenant_id, userId: deviceId, isOwner: false, mfa: false, deviceId,
      deviceBranchId: d.branch_id, deviceCompanyId: d.company_id, requestId,
      assignments: [{ roleId: 'device', scopeType: 'branch', companyId: d.company_id, branchId: d.branch_id, warehouseId: null, permissions: new Set(['pos.sync', 'catalog.product.read', 'sales.order.read', 'inventory.stock.read', 'sales.customer.read']), limits: {} }],
    };
  }
  throw new AppError('UNAUTHENTICATED', 401);
}

function resolveCompany(req: FastifyRequest, actor: Actor | null, mode: RouteOpts<undefined, undefined>['company']): string {
  if (!actor || mode === 'none') return '';
  if (actor.kind === 'device') return actor.deviceCompanyId!;
  const header = req.headers['x-company-id'];
  const allowed = companyIds(actor);
  if (typeof header === 'string' && header) {
    if (allowed !== '*' && !allowed.includes(header)) throw forbidden('company access');
    return header;
  }
  if (allowed !== '*' && allowed.length === 1) return allowed[0]!;
  if (mode === 'required') throw new AppError('COMPANY_REQUIRED', 400, 'X-Company-Id header required');
  return '';
}

const tenantCompanies = new Map<string, Set<string>>();
async function companyInTenant(tx: Tx, tenantId: string, companyId: string): Promise<boolean> {
  if (tenantCompanies.get(tenantId)?.has(companyId)) return true;
  const ids = (await tx.query('SELECT id FROM core_company')).rows.map((r) => r.id as string);
  tenantCompanies.set(tenantId, new Set(ids));
  return ids.includes(companyId);
}

export function route<B extends ZodType | undefined = undefined, Q extends ZodType | undefined = undefined>(
  app: FastifyInstance, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string,
  opts: RouteOpts<B, Q>, handler: (c: Ctx<Infer<B>, Infer<Q>>) => Promise<unknown>,
) {
  const auth = opts.auth ?? 'user';
  const mutating = method !== 'GET';
  app.route({
    method, url,
    config: opts.rateLimit ? { rateLimit: opts.rateLimit } : {},
    handler: async (req, reply) => {
      const actor = await authenticate(req, auth);
      if (actor) req.actor = actor;
      const companyId = resolveCompany(req, actor, opts.company ?? 'required');
      if (opts.perm && actor && !holdsAnywhere(actor, opts.perm, companyId || undefined)) throw forbidden(opts.perm);
      const body = (opts.body ? opts.body.parse(req.body ?? {}) : undefined) as Infer<B>;
      const query = (opts.query ? opts.query.parse(req.query ?? {}) : undefined) as Infer<Q>;
      const params = (req.params ?? {}) as Params;
      const idemKey = req.headers['idempotency-key'];
      const useIdem = mutating && actor?.kind === 'user' && (opts.idempotent ?? true);
      if (useIdem && (typeof idemKey !== 'string' || idemKey.length < 8 || idemKey.length > 100)) throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 400, 'Idempotency-Key header required');

      const run = async (tx: Tx) => {
        if (companyId && actor && !(await companyInTenant(tx, actor.tenantId, companyId))) throw forbidden('company access');
        let reqHash = '';
        if (useIdem) {
          reqHash = createHash('sha256').update(method + url + stableStringify(params) + stableStringify(req.body ?? null)).digest('hex');
          const ins = await tx.query(`INSERT INTO core_idempotency_key (tenant_id, key, user_id, request_hash) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING key`,
            [actor!.tenantId, idemKey, actor!.userId, reqHash]);
          if (!ins.rowCount) {
            const prev = (await tx.query(`SELECT request_hash, status_code, response FROM core_idempotency_key WHERE tenant_id = $1 AND key = $2`, [actor!.tenantId, idemKey])).rows[0];
            if (prev.request_hash !== reqHash) throw new AppError('IDEMPOTENCY_KEY_REUSED', 422, 'Idempotency-Key reused with a different request');
            reply.header('idempotent-replay', 'true');
            return { __replay: true, status: prev.status_code ?? 200, body: prev.response };
          }
        }
        const out = await handler({ actor: actor!, body, query, params, companyId, tx, req, reply });
        if (useIdem) await tx.query(`UPDATE core_idempotency_key SET status_code = $3, response = $4 WHERE tenant_id = $1 AND key = $2`, [actor!.tenantId, idemKey, reply.statusCode || 200, JSON.stringify(out ?? null)]);
        return out;
      };

      if (opts.tx === false) return handler({ actor: actor!, body, query, params, companyId, tx: null as unknown as Tx, req, reply });
      const ctx = actor ? { tenantId: actor.tenantId, userId: actor.kind === 'user' ? actor.userId : null, deviceId: actor.deviceId ?? null, companyIds: companyIds(actor), requestId: actor.requestId } : null;
      const out = await withTx(ctx, run, { isolation: opts.isolation });
      if (opts.raw) return reply;
      if (out && typeof out === 'object' && '__replay' in out) { const rp = out as unknown as { status: number; body: unknown }; reply.code(rp.status); return rp.body; }
      return out ?? { ok: true };
    },
  });
}

export function installErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: Error & { validation?: unknown; statusCode?: number }, req, reply) => {
    let e: AppError;
    if (err instanceof AppError) e = err;
    else if (err instanceof ZodError) e = new AppError('VALIDATION_FAILED', 400, 'Invalid request', err.issues.map((i) => ({ path: i.path.join('.'), code: i.message })));
    else if ((err as { validation?: unknown }).validation) e = new AppError('VALIDATION_FAILED', 400, err.message);
    else if ((err as { statusCode?: number }).statusCode === 429) e = new AppError('RATE_LIMITED', 429, err.message);
    else e = fromPg(err) ?? new AppError('INTERNAL', 500, 'Internal error');
    if (e.status >= 500 && e.code === 'INTERNAL') req.log.error({ err }, 'unhandled');
    reply.code(e.status).type('application/problem+json').send({
      type: `https://errors.retailcore.app/${e.code.toLowerCase().replace(/_/g, '-')}`,
      title: e.code, status: e.status, code: e.code, detail: e.message, errors: e.details, requestId: req.id,
    });
  });
}

/** Keyset pagination helpers: cursor = base64url(JSON [sortValue, id]) */
export const pageQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50), cursor: z.string().optional() });
export function decodeCursor(c?: string): [string, string] | null {
  if (!c) return null;
  try { const v = JSON.parse(Buffer.from(c, 'base64url').toString()); return Array.isArray(v) && v.length === 2 ? [String(v[0]), String(v[1])] : null; } catch { return null; }
}
export const encodeCursor = (sortVal: unknown, id: string) => Buffer.from(JSON.stringify([sortVal, id])).toString('base64url');
export function page<T extends { id: string }>(rows: T[], limit: number, sortKey: keyof T) {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return { data, hasMore, nextCursor: hasMore && last ? encodeCursor(last[sortKey], last.id) : null };
}

export async function audit(tx: Tx, actor: Actor, action: string, entity: string, entityId: string, after?: unknown, companyId?: string) {
  await tx.query(`INSERT INTO core_audit_log (tenant_id, company_id, user_id, device_id, action, entity, entity_id, after, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [actor.tenantId, companyId || null, actor.kind === 'user' ? actor.userId : null, actor.deviceId ?? null, action, entity, entityId, after === undefined ? null : JSON.stringify(after), actor.requestId]);
}

export async function emit(tx: Tx, e: { id: string; tenantId: string; companyId?: string | null; aggregateType: string; aggregateId: string; type: string; payload: unknown }) {
  await tx.query(`INSERT INTO core_outbox_event (id, tenant_id, company_id, aggregate_type, aggregate_id, event_type, payload) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [e.id, e.tenantId, e.companyId ?? null, e.aggregateType, e.aggregateId, e.type, JSON.stringify(e.payload)]);
}

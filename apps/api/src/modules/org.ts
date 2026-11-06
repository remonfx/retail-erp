import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { uuidv7, uuid, sodViolations, PERMISSIONS } from '@rc/domain';
import { route, audit } from '../lib/http.js';
import { require as requirePerm, invalidateActorCache, can } from '../lib/actor.js';
import { AppError, invalid, notFound, forbidden } from '../lib/errors.js';
import type { Tx } from '../lib/db.js';
import { hashPassword, validatePasswordStrength, randomToken, sha256 } from '../lib/security.js';
import { provisionBranch, provisionCompany } from './provision.js';

export async function enforcePlanLimit(tx: Tx, tenantId: string, kind: 'companies' | 'branches' | 'terminals' | 'users' | 'skus') {
  const plan = (await tx.query(`SELECT p.* FROM core_tenant t JOIN saas_plan p ON p.code = t.plan_code WHERE t.id = $1`, [tenantId])).rows[0];
  const sql: Record<typeof kind, [string, string]> = {
    companies: ['SELECT count(*)::int AS n FROM core_company', 'max_companies'],
    branches: ['SELECT count(*)::int AS n FROM core_branch WHERE active', 'max_branches'],
    terminals: ['SELECT count(*)::int AS n FROM pos_terminal WHERE active', 'max_terminals'],
    users: [`SELECT count(*)::int AS n FROM core_user WHERE status <> 'disabled'`, 'max_users'],
    skus: [`SELECT count(*)::int AS n FROM cat_variant WHERE status = 'active'`, 'max_skus'],
  };
  const [q, col] = sql[kind];
  const n = (await tx.query(q)).rows[0].n as number;
  if (n >= Number(plan[col])) throw new AppError('PLAN_LIMIT_REACHED', 402, `Plan ${plan.code} allows ${plan[col]} ${kind}`);
}

export default async function orgRoutes(app: FastifyInstance) {
  // ---------- SaaS ----------
  route(app, 'GET', '/api/v1/saas/subscription', { company: 'none' }, async ({ tx, actor }) => {
    const tenant = (await tx.query('SELECT t.*, p.name_ar AS plan_name_ar, p.name_en AS plan_name_en, p.max_companies, p.max_branches, p.max_terminals, p.max_users, p.max_skus, p.monthly_price_egp, p.features FROM core_tenant t JOIN saas_plan p ON p.code = t.plan_code WHERE t.id = $1', [actor.tenantId])).rows[0];
    const usage = (await tx.query(`SELECT (SELECT count(*) FROM core_company)::int companies, (SELECT count(*) FROM core_branch WHERE active)::int branches,
      (SELECT count(*) FROM pos_terminal WHERE active)::int terminals, (SELECT count(*) FROM core_user WHERE status <> 'disabled')::int users, (SELECT count(*) FROM cat_variant WHERE status='active')::int skus`)).rows[0];
    const subs = (await tx.query('SELECT * FROM saas_subscription ORDER BY period_end DESC LIMIT 12')).rows;
    return { tenant, usage, subscriptions: subs };
  });
  route(app, 'GET', '/api/v1/saas/plans', { auth: 'public', company: 'none' }, async ({ tx }) => (await tx.query('SELECT * FROM saas_plan WHERE active ORDER BY monthly_price_egp')).rows);
  route(app, 'POST', '/api/v1/saas/subscription/change-plan', { company: 'none', perm: 'saas.subscription.manage', body: z.object({ planCode: z.enum(['starter', 'growth', 'enterprise']) }) }, async ({ tx, actor, body }) => {
    const plan = (await tx.query('SELECT * FROM saas_plan WHERE code = $1', [body.planCode])).rows[0];
    const usage = (await tx.query(`SELECT (SELECT count(*) FROM core_branch WHERE active)::int b, (SELECT count(*) FROM pos_terminal WHERE active)::int t, (SELECT count(*) FROM core_user WHERE status<>'disabled')::int u, (SELECT count(*) FROM core_company)::int c`)).rows[0];
    if (usage.b > plan.max_branches || usage.t > plan.max_terminals || usage.u > plan.max_users || usage.c > plan.max_companies) throw new AppError('PLAN_DOWNGRADE_BLOCKED', 409, 'Current usage exceeds target plan limits');
    await tx.query(`UPDATE core_tenant SET plan_code = $2, status = CASE WHEN status = 'trial' THEN 'trial' ELSE 'active' END WHERE id = $1`, [actor.tenantId, body.planCode]);
    await tx.query(`INSERT INTO saas_subscription (id, tenant_id, plan_code, status, period_start, period_end) VALUES ($1,$2,$3,'active', current_date, current_date + 30)`, [uuidv7(), actor.tenantId, body.planCode]);
    await audit(tx, actor, 'change_plan', 'core_tenant', actor.tenantId, body);
    return { ok: true };
  });

  // ---------- Companies ----------
  route(app, 'GET', '/api/v1/companies', { company: 'none' }, async ({ tx }) => (await tx.query('SELECT * FROM core_company ORDER BY code')).rows);
  route(app, 'POST', '/api/v1/companies', {
    company: 'none', body: z.object({ code: z.string().regex(/^[A-Z0-9]{2,10}$/), legalNameAr: z.string().min(2), legalNameEn: z.string().optional(), taxRegistrationNo: z.string().optional(), costingMethod: z.enum(['average', 'fifo']).default('average') }),
  }, async ({ tx, actor, body, reply }) => {
    requirePerm(actor, 'core.org.manage', {});
    if (!actor.assignments.some((a) => a.scopeType === 'tenant' && a.permissions.has('core.org.manage'))) throw forbidden('core.org.manage (tenant scope)');
    await enforcePlanLimit(tx, actor.tenantId, 'companies');
    if (body.costingMethod === 'fifo') {
      const f = (await tx.query(`SELECT p.features FROM core_tenant t JOIN saas_plan p ON p.code = t.plan_code WHERE t.id = $1`, [actor.tenantId])).rows[0].features;
      if (!f.fifo) throw new AppError('PLAN_FEATURE_UNAVAILABLE', 402, 'FIFO costing requires Growth plan');
    }
    const r = await provisionCompany(tx, actor.tenantId, actor.userId, body);
    reply.code(201);
    return r;
  });
  route(app, 'PATCH', '/api/v1/companies/:id', {
    company: 'none', body: z.object({ legalNameAr: z.string().min(2).optional(), legalNameEn: z.string().nullish(), taxRegistrationNo: z.string().nullish(), allowNegativeStock: z.enum(['never', 'pos_offline', 'pos', 'always']).optional(),
      settings: z.record(z.string(), z.string()).optional(), costingMethod: z.enum(['average', 'fifo']).optional() }),
  }, async ({ tx, actor, body, params }) => {
    requirePerm(actor, 'core.org.manage', { companyId: params.id });
    const c = (await tx.query('SELECT * FROM core_company WHERE id = $1 FOR UPDATE', [params.id])).rows[0];
    if (!c) throw notFound('COMPANY');
    if (body.costingMethod && body.costingMethod !== c.costing_method) {
      const moves = (await tx.query('SELECT 1 FROM inv_product_cost WHERE company_id = $1 LIMIT 1', [params.id])).rowCount;
      if (c.costing_locked || moves) throw new AppError('COSTING_METHOD_LOCKED', 409, 'Costing method cannot change after first valued movement');
    }
    await tx.query(`UPDATE core_company SET legal_name_ar = coalesce($2, legal_name_ar), legal_name_en = coalesce($3, legal_name_en), tax_registration_no = coalesce($4, tax_registration_no),
      allow_negative_stock = coalesce($5, allow_negative_stock), settings = settings || coalesce($6::jsonb, '{}'::jsonb), costing_method = coalesce($7, costing_method) WHERE id = $1`,
      [params.id, body.legalNameAr ?? null, body.legalNameEn ?? null, body.taxRegistrationNo ?? null, body.allowNegativeStock ?? null, body.settings ? JSON.stringify(body.settings) : null, body.costingMethod ?? null]);
    return (await tx.query('SELECT * FROM core_company WHERE id = $1', [params.id])).rows[0];
  });

  // ---------- Branches / warehouses / locations ----------
  route(app, 'GET', '/api/v1/branches', { perm: 'core.org.read' }, async ({ tx, companyId }) =>
    (await tx.query(`SELECT b.*, (SELECT json_agg(w ORDER BY w.code) FROM core_warehouse w WHERE w.branch_id = b.id) AS warehouses FROM core_branch b WHERE b.company_id = $1 ORDER BY b.code`, [companyId])).rows);
  route(app, 'POST', '/api/v1/branches', {
    body: z.object({ code: z.string().regex(/^[A-Z0-9-]{2,12}$/), nameAr: z.string().min(2), nameEn: z.string().optional(), timezone: z.string().default('Africa/Cairo'), address: z.string().optional(), phone: z.string().optional() }),
  }, async ({ tx, actor, body, companyId, reply }) => {
    requirePerm(actor, 'core.org.manage', { companyId });
    await enforcePlanLimit(tx, actor.tenantId, 'branches');
    const r = await provisionBranch(tx, actor.tenantId, companyId, actor.userId, body);
    const pl = (await tx.query(`SELECT id FROM prc_price_list WHERE company_id = $1 AND scope = 'company' ORDER BY priority LIMIT 1`, [companyId])).rows[0];
    if (pl) await tx.query('UPDATE core_branch SET default_price_list_id = $1 WHERE id = $2', [pl.id, r.branchId]);
    reply.code(201);
    return r;
  });
  route(app, 'GET', '/api/v1/locations', { perm: 'core.org.read', query: z.object({ warehouseId: uuid.optional(), type: z.string().optional() }) }, async ({ tx, companyId, query }) =>
    (await tx.query(`SELECT * FROM inv_location WHERE company_id = $1 AND ($2::uuid IS NULL OR warehouse_id = $2) AND ($3::text IS NULL OR type = $3) ORDER BY code`, [companyId, query.warehouseId ?? null, query.type ?? null])).rows);
  route(app, 'POST', '/api/v1/locations', {
    body: z.object({ warehouseId: uuid, parentId: uuid.optional(), code: z.string().regex(/^[A-Z0-9-]{2,30}$/), nameAr: z.string(), nameEn: z.string().optional(), type: z.enum(['internal', 'quarantine', 'scrap']) }),
  }, async ({ tx, actor, body, companyId, reply }) => {
    const wh = (await tx.query('SELECT * FROM core_warehouse WHERE id = $1 AND company_id = $2', [body.warehouseId, companyId])).rows[0];
    if (!wh) throw notFound('WAREHOUSE');
    requirePerm(actor, 'core.org.manage', { companyId, branchId: wh.branch_id });
    const id = uuidv7();
    const parentPath = body.parentId ? (await tx.query('SELECT path FROM inv_location WHERE id = $1', [body.parentId])).rows[0]?.path : null;
    await tx.query(`INSERT INTO inv_location (id, tenant_id, company_id, warehouse_id, branch_id, parent_id, code, name_ar, name_en, type, path) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, actor.tenantId, companyId, body.warehouseId, wh.branch_id, body.parentId ?? null, body.code, body.nameAr, body.nameEn ?? null, body.type, parentPath ? `${parentPath}/${body.code}` : body.code]);
    reply.code(201);
    return { id };
  });
  route(app, 'GET', '/api/v1/cost-centers', { perm: 'core.org.read' }, async ({ tx, companyId }) => (await tx.query('SELECT * FROM core_cost_center WHERE company_id = $1 ORDER BY code', [companyId])).rows);

  // ---------- Users & roles ----------
  route(app, 'GET', '/api/v1/users', { company: 'none', perm: 'core.user.read' }, async ({ tx }) =>
    (await tx.query(`SELECT u.id, u.email, u.full_name, u.phone, u.status, u.mfa_enabled, u.last_login_at, u.is_tenant_owner,
      coalesce((SELECT json_agg(json_build_object('id', a.id, 'role', r.code, 'roleNameAr', r.name_ar, 'scopeType', a.scope_type, 'companyId', a.company_id, 'branchId', a.branch_id, 'warehouseId', a.warehouse_id, 'limits', a.limits))
        FROM core_role_assignment a JOIN core_role r ON r.id = a.role_id WHERE a.user_id = u.id), '[]') AS assignments
      FROM core_user u ORDER BY u.full_name`)).rows);
  route(app, 'POST', '/api/v1/users', {
    company: 'none', perm: 'core.user.manage',
    body: z.object({ email: z.string().email(), fullName: z.string().min(2), phone: z.string().optional(), password: z.string().min(12), locale: z.enum(['ar', 'en']).default('ar') }),
  }, async ({ tx, actor, body, reply }) => {
    const weak = validatePasswordStrength(body.password);
    if (weak) throw invalid(weak);
    await enforcePlanLimit(tx, actor.tenantId, 'users');
    const avail = (await tx.query('SELECT saas_email_available($1) AS a', [body.email])).rows[0].a;
    if (!avail) throw new AppError('EMAIL_TAKEN', 409);
    const id = uuidv7();
    await tx.query(`INSERT INTO core_user (id, tenant_id, email, full_name, phone, password_hash, locale, status, created_by) VALUES ($1,$2,lower($3),$4,$5,$6,$7,'active',$8)`,
      [id, actor.tenantId, body.email, body.fullName, body.phone ?? null, await hashPassword(body.password), body.locale, actor.userId]);
    reply.code(201);
    return { id };
  });
  route(app, 'PATCH', '/api/v1/users/:id', { company: 'none', perm: 'core.user.manage', body: z.object({ status: z.enum(['active', 'disabled', 'locked']).optional(), fullName: z.string().optional(), resetMfa: z.boolean().optional() }) }, async ({ tx, actor, body, params }) => {
    if (params.id === actor.userId) throw new AppError('SELF_MODIFICATION_FORBIDDEN', 403);
    const u = (await tx.query('SELECT is_tenant_owner FROM core_user WHERE id = $1', [params.id])).rows[0];
    if (!u) throw notFound('USER');
    if (u.is_tenant_owner && !actor.isOwner) throw forbidden('owner account');
    await tx.query(`UPDATE core_user SET status = coalesce($2, status), full_name = coalesce($3, full_name), failed_logins = CASE WHEN $2 = 'active' THEN 0 ELSE failed_logins END,
      mfa_enabled = CASE WHEN $4 THEN false ELSE mfa_enabled END, mfa_secret = CASE WHEN $4 THEN NULL ELSE mfa_secret END WHERE id = $1`, [params.id, body.status ?? null, body.fullName ?? null, !!body.resetMfa]);
    if (body.status && body.status !== 'active') await tx.query('UPDATE core_refresh_token SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [params.id]);
    invalidateActorCache(params.id);
    return { ok: true };
  });

  route(app, 'GET', '/api/v1/roles', { company: 'none', perm: 'core.user.read' }, async ({ tx }) =>
    (await tx.query(`SELECT r.*, coalesce(array_agg(p.permission ORDER BY p.permission) FILTER (WHERE p.permission IS NOT NULL), '{}') AS permissions FROM core_role r LEFT JOIN core_role_permission p ON p.role_id = r.id GROUP BY r.id ORDER BY r.is_system DESC, r.code`)).rows);
  route(app, 'GET', '/api/v1/permissions', { company: 'none' }, async () => PERMISSIONS);
  route(app, 'POST', '/api/v1/roles', { company: 'none', perm: 'core.role.manage', body: z.object({ code: z.string().regex(/^[a-z0-9_]{3,40}$/), nameAr: z.string(), nameEn: z.string().optional(), permissions: z.array(z.enum(PERMISSIONS)).min(1) }) }, async ({ tx, actor, body, reply }) => {
    const sod = sodViolations(body.permissions);
    if (sod.length) throw invalid('SOD_CONFLICT', `Role combines conflicting permissions: ${sod.map((x) => x.join(' + ')).join(', ')}`);
    const id = uuidv7();
    await tx.query('INSERT INTO core_role (id, tenant_id, code, name_ar, name_en) VALUES ($1,$2,$3,$4,$5)', [id, actor.tenantId, body.code, body.nameAr, body.nameEn ?? null]);
    await tx.query('INSERT INTO core_role_permission (tenant_id, role_id, permission) SELECT $1,$2,unnest($3::text[])', [actor.tenantId, id, body.permissions]);
    reply.code(201);
    return { id };
  });

  route(app, 'POST', '/api/v1/users/:id/assignments', {
    company: 'none', perm: 'core.role.manage',
    body: z.object({ roleId: uuid, scopeType: z.enum(['tenant', 'company', 'branch', 'warehouse']), companyId: uuid.optional(), branchId: uuid.optional(), warehouseId: uuid.optional(),
      limits: z.object({ maxLineDiscountPercent: z.number().min(0).max(100).optional(), maxBasketDiscountPercent: z.number().min(0).max(100).optional(), maxRefundAmount: z.number().min(0).optional(), approvalCeiling: z.number().min(0).optional() }).default({}),
      validTo: z.string().optional() }),
  }, async ({ tx, actor, body, params, reply }) => {
    if (params.id === actor.userId) throw new AppError('SELF_ASSIGNMENT_FORBIDDEN', 403, 'Users cannot change their own role assignments');
    if (body.scopeType === 'tenant' && !actor.isOwner) throw forbidden('tenant-scope grants require the tenant owner');
    if (body.scopeType !== 'tenant' && !body.companyId) throw invalid('COMPANY_REQUIRED');
    if (body.companyId && !can(actor, 'core.role.manage', { companyId: body.companyId })) throw forbidden('core.role.manage');
    let warehouseBranch: string | null = null;
    if (body.scopeType === 'warehouse') warehouseBranch = (await tx.query('SELECT branch_id FROM core_warehouse WHERE id = $1 AND company_id = $2', [body.warehouseId, body.companyId])).rows[0]?.branch_id ?? null;
    if (body.scopeType === 'branch' && !(await tx.query('SELECT 1 FROM core_branch WHERE id = $1 AND company_id = $2', [body.branchId, body.companyId])).rowCount) throw invalid('BRANCH_NOT_IN_COMPANY');
    if (body.scopeType === 'warehouse' && !warehouseBranch) throw invalid('WAREHOUSE_NOT_IN_COMPANY');
    // SoD across all of the user's permissions after the grant
    const perms = (await tx.query(`SELECT DISTINCT rp.permission FROM core_role_assignment a JOIN core_role_permission rp ON rp.role_id = a.role_id WHERE a.user_id = $1
                                   UNION SELECT permission FROM core_role_permission WHERE role_id = $2`, [params.id, body.roleId])).rows.map((r) => r.permission);
    const sod = sodViolations(perms);
    if (sod.length) throw invalid('SOD_CONFLICT', `Grant would combine: ${sod.map((x) => x.join(' + ')).join(', ')}`);
    const id = uuidv7();
    await tx.query(`INSERT INTO core_role_assignment (id, tenant_id, user_id, role_id, scope_type, company_id, branch_id, warehouse_id, limits, valid_to, granted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, actor.tenantId, params.id, body.roleId, body.scopeType, body.scopeType === 'tenant' ? null : body.companyId, body.scopeType === 'branch' ? body.branchId : body.scopeType === 'warehouse' ? warehouseBranch : null,
       body.scopeType === 'warehouse' ? body.warehouseId : null, JSON.stringify(body.limits), body.validTo ?? null, actor.userId]);
    invalidateActorCache(params.id);
    reply.code(201);
    return { id };
  });
  route(app, 'DELETE', '/api/v1/users/:id/assignments/:aid', { company: 'none', perm: 'core.role.manage' }, async ({ tx, actor, params }) => {
    if (params.id === actor.userId) throw new AppError('SELF_ASSIGNMENT_FORBIDDEN', 403);
    const r = await tx.query('DELETE FROM core_role_assignment WHERE id = $1 AND user_id = $2', [params.aid, params.id]);
    if (!r.rowCount) throw notFound('ASSIGNMENT');
    invalidateActorCache(params.id);
    return { ok: true };
  });

  // ---------- Devices & terminals ----------
  route(app, 'GET', '/api/v1/devices', { perm: 'core.device.manage' }, async ({ tx, companyId }) =>
    (await tx.query(`SELECT d.id, d.kind, d.name, d.status, d.branch_id, d.last_seen_at, d.app_version, d.last_heartbeat, t.id AS terminal_id, t.code AS terminal_code
                     FROM core_device d LEFT JOIN pos_terminal t ON t.device_id = d.id WHERE d.company_id = $1 ORDER BY d.created_at DESC`, [companyId])).rows);
  route(app, 'POST', '/api/v1/devices', { body: z.object({ branchId: uuid, kind: z.enum(['pos', 'wms', 'mobile']), name: z.string().min(2) }) }, async ({ tx, actor, body, companyId, reply }) => {
    requirePerm(actor, 'core.device.manage', { companyId, branchId: body.branchId });
    const id = uuidv7();
    const code = randomToken(6).replace(/[^A-Za-z0-9]/g, 'X').slice(0, 8).toUpperCase();
    await tx.query(`INSERT INTO core_device (id, tenant_id, company_id, branch_id, kind, name, enrollment_code_hash, enrollment_expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7, now() + interval '24 hours', $8)`,
      [id, actor.tenantId, companyId, body.branchId, body.kind, body.name, sha256(code), actor.userId]);
    reply.code(201);
    return { id, enrollmentCode: code, expiresInHours: 24 };
  });
  route(app, 'POST', '/api/v1/devices/:id/revoke', { company: 'required' }, async ({ tx, actor, params, companyId }) => {
    const d = (await tx.query('SELECT branch_id FROM core_device WHERE id = $1 AND company_id = $2', [params.id, companyId])).rows[0];
    if (!d) throw notFound('DEVICE');
    requirePerm(actor, 'core.device.manage', { companyId, branchId: d.branch_id });
    await tx.query(`UPDATE core_device SET status = 'revoked', secret_hash = NULL WHERE id = $1`, [params.id]);
    await audit(tx, actor, 'revoke', 'core_device', params.id, null, companyId);
    return { ok: true };
  });
  // public: device exchanges one-time enrollment code for its permanent secret
  route(app, 'POST', '/api/v1/devices/enroll', { auth: 'public', company: 'none', tx: false, body: z.object({ deviceId: uuid, enrollmentCode: z.string().min(6).max(12), appVersion: z.string().max(40).optional() }), rateLimit: { max: 10, timeWindow: '1 minute' } }, async ({ body }) => {
    const { withTx } = await import('../lib/db.js');
    const d = await withTx(null, async (tx) => (await tx.query('SELECT * FROM auth_lookup_device($1)', [body.deviceId])).rows[0]);
    if (!d || d.status !== 'pending' || !d.enrollment_code_hash || new Date(d.enrollment_expires_at) < new Date() || !sha256(body.enrollmentCode.toUpperCase()).equals(d.enrollment_code_hash)) throw new AppError('ENROLLMENT_INVALID', 401);
    const secret = randomToken(32);
    const terminal = await withTx({ tenantId: d.tenant_id, companyIds: [d.company_id] }, async (tx) => {
      await tx.query(`UPDATE core_device SET status = 'active', secret_hash = $2, enrollment_code_hash = NULL, app_version = $3, last_seen_at = now() WHERE id = $1`, [body.deviceId, sha256(secret), body.appVersion ?? null]);
      return (await tx.query('SELECT id, code, branch_id, warehouse_id, stock_location_id FROM pos_terminal WHERE device_id = $1', [body.deviceId])).rows[0] ?? null;
    });
    return { deviceId: body.deviceId, secret, tenantId: d.tenant_id, companyId: d.company_id, branchId: d.branch_id, terminal };
  });

  route(app, 'GET', '/api/v1/terminals', { perm: 'core.org.read' }, async ({ tx, companyId }) =>
    (await tx.query(`SELECT t.*, d.status AS device_status, d.last_seen_at, (SELECT row_to_json(s) FROM pos_session s WHERE s.terminal_id = t.id AND s.state = 'open') AS open_session FROM pos_terminal t LEFT JOIN core_device d ON d.id = t.device_id WHERE t.company_id = $1 ORDER BY t.code`, [companyId])).rows);
  route(app, 'POST', '/api/v1/terminals', { body: z.object({ branchId: uuid, code: z.string().regex(/^[A-Z0-9]{1,6}$/), name: z.string(), deviceId: uuid.optional(), settings: z.record(z.string(), z.unknown()).default({}) }) }, async ({ tx, actor, body, companyId, reply }) => {
    requirePerm(actor, 'core.device.manage', { companyId, branchId: body.branchId });
    await enforcePlanLimit(tx, actor.tenantId, 'terminals');
    const wh = (await tx.query(`SELECT w.id AS warehouse_id, l.id AS location_id FROM core_warehouse w JOIN inv_location l ON l.warehouse_id = w.id AND l.type = 'internal' WHERE w.branch_id = $1 ORDER BY w.code, l.code LIMIT 1`, [body.branchId])).rows[0];
    if (!wh) throw invalid('BRANCH_HAS_NO_STOCK_LOCATION');
    const id = uuidv7();
    await tx.query(`INSERT INTO pos_terminal (id, tenant_id, company_id, branch_id, code, name, warehouse_id, stock_location_id, device_id, settings) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, actor.tenantId, companyId, body.branchId, body.code, body.name, wh.warehouse_id, wh.location_id, body.deviceId ?? null,
       JSON.stringify({ maxOfflineHours: 72, cashRounding: '0', maxLineDiscountPercent: 10, maxBasketDiscountPercent: 5, ...body.settings })]);
    reply.code(201);
    return { id };
  });

  // ---------- Audit log ----------
  route(app, 'GET', '/api/v1/audit-log', { company: 'none', perm: 'core.audit.read', query: z.object({ entity: z.string().optional(), entityId: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100), before: z.coerce.number().optional() }) }, async ({ tx, query }) =>
    (await tx.query(`SELECT l.*, u.full_name AS user_name FROM core_audit_log l LEFT JOIN core_user u ON u.id = l.user_id
                     WHERE ($1::text IS NULL OR entity = $1) AND ($2::text IS NULL OR entity_id = $2) AND ($3::bigint IS NULL OR l.id < $3)
                     ORDER BY l.created_at DESC, l.id DESC LIMIT $4`, [query.entity ?? null, query.entityId ?? null, query.before ?? null, query.limit])).rows);
}

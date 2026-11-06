import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { uuidv7, normalizeEgyptPhone } from '@rc/domain';
import { route, audit } from '../lib/http.js';
import { withTx } from '../lib/db.js';
import { AppError, invalid } from '../lib/errors.js';
import { hashPassword, verifyPassword, validatePasswordStrength, signAccessToken, randomToken, sha256, newTotpSecret, totpUri, verifyTotp, encryptSecret, decryptSecret } from '../lib/security.js';
import { companyIds, allPermissions, invalidateActorCache } from '../lib/actor.js';
import { provisionTenantMasters, provisionCompany, provisionBranch } from './provision.js';
import { config } from '../config.js';

const signupSchema = z.object({
  tenantName: z.string().min(2).max(120),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,40}$/),
  ownerName: z.string().min(2).max(120),
  email: z.string().email().max(200),
  password: z.string().min(12).max(200),
  phone: z.string().max(30).optional(),
  companyNameAr: z.string().min(2).max(200),
  companyNameEn: z.string().max(200).optional(),
  taxRegistrationNo: z.string().max(30).optional(),
  branchNameAr: z.string().min(2).max(120),
  branchCode: z.string().regex(/^[A-Z0-9-]{2,12}$/).default('MAIN'),
  planCode: z.enum(['starter', 'growth', 'enterprise']).default('starter'),
});

async function issueTokens(tenantId: string, userId: string, mfa: boolean, familyId?: string, meta?: { ua?: string; ip?: string }) {
  const refresh = randomToken(48);
  const id = uuidv7();
  await withTx({ tenantId }, (tx) => tx.query(
    `INSERT INTO core_refresh_token (id, tenant_id, user_id, family_id, token_hash, expires_at, user_agent, ip) VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval, $7, $8)`,
    [id, tenantId, userId, familyId ?? id, sha256(refresh), String(config.refreshTokenTtlDays), meta?.ua ?? null, meta?.ip ?? null]));
  return { accessToken: await signAccessToken({ sub: userId, tid: tenantId, mfa }), refreshToken: refresh, expiresIn: config.accessTokenTtlSec, tokenId: id };
}

export default async function authRoutes(app: FastifyInstance) {
  route(app, 'POST', '/api/v1/auth/signup', { auth: 'public', body: signupSchema, company: 'none', tx: false, rateLimit: { max: 5, timeWindow: '1 minute' } }, async ({ body, req, reply }) => {
    const weak = validatePasswordStrength(body.password);
    if (weak) throw invalid(weak);
    const available = await withTx(null, async (tx) => (await tx.query('SELECT saas_slug_available($1) AS s, saas_email_available($2) AS e', [body.slug, body.email])).rows[0]);
    if (!available.s) throw new AppError('SLUG_TAKEN', 409);
    if (!available.e) throw new AppError('EMAIL_TAKEN', 409);
    const tenantId = uuidv7(), userId = uuidv7();
    const pwHash = await hashPassword(body.password);
    const result = await withTx({ tenantId, userId, companyIds: '*' }, async (tx) => {
      await tx.query(`INSERT INTO core_tenant (id, slug, name, status, plan_code, trial_ends_at) VALUES ($1,$2,$3,'trial',$4, now() + interval '14 days')`, [tenantId, body.slug, body.tenantName, body.planCode]);
      await tx.query(`INSERT INTO saas_subscription (id, tenant_id, plan_code, status, period_start, period_end) VALUES ($1,$2,$3,'trialing', current_date, current_date + 14)`, [uuidv7(), tenantId, body.planCode]);
      await tx.query(`INSERT INTO core_user (id, tenant_id, email, full_name, phone, password_hash, is_tenant_owner, status, created_by) VALUES ($1,$2,lower($3),$4,$5,$6,true,'active',$1)`,
        [userId, tenantId, body.email, body.ownerName, normalizeEgyptPhone(body.phone) ?? body.phone ?? null, pwHash]);
      const { roles } = await provisionTenantMasters(tx, tenantId);
      const { companyId, priceListId } = await provisionCompany(tx, tenantId, userId, { code: 'C01', legalNameAr: body.companyNameAr, legalNameEn: body.companyNameEn, taxRegistrationNo: body.taxRegistrationNo });
      const branch = await provisionBranch(tx, tenantId, companyId, userId, { code: body.branchCode, nameAr: body.branchNameAr });
      await tx.query('UPDATE core_branch SET default_price_list_id = $1 WHERE id = $2', [priceListId, branch.branchId]);
      // Owner gets tenant_owner + system_admin (setup); SoD: no journal posting rights.
      for (const r of ['tenant_owner', 'system_admin']) {
        await tx.query(`INSERT INTO core_role_assignment (id, tenant_id, user_id, role_id, scope_type, granted_by) VALUES ($1,$2,$3,$4,'tenant',$3)`, [uuidv7(), tenantId, userId, roles[r]]);
      }
      return { companyId, branchId: branch.branchId };
    });
    const tokens = await issueTokens(tenantId, userId, false, undefined, { ua: req.headers['user-agent'], ip: req.ip });
    reply.code(201);
    return { tenantId, userId, ...result, ...tokens };
  });

  route(app, 'POST', '/api/v1/auth/login', {
    auth: 'public', company: 'none', tx: false, rateLimit: { max: 10, timeWindow: '1 minute' },
    body: z.object({ email: z.string().email(), password: z.string().min(1).max(200), totp: z.string().regex(/^\d{6}$/).optional() }),
  }, async ({ body, req }) => {
    const u = await withTx(null, async (tx) => (await tx.query('SELECT * FROM auth_lookup_user($1)', [body.email])).rows[0]);
    const ok = await verifyPassword(u?.password_hash, body.password);
    if (!u || !ok) {
      if (u) await withTx({ tenantId: u.tenant_id }, (tx) => tx.query(`UPDATE core_user SET failed_logins = failed_logins + 1, status = CASE WHEN failed_logins + 1 >= 10 THEN 'locked' ELSE status END WHERE id = $1`, [u.user_id]));
      throw new AppError('INVALID_CREDENTIALS', 401);
    }
    if (u.status !== 'active') throw new AppError('ACCOUNT_LOCKED', 423);
    if (u.tenant_status === 'cancelled') throw new AppError('TENANT_CANCELLED', 402);
    if (u.mfa_enabled) {
      if (!body.totp) throw new AppError('MFA_REQUIRED', 401);
      const secret = await withTx({ tenantId: u.tenant_id }, async (tx) => (await tx.query('SELECT mfa_secret FROM core_user WHERE id = $1', [u.user_id])).rows[0]?.mfa_secret);
      if (!secret || !verifyTotp(decryptSecret(secret), body.totp)) throw new AppError('MFA_INVALID', 401);
    }
    await withTx({ tenantId: u.tenant_id }, (tx) => tx.query('UPDATE core_user SET failed_logins = 0, last_login_at = now() WHERE id = $1', [u.user_id]));
    return issueTokens(u.tenant_id, u.user_id, !!u.mfa_enabled, undefined, { ua: req.headers['user-agent'], ip: req.ip });
  });

  route(app, 'POST', '/api/v1/auth/refresh', { auth: 'public', company: 'none', tx: false, body: z.object({ refreshToken: z.string().min(20) }), rateLimit: { max: 30, timeWindow: '1 minute' } }, async ({ body, req }) => {
    const hash = sha256(body.refreshToken);
    const t = await withTx(null, async (tx) => (await tx.query('SELECT * FROM auth_lookup_refresh($1)', [hash])).rows[0]);
    if (!t) throw new AppError('INVALID_REFRESH', 401);
    if (t.revoked_at) {
      // reuse detected → revoke the whole family
      await withTx({ tenantId: t.tenant_id }, (tx) => tx.query('UPDATE core_refresh_token SET revoked_at = coalesce(revoked_at, now()) WHERE family_id = $1', [t.family_id]));
      throw new AppError('REFRESH_REUSED', 401);
    }
    if (new Date(t.expires_at) < new Date()) throw new AppError('REFRESH_EXPIRED', 401);
    const u = await withTx({ tenantId: t.tenant_id }, async (tx) => (await tx.query('SELECT status, mfa_enabled FROM core_user WHERE id = $1', [t.user_id])).rows[0]);
    if (u?.status !== 'active') throw new AppError('UNAUTHENTICATED', 401);
    const tokens = await issueTokens(t.tenant_id, t.user_id, !!u.mfa_enabled, t.family_id, { ua: req.headers['user-agent'], ip: req.ip });
    await withTx({ tenantId: t.tenant_id }, (tx) => tx.query('UPDATE core_refresh_token SET revoked_at = now(), replaced_by = $2 WHERE id = $1', [t.id, tokens.tokenId]));
    return tokens;
  });

  route(app, 'POST', '/api/v1/auth/logout', { company: 'none', idempotent: false, body: z.object({ refreshToken: z.string().min(20) }) }, async ({ body, tx, actor }) => {
    await tx.query('UPDATE core_refresh_token SET revoked_at = now() WHERE token_hash = $1 AND user_id = $2', [sha256(body.refreshToken), actor.userId]);
    return { ok: true };
  });

  route(app, 'GET', '/api/v1/auth/me', { company: 'none' }, async ({ actor, tx }) => {
    const user = (await tx.query('SELECT id, email, full_name, locale, mfa_enabled, is_tenant_owner FROM core_user WHERE id = $1', [actor.userId])).rows[0];
    const tenant = (await tx.query('SELECT id, slug, name, status, plan_code, trial_ends_at FROM core_tenant WHERE id = $1', [actor.tenantId])).rows[0];
    const cids = companyIds(actor);
    const companies = (await tx.query(`SELECT id, code, legal_name_ar, legal_name_en, base_currency, costing_method FROM core_company WHERE ($1::text = '*' OR id = ANY(string_to_array($1, ',')::uuid[])) ORDER BY code`, [cids === '*' ? '*' : cids.join(',')])).rows;
    const branches = (await tx.query(`SELECT id, company_id, code, name_ar, name_en FROM core_branch WHERE active ORDER BY code`)).rows;
    return {
      user, tenant, companies, branches,
      permissions: [...allPermissions(actor)].sort(),
      assignments: actor.assignments.map((a) => ({ scopeType: a.scopeType, companyId: a.companyId, branchId: a.branchId, warehouseId: a.warehouseId, permissions: [...a.permissions].sort(), limits: a.limits })),
    };
  });

  route(app, 'POST', '/api/v1/auth/mfa/setup', { company: 'none', idempotent: false }, async ({ actor, tx }) => {
    const secret = newTotpSecret();
    await tx.query('UPDATE core_user SET mfa_secret = $2 WHERE id = $1 AND NOT mfa_enabled', [actor.userId, encryptSecret(secret)]);
    return { secret, otpauthUri: totpUri(actor.email ?? actor.userId, secret) };
  });
  route(app, 'POST', '/api/v1/auth/mfa/enable', { company: 'none', idempotent: false, body: z.object({ code: z.string().regex(/^\d{6}$/) }) }, async ({ actor, tx, body }) => {
    const row = (await tx.query('SELECT mfa_secret FROM core_user WHERE id = $1', [actor.userId])).rows[0];
    if (!row?.mfa_secret || !verifyTotp(decryptSecret(row.mfa_secret), body.code)) throw new AppError('MFA_INVALID', 422);
    await tx.query('UPDATE core_user SET mfa_enabled = true WHERE id = $1', [actor.userId]);
    await audit(tx, actor, 'mfa_enabled', 'core_user', actor.userId);
    return { ok: true };
  });
  route(app, 'POST', '/api/v1/auth/pos-pin', { company: 'none', idempotent: false, body: z.object({ pin: z.string().regex(/^\d{6}$/), password: z.string() }) }, async ({ actor, tx, body }) => {
    const row = (await tx.query('SELECT password_hash FROM core_user WHERE id = $1', [actor.userId])).rows[0];
    if (!(await verifyPassword(row?.password_hash, body.password))) throw new AppError('INVALID_CREDENTIALS', 401);
    if (/^(\d)\1{5}$/.test(body.pin) || body.pin === '123456') throw invalid('PIN_TOO_WEAK');
    await tx.query('UPDATE core_user SET pos_pin_hash = $2 WHERE id = $1', [actor.userId, await hashPassword(body.pin)]);
    invalidateActorCache(actor.userId);
    return { ok: true };
  });
}

import { describe, it, expect, afterAll } from 'vitest';
import { call, signup, userWithRole, product, appPool } from './helpers.js';
import { closePool } from '../src/lib/db.js';

afterAll(async () => { await closePool(); });

describe('SaaS signup & auth', () => {
  it('signup provisions tenant, company, branch, COA, periods, roles', async () => {
    const t = await signup('prov');
    const me = await call('GET', '/api/v1/auth/me', undefined, { token: t.token });
    expect(me.status).toBe(200);
    expect(me.body.companies).toHaveLength(1);
    expect(me.body.branches).toHaveLength(1);
    expect(me.body.permissions).not.toContain('accounting.journal.post');
    const accounts = await call('GET', '/api/v1/accounts', undefined, { token: t.token, company: t.companyId });
    expect(accounts.body.length).toBeGreaterThan(50);
    const periods = await call('GET', '/api/v1/fiscal-periods', undefined, { token: t.token, company: t.companyId });
    expect(periods.body.length).toBe(36);
    const sub = await call('GET', '/api/v1/saas/subscription', undefined, { token: t.token });
    expect(sub.body.tenant.status).toBe('trial');
  });

  it('rejects duplicate slug/email and weak passwords', async () => {
    const t = await signup('dup');
    const r = await call('POST', '/api/v1/auth/signup', { tenantName: 'xx', slug: 'other-' + Date.now(), ownerName: 'xx', email: t.email, password: 'Str0ngPassw0rd!', companyNameAr: 'شركة', branchNameAr: 'فرع' });
    expect(r.body.code).toBe('EMAIL_TAKEN');
    const w = await call('POST', '/api/v1/auth/signup', { tenantName: 'xx', slug: 'weak-' + Date.now(), ownerName: 'xx', email: `w${Date.now()}@x.com`, password: 'aaaaaaaaaaaa', companyNameAr: 'شركة', branchNameAr: 'فرع' });
    expect(w.body.code).toBe('PASSWORD_TOO_WEAK');
  });

  it('login, refresh rotation and reuse detection', async () => {
    const t = await signup('login');
    expect((await call('POST', '/api/v1/auth/login', { email: t.email, password: 'wrong-password-1' })).status).toBe(401);
    const l = await call('POST', '/api/v1/auth/login', { email: t.email, password: 'Str0ngPassw0rd!' });
    expect(l.status).toBe(200);
    const r1 = await call('POST', '/api/v1/auth/refresh', { refreshToken: l.body.refreshToken });
    expect(r1.status).toBe(200);
    // reusing the old (rotated) token revokes the whole family
    const reuse = await call('POST', '/api/v1/auth/refresh', { refreshToken: l.body.refreshToken });
    expect(reuse.body.code).toBe('REFRESH_REUSED');
    const r2 = await call('POST', '/api/v1/auth/refresh', { refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(401);
  });

  it('MFA (TOTP) enrollment then required at login', async () => {
    const { totpNow } = await import('../src/lib/security.js');
    const t = await signup('mfa');
    const s = await call('POST', '/api/v1/auth/mfa/setup', {}, { token: t.token });
    expect(s.body.otpauthUri).toContain('otpauth://');
    expect((await call('POST', '/api/v1/auth/mfa/enable', { code: totpNow(s.body.secret) }, { token: t.token })).status).toBe(200);
    expect((await call('POST', '/api/v1/auth/login', { email: t.email, password: 'Str0ngPassw0rd!' })).body.code).toBe('MFA_REQUIRED');
    expect((await call('POST', '/api/v1/auth/login', { email: t.email, password: 'Str0ngPassw0rd!', totp: totpNow(s.body.secret) })).status).toBe(200);
  });

  it('idempotency: same key replays response; different body is rejected', async () => {
    const t = await signup('idem');
    const body = { nameAr: 'علامة', nameEn: 'Brand' };
    const a = await call('POST', '/api/v1/brands', body, { token: t.token, idem: 'key-12345678' });
    const b = await call('POST', '/api/v1/brands', body, { token: t.token, idem: 'key-12345678' });
    expect(a.body.id).toBe(b.body.id);
    expect(b.headers['idempotent-replay']).toBe('true');
    const c = await call('POST', '/api/v1/brands', { nameAr: 'أخرى' }, { token: t.token, idem: 'key-12345678' });
    expect(c.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const d = await call('POST', '/api/v1/brands', body, { token: t.token, idem: false });
    expect(d.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

describe('Tenant & branch isolation', () => {
  it('tenant B cannot read tenant A data (API and direct SQL under RLS)', async () => {
    const a = await signup('tena');
    const b = await signup('tenb');
    const p = await product(a);
    expect((await call('GET', `/api/v1/products/${p.productId}`, undefined, { token: b.token })).status).toBe(404);
    const list = await call('GET', `/api/v1/products?q=${p.sku}`, undefined, { token: b.token, company: b.companyId });
    expect(list.body.data).toHaveLength(0);
    // cross-tenant company header is refused
    expect((await call('GET', '/api/v1/accounts', undefined, { token: b.token, company: a.companyId })).status).toBe(403);
    // direct SQL as the application role: RLS hides other tenant rows and blocks writes
    const pool = appPool();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('rc.tenant_id', $1, true), set_config('rc.company_ids', '*', true)`, [b.tenantId]);
      expect((await c.query('SELECT count(*)::int AS n FROM cat_product WHERE id = $1', [p.productId])).rows[0].n).toBe(0);
      expect((await c.query('SELECT count(*)::int AS n FROM core_company WHERE id = $1', [a.companyId])).rows[0].n).toBe(0);
      await expect(c.query(`INSERT INTO cat_brand (id, tenant_id, name_ar) VALUES (gen_random_uuid(), $1, 'x')`, [a.tenantId])).rejects.toThrow(/row-level security/);
      await c.query('ROLLBACK');
      // no context at all → nothing visible
      await c.query('BEGIN');
      expect((await c.query('SELECT count(*)::int AS n FROM cat_product')).rows[0].n).toBe(0);
      await c.query('ROLLBACK');
    } finally { c.release(); await pool.end(); }
  });

  it('branch manager is limited to assigned branch', async () => {
    const t = await signup('branch');
    const br2 = await call('POST', '/api/v1/branches', { code: 'ALX01', nameAr: 'فرع الإسكندرية' }, { token: t.token, company: t.companyId });
    expect(br2.status).toBe(201);
    const bm = await userWithRole(t, 'branch_manager', { scopeType: 'branch', branchId: t.branchId });
    const own = await call('GET', `/api/v1/replenishment/suggestions?branchId=${t.branchId}`, undefined, { token: bm.token });
    expect(own.status).toBe(200);
    const other = await call('GET', `/api/v1/replenishment/suggestions?branchId=${br2.body.branchId}`, undefined, { token: bm.token });
    expect(other.status).toBe(403);
    const dash = await call('GET', `/api/v1/dashboard?from=2026-01-01&to=2026-12-31&branchId=${br2.body.branchId}`, undefined, { token: bm.token });
    expect(dash.status).toBe(403);
  });
});

describe('Permission matrix (SECURITY.md §3)', () => {
  it('cashier has no accounting access; clerk cannot post; controller cannot manage users', async () => {
    const t = await signup('perm');
    const cashier = await userWithRole(t, 'cashier', { scopeType: 'branch', branchId: t.branchId });
    for (const url of ['/api/v1/accounts', '/api/v1/journal-entries', '/api/v1/reports/trial-balance?from=2026-01-01&to=2026-12-31', '/api/v1/account-mappings']) {
      expect((await call('GET', url, undefined, { token: cashier.token })).status, url).toBe(403);
    }
    const clerk = await userWithRole(t, 'warehouse_clerk', { scopeType: 'branch', branchId: t.branchId });
    const accounts = await call('GET', '/api/v1/accounts', undefined, { token: t.token, company: t.companyId });
    const cash = accounts.body.find((a: { code: string }) => a.code === '1102').id, equity = accounts.body.find((a: { code: string }) => a.code === '3101').id;
    const je = await call('POST', '/api/v1/journal-entries', { date: '2026-11-01', memo: 'test', lines: [{ accountId: cash, debit: '10' }, { accountId: equity, credit: '10' }] }, { token: clerk.token, company: t.companyId });
    expect(je.status).toBe(403);
    const fc = await userWithRole(t, 'financial_controller', { scopeType: 'company' });
    expect((await call('POST', '/api/v1/users', { email: `x${Date.now()}@x.com`, fullName: 'x', password: 'Str0ngPassw0rd!' }, { token: fc.token })).status).toBe(403);
    expect((await call('GET', '/api/v1/reports/trial-balance?from=2026-01-01&to=2026-12-31', undefined, { token: fc.token })).status).toBe(200);
  });

  it('users cannot grant themselves roles; SoD conflicts are refused', async () => {
    const t = await signup('sod');
    const roles = (await call('GET', '/api/v1/roles', undefined, { token: t.token })).body;
    const fcRole = roles.find((r: { code: string }) => r.code === 'financial_controller').id;
    const self = await call('POST', `/api/v1/users/${t.userId}/assignments`, { roleId: fcRole, scopeType: 'company', companyId: t.companyId }, { token: t.token });
    expect(self.body.code).toBe('SELF_ASSIGNMENT_FORBIDDEN');
    const admin = await userWithRole(t, 'system_admin', { scopeType: 'company' });
    const r = await call('POST', `/api/v1/users/${admin.userId}/assignments`, { roleId: fcRole, scopeType: 'company', companyId: t.companyId }, { token: t.token });
    expect(r.body.code).toBe('SOD_CONFLICT');
  });
});

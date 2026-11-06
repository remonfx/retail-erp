import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { uuidv7 } from '@rc/domain';
import { buildApp } from '../src/app.js';
import { invalidateActorCache } from '../src/lib/actor.js';

let app: FastifyInstance | null = null;
export async function getApp() {
  if (!app) app = await buildApp({ logger: false, rateLimit: false });
  return app;
}

export interface Session { token: string; companyId?: string; userId: string; tenantId: string }
export interface CallOpts { token?: string; company?: string; device?: string; idem?: string | false; headers?: Record<string, string> }

export async function call<T = any>(method: string, url: string, body?: unknown, o: CallOpts = {}): Promise<{ status: number; body: T; headers: Record<string, unknown> }> {
  const a = await getApp();
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.device) headers.authorization = `Device ${o.device}`;
  if (o.company) headers['x-company-id'] = o.company;
  if (method !== 'GET' && o.idem !== false) headers['idempotency-key'] = o.idem ?? uuidv7();
  const res = await a.inject({ method: method as 'GET', url, payload: body === undefined ? undefined : (body as object), headers });
  let parsed: unknown = res.body;
  try { parsed = JSON.parse(res.body); } catch { /* raw */ }
  return { status: res.statusCode, body: parsed as T, headers: res.headers };
}

let counter = 0;
export async function signup(name = 'acme') {
  counter++;
  const slug = `${name}-${Date.now().toString(36)}-${counter}`;
  const email = `${slug}@example.com`;
  const r = await call('POST', '/api/v1/auth/signup', { tenantName: `${name} Retail`, slug, ownerName: 'Owner', email, password: 'Str0ngPassw0rd!', companyNameAr: 'شركة التجربة للتجارة', companyNameEn: 'Test Trading', branchNameAr: 'فرع القاهرة', branchCode: 'CAI01', planCode: 'enterprise' });
  if (r.status !== 201) throw new Error(`signup failed ${r.status} ${JSON.stringify(r.body)}`);
  return { token: r.body.accessToken as string, refresh: r.body.refreshToken as string, tenantId: r.body.tenantId as string, userId: r.body.userId as string, companyId: r.body.companyId as string, branchId: r.body.branchId as string, email };
}

/** Create a user with a role template at a scope and log in. */
export async function userWithRole(owner: { token: string; companyId: string }, role: string, scope: { scopeType: 'tenant' | 'company' | 'branch' | 'warehouse'; branchId?: string; warehouseId?: string; limits?: Record<string, number> }) {
  const email = `${role}-${uuidv7().slice(-12)}@example.com`;
  const u = await call('POST', '/api/v1/users', { email, fullName: `User ${role}`, password: 'Str0ngPassw0rd!' }, { token: owner.token });
  if (u.status !== 201) throw new Error(`create user ${u.status} ${JSON.stringify(u.body)}`);
  const roles = await call('GET', '/api/v1/roles', undefined, { token: owner.token });
  const roleId = roles.body.find((r: { code: string }) => r.code === role).id;
  const a = await call('POST', `/api/v1/users/${u.body.id}/assignments`, { roleId, scopeType: scope.scopeType, companyId: scope.scopeType === 'tenant' ? undefined : owner.companyId, branchId: scope.branchId, warehouseId: scope.warehouseId, limits: scope.limits ?? {} }, { token: owner.token });
  if (a.status !== 201) throw new Error(`assign ${a.status} ${JSON.stringify(a.body)}`);
  invalidateActorCache(u.body.id);
  const l = await call('POST', '/api/v1/auth/login', { email, password: 'Str0ngPassw0rd!' });
  return { token: l.body.accessToken as string, userId: u.body.id as string, email };
}

export async function refData(token: string) {
  const [uoms, taxes, cats] = await Promise.all([call('GET', '/api/v1/uoms', undefined, { token }), call('GET', '/api/v1/tax-classes', undefined, { token }), call('GET', '/api/v1/categories', undefined, { token })]);
  return {
    pcs: uoms.body.find((u: { code: string }) => u.code === 'PCS').id as string,
    kg: uoms.body.find((u: { code: string }) => u.code === 'KG').id as string,
    standard: taxes.body.find((t: { code: string }) => t.code === 'STANDARD').id as string,
    vat14: (taxes.body.find((t: { code: string }) => t.code === 'STANDARD').rates[0].id) as string,
    rootCategory: cats.body[0].id as string,
  };
}

let skuN = 0;
export async function product(s: { token: string; companyId: string }, opts: { price?: string; cost?: string; tracking?: 'none' | 'lot' | 'serial'; barcode?: string; name?: string } = {}) {
  const ref = await refData(s.token);
  skuN++;
  const sku = `SKU-${Date.now().toString(36)}-${skuN}`;
  const r = await call('POST', '/api/v1/products', {
    nameAr: opts.name ?? `منتج تجريبي ${skuN}`, nameEn: `Test product ${skuN}`, categoryId: ref.rootCategory, stockUomId: ref.pcs, taxClassId: ref.standard, tracking: opts.tracking ?? 'none',
    variants: [{ sku, barcodes: opts.barcode ? [{ code: opts.barcode }] : [], retailPrice: opts.price ?? '114.00', standardCost: opts.cost }],
  }, { token: s.token, company: s.companyId });
  if (r.status !== 201) throw new Error(`product ${r.status} ${JSON.stringify(r.body)}`);
  return { productId: r.body.id as string, variantId: r.body.variants[0].id as string, sku, ...ref };
}

export async function locations(s: { token: string; companyId: string }) {
  const r = await call('GET', '/api/v1/locations', undefined, { token: s.token, company: s.companyId });
  return r.body as { id: string; code: string; type: string; branch_id: string; warehouse_id: string }[];
}

export async function reasons(token: string) {
  const r = await call('GET', '/api/v1/inventory/reason-codes', undefined, { token });
  return Object.fromEntries((r.body as { code: string; id: string }[]).map((x) => [x.code, x.id])) as Record<string, string>;
}

export async function receiveOpening(s: { token: string; companyId: string }, locationId: string, variantId: string, qty: string, unitCost: string) {
  const rc = await reasons(s.token);
  const r = await call('POST', '/api/v1/stock-adjustments', { kind: 'adjustment', locationId, reasonCodeId: rc.OPENING, opening: true, lines: [{ variantId, qty, unitCost }] }, { token: s.token, company: s.companyId });
  if (r.status !== 201) throw new Error(`opening ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export function ownerPool() {
  return new pg.Pool({ connectionString: process.env.DATABASE_OWNER_URL, max: 2 });
}
export function appPool() {
  return new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
}

/**
 * End-to-end: real POS engine ↔ real API (in-process) ↔ real PostgreSQL.
 * Proves offline commit, durable queue, lost-ack retries without duplicates, power-loss atomicity, PIN login, close & GL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { argon2Verify } from 'hash-wasm';
import pg from 'pg';
import { uuidv7 } from '@rc/domain';
import { PosEngine, type Transport } from '../src/core/engine';
import { MemoryStore } from '../src/core/store';

process.env.DATABASE_URL ??= 'postgres://rc_app:rc_app_dev_password@localhost:5432/rc_test';
process.env.DATABASE_OWNER_URL ??= 'postgres://postgres:postgres@localhost:5432/rc_test';
process.env.VITEST = '1';

const { buildApp } = await import('../../api/src/app');
const { drainOutbox } = await import('../../api/src/lib/outbox');
const { closePool } = await import('../../api/src/lib/db');
const { migrate } = await import('../../api/src/migrate');

let app: Awaited<ReturnType<typeof buildApp>>;
let network: 'up' | 'down' | 'lose_ack' = 'up';
const API = 'http://inproc';
const transport: Transport = async (method, url, body, headers) => {
  if (network === 'down') throw new Error('NETWORK_DOWN');
  const r = await app.inject({ method, url: url.replace(API, ''), payload: body as object, headers });
  if (network === 'lose_ack') throw new Error('CONNECTION_RESET_AFTER_SEND');
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
async function call(method: string, url: string, body?: unknown, h: Record<string, string> = {}) {
  const r = await app.inject({ method: method as 'GET', url, payload: body as object, headers: { ...h, ...(method !== 'GET' ? { 'idempotency-key': uuidv7() } : {}) } });
  const b = r.body ? JSON.parse(r.body) : null;
  if (r.statusCode >= 400) throw new Error(`${url} ${r.statusCode} ${r.body}`);
  return b;
}

const store = new MemoryStore();
const engine = new PosEngine(store, transport);
let H: Record<string, string>, cashierId = '', variantId = '', ownerPool: pg.Pool;

beforeAll(async () => {
  ownerPool = new pg.Pool({ connectionString: process.env.DATABASE_OWNER_URL });
  const exists = (await ownerPool.query(`SELECT to_regclass('public.schema_migrations') AS t`)).rows[0].t;
  if (!exists) await migrate(process.env.DATABASE_OWNER_URL!, () => undefined);
  app = await buildApp({ logger: false, rateLimit: false });
  const s = await call('POST', '/api/v1/auth/signup', { tenantName: 'POS e2e', slug: `pose2e-${Date.now().toString(36)}`, ownerName: 'Owner', email: `pos${Date.now()}@e2e.test`, password: 'Str0ngPassw0rd!', companyNameAr: 'شركة', branchNameAr: 'فرع', branchCode: 'CAI01', planCode: 'enterprise' });
  H = { authorization: `Bearer ${s.accessToken}`, 'x-company-id': s.companyId };
  const [uoms, taxes, cats, locs, reasons, roles] = await Promise.all(['/api/v1/uoms', '/api/v1/tax-classes', '/api/v1/categories', '/api/v1/locations', '/api/v1/inventory/reason-codes', '/api/v1/roles'].map((u) => call('GET', u, undefined, H)));
  const p = await call('POST', '/api/v1/products', { nameAr: 'زيت عباد الشمس', categoryId: cats[0].id, stockUomId: uoms.find((u: any) => u.code === 'PCS').id, taxClassId: taxes.find((t: any) => t.code === 'STANDARD').id,
    variants: [{ sku: 'OIL-1L', barcodes: [{ code: '6221007012340' }], retailPrice: '89.00' }] }, H);
  variantId = p.variants[0].id;
  const stock = locs.find((l: any) => l.type === 'internal').id;
  await call('POST', '/api/v1/stock-adjustments', { kind: 'adjustment', locationId: stock, reasonCodeId: reasons.find((r: any) => r.code === 'OPENING').id, opening: true, lines: [{ variantId, qty: '100', unitCost: '60' }] }, H);
  const email = `cashier${Date.now()}@e2e.test`;
  const u = await call('POST', '/api/v1/users', { email, fullName: 'Cashier', password: 'Str0ngPassw0rd!' }, H);
  cashierId = u.id;
  await call('POST', `/api/v1/users/${u.id}/assignments`, { roleId: roles.find((r: any) => r.code === 'cashier').id, scopeType: 'branch', companyId: s.companyId, branchId: s.branchId, limits: { maxLineDiscountPercent: 5 } }, H);
  const login = await call('POST', '/api/v1/auth/login', { email, password: 'Str0ngPassw0rd!' });
  await call('POST', '/api/v1/auth/pos-pin', { pin: '482915', password: 'Str0ngPassw0rd!' }, { authorization: `Bearer ${login.accessToken}` });
  const d = await call('POST', '/api/v1/devices', { branchId: s.branchId, kind: 'pos', name: 'Till' }, H);
  await call('POST', '/api/v1/terminals', { branchId: s.branchId, code: 'T01', name: 'Till', deviceId: d.id }, H);
  await engine.enroll(API, d.id, d.enrollmentCode);
});
afterAll(async () => { await ownerPool.end(); await app.close(); await closePool(); });

const verify = (hash: string, pin: string) => argon2Verify({ hash, password: pin });

describe('POS engine end-to-end', () => {
  it('bootstraps config + master data and resolves barcodes/prices offline', async () => {
    await engine.refreshConfig();
    await engine.pullAll();
    const hit = engine.lookup('6221007012340');
    expect(hit?.variant.id).toBe(variantId);
    expect(engine.priceFor(variantId, '1')?.price).toBe('89.00');
    expect(engine.search('عباد')).toHaveLength(1);
  });

  it('cashier PIN login works offline from synced hash; wrong PIN rejected', async () => {
    await expect(engine.login(cashierId, '000000', verify)).rejects.toThrow('WRONG_PIN');
    await engine.login(cashierId, '482915', verify);
    expect(engine.cashier?.id).toBe(cashierId);
  });

  it('sells offline; queue is durable; discount above limit needs override', async () => {
    network = 'down';
    await engine.openSession('500');
    const l = engine.newLine(variantId, '2');
    await expect(engine.commit({ lines: [{ ...l, manualDiscountPercent: '20' }], tenders: [{ method: 'cash', amount: '200' }], offline: true })).rejects.toThrow('DISCOUNT_OVERRIDE_REQUIRED');
    for (let i = 0; i < 3; i++) {
      const o = await engine.commit({ lines: [engine.newLine(variantId, '1')], tenders: [{ method: 'cash', amount: '100' }], offline: true });
      expect(o.change).toBe('11.00');
    }
    const r = await engine.syncOnce();
    expect(r.error).toBe('NETWORK_DOWN');
    const st = await engine.syncStatus();
    expect(st.pending).toBe(4); // session_open + 3 sales
  });

  it('power loss during commit leaves no partial record', async () => {
    const before = (await engine.queue()).length;
    store.failNextTx = true;
    await expect(engine.commit({ lines: [engine.newLine(variantId, '1')], tenders: [{ method: 'card', amount: '89.00' }], offline: true })).rejects.toThrow('SIMULATED_POWER_LOSS');
    expect((await engine.queue()).length).toBe(before);
    expect((await store.all('orders')).length).toBe(3);
  });

  it('lost acknowledgements do not create duplicates on retry', async () => {
    network = 'lose_ack';
    const r1 = await engine.syncOnce();
    expect(r1.error).toBe('CONNECTION_RESET_AFTER_SEND');
    expect((await engine.syncStatus()).pending).toBe(4);
    network = 'up';
    const r2 = await engine.syncOnce();
    expect(r2).toMatchObject({ pushed: 4, acked: 4, retry: 0 });
    const ids = (await store.all<any>('orders')).map((o) => o.id);
    const n = (await ownerPool.query('SELECT count(*)::int AS n FROM pos_order WHERE id = ANY($1::uuid[])', [ids])).rows[0].n;
    expect(n).toBe(3);
  });

  it('return of a local receipt, close session, server Z matches local X, GL posted', async () => {
    const sale = (await store.all<any>('orders'))[0];
    const ret = await engine.commit({ kind: 'return', returnOfId: sale.id, lines: [{ ...engine.newLine(variantId, '1'), unitPrice: sale.lines[0].unitPrice, returnOfLineId: sale.lines[0].lineId }], tenders: [{ method: 'cash', amount: '89.00' }], offline: false });
    expect(ret.kind).toBe('return');
    await engine.cashMovement('safe_drop', '100', 'إيداع');
    const x = await engine.xReport();
    expect(x!.expectedCash).toBe((500 + 267 - 89 - 100).toFixed(2));
    const z = await engine.closeSession(x!.expectedCash);
    expect(z.difference).toBe('0.00');
    expect(await engine.syncOnce()).toMatchObject({ acked: 3, retry: 0 });
    await drainOutbox();
    const s = (await ownerPool.query('SELECT state, expected_cash, cash_difference, journal_entry_id FROM pos_session WHERE id = $1', [z.session!.id])).rows[0];
    expect(s.state).toBe('posted');
    expect(Number(s.expected_cash).toFixed(2)).toBe(x!.expectedCash);
    expect(Number(s.cash_difference)).toBe(0);
    expect(s.journal_entry_id).toBeTruthy();
  });
});

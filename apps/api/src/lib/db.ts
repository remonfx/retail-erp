import pg from 'pg';
import { config } from '../config.js';

// NUMERIC -> string (never JS float), bigint -> string, date -> 'YYYY-MM-DD'
pg.types.setTypeParser(1700, (v) => v);
pg.types.setTypeParser(20, (v) => v);
pg.types.setTypeParser(1082, (v) => v);

export type Tx = pg.PoolClient;
export interface DbContext { tenantId: string; userId?: string | null; companyIds?: string[] | '*'; requestId?: string; deviceId?: string | null; allowLockedPeriod?: boolean }

let pool: pg.Pool | null = null;
export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.poolMax, statement_timeout: config.statementTimeoutMs, application_name: 'rc-api' });
    pool.on('error', (e) => console.error('pg pool error', e.message));
  }
  return pool;
}
export async function closePool() { if (pool) { await pool.end(); pool = null; } }
export function setPool(p: pg.Pool) { pool = p; }

async function applyContext(client: Tx, ctx: DbContext | null) {
  const companies = ctx?.companyIds === '*' ? '*' : (ctx?.companyIds ?? []).join(',');
  await client.query(
    `SELECT set_config('rc.tenant_id', $1, true), set_config('rc.user_id', $2, true), set_config('rc.company_ids', $3, true),
            set_config('rc.request_id', $4, true), set_config('rc.device_id', $5, true), set_config('rc.allow_locked_period', $6, true)`,
    [ctx?.tenantId ?? '', ctx?.userId ?? '', companies, ctx?.requestId ?? '', ctx?.deviceId ?? '', ctx?.allowLockedPeriod ? 'on' : ''],
  );
}

/** Run fn in a transaction with RLS context. Retries serialization/deadlock failures up to 3 times. */
export async function withTx<T>(ctx: DbContext | null, fn: (tx: Tx) => Promise<T>, opts: { isolation?: 'read committed' | 'repeatable read' | 'serializable' } = {}): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await getPool().connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${(opts.isolation ?? 'read committed').toUpperCase()}`);
      await applyContext(client, ctx);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (e as { code?: string }).code;
      if ((code === '40001' || code === '40P01') && attempt < 3) continue;
      throw e;
    } finally {
      client.release();
    }
  }
}

export async function one<T = Record<string, unknown>>(tx: Tx, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await tx.query(sql, params);
  return (r.rows[0] as T) ?? null;
}
export async function many<T = Record<string, unknown>>(tx: Tx, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await tx.query(sql, params)).rows as T[];
}

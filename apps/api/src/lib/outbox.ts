/** Outbox relay + consumer (worker). Claims events across tenants, processes each under its tenant's RLS context. */
import { uuidv7 } from '@rc/domain';
import { withTx, getPool } from './db.js';
import { HANDLERS, type OutboxEvent } from '../modules/accounting/handlers.js';

const CONSUMER = 'gl-posting';
const MAX_ATTEMPTS_BEFORE_EXCEPTION = 5;

export async function processOutbox(limit = 50): Promise<{ processed: number; failed: number }> {
  const claimed = (await getPool().query<OutboxEvent & { attempts: number }>('SELECT * FROM outbox_claim($1)', [limit])).rows;
  let processed = 0, failed = 0;
  for (const e of claimed) {
    const ctx = { tenantId: e.tenant_id, companyIds: '*' as const };
    try {
      await withTx(ctx, async (tx) => {
        const seen = await tx.query('INSERT INTO core_processed_event (consumer, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING event_id', [CONSUMER, e.id]);
        if (seen.rowCount) {
          const h = HANDLERS[e.event_type];
          if (h) await h(tx, e);
        }
        await tx.query('UPDATE core_outbox_event SET processed_at = now(), last_error = NULL WHERE id = $1', [e.id]);
        await tx.query(`UPDATE acc_posting_exception SET status = 'resolved', resolved_at = now() WHERE source_event_id = $1 AND status <> 'resolved'`, [e.id]);
      });
      processed++;
    } catch (err) {
      failed++;
      const msg = (err as Error).message.slice(0, 2000);
      await withTx(ctx, async (tx) => {
        const backoffSec = Math.min(3600, 2 ** Math.min(e.attempts, 12));
        await tx.query(`UPDATE core_outbox_event SET last_error = $2, available_at = now() + ($3 || ' seconds')::interval WHERE id = $1`, [e.id, msg, String(backoffSec)]);
        if (e.attempts >= MAX_ATTEMPTS_BEFORE_EXCEPTION && e.company_id) {
          await tx.query(`INSERT INTO acc_posting_exception (id, tenant_id, company_id, source_event_id, event_type, payload, error) VALUES ($1,$2,$3,$4,$5,$6,$7)
                          ON CONFLICT (source_event_id) DO UPDATE SET error = EXCLUDED.error, status = 'open'`, [uuidv7(), e.tenant_id, e.company_id, e.id, e.event_type, JSON.stringify(e.payload), msg]);
        }
      }).catch(() => undefined);
    }
  }
  return { processed, failed };
}

/** Drain everything currently available (used by tests and admin "process now"). */
export async function drainOutbox(maxRounds = 50) {
  let total = { processed: 0, failed: 0 };
  for (let i = 0; i < maxRounds; i++) {
    const r = await processOutbox(200);
    total = { processed: total.processed + r.processed, failed: total.failed + r.failed };
    if (r.processed + r.failed === 0) break;
    if (r.processed === 0) break;
  }
  return total;
}

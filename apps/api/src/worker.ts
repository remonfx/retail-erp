/** Background worker: outbox → GL posting; partition maintenance. Run N replicas safely (SKIP LOCKED). */
import pg from 'pg';
import { processOutbox } from './lib/outbox.js';
import { closePool } from './lib/db.js';
import { config } from './config.js';

let running = true;
process.on('SIGTERM', () => { running = false; });
process.on('SIGINT', () => { running = false; });

async function maintainPartitions() {
  const c = new pg.Client({ connectionString: config.databaseOwnerUrl });
  await c.connect();
  try { const r = await c.query('SELECT rc_maintain_partitions(3) AS n'); console.log(`partitions created: ${r.rows[0].n}`); } finally { await c.end(); }
}

await maintainPartitions().catch((e) => console.error('partition maintenance failed', e.message));
let lastMaint = Date.now();
while (running) {
  try {
    const r = await processOutbox(100);
    if (r.processed + r.failed === 0) await new Promise((res) => setTimeout(res, 1000));
    if (r.failed) console.warn(`outbox: ${r.failed} failed`);
  } catch (e) {
    console.error('worker loop error', (e as Error).message);
    await new Promise((res) => setTimeout(res, 5000));
  }
  if (Date.now() - lastMaint > 6 * 3600_000) { lastMaint = Date.now(); await maintainPartitions().catch(() => undefined); }
}
await closePool();

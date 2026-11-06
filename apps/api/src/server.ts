import { buildApp } from './app.js';
import { config } from './config.js';
import { closePool } from './lib/db.js';

const app = await buildApp();
await app.listen({ port: config.port, host: config.host });
const shutdown = async () => { await app.close(); await closePool(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

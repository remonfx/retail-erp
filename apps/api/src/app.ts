import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { uuidv7 } from '@rc/domain';
import { createHash } from 'node:crypto';
import { config } from './config.js';
import { installErrorHandler } from './lib/http.js';
import authRoutes from './modules/auth.js';
import orgRoutes from './modules/org.js';
import catalogRoutes from './modules/catalog/routes.js';
import pricingRoutes from './modules/pricing/routes.js';
import inventoryRoutes from './modules/inventory/routes.js';
import purchasingRoutes from './modules/purchasing/routes.js';
import posRoutes from './modules/pos/routes.js';
import accountingRoutes from './modules/accounting/routes.js';
import workflowRoutes from './modules/workflow.js';
import reportingRoutes from './modules/reporting.js';
import hrRoutes from './modules/hr.js';
import navigationRoutes from './modules/navigation.js';
import { getPool } from './lib/db.js';

export async function buildApp(opts: { logger?: boolean; rateLimit?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? !process.env.VITEST,
    bodyLimit: 60 * 1024 * 1024,
    genReqId: (req) => (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].length <= 64 ? req.headers['x-request-id'] : uuidv7()),
    trustProxy: true,
  });
  await app.register(cors, { origin: config.corsOrigins, credentials: true, allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-company-id', 'x-request-id', 'if-match', 'x-client-version'] });
  if (opts.rateLimit ?? true) {
    // keyed per bearer/device credential (stores share one NAT IP), falling back to client IP
    await app.register(rateLimit, { global: true, max: Number(process.env.RATE_LIMIT_MAX ?? 1200), timeWindow: '1 minute', allowList: (req) => req.url === '/health' || req.url === '/ready',
      keyGenerator: (req) => { const a = req.headers.authorization; return a ? `a:${createHash('sha256').update(a).digest('base64url').slice(0, 22)}` : `ip:${req.ip}`; } });
  }
  installErrorHandler(app);
  app.addHook('onSend', async (req, reply) => { reply.header('x-request-id', req.id); reply.header('x-content-type-options', 'nosniff'); reply.header('referrer-policy', 'no-referrer'); });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async () => { await getPool().query('SELECT 1'); return { status: 'ready' }; });

  for (const r of [authRoutes, orgRoutes, catalogRoutes, pricingRoutes, inventoryRoutes, purchasingRoutes, posRoutes, accountingRoutes, workflowRoutes, reportingRoutes, hrRoutes, navigationRoutes]) await app.register(r);
  return app;
}

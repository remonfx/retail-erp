export const config = {
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://rc_app:rc_app_dev_password@localhost:5432/rc_dev',
  databaseOwnerUrl: process.env.DATABASE_OWNER_URL ?? 'postgres://postgres:postgres@localhost:5432/rc_dev',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-secret-change-me-dev-only-secret-change-me',
  mfaEncryptionKey: process.env.MFA_ENCRYPTION_KEY ?? 'dev-only-32-byte-key-change-me!!',
  accessTokenTtlSec: Number(process.env.ACCESS_TOKEN_TTL ?? 600),
  refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 14),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000,http://localhost:1420').split(','),
  poolMax: Number(process.env.DB_POOL_MAX ?? 20),
  statementTimeoutMs: Number(process.env.STATEMENT_TIMEOUT_MS ?? 15000),
  isProd: process.env.NODE_ENV === 'production',
};

if (config.isProd && (config.jwtSecret.startsWith('dev-only') || config.mfaEncryptionKey.startsWith('dev-only'))) {
  throw new Error('JWT_SECRET and MFA_ENCRYPTION_KEY must be set in production');
}

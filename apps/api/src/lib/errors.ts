export class AppError extends Error {
  constructor(public code: string, public status = 422, message?: string, public details?: unknown) {
    super(message ?? code);
  }
}
export const notFound = (what = 'RESOURCE') => new AppError(`${what}_NOT_FOUND`, 404);
export const forbidden = (perm?: string) => new AppError('FORBIDDEN', 403, perm ? `Missing permission ${perm}` : undefined);
export const conflict = (code: string, msg?: string) => new AppError(code, 409, msg);
export const invalid = (code: string, msg?: string, details?: unknown) => new AppError(code, 422, msg, details);

interface PgErr { code?: string; message: string; constraint?: string; detail?: string }

/** Map PostgreSQL errors to stable API errors. */
export function fromPg(e: unknown): AppError | null {
  const err = e as PgErr;
  if (!err || typeof err.code !== 'string') return null;
  switch (err.code) {
    case '23505': return new AppError('DUPLICATE', 409, err.detail ?? err.message, { constraint: err.constraint });
    case '23503': return new AppError('REFERENCE_INVALID', 422, err.detail ?? err.message, { constraint: err.constraint });
    case '23514': return new AppError('CHECK_VIOLATION', 422, err.message, { constraint: err.constraint });
    case '23P01': return new AppError('OVERLAP', 409, err.detail ?? err.message, { constraint: err.constraint });
    case '22P02': return new AppError('INVALID_INPUT', 422, err.message);
    case '42501': return new AppError('FORBIDDEN', 403, 'Row-level security violation');
    case '40001': case '40P01': return new AppError('RETRY', 503, 'Concurrent update, retry');
    case '57014': return new AppError('TIMEOUT', 503, 'Query timeout');
    case 'P0001': {
      const m = /^([A-Z_]+)(:|$)/.exec(err.message);
      return new AppError(m?.[1] ?? 'DB_RULE', 422, err.message);
    }
    default: return null;
  }
}

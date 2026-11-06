import type { Tx } from './db.js';

const PREFIX: Record<string, string> = {
  PO: 'PO', PR: 'PR', GRN: 'GRN', PINV: 'PINV', PRET: 'PRET', PAY: 'PAY', RCPT: 'RCV', EXP: 'EXP',
  ADJ: 'ADJ', TRF: 'TRF', SCR: 'SCR', CNT: 'CNT', SES: 'SES', RCV: 'IN', STK: 'STK',
};

/** Gapless per company/doc type/branch/year: e.g. PO-CAI01-2026-000042 */
export async function nextNumber(tx: Tx, tenantId: string, companyId: string, doc: keyof typeof PREFIX | string, branchCode = '', date = new Date()): Promise<string> {
  const year = String(date.getUTCFullYear());
  const prefix = `${PREFIX[doc] ?? doc}-${branchCode ? branchCode + '-' : ''}${year}-`;
  const r = await tx.query<{ n: string }>('SELECT rc_next_number($1,$2,$3,$4,$5,$6) AS n', [tenantId, companyId, doc, branchCode, year, prefix]);
  return r.rows[0]!.n;
}

export async function branchCode(tx: Tx, branchId: string): Promise<string> {
  const r = await tx.query<{ code: string }>('SELECT code FROM core_branch WHERE id = $1', [branchId]);
  return r.rows[0]?.code ?? '';
}

/**
 * Posting engine (ACCOUNTING_RULES.md §2). Builds balanced journal entries from signed amounts
 * (+ = debit, − = credit), resolves accounts through mappings, enforces idempotency via
 * acc_posting_registry, and relies on DB triggers for balance/period/immutability guarantees.
 */
import { uuidv7, dec, ZERO, fmt, type Dec, type DecInput } from '@rc/domain';
import type { Tx } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';

export interface Dims { branchId?: string | null; costCenterId?: string | null; partnerId?: string | null; taxRateId?: string | null; variantId?: string | null }
export interface PostingLine extends Dims {
  key?: string;                     // mapping key, e.g. 'sales.revenue'
  accountId?: string;               // explicit account
  amount: DecInput;                 // signed: + debit / − credit
  mapping?: { categoryId?: string | null; tenderMethod?: string | null; reasonCodeId?: string | null };
  taxBase?: DecInput | null;
  quantity?: DecInput | null;
  label?: string | null;
  dueDate?: string | null;
}
export interface PostEntryInput {
  tenantId: string; companyId: string; journalCode: string; date: string;
  sourceType: string; sourceId?: string | null; sourceEventId?: string | null;
  rule: string; ruleVersion?: number; memo?: string | null; createdBy: string;
  lines: PostingLine[];
  reversalOf?: { id: string; date: string } | null;
}

const mappingCache = new Map<string, { at: number; rows: { key: string; branch_id: string | null; category_id: string | null; tender_method: string | null; tax_rate_id: string | null; reason_code_id: string | null; account_id: string }[] }>();
export function clearMappingCache() { mappingCache.clear(); }

export async function resolveAccount(tx: Tx, companyId: string, key: string, dims: { branchId?: string | null; categoryId?: string | null; tenderMethod?: string | null; taxRateId?: string | null; reasonCodeId?: string | null } = {}): Promise<string> {
  let c = mappingCache.get(companyId);
  if (!c || Date.now() - c.at > 60_000) {
    c = { at: Date.now(), rows: (await tx.query('SELECT key, branch_id, category_id, tender_method, tax_rate_id, reason_code_id, account_id FROM acc_account_mapping WHERE company_id = $1', [companyId])).rows };
    mappingCache.set(companyId, c);
  }
  let best: { score: number; account: string } | null = null;
  for (const r of c.rows) {
    if (r.key !== key) continue;
    const checks: [string | null, string | null | undefined][] = [[r.branch_id, dims.branchId], [r.category_id, dims.categoryId], [r.tender_method, dims.tenderMethod], [r.tax_rate_id, dims.taxRateId], [r.reason_code_id, dims.reasonCodeId]];
    if (checks.some(([m, d]) => m !== null && m !== d)) continue;
    const score = checks.filter(([m]) => m !== null).length;
    if (!best || score > best.score) best = { score, account: r.account_id };
  }
  if (!best) throw new AppError('ACCOUNT_MAPPING_MISSING', 422, `No account mapping for ${key}`);
  return best.account;
}

const ccCache = new Map<string, string | null>();
async function branchCostCenter(tx: Tx, branchId: string): Promise<string | null> {
  if (!ccCache.has(branchId)) ccCache.set(branchId, (await tx.query('SELECT id FROM core_cost_center WHERE branch_id = $1 AND active ORDER BY code LIMIT 1', [branchId])).rows[0]?.id ?? null);
  return ccCache.get(branchId)!;
}

/** Resolve the posting date: if the period is hard-locked, post on the first day of the next open period (late posting). */
async function effectiveDate(tx: Tx, companyId: string, date: string): Promise<{ date: string; late: boolean }> {
  const p = (await tx.query(`SELECT state FROM acc_fiscal_period WHERE company_id = $1 AND $2::date BETWEEN start_date AND end_date`, [companyId, date])).rows[0];
  if (!p) throw new AppError('NO_FISCAL_PERIOD', 422, `No fiscal period for ${date}`);
  if (p.state === 'open') return { date, late: false };
  const next = (await tx.query(`SELECT start_date FROM acc_fiscal_period WHERE company_id = $1 AND state = 'open' AND start_date > $2::date ORDER BY start_date LIMIT 1`, [companyId, date])).rows[0];
  if (!next) throw new AppError('NO_OPEN_PERIOD', 422, `No open period after ${date}`);
  return { date: next.start_date, late: true };
}

export async function postEntry(tx: Tx, input: PostEntryInput): Promise<{ entryId: string; postingDate: string; duplicate: boolean; number: string | null }> {
  if (input.sourceEventId) {
    const prev = (await tx.query('SELECT entry_id, posting_date FROM acc_posting_registry WHERE source_event_id = $1', [input.sourceEventId])).rows[0];
    if (prev) return { entryId: prev.entry_id, postingDate: prev.posting_date, duplicate: true, number: null };
  }
  const journal = (await tx.query('SELECT id FROM acc_journal WHERE company_id = $1 AND code = $2', [input.companyId, input.journalCode])).rows[0];
  if (!journal) throw new AppError('JOURNAL_NOT_FOUND', 422, input.journalCode);

  // resolve + aggregate
  const agg = new Map<string, { accountId: string; amount: Dec; dims: Dims; taxBase: Dec | null; qty: Dec | null; label: string | null; dueDate: string | null }>();
  for (const l of input.lines) {
    const amount = dec(l.amount).toDecimalPlaces(4);
    if (amount.isZero()) continue;
    const accountId = l.accountId ?? await resolveAccount(tx, input.companyId, l.key!, { branchId: l.branchId, ...l.mapping, taxRateId: l.taxRateId });
    const acc = (await tx.query('SELECT type FROM acc_account WHERE id = $1', [accountId])).rows[0];
    const costCenterId = l.costCenterId ?? (l.branchId && acc && ['income', 'expense'].includes(acc.type) ? await branchCostCenter(tx, l.branchId) : null);
    const dims: Dims = { branchId: l.branchId ?? null, costCenterId, partnerId: l.partnerId ?? null, taxRateId: l.taxRateId ?? null, variantId: l.variantId ?? null };
    const k = [accountId, dims.branchId, dims.costCenterId, dims.partnerId, dims.taxRateId, dims.variantId, l.label ?? '', l.dueDate ?? ''].join('|');
    const prev = agg.get(k);
    if (prev) {
      prev.amount = prev.amount.add(amount);
      if (l.taxBase != null) prev.taxBase = (prev.taxBase ?? ZERO).add(dec(l.taxBase));
      if (l.quantity != null) prev.qty = (prev.qty ?? ZERO).add(dec(l.quantity));
    } else agg.set(k, { accountId, amount, dims, taxBase: l.taxBase != null ? dec(l.taxBase) : null, qty: l.quantity != null ? dec(l.quantity) : null, label: l.label ?? null, dueDate: l.dueDate ?? null });
  }
  const lines = [...agg.values()].filter((l) => !l.amount.isZero());
  const total = lines.reduce<Dec>((s, l) => s.add(l.amount), ZERO);
  if (!total.isZero()) throw new AppError('UNBALANCED_ENTRY', 422, `Entry for ${input.sourceType}/${input.sourceId} out of balance by ${total.toFixed(4)}`);
  if (lines.length < 2) return { entryId: '', postingDate: input.date, duplicate: false, number: null }; // nothing to post (all zero)

  const { date, late } = await effectiveDate(tx, input.companyId, input.date);
  const entryId = uuidv7();
  await tx.query(`INSERT INTO acc_journal_entry (id, posting_date, tenant_id, company_id, journal_id, state, source_type, source_id, source_event_id, posting_rule, posting_rule_version, memo, late_posting, created_by, reversal_of_id, reversal_of_date)
                  VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [entryId, date, input.tenantId, input.companyId, journal.id, input.sourceType, input.sourceId ?? null, input.sourceEventId ?? null, input.rule, input.ruleVersion ?? 1, input.memo ?? null, late, input.createdBy,
     input.reversalOf?.id ?? null, input.reversalOf?.date ?? null]);
  await tx.query(`INSERT INTO acc_journal_line (id, posting_date, entry_id, tenant_id, company_id, account_id, debit, credit, currency, partner_id, branch_id, cost_center_id, tax_rate_id, tax_base, variant_id, quantity, label, due_date)
                  SELECT x.id, $1, $2, $3, $4, x.account_id, x.debit, x.credit, 'EGP', x.partner_id, x.branch_id, x.cost_center_id, x.tax_rate_id, x.tax_base, x.variant_id, x.quantity, x.label, x.due_date
                    FROM json_to_recordset($5::json) AS x(id uuid, account_id uuid, debit numeric, credit numeric, partner_id uuid, branch_id uuid, cost_center_id uuid, tax_rate_id uuid, tax_base numeric, variant_id uuid, quantity numeric, label text, due_date date)`,
    [date, entryId, input.tenantId, input.companyId, JSON.stringify(lines.map((l) => ({
      id: uuidv7(), account_id: l.accountId, debit: l.amount.gt(0) ? fmt(l.amount, 4) : '0', credit: l.amount.lt(0) ? fmt(l.amount.neg(), 4) : '0',
      partner_id: l.dims.partnerId, branch_id: l.dims.branchId, cost_center_id: l.dims.costCenterId, tax_rate_id: l.dims.taxRateId,
      tax_base: l.taxBase ? fmt(l.taxBase, 4) : null, variant_id: l.dims.variantId, quantity: l.qty ? fmt(l.qty, 6) : null, label: l.label, due_date: l.dueDate,
    })))]);
  const posted = await tx.query(`UPDATE acc_journal_entry SET state = 'posted' WHERE id = $1 AND posting_date = $2 RETURNING number`, [entryId, date]);
  if (input.sourceEventId) await tx.query('INSERT INTO acc_posting_registry (source_event_id, tenant_id, entry_id, posting_date) VALUES ($1,$2,$3,$4)', [input.sourceEventId, input.tenantId, entryId, date]);
  return { entryId, postingDate: date, duplicate: false, number: posted.rows[0]?.number ?? null };
}

/** Reverse a posted entry: mirror lines in an open period, link both, flag original as reversed. */
export async function reverseEntry(tx: Tx, a: { tenantId: string; companyId: string; entryId: string; reversalDate: string; reason: string; userId: string }) {
  const e = (await tx.query(`SELECT e.*, j.code AS journal_code FROM acc_journal_entry e JOIN acc_journal j ON j.id = e.journal_id WHERE e.id = $1 AND e.company_id = $2`, [a.entryId, a.companyId])).rows[0];
  if (!e) throw new AppError('ENTRY_NOT_FOUND', 404);
  if (e.state !== 'posted') throw new AppError('ENTRY_NOT_REVERSIBLE', 409, `Entry is ${e.state}`);
  const lines = (await tx.query('SELECT * FROM acc_journal_line WHERE entry_id = $1 AND posting_date = $2', [e.id, e.posting_date])).rows;
  const r = await postEntry(tx, {
    tenantId: a.tenantId, companyId: a.companyId, journalCode: e.journal_code, date: a.reversalDate, sourceType: 'reversal', sourceId: e.id,
    rule: 'reversal', memo: `عكس قيد ${e.number}: ${a.reason}`, createdBy: a.userId, reversalOf: { id: e.id, date: e.posting_date },
    lines: lines.map((l) => ({ accountId: l.account_id, amount: dec(l.credit).sub(dec(l.debit)), branchId: l.branch_id, costCenterId: l.cost_center_id, partnerId: l.partner_id, taxRateId: l.tax_rate_id, variantId: l.variant_id, label: l.label })),
  });
  await tx.query(`UPDATE acc_journal_entry SET state = 'reversed', reversed_by_id = $3 WHERE id = $1 AND posting_date = $2`, [e.id, e.posting_date, r.entryId]);
  return r;
}

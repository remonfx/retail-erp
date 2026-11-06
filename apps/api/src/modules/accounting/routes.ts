import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { uuidv7, uuid, isoDate, positiveDecimal, nonNegDecimal, decimalStr, dec, fmt, ZERO, sum, roundMoney, type Dec } from '@rc/domain';
import { route, audit, emit, pageQuery, decodeCursor, page } from '../../lib/http.js';
import { require as requirePerm, can } from '../../lib/actor.js';
import { AppError, invalid, notFound, forbidden } from '../../lib/errors.js';
import type { Tx } from '../../lib/db.js';
import { nextNumber, branchCode } from '../../lib/numbering.js';
import { postEntry, reverseEntry, clearMappingCache } from './posting.js';
import { drainOutbox } from '../../lib/outbox.js';

const dateRange = z.object({ from: isoDate, to: isoDate, branchId: uuid.optional(), costCenterId: uuid.optional() });
const isMonthAligned = (from: string, to: string) => from.endsWith('-01') && new Date(Date.parse(to) + 86400000).getUTCDate() === 1;

/** Per-account debit/credit totals for [from, to] (fast path through monthly balances when aligned). */
export async function accountTotals(tx: Tx, companyId: string, from: string | null, to: string, branchId?: string | null, costCenterId?: string | null) {
  if (from && isMonthAligned(from, to) || (!from && new Date(Date.parse(to) + 86400000).getUTCDate() === 1)) {
    return (await tx.query(`SELECT account_id, sum(debit) AS debit, sum(credit) AS credit FROM acc_account_balance WHERE company_id = $1 AND ($2::date IS NULL OR period_month >= $2) AND period_month <= date_trunc('month', $3::date)
        AND ($4::uuid IS NULL OR branch_id = $4) AND ($5::uuid IS NULL OR cost_center_id = $5) GROUP BY account_id`, [companyId, from, to, branchId ?? null, costCenterId ?? null])).rows;
  }
  return (await tx.query(`SELECT l.account_id, sum(l.debit) AS debit, sum(l.credit) AS credit FROM acc_journal_line l JOIN acc_journal_entry e ON e.id = l.entry_id AND e.posting_date = l.posting_date
      WHERE l.company_id = $1 AND e.state <> 'draft' AND ($2::date IS NULL OR l.posting_date >= $2) AND l.posting_date <= $3 AND ($4::uuid IS NULL OR l.branch_id = $4) AND ($5::uuid IS NULL OR l.cost_center_id = $5)
      GROUP BY l.account_id`, [companyId, from, to, branchId ?? null, costCenterId ?? null])).rows;
}

async function accounts(tx: Tx, companyId: string) {
  return new Map((await tx.query('SELECT id, code, name_ar, name_en, type, subtype, cash_flow_group, is_postable FROM acc_account WHERE company_id = $1 ORDER BY code', [companyId])).rows.map((a) => [a.id, a]));
}
const prevDay = (d: string) => new Date(Date.parse(d) - 86400000).toISOString().slice(0, 10);

export async function trialBalance(tx: Tx, companyId: string, from: string, to: string, branchId?: string | null) {
  const accs = await accounts(tx, companyId);
  const opening = new Map((await accountTotals(tx, companyId, null, prevDay(from), branchId)).map((r) => [r.account_id, dec(r.debit).sub(dec(r.credit))]));
  const period = new Map((await accountTotals(tx, companyId, from, to, branchId)).map((r) => [r.account_id, r]));
  const rows = [...accs.values()].filter((a) => a.is_postable).map((a) => {
    const isPL = a.type === 'income' || a.type === 'expense';
    const op = isPL ? ZERO : (opening.get(a.id) ?? ZERO); // P&L accounts restart each fiscal year (simplified: report period)
    const p = period.get(a.id);
    const d = dec(p?.debit ?? 0), c = dec(p?.credit ?? 0);
    const close = op.add(d).sub(c);
    return { accountId: a.id, code: a.code, nameAr: a.name_ar, nameEn: a.name_en, type: a.type, opening: fmt(op, 2), debit: fmt(d, 2), credit: fmt(c, 2), closing: fmt(close, 2) };
  }).filter((r) => r.opening !== '0.00' || r.debit !== '0.00' || r.credit !== '0.00');
  const totals = { debit: fmt(sum(rows.map((r) => r.debit)), 2), credit: fmt(sum(rows.map((r) => r.credit)), 2) };
  return { from, to, rows, totals, balanced: totals.debit === totals.credit };
}

export async function incomeStatement(tx: Tx, companyId: string, from: string, to: string, branchId?: string | null) {
  const accs = await accounts(tx, companyId);
  const t = await accountTotals(tx, companyId, from, to, branchId);
  const g: Record<string, Dec> = { revenue: ZERO, contra: ZERO, cogs: ZERO, otherIncome: ZERO, opex: ZERO };
  const lines: { code: string; nameAr: string; nameEn: string; group: string; amount: string }[] = [];
  for (const r of t) {
    const a = accs.get(r.account_id);
    if (!a || (a.type !== 'income' && a.type !== 'expense')) continue;
    const bal = dec(r.credit).sub(dec(r.debit)); // income positive
    const group = a.type === 'income' ? (a.subtype === 'revenue' ? 'revenue' : a.subtype === 'contra_revenue' ? 'contra' : 'otherIncome') : (a.subtype === 'cogs' ? 'cogs' : 'opex');
    g[group] = g[group]!.add(bal);
    lines.push({ code: a.code, nameAr: a.name_ar, nameEn: a.name_en, group, amount: fmt(a.type === 'income' ? bal : bal.neg(), 2) });
  }
  const netSales = g.revenue!.add(g.contra!);
  const grossProfit = netSales.add(g.cogs!);
  const netProfit = grossProfit.add(g.otherIncome!).add(g.opex!);
  return { from, to, lines: lines.sort((a, b) => a.code.localeCompare(b.code)),
    summary: { grossSales: fmt(g.revenue!, 2), discountsAndReturns: fmt(g.contra!.neg(), 2), netSales: fmt(netSales, 2), cogs: fmt(g.cogs!.neg(), 2), grossProfit: fmt(grossProfit, 2),
      grossMarginPct: netSales.isZero() ? '0.00' : fmt(grossProfit.div(netSales).mul(100), 2), otherIncome: fmt(g.otherIncome!, 2), operatingExpenses: fmt(g.opex!.neg(), 2), netProfit: fmt(netProfit, 2) } };
}

export async function balanceSheet(tx: Tx, companyId: string, asOf: string) {
  const accs = await accounts(tx, companyId);
  const t = await accountTotals(tx, companyId, null, asOf);
  const groups: Record<string, { code: string; nameAr: string; nameEn: string; amount: string }[]> = { asset: [], liability: [], equity: [] };
  let assets = ZERO, liabilities = ZERO, equity = ZERO, earnings = ZERO;
  for (const r of t) {
    const a = accs.get(r.account_id);
    if (!a) continue;
    const dr = dec(r.debit).sub(dec(r.credit));
    if (a.type === 'income' || a.type === 'expense') { earnings = earnings.sub(dr); continue; }
    const amount = a.type === 'asset' ? dr : dr.neg();
    if (a.type === 'asset') assets = assets.add(amount); else if (a.type === 'liability') liabilities = liabilities.add(amount); else equity = equity.add(amount);
    if (!amount.isZero()) groups[a.type]!.push({ code: a.code, nameAr: a.name_ar, nameEn: a.name_en, amount: fmt(amount, 2) });
  }
  groups.equity!.push({ code: '—', nameAr: 'أرباح الفترة غير المرحلة', nameEn: 'Unclosed earnings', amount: fmt(earnings, 2) });
  const totalEq = equity.add(earnings);
  return { asOf, groups, totals: { assets: fmt(assets, 2), liabilities: fmt(liabilities, 2), equity: fmt(totalEq, 2), liabilitiesAndEquity: fmt(liabilities.add(totalEq), 2) }, balanced: assets.eq(liabilities.add(totalEq)) };
}

export async function cashFlow(tx: Tx, companyId: string, from: string, to: string) {
  const accs = await accounts(tx, companyId);
  const t = await accountTotals(tx, companyId, from, to);
  let netIncome = ZERO, cashChange = ZERO;
  const sections: Record<string, Dec> = { operating: ZERO, investing: ZERO, financing: ZERO, non_cash: ZERO };
  const detail: { code: string; nameAr: string; section: string; amount: string }[] = [];
  for (const r of t) {
    const a = accs.get(r.account_id);
    if (!a) continue;
    const dr = dec(r.debit).sub(dec(r.credit));
    if (a.type === 'income' || a.type === 'expense') { netIncome = netIncome.sub(dr); continue; }
    if (a.cash_flow_group === 'cash') { cashChange = cashChange.add(dr); continue; }
    const section = a.cash_flow_group ?? 'operating';
    sections[section] = sections[section]!.add(dr.neg());
    if (!dr.isZero()) detail.push({ code: a.code, nameAr: a.name_ar, section, amount: fmt(dr.neg(), 2) });
  }
  const operating = netIncome.add(sections.operating!).add(sections.non_cash!);
  const computed = operating.add(sections.investing!).add(sections.financing!);
  return { from, to, method: 'indirect', netIncome: fmt(netIncome, 2), operating: fmt(operating, 2), investing: fmt(sections.investing!, 2), financing: fmt(sections.financing!, 2),
    netChangeInCash: fmt(computed, 2), cashAccountsChange: fmt(cashChange, 2), reconciles: computed.eq(cashChange), detail };
}

/** Inventory sub-ledger vs GL (must be equal before hard-locking a period). */
export async function inventoryReconciliation(tx: Tx, companyId: string) {
  const sub = (await tx.query(`SELECT coalesce(sum(value), 0) AS v FROM inv_product_cost WHERE company_id = $1`, [companyId])).rows[0].v;
  const gl = (await tx.query(`SELECT coalesce(sum(b.debit - b.credit), 0) AS v FROM acc_account_balance b JOIN acc_account a ON a.id = b.account_id WHERE b.company_id = $1 AND a.subtype = 'inventory'`, [companyId])).rows[0].v;
  const pending = (await tx.query(`SELECT count(*)::int AS n FROM core_outbox_event WHERE company_id = $1 AND processed_at IS NULL`, [companyId])).rows[0].n;
  return { subledger: fmt(sub, 2), gl: fmt(gl, 2), difference: fmt(dec(sub).sub(dec(gl)), 2), pendingPostings: pending, reconciled: dec(sub).sub(dec(gl)).abs().lt('0.01') };
}

export const paymentApproval = async (tx: Tx, docId: string, userId: string, approved: boolean) => {
  const p = (await tx.query(`SELECT * FROM acc_payment WHERE id = $1 AND state = 'pending_approval' FOR UPDATE`, [docId])).rows[0];
  if (!p) throw new AppError('PAYMENT_NOT_PENDING', 409);
  if (!approved) { await tx.query(`UPDATE acc_payment SET state = 'cancelled' WHERE id = $1`, [docId]); return; }
  await tx.query(`UPDATE acc_payment SET state = 'approved', approved_by = $2 WHERE id = $1`, [docId, userId]);
  await postPayment(tx, p);
};
export const expenseApproval = async (tx: Tx, docId: string, userId: string, approved: boolean) => {
  const x = (await tx.query(`SELECT * FROM acc_expense WHERE id = $1 AND state = 'pending_approval' FOR UPDATE`, [docId])).rows[0];
  if (!x) throw new AppError('EXPENSE_NOT_PENDING', 409);
  await tx.query(`UPDATE acc_expense SET state = $2, approved_by = $3 WHERE id = $1`, [docId, approved ? 'approved' : 'rejected', userId]);
  if (approved) await emit(tx, { id: uuidv7(), tenantId: x.tenant_id, companyId: x.company_id, aggregateType: 'expense', aggregateId: x.id, type: 'accounting.expense_posted', payload: { expenseId: x.id } });
};

async function postPayment(tx: Tx, p: Record<string, any>) {
  const allocs = (await tx.query('SELECT * FROM acc_payment_allocation WHERE payment_id = $1', [p.id])).rows;
  for (const a of allocs) {
    if (a.invoice_type === 'supplier_invoice') {
      const r = await tx.query(`UPDATE pur_invoice SET amount_paid = amount_paid + $2 WHERE id = $1 AND state = 'posted' AND amount_paid + $2 <= total`, [a.invoice_id, a.amount]);
      if (!r.rowCount) throw new AppError('ALLOCATION_EXCEEDS_BALANCE', 409, `Invoice ${a.invoice_id}`);
    }
  }
  await tx.query(`UPDATE acc_payment SET state = 'posted', posted_at = now() WHERE id = $1`, [p.id]);
  await emit(tx, { id: uuidv7(), tenantId: p.tenant_id, companyId: p.company_id, aggregateType: 'payment', aggregateId: p.id, type: 'accounting.payment_posted', payload: { paymentId: p.id } });
}

export default async function accountingRoutes(app: FastifyInstance) {
  route(app, 'GET', '/api/v1/accounts', { perm: 'accounting.read' }, async ({ tx, companyId }) => (await tx.query('SELECT * FROM acc_account WHERE company_id = $1 ORDER BY code', [companyId])).rows);
  route(app, 'POST', '/api/v1/accounts', { perm: 'accounting.coa.manage', body: z.object({ code: z.string().regex(/^\d{1,10}$/), nameAr: z.string(), nameEn: z.string().optional(), type: z.enum(['asset', 'liability', 'equity', 'income', 'expense']), subtype: z.string().default('other'), cashFlowGroup: z.enum(['cash', 'operating', 'investing', 'financing', 'non_cash']).default('operating'), parentId: uuid.optional(), reconcilable: z.boolean().default(false) }) }, async ({ tx, actor, companyId, body, reply }) => {
    const id = uuidv7();
    await tx.query(`INSERT INTO acc_account (id, tenant_id, company_id, code, name_ar, name_en, type, subtype, cash_flow_group, parent_id, reconcilable) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, actor.tenantId, companyId, body.code, body.nameAr, body.nameEn ?? null, body.type, body.subtype, body.cashFlowGroup, body.parentId ?? null, body.reconcilable]);
    reply.code(201);
    return { id };
  });
  route(app, 'GET', '/api/v1/account-mappings', { perm: 'accounting.read' }, async ({ tx, companyId }) => (await tx.query(`SELECT m.*, a.code AS account_code, a.name_ar AS account_name FROM acc_account_mapping m JOIN acc_account a ON a.id = m.account_id WHERE m.company_id = $1 ORDER BY m.key`, [companyId])).rows);
  route(app, 'PUT', '/api/v1/account-mappings', { perm: 'accounting.posting_rules.manage', body: z.object({ key: z.string(), accountId: uuid, branchId: uuid.nullish(), categoryId: uuid.nullish(), tenderMethod: z.string().nullish(), taxRateId: uuid.nullish(), reasonCodeId: uuid.nullish() }) }, async ({ tx, actor, companyId, body }) => {
    const acc = (await tx.query('SELECT is_postable FROM acc_account WHERE id = $1 AND company_id = $2', [body.accountId, companyId])).rows[0];
    if (!acc?.is_postable) throw invalid('ACCOUNT_NOT_POSTABLE');
    await tx.query(`INSERT INTO acc_account_mapping (id, tenant_id, company_id, key, branch_id, category_id, tender_method, tax_rate_id, reason_code_id, account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                    ON CONFLICT (company_id, key, branch_id, category_id, tender_method, tax_rate_id, reason_code_id) DO UPDATE SET account_id = EXCLUDED.account_id`,
      [uuidv7(), actor.tenantId, companyId, body.key, body.branchId ?? null, body.categoryId ?? null, body.tenderMethod ?? null, body.taxRateId ?? null, body.reasonCodeId ?? null, body.accountId]);
    clearMappingCache();
    return { ok: true };
  });

  // ---------- journal entries ----------
  route(app, 'GET', '/api/v1/journal-entries', { perm: 'accounting.read', query: pageQuery.extend({ from: isoDate.optional(), to: isoDate.optional(), journal: z.string().optional(), sourceType: z.string().optional(), state: z.string().optional() }) }, async ({ tx, companyId, query }) => {
    const cur = decodeCursor(query.cursor);
    const rows = (await tx.query(`SELECT e.id, e.posting_date, e.number, e.state, e.source_type, e.source_id, e.memo, e.total_debit, e.total_credit, e.late_posting, e.reversal_of_id, e.reversed_by_id, j.code AS journal_code, e.posted_at, e.posting_date::text || e.id::text AS sort
      FROM acc_journal_entry e JOIN acc_journal j ON j.id = e.journal_id WHERE e.company_id = $1 AND ($2::date IS NULL OR e.posting_date >= $2) AND ($3::date IS NULL OR e.posting_date <= $3)
        AND ($4::text IS NULL OR j.code = $4) AND ($5::text IS NULL OR e.source_type = $5) AND ($6::text IS NULL OR e.state = $6) AND ($7::text IS NULL OR e.posting_date::text || e.id::text < $7)
      ORDER BY e.posting_date DESC, e.id DESC LIMIT $8`, [companyId, query.from ?? null, query.to ?? null, query.journal ?? null, query.sourceType ?? null, query.state ?? null, cur?.[0] ?? null, query.limit + 1])).rows;
    return page(rows, query.limit, 'sort');
  });
  route(app, 'GET', '/api/v1/journal-entries/:id', { perm: 'accounting.read' }, async ({ tx, companyId, params }) => {
    const e = (await tx.query(`SELECT e.*, j.code AS journal_code, j.name_ar AS journal_name FROM acc_journal_entry e JOIN acc_journal j ON j.id = e.journal_id WHERE e.id = $1 AND e.company_id = $2`, [params.id, companyId])).rows[0];
    if (!e) throw notFound('ENTRY');
    e.lines = (await tx.query(`SELECT l.*, a.code AS account_code, a.name_ar AS account_name, p.name_ar AS partner_name, b.code AS branch_code FROM acc_journal_line l JOIN acc_account a ON a.id = l.account_id
      LEFT JOIN par_partner p ON p.id = l.partner_id LEFT JOIN core_branch b ON b.id = l.branch_id WHERE l.entry_id = $1 AND l.posting_date = $2 ORDER BY l.debit DESC, a.code`, [e.id, e.posting_date])).rows;
    return e;
  });
  // manual journal: maker creates draft; checker (different user) posts
  route(app, 'POST', '/api/v1/journal-entries', {
    perm: 'accounting.journal.write',
    body: z.object({ journalCode: z.string().default('GEN'), date: isoDate, memo: z.string().min(3), lines: z.array(z.object({ accountId: uuid, debit: nonNegDecimal.default('0'), credit: nonNegDecimal.default('0'), branchId: uuid.optional(), costCenterId: uuid.optional(), partnerId: uuid.optional(), label: z.string().optional() })).min(2).max(500) }),
  }, async ({ tx, actor, companyId, body, reply }) => {
    for (const l of body.lines) if (dec(l.debit).isZero() === dec(l.credit).isZero()) throw invalid('LINE_NEEDS_ONE_SIDE');
    const d = sum(body.lines.map((l) => l.debit)), c = sum(body.lines.map((l) => l.credit));
    if (!d.eq(c)) throw invalid('UNBALANCED_ENTRY', `debit ${fmt(d, 2)} != credit ${fmt(c, 2)}`);
    const j = (await tx.query('SELECT id FROM acc_journal WHERE company_id = $1 AND code = $2', [companyId, body.journalCode])).rows[0];
    if (!j) throw notFound('JOURNAL');
    const id = uuidv7();
    await tx.query(`INSERT INTO acc_journal_entry (id, posting_date, tenant_id, company_id, journal_id, state, source_type, memo, created_by) VALUES ($1,$2,$3,$4,$5,'draft','manual',$6,$7)`, [id, body.date, actor.tenantId, companyId, j.id, body.memo, actor.userId]);
    for (const l of body.lines) await tx.query(`INSERT INTO acc_journal_line (id, posting_date, entry_id, tenant_id, company_id, account_id, debit, credit, branch_id, cost_center_id, partner_id, label) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [uuidv7(), body.date, id, actor.tenantId, companyId, l.accountId, l.debit, l.credit, l.branchId ?? null, l.costCenterId ?? null, l.partnerId ?? null, l.label ?? null]);
    reply.code(201);
    return { id, postingDate: body.date, state: 'draft' };
  });
  route(app, 'POST', '/api/v1/journal-entries/:id/post', { perm: 'accounting.journal.post', body: z.object({ postingDate: isoDate }) }, async ({ tx, actor, companyId, params, body }) => {
    const e = (await tx.query(`SELECT * FROM acc_journal_entry WHERE id = $1 AND posting_date = $2 AND company_id = $3 FOR UPDATE`, [params.id, body.postingDate, companyId])).rows[0];
    if (!e) throw notFound('ENTRY');
    if (e.state !== 'draft') throw new AppError('INVALID_STATE', 409);
    if (e.created_by === actor.userId) throw new AppError('SELF_APPROVAL_FORBIDDEN', 403, 'Manual journals must be posted by a different user (maker-checker)');
    if (can(actor, 'accounting.post_locked_period', { companyId })) await tx.query(`SELECT set_config('rc.allow_locked_period', 'on', true)`);
    const r = await tx.query(`UPDATE acc_journal_entry SET state = 'posted' WHERE id = $1 AND posting_date = $2 RETURNING number`, [e.id, e.posting_date]);
    await audit(tx, actor, 'post', 'acc_journal_entry', e.id, { number: r.rows[0].number }, companyId);
    return { state: 'posted', number: r.rows[0].number };
  });
  route(app, 'POST', '/api/v1/journal-entries/:id/reverse', { perm: 'accounting.journal.reverse', body: z.object({ reversalDate: isoDate, reason: z.string().min(3) }) }, async ({ tx, actor, companyId, params, body }) => {
    const r = await reverseEntry(tx, { tenantId: actor.tenantId, companyId, entryId: params.id, reversalDate: body.reversalDate, reason: body.reason, userId: actor.userId });
    await audit(tx, actor, 'reverse', 'acc_journal_entry', params.id, { reversal: r.entryId, reason: body.reason }, companyId);
    return { reversalEntryId: r.entryId, postingDate: r.postingDate };
  });

  // ---------- periods ----------
  route(app, 'GET', '/api/v1/fiscal-periods', { perm: 'accounting.read' }, async ({ tx, companyId }) => (await tx.query('SELECT * FROM acc_fiscal_period WHERE company_id = $1 ORDER BY start_date DESC', [companyId])).rows);
  route(app, 'POST', '/api/v1/fiscal-periods/:id/state', { perm: 'accounting.period.manage', body: z.object({ state: z.enum(['open', 'soft_locked', 'hard_locked']) }) }, async ({ tx, actor, companyId, params, body }) => {
    const p = (await tx.query('SELECT * FROM acc_fiscal_period WHERE id = $1 AND company_id = $2 FOR UPDATE', [params.id, companyId])).rows[0];
    if (!p) throw notFound('PERIOD');
    if (p.state === 'hard_locked' && body.state !== 'hard_locked' && !actor.isOwner) throw forbidden('reopening a hard-locked period requires the tenant owner');
    if (body.state === 'hard_locked') {
      const pending = (await tx.query(`SELECT count(*)::int AS n FROM core_outbox_event WHERE company_id = $1 AND processed_at IS NULL`, [companyId])).rows[0].n;
      if (pending) throw new AppError('PENDING_POSTINGS', 409, `${pending} operational events not yet posted`);
      const openSessions = (await tx.query(`SELECT count(*)::int AS n FROM pos_session WHERE company_id = $1 AND business_date <= $2 AND state = 'open'`, [companyId, p.end_date])).rows[0].n;
      if (openSessions) throw new AppError('OPEN_POS_SESSIONS', 409, `${openSessions} POS sessions still open in the period`);
      const rec = await inventoryReconciliation(tx, companyId);
      if (!rec.reconciled) throw new AppError('INVENTORY_NOT_RECONCILED', 409, `Inventory sub-ledger differs from GL by ${rec.difference}`);
    }
    await tx.query(`UPDATE acc_fiscal_period SET state = $2, locked_by = $3, locked_at = now() WHERE id = $1`, [p.id, body.state, actor.userId]);
    return { ok: true };
  });

  // ---------- statements ----------
  route(app, 'GET', '/api/v1/reports/trial-balance', { perm: 'accounting.reports.read', query: dateRange }, async ({ tx, companyId, query }) => trialBalance(tx, companyId, query.from, query.to, query.branchId));
  route(app, 'GET', '/api/v1/reports/income-statement', { perm: 'accounting.reports.read', query: dateRange }, async ({ tx, actor, companyId, query }) => {
    if (query.branchId) requirePerm(actor, 'accounting.reports.read', { companyId, branchId: query.branchId });
    return incomeStatement(tx, companyId, query.from, query.to, query.branchId);
  });
  route(app, 'GET', '/api/v1/reports/balance-sheet', { perm: 'accounting.reports.read', query: z.object({ asOf: isoDate }) }, async ({ tx, companyId, query }) => balanceSheet(tx, companyId, query.asOf));
  route(app, 'GET', '/api/v1/reports/cash-flow', { perm: 'accounting.reports.read', query: dateRange }, async ({ tx, companyId, query }) => cashFlow(tx, companyId, query.from, query.to));
  route(app, 'GET', '/api/v1/reports/general-ledger', { perm: 'accounting.reports.read', query: dateRange.extend({ accountId: uuid, partnerId: uuid.optional() }) }, async ({ tx, companyId, query }) => {
    const opening = (await tx.query(`SELECT coalesce(sum(l.debit - l.credit), 0) AS b FROM acc_journal_line l JOIN acc_journal_entry e ON e.id = l.entry_id AND e.posting_date = l.posting_date
       WHERE l.company_id = $1 AND l.account_id = $2 AND l.posting_date < $3 AND e.state <> 'draft' AND ($4::uuid IS NULL OR l.partner_id = $4)`, [companyId, query.accountId, query.from, query.partnerId ?? null])).rows[0].b;
    const lines = (await tx.query(`SELECT l.posting_date, e.number, e.memo, e.source_type, l.label, l.debit, l.credit, p.name_ar AS partner_name, b.code AS branch_code, e.id AS entry_id
       FROM acc_journal_line l JOIN acc_journal_entry e ON e.id = l.entry_id AND e.posting_date = l.posting_date LEFT JOIN par_partner p ON p.id = l.partner_id LEFT JOIN core_branch b ON b.id = l.branch_id
       WHERE l.company_id = $1 AND l.account_id = $2 AND l.posting_date BETWEEN $3 AND $4 AND e.state <> 'draft' AND ($5::uuid IS NULL OR l.partner_id = $5) AND ($6::uuid IS NULL OR l.branch_id = $6)
       ORDER BY l.posting_date, e.number LIMIT 20000`, [companyId, query.accountId, query.from, query.to, query.partnerId ?? null, query.branchId ?? null])).rows;
    let run = dec(opening);
    return { opening: fmt(run, 2), lines: lines.map((l) => { run = run.add(dec(l.debit)).sub(dec(l.credit)); return { ...l, balance: fmt(run, 2) }; }), closing: fmt(run, 2) };
  });
  route(app, 'GET', '/api/v1/reports/ap-aging', { perm: 'accounting.reports.read', query: z.object({ asOf: isoDate }) }, async ({ tx, companyId, query }) =>
    (await tx.query(`SELECT s.id AS supplier_id, s.name_ar, sum(i.total - i.amount_paid) AS balance,
        sum(CASE WHEN $2::date - i.due_date <= 0 THEN i.total - i.amount_paid ELSE 0 END) AS current,
        sum(CASE WHEN $2::date - i.due_date BETWEEN 1 AND 30 THEN i.total - i.amount_paid ELSE 0 END) AS d1_30,
        sum(CASE WHEN $2::date - i.due_date BETWEEN 31 AND 60 THEN i.total - i.amount_paid ELSE 0 END) AS d31_60,
        sum(CASE WHEN $2::date - i.due_date BETWEEN 61 AND 90 THEN i.total - i.amount_paid ELSE 0 END) AS d61_90,
        sum(CASE WHEN $2::date - i.due_date > 90 THEN i.total - i.amount_paid ELSE 0 END) AS d90_plus
      FROM pur_invoice i JOIN par_partner s ON s.id = i.supplier_id WHERE i.company_id = $1 AND i.state = 'posted' AND i.kind = 'invoice' AND i.amount_paid < i.total AND i.invoice_date <= $2
      GROUP BY s.id, s.name_ar ORDER BY balance DESC`, [companyId, query.asOf])).rows);
  route(app, 'GET', '/api/v1/reports/vat', { perm: 'accounting.reports.read', query: dateRange }, async ({ tx, companyId, query }) =>
    (await tx.query(`SELECT a.code, a.name_ar, r.code AS tax_code, sum(l.tax_base) AS base, sum(l.credit - l.debit) AS output_minus_input
      FROM acc_journal_line l JOIN acc_account a ON a.id = l.account_id JOIN acc_journal_entry e ON e.id = l.entry_id AND e.posting_date = l.posting_date LEFT JOIN tax_rate r ON r.id = l.tax_rate_id
      WHERE l.company_id = $1 AND a.subtype IN ('tax_output','tax_input') AND l.posting_date BETWEEN $2 AND $3 AND e.state <> 'draft' GROUP BY a.code, a.name_ar, r.code ORDER BY a.code`, [companyId, query.from, query.to])).rows);
  route(app, 'GET', '/api/v1/reports/inventory-reconciliation', { perm: 'accounting.reports.read' }, async ({ tx, companyId }) => inventoryReconciliation(tx, companyId));
  route(app, 'GET', '/api/v1/posting-exceptions', { perm: 'accounting.read' }, async ({ tx, companyId }) => (await tx.query(`SELECT * FROM acc_posting_exception WHERE company_id = $1 AND status = 'open' ORDER BY created_at DESC`, [companyId])).rows);
  route(app, 'POST', '/api/v1/posting-exceptions/retry', { perm: 'accounting.posting_rules.manage', tx: false, idempotent: false }, async ({ actor }) => {
    void actor;
    return drainOutbox();
  });

  // ---------- payments ----------
  route(app, 'GET', '/api/v1/bank-accounts', { perm: 'accounting.read' }, async ({ tx, companyId }) => (await tx.query('SELECT b.*, a.code AS account_code FROM acc_bank_account b JOIN acc_account a ON a.id = b.account_id WHERE b.company_id = $1', [companyId])).rows);
  route(app, 'POST', '/api/v1/payments', {
    perm: 'accounting.payment.write',
    body: z.object({ direction: z.enum(['outbound', 'inbound']), partnerId: uuid, bankAccountId: uuid, branchId: uuid.optional(), paymentDate: isoDate, amount: positiveDecimal, whtAmount: nonNegDecimal.default('0'), reference: z.string().optional(),
      allocations: z.array(z.object({ invoiceId: uuid, amount: positiveDecimal })).default([]) }),
  }, async ({ tx, actor, companyId, body, reply }) => {
    const alloc = sum(body.allocations.map((a) => a.amount));
    if (alloc.gt(dec(body.amount).add(dec(body.whtAmount)))) throw invalid('ALLOCATION_EXCEEDS_PAYMENT');
    const id = uuidv7();
    const number = await nextNumber(tx, actor.tenantId, companyId, body.direction === 'outbound' ? 'PAY' : 'RCPT', body.branchId ? await branchCode(tx, body.branchId) : '');
    const threshold = dec((await tx.query('SELECT settings FROM core_company WHERE id = $1', [companyId])).rows[0].settings.paymentApprovalThreshold ?? '0');
    const needsApproval = body.direction === 'outbound' && dec(body.amount).gt(threshold);
    await tx.query(`INSERT INTO acc_payment (id, tenant_id, company_id, branch_id, number, direction, partner_id, bank_account_id, payment_date, amount, wht_amount, reference, state, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, actor.tenantId, companyId, body.branchId ?? null, number, body.direction, body.partnerId, body.bankAccountId, body.paymentDate, body.amount, body.whtAmount, body.reference ?? null, needsApproval ? 'pending_approval' : 'approved', actor.userId]);
    for (const a of body.allocations) {
      const inv = (await tx.query(`SELECT supplier_id, total, amount_paid FROM pur_invoice WHERE id = $1 AND company_id = $2 AND state = 'posted'`, [a.invoiceId, companyId])).rows[0];
      if (!inv || inv.supplier_id !== body.partnerId) throw invalid('INVOICE_NOT_PAYABLE', a.invoiceId);
      if (dec(a.amount).gt(dec(inv.total).sub(dec(inv.amount_paid)))) throw invalid('ALLOCATION_EXCEEDS_BALANCE', a.invoiceId);
      await tx.query(`INSERT INTO acc_payment_allocation (tenant_id, payment_id, invoice_type, invoice_id, amount) VALUES ($1,$2,'supplier_invoice',$3,$4)`, [actor.tenantId, id, a.invoiceId, a.amount]);
    }
    reply.code(201);
    if (needsApproval) {
      await tx.query(`INSERT INTO wf_approval_request (id, tenant_id, company_id, branch_id, doc_type, doc_id, summary, amount, required_permission, requested_by) VALUES ($1,$2,$3,$4,'payment',$5,$6,$7,'accounting.payment.approve',$8)`,
        [uuidv7(), actor.tenantId, companyId, body.branchId ?? null, id, `${number}`, body.amount, actor.userId]);
      return { id, number, state: 'pending_approval' };
    }
    const p = (await tx.query('SELECT * FROM acc_payment WHERE id = $1', [id])).rows[0];
    await postPayment(tx, p);
    return { id, number, state: 'posted' };
  });
  route(app, 'GET', '/api/v1/payments', { perm: 'accounting.read' }, async ({ tx, companyId }) => (await tx.query(`SELECT p.*, pa.name_ar AS partner_name FROM acc_payment p JOIN par_partner pa ON pa.id = p.partner_id WHERE p.company_id = $1 ORDER BY p.created_at DESC LIMIT 500`, [companyId])).rows);

  // ---------- expenses ----------
  route(app, 'POST', '/api/v1/expenses', {
    body: z.object({ branchId: uuid, expenseDate: isoDate, accountId: uuid, costCenterId: uuid.optional(), partnerId: uuid.optional(), description: z.string().min(3), netAmount: positiveDecimal, taxRateId: uuid.optional(), paidFromBankAccountId: uuid.optional() }),
  }, async ({ tx, actor, companyId, body, reply }) => {
    requirePerm(actor, 'accounting.expense.write', { companyId, branchId: body.branchId });
    const acc = (await tx.query(`SELECT type, is_postable FROM acc_account WHERE id = $1 AND company_id = $2`, [body.accountId, companyId])).rows[0];
    if (!acc || acc.type !== 'expense' || !acc.is_postable) throw invalid('EXPENSE_ACCOUNT_INVALID');
    if (!body.paidFromBankAccountId && !body.partnerId) throw invalid('EXPENSE_NEEDS_PAYER_OR_SUPPLIER');
    const rate = body.taxRateId ? dec((await tx.query('SELECT rate FROM tax_rate WHERE id = $1', [body.taxRateId])).rows[0]?.rate ?? 0) : ZERO;
    const tax = roundMoney(dec(body.netAmount).mul(rate).div(100));
    const id = uuidv7();
    const number = await nextNumber(tx, actor.tenantId, companyId, 'EXP', await branchCode(tx, body.branchId));
    const threshold = dec((await tx.query('SELECT settings FROM core_company WHERE id = $1', [companyId])).rows[0].settings.expenseApprovalThreshold ?? '0');
    const needsApproval = dec(body.netAmount).add(tax).gt(threshold);
    const cc = body.costCenterId ?? (await tx.query('SELECT id FROM core_cost_center WHERE branch_id = $1 LIMIT 1', [body.branchId])).rows[0]?.id ?? null;
    await tx.query(`INSERT INTO acc_expense (id, tenant_id, company_id, branch_id, number, expense_date, account_id, cost_center_id, partner_id, description, net_amount, tax_rate_id, tax_amount, paid_from_bank_account_id, state, created_by)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [id, actor.tenantId, companyId, body.branchId, number, body.expenseDate, body.accountId, cc, body.partnerId ?? null, body.description, body.netAmount, body.taxRateId ?? null, fmt(tax, 4), body.paidFromBankAccountId ?? null, needsApproval ? 'pending_approval' : 'approved', actor.userId]);
    reply.code(201);
    if (needsApproval) {
      await tx.query(`INSERT INTO wf_approval_request (id, tenant_id, company_id, branch_id, doc_type, doc_id, summary, amount, required_permission, requested_by) VALUES ($1,$2,$3,$4,'expense',$5,$6,$7,'accounting.expense.approve',$8)`,
        [uuidv7(), actor.tenantId, companyId, body.branchId, id, `${number} — ${body.description}`, fmt(dec(body.netAmount).add(tax), 4), actor.userId]);
      return { id, number, state: 'pending_approval' };
    }
    await emit(tx, { id: uuidv7(), tenantId: actor.tenantId, companyId, aggregateType: 'expense', aggregateId: id, type: 'accounting.expense_posted', payload: { expenseId: id } });
    return { id, number, state: 'approved' };
  });
  route(app, 'GET', '/api/v1/expenses', { perm: 'accounting.read' }, async ({ tx, companyId }) => (await tx.query(`SELECT x.*, a.code AS account_code, a.name_ar AS account_name FROM acc_expense x JOIN acc_account a ON a.id = x.account_id WHERE x.company_id = $1 ORDER BY x.created_at DESC LIMIT 500`, [companyId])).rows);

  // opening balances (owner-equity offset) for go-live
  route(app, 'POST', '/api/v1/opening-balances', { perm: 'accounting.journal.post', body: z.object({ date: isoDate, lines: z.array(z.object({ accountId: uuid, amount: decimalStr, partnerId: uuid.optional(), branchId: uuid.optional() })).min(1) }) }, async ({ tx, actor, companyId, body }) => {
    const total = sum(body.lines.map((l) => l.amount));
    const r = await postEntry(tx, { tenantId: actor.tenantId, companyId, journalCode: 'GEN', date: body.date, sourceType: 'opening', rule: 'opening', memo: 'أرصدة افتتاحية', createdBy: actor.userId,
      lines: [...body.lines.map((l) => ({ accountId: l.accountId, amount: l.amount, partnerId: l.partnerId, branchId: l.branchId })), { key: 'equity.opening', amount: total.neg() }] });
    return r;
  });
}

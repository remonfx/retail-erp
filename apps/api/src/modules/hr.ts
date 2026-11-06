import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { uuidv7, uuid, isoDate, nonNegDecimal, dec, fmt, sum } from '@rc/domain';
import { route, emit } from '../lib/http.js';
import { require as requirePerm } from '../lib/actor.js';
import { AppError, invalid, notFound } from '../lib/errors.js';

export default async function hrRoutes(app: FastifyInstance) {
  route(app, 'GET', '/api/v1/employees', { perm: 'hr.employee.read' }, async ({ tx, companyId }) => (await tx.query('SELECT e.*, b.code AS branch_code FROM hr_employee e LEFT JOIN core_branch b ON b.id = e.branch_id WHERE e.company_id = $1 ORDER BY e.code', [companyId])).rows);
  route(app, 'POST', '/api/v1/employees', { perm: 'hr.employee.write', body: z.object({ code: z.string().min(1), fullNameAr: z.string(), fullNameEn: z.string().optional(), branchId: uuid.optional(), userId: uuid.optional(), nationalId: z.string().regex(/^\d{14}$/).optional(), phone: z.string().optional(), jobTitle: z.string().optional(), hireDate: isoDate.optional() }) }, async ({ tx, actor, companyId, body, reply }) => {
    const id = uuidv7();
    const cc = body.branchId ? (await tx.query('SELECT id FROM core_cost_center WHERE branch_id = $1 LIMIT 1', [body.branchId])).rows[0]?.id ?? null : null;
    await tx.query(`INSERT INTO hr_employee (id, tenant_id, company_id, branch_id, code, full_name_ar, full_name_en, user_id, national_id, phone, job_title, hire_date, cost_center_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, actor.tenantId, companyId, body.branchId ?? null, body.code, body.fullNameAr, body.fullNameEn ?? null, body.userId ?? null, body.nationalId ?? null, body.phone ?? null, body.jobTitle ?? null, body.hireDate ?? null, cc]);
    reply.code(201);
    return { id };
  });
  // self check-in/out (mobile)
  route(app, 'POST', '/api/v1/attendance/check', { company: 'required', idempotent: true, body: z.object({ action: z.enum(['in', 'out']), lat: z.number().optional(), lng: z.number().optional() }) }, async ({ tx, actor, companyId, body }) => {
    const emp = (await tx.query('SELECT * FROM hr_employee WHERE user_id = $1 AND company_id = $2 AND active', [actor.userId, companyId])).rows[0];
    if (!emp) throw notFound('EMPLOYEE_PROFILE');
    const open = (await tx.query('SELECT id FROM hr_attendance WHERE employee_id = $1 AND check_out IS NULL ORDER BY check_in DESC LIMIT 1', [emp.id])).rows[0];
    if (body.action === 'in') {
      if (open) throw new AppError('ALREADY_CHECKED_IN', 409);
      const id = uuidv7();
      await tx.query(`INSERT INTO hr_attendance (id, tenant_id, company_id, employee_id, branch_id, check_in, source, lat, lng) VALUES ($1,$2,$3,$4,$5, now(), 'mobile', $6, $7)`, [id, actor.tenantId, companyId, emp.id, emp.branch_id, body.lat ?? null, body.lng ?? null]);
      return { id, action: 'in' };
    }
    if (!open) throw new AppError('NOT_CHECKED_IN', 409);
    await tx.query('UPDATE hr_attendance SET check_out = now() WHERE id = $1', [open.id]);
    return { id: open.id, action: 'out' };
  });
  route(app, 'GET', '/api/v1/attendance', { perm: 'hr.employee.read', query: z.object({ from: isoDate, to: isoDate }) }, async ({ tx, companyId, query }) =>
    (await tx.query(`SELECT a.*, e.code, e.full_name_ar, round(extract(epoch FROM (coalesce(a.check_out, now()) - a.check_in)) / 3600, 2) AS hours FROM hr_attendance a JOIN hr_employee e ON e.id = a.employee_id
                     WHERE a.company_id = $1 AND a.check_in::date BETWEEN $2 AND $3 ORDER BY a.check_in DESC`, [companyId, query.from, query.to])).rows);
  // payroll import (computed externally) → GL
  route(app, 'POST', '/api/v1/payroll-runs', {
    perm: 'hr.payroll.import',
    body: z.object({ periodMonth: z.string().regex(/^\d{4}-\d{2}$/), lines: z.array(z.object({ employeeCode: z.string(), gross: nonNegDecimal, employerSi: nonNegDecimal, employeeSi: nonNegDecimal, incomeTax: nonNegDecimal, deductions: nonNegDecimal.default('0'), net: nonNegDecimal })).min(1) }),
  }, async ({ tx, actor, companyId, body, reply }) => {
    const emps = new Map((await tx.query('SELECT code, branch_id, cost_center_id FROM hr_employee WHERE company_id = $1', [companyId])).rows.map((e) => [e.code, e]));
    const lines = body.lines.map((l, i) => {
      const e = emps.get(l.employeeCode);
      if (!e) throw invalid('UNKNOWN_EMPLOYEE', `row ${i + 1}: ${l.employeeCode}`);
      if (!dec(l.gross).sub(dec(l.employeeSi)).sub(dec(l.incomeTax)).sub(dec(l.deductions)).eq(dec(l.net))) throw invalid('PAYROLL_LINE_INCONSISTENT', `row ${i + 1}: gross - SI - tax - deductions != net`);
      return { ...l, branchId: e.branch_id, costCenterId: e.cost_center_id };
    });
    const totals = Object.fromEntries((['gross', 'employerSi', 'employeeSi', 'incomeTax', 'deductions', 'net'] as const).map((k) => [k, fmt(sum(lines.map((l) => l[k])), 2)]));
    const id = uuidv7();
    await tx.query(`INSERT INTO hr_payroll_run (id, tenant_id, company_id, period_month, totals, lines, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, actor.tenantId, companyId, `${body.periodMonth}-01`, JSON.stringify(totals), JSON.stringify(lines), actor.userId]);
    requirePerm(actor, 'hr.payroll.import', { companyId });
    await emit(tx, { id: uuidv7(), tenantId: actor.tenantId, companyId, aggregateType: 'payroll', aggregateId: id, type: 'hr.payroll_posted', payload: { runId: id } });
    reply.code(201);
    return { id, totals };
  });
}

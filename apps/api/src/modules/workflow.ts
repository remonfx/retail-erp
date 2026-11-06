import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { route, audit } from '../lib/http.js';
import { can } from '../lib/actor.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import type { Tx } from '../lib/db.js';
import { approvalHandlers as invHandlers } from './inventory/routes.js';
import { promotionApproval } from './pricing/routes.js';
import { poApproval, invoiceExceptionApproval } from './purchasing/routes.js';
import { paymentApproval, expenseApproval } from './accounting/routes.js';

const HANDLERS: Record<string, (tx: Tx, docId: string, userId: string, approved: boolean) => Promise<void>> = {
  ...invHandlers,
  promotion: promotionApproval,
  purchase_order: poApproval,
  supplier_invoice_exception: invoiceExceptionApproval,
  payment: paymentApproval,
  expense: expenseApproval,
};

export default async function workflowRoutes(app: FastifyInstance) {
  route(app, 'GET', '/api/v1/approvals', { company: 'optional', query: z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).default('pending'), mine: z.coerce.boolean().optional() }) }, async ({ tx, actor, query }) => {
    const rows = (await tx.query(`SELECT a.*, u.full_name AS requested_by_name, b.code AS branch_code FROM wf_approval_request a LEFT JOIN core_user u ON u.id = a.requested_by LEFT JOIN core_branch b ON b.id = a.branch_id
                                  WHERE a.status = $1 ORDER BY a.requested_at DESC LIMIT 500`, [query.status])).rows;
    return rows.filter((r) => query.mine ? r.requested_by === actor.userId : can(actor, r.required_permission, { companyId: r.company_id, branchId: r.branch_id }))
      .map((r) => ({ ...r, canDecide: r.status === 'pending' && r.requested_by !== actor.userId && can(actor, r.required_permission, { companyId: r.company_id, branchId: r.branch_id }) }));
  });
  route(app, 'POST', '/api/v1/approvals/:id/decide', { company: 'none', body: z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(1000).optional() }) }, async ({ tx, actor, params, body }) => {
    const a = (await tx.query(`SELECT * FROM wf_approval_request WHERE id = $1 FOR UPDATE`, [params.id])).rows[0];
    if (!a) throw notFound('APPROVAL');
    if (a.status !== 'pending') throw new AppError('APPROVAL_ALREADY_DECIDED', 409);
    if (a.requested_by === actor.userId) throw new AppError('SELF_APPROVAL_FORBIDDEN', 403);
    if (!can(actor, a.required_permission, { companyId: a.company_id, branchId: a.branch_id })) throw forbidden(a.required_permission);
    const limit = actor.assignments.filter((x) => x.permissions.has(a.required_permission)).map((x) => Number(x.limits.approvalCeiling)).filter(Number.isFinite);
    if (a.amount !== null && limit.length && Math.max(...limit) < Number(a.amount)) throw new AppError('APPROVAL_LIMIT_EXCEEDED', 403, `Your approval ceiling is ${Math.max(...limit)}`);
    const h = HANDLERS[a.doc_type];
    if (!h) throw new AppError('NO_APPROVAL_HANDLER', 500, a.doc_type);
    await tx.query(`SELECT set_config('rc.company_ids', $1, true)`, [a.company_id]);
    await h(tx, a.doc_id, actor.userId, body.decision === 'approve');
    await tx.query(`UPDATE wf_approval_request SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`, [a.id, body.decision === 'approve' ? 'approved' : 'rejected', actor.userId, body.note ?? null]);
    await audit(tx, actor, `approval_${body.decision}`, a.doc_type, a.doc_id, { approvalId: a.id, note: body.note }, a.company_id);
    return { status: body.decision === 'approve' ? 'approved' : 'rejected' };
  });
  route(app, 'GET', '/api/v1/notifications', { company: 'none' }, async ({ tx, actor }) => (await tx.query('SELECT * FROM core_notification WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [actor.userId])).rows);
}

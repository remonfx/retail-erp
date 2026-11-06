import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { uuidv7, uuid, nonNegDecimal, positiveDecimal, resolvePrice, dec, type PriceCandidate, type Promotion } from '@rc/domain';
import { route, audit } from '../../lib/http.js';
import { require as requirePerm } from '../../lib/actor.js';
import { AppError, invalid, notFound } from '../../lib/errors.js';
import type { Tx } from '../../lib/db.js';

export async function priceCandidates(tx: Tx, companyId: string, branchId: string, variantIds: string[]): Promise<PriceCandidate[]> {
  return (await tx.query(`SELECT i.id AS "priceListItemId", pl.id AS "priceListId", pl.scope, pl.priority, i.variant_id AS "variantId", i.uom_id AS "uomId", i.price, i.min_qty AS "minQty",
      to_char(i.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "validFrom", CASE WHEN i.valid_to IS NULL THEN NULL ELSE to_char(i.valid_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "validTo"
    FROM prc_price_list_item i JOIN prc_price_list pl ON pl.id = i.price_list_id
    WHERE pl.company_id = $1 AND pl.active AND i.variant_id = ANY($3::uuid[]) AND (i.valid_to IS NULL OR i.valid_to > now() - interval '1 day')
      AND (pl.scope = 'company' OR (pl.scope = 'branch' AND pl.branch_id = $2) OR (pl.scope = 'branch_group' AND EXISTS (SELECT 1 FROM prc_branch_group_member m WHERE m.group_id = pl.branch_group_id AND m.branch_id = $2)))`,
    [companyId, branchId, variantIds])).rows;
}

export async function activePromotions(tx: Tx, companyId: string, branchId: string, at = new Date()): Promise<Promotion[]> {
  return (await tx.query(`SELECT p.id, p.code, p.name_ar AS "nameAr", p.name_en AS "nameEn", p.priority, p.exclusive, p.stackable,
      to_char(p.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "validFrom", CASE WHEN p.valid_to IS NULL THEN NULL ELSE to_char(p.valid_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END AS "validTo",
      p.time_from AS "timeFrom", p.time_to AS "timeTo", p.coupon_code AS "couponCode", p.customer_group_ids AS "customerGroupIds", p.targets, p.rule
    FROM prc_promotion p WHERE p.company_id = $1 AND p.status = 'active' AND p.valid_from <= $3::timestamptz + interval '1 day' AND (p.valid_to IS NULL OR p.valid_to > $3::timestamptz - interval '1 day')
      AND (p.all_branches OR EXISTS (SELECT 1 FROM prc_promotion_branch b WHERE b.promotion_id = p.id AND b.branch_id = $2))`, [companyId, branchId, at])).rows;
}

const ruleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('percent_off'), percent: z.number().gt(0).max(100) }),
  z.object({ type: z.literal('amount_off_unit'), amount: z.number().gt(0) }),
  z.object({ type: z.literal('buy_x_get_y'), buyQty: z.number().int().min(1), getQty: z.number().int().min(1), getPercent: z.number().gt(0).max(100) }),
  z.object({ type: z.literal('bundle_price'), qty: z.number().int().min(2), price: z.number().gt(0) }),
  z.object({ type: z.literal('basket_threshold'), threshold: z.number().gt(0), percent: z.number().gt(0).max(100).optional(), amount: z.number().gt(0).optional() }),
]);

export default async function pricingRoutes(app: FastifyInstance) {
  route(app, 'GET', '/api/v1/price-lists', { perm: 'pricing.pricelist.read' }, async ({ tx, companyId }) =>
    (await tx.query(`SELECT pl.*, b.code AS branch_code, (SELECT count(*) FROM prc_price_list_item i WHERE i.price_list_id = pl.id AND (i.valid_to IS NULL OR i.valid_to > now()))::int AS active_items FROM prc_price_list pl LEFT JOIN core_branch b ON b.id = pl.branch_id WHERE pl.company_id = $1 ORDER BY pl.scope, pl.priority`, [companyId])).rows);
  route(app, 'POST', '/api/v1/price-lists', {
    body: z.object({ code: z.string().regex(/^[A-Z0-9_-]{2,20}$/), nameAr: z.string(), nameEn: z.string().optional(), kind: z.enum(['retail', 'wholesale', 'custom', 'transfer']).default('retail'), scope: z.enum(['company', 'branch', 'branch_group']), branchId: uuid.optional(), branchGroupId: uuid.optional(), priority: z.number().int().default(10), pricesIncludeTax: z.boolean().default(true) }),
  }, async ({ tx, actor, companyId, body, reply }) => {
    requirePerm(actor, 'pricing.pricelist.write', { companyId, branchId: body.branchId });
    const id = uuidv7();
    await tx.query(`INSERT INTO prc_price_list (id, tenant_id, company_id, code, name_ar, name_en, kind, scope, branch_id, branch_group_id, priority, prices_include_tax) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, actor.tenantId, companyId, body.code, body.nameAr, body.nameEn ?? null, body.kind, body.scope, body.branchId ?? null, body.branchGroupId ?? null, body.priority, body.pricesIncludeTax]);
    reply.code(201);
    return { id };
  });
  // set price: closes the current open item at validFrom and creates a new one (full history kept)
  route(app, 'POST', '/api/v1/price-lists/:id/items', {
    body: z.object({ items: z.array(z.object({ variantId: uuid, uomId: uuid, price: nonNegDecimal, minQty: positiveDecimal.default('1'), validFrom: z.string().datetime({ offset: true }).optional(), validTo: z.string().datetime({ offset: true }).optional() })).min(1).max(5000) }),
  }, async ({ tx, actor, companyId, params, body }) => {
    const pl = (await tx.query('SELECT * FROM prc_price_list WHERE id = $1 AND company_id = $2', [params.id, companyId])).rows[0];
    if (!pl) throw notFound('PRICE_LIST');
    requirePerm(actor, 'pricing.pricelist.write', { companyId, branchId: pl.branch_id });
    let n = 0;
    for (const it of body.items) {
      const from = it.validFrom ?? new Date().toISOString();
      await tx.query(`UPDATE prc_price_list_item SET valid_to = $5 WHERE price_list_id = $1 AND variant_id = $2 AND uom_id = $3 AND min_qty = $4 AND valid_from < $5 AND (valid_to IS NULL OR valid_to > $5)`, [pl.id, it.variantId, it.uomId, it.minQty, from]);
      await tx.query(`INSERT INTO prc_price_list_item (id, tenant_id, price_list_id, variant_id, uom_id, price, min_qty, valid_from, valid_to, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [uuidv7(), actor.tenantId, pl.id, it.variantId, it.uomId, it.price, it.minQty, from, it.validTo ?? null, actor.userId]);
      n++;
    }
    return { upserted: n };
  });
  route(app, 'GET', '/api/v1/prices/resolve', { perm: 'pricing.pricelist.read', query: z.object({ branchId: uuid, variantId: uuid, uomId: uuid, qty: z.string().default('1'), at: z.string().optional() }) }, async ({ tx, companyId, query }) => {
    const cands = await priceCandidates(tx, companyId, query.branchId, [query.variantId]);
    const r = resolvePrice(cands, query.variantId, query.uomId, query.qty, query.at ? new Date(query.at) : new Date());
    if (!r) throw notFound('PRICE');
    return { ...r, unitPrice: r.unitPrice.toFixed(2) };
  });

  // promotions (maker-checker: created as draft → submitted → approved by another user → active)
  route(app, 'GET', '/api/v1/promotions', { perm: 'pricing.promotion.read' }, async ({ tx, companyId }) =>
    (await tx.query(`SELECT p.*, coalesce((SELECT array_agg(branch_id) FROM prc_promotion_branch b WHERE b.promotion_id = p.id), '{}') AS branch_ids FROM prc_promotion p WHERE p.company_id = $1 ORDER BY p.created_at DESC`, [companyId])).rows);
  route(app, 'POST', '/api/v1/promotions', {
    perm: 'pricing.promotion.write',
    body: z.object({ code: z.string().regex(/^[A-Z0-9_-]{2,30}$/), nameAr: z.string(), nameEn: z.string().optional(), priority: z.number().int().default(10), exclusive: z.boolean().default(false), stackable: z.boolean().default(false),
      validFrom: z.string().datetime({ offset: true }), validTo: z.string().datetime({ offset: true }).optional(), timeFrom: z.string().regex(/^\d{2}:\d{2}$/).optional(), timeTo: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      couponCode: z.string().max(40).optional(), targets: z.object({ variantIds: z.array(uuid).optional(), categoryIds: z.array(uuid).optional(), brandIds: z.array(uuid).optional(), all: z.boolean().optional() }),
      rule: ruleSchema, allBranches: z.boolean().default(false), branchIds: z.array(uuid).default([]) }),
  }, async ({ tx, actor, companyId, body, reply }) => {
    if (body.rule.type === 'basket_threshold' && !body.rule.percent === !body.rule.amount) throw invalid('BASKET_RULE_NEEDS_PERCENT_OR_AMOUNT');
    if (!body.allBranches && !body.branchIds.length) throw invalid('PROMOTION_SCOPE_REQUIRED');
    const id = uuidv7();
    await tx.query(`INSERT INTO prc_promotion (id, tenant_id, company_id, code, name_ar, name_en, priority, exclusive, stackable, valid_from, valid_to, time_from, time_to, coupon_code, targets, rule, all_branches, status, created_by)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'pending_approval',$18)`,
      [id, actor.tenantId, companyId, body.code, body.nameAr, body.nameEn ?? null, body.priority, body.exclusive, body.stackable, body.validFrom, body.validTo ?? null, body.timeFrom ?? null, body.timeTo ?? null,
       body.couponCode ?? null, JSON.stringify(body.targets), JSON.stringify(body.rule), body.allBranches, actor.userId]);
    for (const b of body.branchIds) await tx.query('INSERT INTO prc_promotion_branch (tenant_id, promotion_id, branch_id) VALUES ($1,$2,$3)', [actor.tenantId, id, b]);
    await tx.query(`INSERT INTO wf_approval_request (id, tenant_id, company_id, doc_type, doc_id, summary, required_permission, requested_by) VALUES ($1,$2,$3,'promotion',$4,$5,'pricing.promotion.approve',$6)`,
      [uuidv7(), actor.tenantId, companyId, id, `${body.code} — ${body.nameAr}`, actor.userId]);
    reply.code(201);
    return { id, status: 'pending_approval' };
  });
  route(app, 'POST', '/api/v1/promotions/:id/end', { perm: 'pricing.promotion.write' }, async ({ tx, actor, companyId, params }) => {
    const r = await tx.query(`UPDATE prc_promotion SET status = 'ended', valid_to = least(coalesce(valid_to, now()), now()) WHERE id = $1 AND company_id = $2 AND status = 'active'`, [params.id, companyId]);
    if (!r.rowCount) throw new AppError('PROMOTION_NOT_ACTIVE', 409);
    await audit(tx, actor, 'end', 'prc_promotion', params.id, null, companyId);
    return { ok: true };
  });
}

export const promotionApproval = async (tx: Tx, docId: string, userId: string, approved: boolean) => {
  const r = await tx.query(`UPDATE prc_promotion SET status = $2, approved_by = $3, approved_at = now() WHERE id = $1 AND status = 'pending_approval'`, [docId, approved ? 'active' : 'cancelled', userId]);
  if (!r.rowCount) throw new AppError('PROMOTION_NOT_PENDING', 409);
};
export { dec };

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { uuidv7, uuid, nonNegDecimal, positiveDecimal, detectSymbology, validateBarcode, parseEmbeddedBarcode, normalizeArabic, dec, fmt, type Symbology } from '@rc/domain';
import { route, audit, pageQuery, decodeCursor, page } from '../../lib/http.js';
import { require as requirePerm, can } from '../../lib/actor.js';
import { AppError, invalid, notFound } from '../../lib/errors.js';
import type { Tx } from '../../lib/db.js';
import { enforcePlanLimit } from '../org.js';
import { importProductsCsv, streamProductsCsv } from './io.js';

const barcodeIn = z.object({ code: z.string().min(1).max(64).regex(/^[\x21-\x7e]+$/), symbology: z.enum(['ean13', 'ean8', 'upca', 'code128', 'internal']).optional(), packQty: positiveDecimal.optional(), uomId: uuid.optional(), isPrimary: z.boolean().optional() });
const variantIn = z.object({ sku: z.string().regex(/^[A-Za-z0-9._/-]{1,64}$/), nameSuffixAr: z.string().max(100).optional(), nameSuffixEn: z.string().max(100).optional(), barcodes: z.array(barcodeIn).max(20).default([]), attributes: z.record(z.string(), z.string()).optional(), retailPrice: nonNegDecimal.optional(), standardCost: nonNegDecimal.optional() });
export const productIn = z.object({
  nameAr: z.string().min(1).max(250), nameEn: z.string().max(250).optional(), descriptionAr: z.string().max(5000).optional(), descriptionEn: z.string().max(5000).optional(),
  categoryId: uuid, brandId: uuid.optional(), stockUomId: uuid, purchaseUomId: uuid.optional(), salesUomId: uuid.optional(), taxClassId: uuid,
  tracking: z.enum(['none', 'lot', 'serial']).default('none'), isWeighted: z.boolean().default(false), isStockable: z.boolean().default(true),
  status: z.enum(['draft', 'active']).default('active'), variants: z.array(variantIn).min(1).max(500),
  supplierId: uuid.optional(), scalePlu: z.string().regex(/^\d{4,6}$/).optional(),
});

export async function createProduct(tx: Tx, tenantId: string, companyId: string | null, userId: string, body: z.infer<typeof productIn>) {
  const id = uuidv7();
  await tx.query(`INSERT INTO cat_product (id, tenant_id, name_ar, name_en, description_ar, description_en, category_id, brand_id, stock_uom_id, purchase_uom_id, sales_uom_id, tax_class_id, tracking, is_weighted, is_stockable, status, created_by, updated_by)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)`,
    [id, tenantId, body.nameAr, body.nameEn ?? null, body.descriptionAr ?? null, body.descriptionEn ?? null, body.categoryId, body.brandId ?? null, body.stockUomId, body.purchaseUomId ?? null, body.salesUomId ?? null,
     body.taxClassId, body.tracking, body.isWeighted, body.isStockable, body.status, userId]);
  const variants: { id: string; sku: string }[] = [];
  const priceList = companyId ? (await tx.query(`SELECT id FROM prc_price_list WHERE company_id = $1 AND scope = 'company' AND kind = 'retail' ORDER BY priority LIMIT 1`, [companyId])).rows[0] : null;
  for (const v of body.variants) {
    const vid = uuidv7();
    await tx.query(`INSERT INTO cat_variant (id, tenant_id, product_id, sku, name_suffix_ar, name_suffix_en, standard_cost, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [vid, tenantId, id, v.sku, v.nameSuffixAr ?? null, v.nameSuffixEn ?? null, v.standardCost ?? null, userId]);
    let primarySet = false;
    for (const b of v.barcodes) {
      const sym: Symbology = b.symbology ?? detectSymbology(b.code);
      const err = validateBarcode(b.code, sym);
      if (err) throw invalid(err, `Barcode ${b.code}: ${err}`);
      const primary = b.isPrimary ?? !primarySet;
      if (primary) primarySet = true;
      await tx.query(`INSERT INTO cat_barcode (id, tenant_id, variant_id, code, symbology, uom_id, pack_qty, is_primary, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [uuidv7(), tenantId, vid, b.code, sym, b.uomId ?? null, b.packQty ?? '1', primary, userId]);
    }
    if (v.retailPrice !== undefined && priceList) {
      await tx.query(`INSERT INTO prc_price_list_item (id, tenant_id, price_list_id, variant_id, uom_id, price, valid_from, created_by) VALUES ($1,$2,$3,$4,$5,$6, now() - interval '1 minute', $7)`,
        [uuidv7(), tenantId, priceList.id, vid, body.salesUomId ?? body.stockUomId, v.retailPrice, userId]);
    }
    if (body.supplierId) await tx.query(`INSERT INTO cat_supplier_product (id, tenant_id, supplier_id, variant_id, last_cost, preferred) VALUES ($1,$2,$3,$4,$5,true) ON CONFLICT DO NOTHING`, [uuidv7(), tenantId, body.supplierId, vid, v.standardCost ?? null]);
    if (body.scalePlu && body.variants.length === 1) await tx.query(`INSERT INTO cat_scale_plu (tenant_id, item_code, variant_id) VALUES ($1,$2,$3)`, [tenantId, body.scalePlu, vid]);
    variants.push({ id: vid, sku: v.sku });
  }
  return { id, variants };
}

export default async function catalogRoutes(app: FastifyInstance) {
  // ---------- reference data ----------
  route(app, 'GET', '/api/v1/uoms', { company: 'none' }, async ({ tx }) => (await tx.query(`SELECT u.*, c.code AS category_code, c.name_ar AS category_name_ar FROM cat_uom u JOIN cat_uom_category c ON c.id = u.category_id ORDER BY c.code, u.factor`)).rows);
  route(app, 'GET', '/api/v1/tax-classes', { company: 'none' }, async ({ tx }) => (await tx.query(`SELECT c.*, coalesce(json_agg(json_build_object('id', r.id, 'code', r.code, 'rate', r.rate, 'kind', r.kind, 'sequence', r.sequence)) FILTER (WHERE r.id IS NOT NULL), '[]') AS rates
     FROM tax_class c LEFT JOIN tax_class_rate cr ON cr.tax_class_id = c.id LEFT JOIN tax_rate r ON r.id = cr.tax_rate_id GROUP BY c.id ORDER BY c.code`)).rows);
  route(app, 'GET', '/api/v1/tax-rates', { company: 'none' }, async ({ tx }) => (await tx.query('SELECT * FROM tax_rate ORDER BY code')).rows);
  route(app, 'GET', '/api/v1/categories', { company: 'none' }, async ({ tx }) => (await tx.query(`SELECT c.*, (SELECT count(*) FROM cat_product p WHERE p.category_id = c.id)::int AS product_count FROM cat_category c ORDER BY c.path`)).rows);
  route(app, 'POST', '/api/v1/categories', { company: 'none', perm: 'catalog.product.write', body: z.object({ parentId: uuid, code: z.string().regex(/^[A-Z0-9_-]{1,30}$/), nameAr: z.string().min(1), nameEn: z.string().optional() }) }, async ({ tx, actor, body, reply }) => {
    const parent = (await tx.query('SELECT path FROM cat_category WHERE id = $1', [body.parentId])).rows[0];
    if (!parent) throw notFound('CATEGORY');
    const id = uuidv7();
    await tx.query(`INSERT INTO cat_category (id, tenant_id, parent_id, code, name_ar, name_en, path) VALUES ($1,$2,$3,$4,$5,$6, $7::uuid[] || $1::uuid)`, [id, actor.tenantId, body.parentId, body.code, body.nameAr, body.nameEn ?? null, parent.path]);
    reply.code(201);
    return { id };
  });
  route(app, 'GET', '/api/v1/brands', { company: 'none' }, async ({ tx }) => (await tx.query('SELECT * FROM cat_brand WHERE active ORDER BY name_ar')).rows);
  route(app, 'POST', '/api/v1/brands', { company: 'none', perm: 'catalog.product.write', body: z.object({ nameAr: z.string().min(1), nameEn: z.string().optional() }) }, async ({ tx, actor, body, reply }) => {
    const id = uuidv7();
    await tx.query('INSERT INTO cat_brand (id, tenant_id, name_ar, name_en) VALUES ($1,$2,$3,$4)', [id, actor.tenantId, body.nameAr, body.nameEn ?? null]);
    reply.code(201);
    return { id };
  });

  // ---------- products ----------
  route(app, 'GET', '/api/v1/products', {
    company: 'optional', perm: 'catalog.product.read',
    query: pageQuery.extend({ q: z.string().max(100).optional(), categoryId: uuid.optional(), brandId: uuid.optional(), status: z.string().optional(), branchId: uuid.optional() }),
  }, async ({ tx, actor, companyId, query }) => {
    const cur = decodeCursor(query.cursor);
    const showCost = !!companyId && can(actor, 'catalog.cost.view', { companyId });
    const q = query.q?.trim();
    // Phase 1 — candidate ids using only index-friendly predicates:
    //   exact SKU / barcode (B-tree) + every normalized word as a trigram LIKE (GIN bitmap AND).
    let candidates: string[] | null = null;
    if (q) {
      const words = normalizeArabic(q).split(' ').filter((w) => w.length >= 2).slice(0, 5);
      // SECURITY DEFINER functions (migration 0011) keep trigram/prefix indexes usable under RLS
      const byCode = (await tx.query('SELECT variant_id FROM catalog_code_ids($1, 200)', [q])).rows.map((r) => r.variant_id as string);
      const byName = words.length ? (await tx.query('SELECT variant_id FROM catalog_search_ids($1::text[], 1000)', [words])).rows.map((r) => r.variant_id as string) : [];
      const exact: string[] = [], bySku = byCode;
      candidates = [...new Set([...exact, ...byName, ...bySku])];
      if (!candidates.length) return { data: [], hasMore: false, nextCursor: null };
    }
    // Phase 2 — one page of details (correlated lookups only for <= limit rows)
    const rows = (await tx.query(`
      WITH base AS (
        SELECT v.id FROM cat_variant v JOIN cat_product p ON p.id = v.product_id
         WHERE ($1::uuid[] IS NULL OR v.id = ANY($1))
           AND ($2::uuid IS NULL OR p.category_id IN (SELECT id FROM cat_category WHERE $2 = ANY(path)))
           AND ($3::uuid IS NULL OR p.brand_id = $3) AND ($4::text IS NULL OR p.status = $4)
           AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM cat_branch_assortment a WHERE a.branch_id = $5 AND a.variant_id = v.id))
           AND ($6::uuid IS NULL OR v.id > $6) AND v.merged_into_id IS NULL
         ORDER BY v.id LIMIT $7)
      SELECT v.id, v.sku, v.status AS variant_status, v.name_suffix_ar, v.name_suffix_en, p.id AS product_id, p.name_ar, p.name_en, p.status, p.tracking, p.is_weighted,
             c.name_ar AS category_name_ar, br.name_ar AS brand_name_ar,
             (SELECT b.code FROM cat_barcode b WHERE b.variant_id = v.id AND b.is_primary AND b.status = 'active' LIMIT 1) AS barcode,
             (SELECT i.price FROM prc_price_list_item i JOIN prc_price_list pl ON pl.id = i.price_list_id WHERE i.variant_id = v.id AND pl.company_id = $8 AND pl.scope = 'company'
                AND i.valid_from <= now() AND (i.valid_to IS NULL OR i.valid_to > now()) ORDER BY pl.priority, i.min_qty LIMIT 1) AS retail_price,
             CASE WHEN $9 THEN (SELECT CASE WHEN pc.qty > 0 THEN round(pc.value / pc.qty, 4) ELSE pc.last_avg END FROM inv_product_cost pc WHERE pc.company_id = $8 AND pc.variant_id = v.id) END AS avg_cost
        FROM base JOIN cat_variant v ON v.id = base.id JOIN cat_product p ON p.id = v.product_id JOIN cat_category c ON c.id = p.category_id LEFT JOIN cat_brand br ON br.id = p.brand_id
       ORDER BY v.id`,
      [candidates, query.categoryId ?? null, query.brandId ?? null, query.status ?? null, query.branchId ?? null, cur?.[1] ?? null, query.limit + 1, companyId || null, showCost])).rows;
    return page(rows, query.limit, 'id');
  });

  route(app, 'GET', '/api/v1/products/:id', { company: 'optional', perm: 'catalog.product.read' }, async ({ tx, params, companyId, actor }) => {
    const p = (await tx.query(`SELECT p.*, c.name_ar AS category_name_ar, c.path AS category_path FROM cat_product p JOIN cat_category c ON c.id = p.category_id WHERE p.id = $1`, [params.id])).rows[0];
    if (!p) throw notFound('PRODUCT');
    p.variants = (await tx.query(`SELECT v.*, coalesce((SELECT json_agg(b ORDER BY b.is_primary DESC, b.code) FROM cat_barcode b WHERE b.variant_id = v.id), '[]') AS barcodes FROM cat_variant v WHERE v.product_id = $1 ORDER BY v.sku`, [params.id])).rows;
    if (companyId) {
      const ids = p.variants.map((v: { id: string }) => v.id);
      p.prices = (await tx.query(`SELECT i.*, pl.code AS price_list_code, pl.scope FROM prc_price_list_item i JOIN prc_price_list pl ON pl.id = i.price_list_id WHERE i.variant_id = ANY($1::uuid[]) AND pl.company_id = $2 AND (i.valid_to IS NULL OR i.valid_to > now()) ORDER BY i.valid_from DESC`, [ids, companyId])).rows;
      if (can(actor, 'catalog.cost.view', { companyId })) p.costs = (await tx.query('SELECT * FROM inv_product_cost WHERE company_id = $1 AND variant_id = ANY($2::uuid[])', [companyId, ids])).rows;
      p.suppliers = (await tx.query(`SELECT sp.*, s.name_ar AS supplier_name FROM cat_supplier_product sp JOIN par_partner s ON s.id = sp.supplier_id WHERE sp.variant_id = ANY($1::uuid[])`, [ids])).rows;
    }
    return p;
  });

  route(app, 'GET', '/api/v1/products/:id/history', { company: 'none', perm: 'catalog.product.read' }, async ({ tx, params }) =>
    (await tx.query(`SELECT l.created_at, l.action, l.entity, l.entity_id, l.before, l.after, u.full_name AS user_name FROM core_audit_log l LEFT JOIN core_user u ON u.id = l.user_id
                     WHERE l.tenant_id = rc_tenant() AND ((l.entity = 'cat_product' AND l.entity_id = $1) OR (l.entity IN ('cat_variant','cat_barcode') AND (l.after->>'product_id' = $1 OR l.before->>'product_id' = $1 OR l.entity_id IN (SELECT id::text FROM cat_variant WHERE product_id = $1::uuid))))
                     ORDER BY l.created_at DESC LIMIT 200`, [params.id])).rows);

  route(app, 'POST', '/api/v1/products', { company: 'optional', perm: 'catalog.product.write', body: productIn }, async ({ tx, actor, companyId, body, reply }) => {
    await enforcePlanLimit(tx, actor.tenantId, 'skus');
    const r = await createProduct(tx, actor.tenantId, companyId || null, actor.userId, body);
    reply.code(201);
    return r;
  });

  route(app, 'PATCH', '/api/v1/products/:id', {
    company: 'none', perm: 'catalog.product.write',
    body: z.object({ version: z.number().int(), nameAr: z.string().min(1).max(250).optional(), nameEn: z.string().max(250).nullish(), categoryId: uuid.optional(), brandId: uuid.nullish(), taxClassId: uuid.optional(),
      status: z.enum(['draft', 'active', 'discontinued', 'archived']).optional(), blockedForSale: z.boolean().optional(), blockedForPurchase: z.boolean().optional(), tracking: z.enum(['none', 'lot', 'serial']).optional(),
      descriptionAr: z.string().nullish(), descriptionEn: z.string().nullish() }),
  }, async ({ tx, body, params }) => {
    const p = (await tx.query('SELECT * FROM cat_product WHERE id = $1 FOR UPDATE', [params.id])).rows[0];
    if (!p) throw notFound('PRODUCT');
    if (p.version !== body.version) throw new AppError('VERSION_CONFLICT', 412, 'Product was modified by someone else');
    if (body.tracking && body.tracking !== p.tracking) {
      const stock = (await tx.query(`SELECT 1 FROM inv_stock_quant q JOIN cat_variant v ON v.id = q.variant_id WHERE v.product_id = $1 AND q.qty_on_hand <> 0 LIMIT 1`, [params.id])).rowCount;
      if (stock) throw new AppError('TRACKING_CHANGE_WITH_STOCK', 409, 'Tracking mode can only change when no stock exists');
    }
    await tx.query(`UPDATE cat_product SET name_ar = coalesce($2, name_ar), name_en = CASE WHEN $3::boolean THEN $4 ELSE name_en END, category_id = coalesce($5, category_id),
        brand_id = CASE WHEN $6::boolean THEN $7 ELSE brand_id END, tax_class_id = coalesce($8, tax_class_id), status = coalesce($9, status),
        blocked_for_sale = coalesce($10, blocked_for_sale), blocked_for_purchase = coalesce($11, blocked_for_purchase), tracking = coalesce($12, tracking),
        description_ar = coalesce($13, description_ar), description_en = coalesce($14, description_en) WHERE id = $1`,
      [params.id, body.nameAr ?? null, body.nameEn !== undefined, body.nameEn ?? null, body.categoryId ?? null, body.brandId !== undefined, body.brandId ?? null, body.taxClassId ?? null, body.status ?? null,
       body.blockedForSale ?? null, body.blockedForPurchase ?? null, body.tracking ?? null, body.descriptionAr ?? null, body.descriptionEn ?? null]);
    return (await tx.query('SELECT * FROM cat_product WHERE id = $1', [params.id])).rows[0];
  });

  route(app, 'POST', '/api/v1/variants/:id/barcodes', { company: 'none', perm: 'catalog.product.write', body: barcodeIn.extend({ status: z.enum(['active', 'alias']).default('active') }) }, async ({ tx, actor, params, body, reply }) => {
    const sym = body.symbology ?? detectSymbology(body.code);
    const err = validateBarcode(body.code, sym);
    if (err) throw invalid(err);
    const owner = (await tx.query(`SELECT b.variant_id, v.sku FROM cat_barcode b JOIN cat_variant v ON v.id = b.variant_id WHERE b.code = $1 AND b.status <> 'retired'`, [body.code])).rows[0];
    if (owner) throw new AppError('DUPLICATE_BARCODE', 409, `Barcode already assigned to SKU ${owner.sku}`, owner);
    if (body.isPrimary) await tx.query(`UPDATE cat_barcode SET is_primary = false WHERE variant_id = $1 AND is_primary`, [params.id]);
    const id = uuidv7();
    await tx.query(`INSERT INTO cat_barcode (id, tenant_id, variant_id, code, symbology, uom_id, pack_qty, is_primary, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, actor.tenantId, params.id, body.code, sym, body.uomId ?? null, body.packQty ?? '1', !!body.isPrimary && body.status === 'active', body.status, actor.userId]);
    reply.code(201);
    return { id };
  });
  route(app, 'POST', '/api/v1/barcodes/:id/retire', { company: 'none', perm: 'catalog.product.write' }, async ({ tx, params }) => {
    const r = await tx.query(`UPDATE cat_barcode SET status = 'retired', is_primary = false WHERE id = $1 AND status <> 'retired'`, [params.id]);
    if (!r.rowCount) throw notFound('BARCODE');
    return { ok: true };
  });

  // barcode lookup incl. weighted/price-embedded scale labels
  route(app, 'GET', '/api/v1/barcodes/:code', { company: 'optional', auth: 'user_or_device', perm: 'catalog.product.read' }, async ({ tx, params }) => {
    const hit = (await tx.query(`SELECT b.code, b.pack_qty, b.uom_id, b.status, v.id AS variant_id, v.sku, p.name_ar, p.name_en, p.is_weighted, p.tracking FROM cat_barcode b JOIN cat_variant v ON v.id = b.variant_id JOIN cat_product p ON p.id = v.product_id WHERE b.code = $1 AND b.status <> 'retired'`, [params.code])).rows[0];
    if (hit) return { match: 'exact', ...hit };
    const rules = (await tx.query('SELECT prefix, item_code_length AS "itemCodeLength", value_length AS "valueLength", value_type AS "valueType", value_decimals AS "valueDecimals" FROM cat_embedded_barcode_rule')).rows;
    const emb = parseEmbeddedBarcode(params.code, rules);
    if (emb) {
      const v = (await tx.query(`SELECT v.id AS variant_id, v.sku, p.name_ar, p.name_en, p.is_weighted FROM cat_scale_plu s JOIN cat_variant v ON v.id = s.variant_id JOIN cat_product p ON p.id = v.product_id WHERE s.item_code = $1`, [emb.itemCode])).rows[0];
      if (v) return { match: 'embedded', valueType: emb.valueType, value: emb.value.toString(), ...v };
    }
    const retired = (await tx.query(`SELECT b.variant_id, v.sku FROM cat_barcode b JOIN cat_variant v ON v.id = b.variant_id WHERE b.code = $1 AND b.status = 'retired' LIMIT 1`, [params.code])).rows[0];
    if (retired) return { match: 'retired', ...retired };
    throw notFound('BARCODE');
  });

  // duplicate & similar-name detection
  route(app, 'POST', '/api/v1/products/check-duplicates', { company: 'none', perm: 'catalog.product.read', body: z.object({ nameAr: z.string().optional(), nameEn: z.string().optional(), skus: z.array(z.string()).default([]), barcodes: z.array(z.string()).default([]), threshold: z.number().min(0.2).max(1).default(0.45) }) }, async ({ tx, body }) => {
    const skus = body.skus.length ? (await tx.query('SELECT sku, id AS variant_id FROM cat_variant WHERE upper(sku) = ANY($1::text[])', [body.skus.map((s) => s.toUpperCase())])).rows : [];
    const barcodes = body.barcodes.length ? (await tx.query(`SELECT b.code, v.sku, b.variant_id FROM cat_barcode b JOIN cat_variant v ON v.id = b.variant_id WHERE b.code = ANY($1::text[]) AND b.status <> 'retired'`, [body.barcodes])).rows : [];
    const name = [body.nameAr, body.nameEn].filter(Boolean).join(' ');
    let similar: unknown[] = [];
    if (name) {
      await tx.query(`SELECT set_config('pg_trgm.similarity_threshold', $1, true)`, [String(body.threshold)]);
      similar = (await tx.query(`SELECT p.id, p.name_ar, p.name_en, round(similarity(p.search_norm, rc_norm_ar($1))::numeric, 3) AS score FROM cat_product p WHERE p.search_norm % rc_norm_ar($1) AND p.merged_into_id IS NULL ORDER BY score DESC LIMIT 10`, [name])).rows;
    }
    return { duplicateSkus: skus, duplicateBarcodes: barcodes, similarNames: similar, normalized: normalizeArabic(name) };
  });

  // merge: re-point barcodes, supplier links, assortment, prices to survivor; history keeps original ids
  route(app, 'POST', '/api/v1/variants/:id/merge', { company: 'none', perm: 'catalog.product.merge', body: z.object({ targetVariantId: uuid }) }, async ({ tx, actor, params, body }) => {
    if (params.id === body.targetVariantId) throw invalid('MERGE_SAME_VARIANT');
    const [src, tgt] = await Promise.all([params.id, body.targetVariantId].map(async (id) => (await tx.query(`SELECT v.*, p.stock_uom_id FROM cat_variant v JOIN cat_product p ON p.id = v.product_id WHERE v.id = $1 FOR UPDATE OF v`, [id])).rows[0]));
    if (!src || !tgt) throw notFound('VARIANT');
    if (src.merged_into_id) throw new AppError('ALREADY_MERGED', 409);
    if (src.stock_uom_id !== tgt.stock_uom_id) throw invalid('MERGE_UOM_MISMATCH');
    const stock = (await tx.query(`SELECT 1 FROM inv_stock_quant q JOIN inv_location l ON l.id = q.location_id WHERE q.variant_id = $1 AND l.type IN ('internal','quarantine','transit') AND q.qty_on_hand <> 0 LIMIT 1`, [src.id])).rowCount;
    if (stock) throw new AppError('MERGE_SOURCE_HAS_STOCK', 409, 'Transfer or adjust the source stock to zero before merging');
    const moved = {
      barcodes: (await tx.query(`UPDATE cat_barcode SET variant_id = $2, is_primary = false, status = CASE WHEN status = 'active' THEN 'alias' ELSE status END WHERE variant_id = $1`, [src.id, tgt.id])).rowCount,
      suppliers: (await tx.query(`UPDATE cat_supplier_product sp SET variant_id = $2, preferred = false WHERE variant_id = $1 AND NOT EXISTS (SELECT 1 FROM cat_supplier_product x WHERE x.supplier_id = sp.supplier_id AND x.variant_id = $2)`, [src.id, tgt.id])).rowCount,
      assortment: (await tx.query(`INSERT INTO cat_branch_assortment (tenant_id, company_id, branch_id, variant_id, sellable, purchasable, reorder_point, min_qty, max_qty)
                                   SELECT tenant_id, company_id, branch_id, $2, sellable, purchasable, reorder_point, min_qty, max_qty FROM cat_branch_assortment WHERE variant_id = $1 ON CONFLICT DO NOTHING`, [src.id, tgt.id])).rowCount,
      pricesEnded: (await tx.query(`UPDATE prc_price_list_item SET valid_to = now() WHERE variant_id = $1 AND (valid_to IS NULL OR valid_to > now()) AND valid_from < now()`, [src.id])).rowCount,
    };
    await tx.query(`DELETE FROM cat_branch_assortment WHERE variant_id = $1`, [src.id]);
    await tx.query(`UPDATE cat_variant SET merged_into_id = $2, status = 'archived' WHERE id = $1`, [src.id, tgt.id]);
    await tx.query(`INSERT INTO cat_product_merge (id, tenant_id, source_variant_id, target_variant_id, moved, merged_by) VALUES ($1,$2,$3,$4,$5,$6)`, [uuidv7(), actor.tenantId, src.id, tgt.id, JSON.stringify(moved), actor.userId]);
    await audit(tx, actor, 'merge', 'cat_variant', src.id, { into: tgt.id, moved });
    return { ok: true, moved };
  });

  // branch assortment (bulk upsert)
  route(app, 'PUT', '/api/v1/branches/:branchId/assortment', {
    perm: 'catalog.product.write',
    body: z.object({ items: z.array(z.object({ variantId: uuid, sellable: z.boolean().default(true), purchasable: z.boolean().default(true), reorderPoint: nonNegDecimal.nullish(), minQty: nonNegDecimal.nullish(), maxQty: nonNegDecimal.nullish() })).min(1).max(10000) }),
  }, async ({ tx, actor, companyId, params, body }) => {
    requirePerm(actor, 'catalog.product.write', { companyId, branchId: params.branchId });
    const r = await tx.query(`INSERT INTO cat_branch_assortment (tenant_id, company_id, branch_id, variant_id, sellable, purchasable, reorder_point, min_qty, max_qty, updated_at)
      SELECT $1, $2, $3, x."variantId", x.sellable, x.purchasable, x."reorderPoint", x."minQty", x."maxQty", now() FROM json_to_recordset($4::json) AS x("variantId" uuid, sellable boolean, purchasable boolean, "reorderPoint" numeric, "minQty" numeric, "maxQty" numeric)
      ON CONFLICT (branch_id, variant_id) DO UPDATE SET sellable = EXCLUDED.sellable, purchasable = EXCLUDED.purchasable, reorder_point = EXCLUDED.reorder_point, min_qty = EXCLUDED.min_qty, max_qty = EXCLUDED.max_qty, updated_at = now()`,
      [actor.tenantId, companyId, params.branchId, JSON.stringify(body.items)]);
    return { upserted: r.rowCount };
  });

  // bulk operations (preview with dryRun, then execute)
  route(app, 'POST', '/api/v1/products/bulk-update', {
    company: 'optional', perm: 'catalog.product.write',
    body: z.object({ variantIds: z.array(uuid).min(1).max(50000), dryRun: z.boolean().default(true),
      set: z.object({ categoryId: uuid.optional(), brandId: uuid.optional(), status: z.enum(['active', 'discontinued', 'archived']).optional(), taxClassId: uuid.optional() }).optional(),
      price: z.object({ priceListId: uuid, mode: z.enum(['set', 'percent', 'amount']), value: z.string(), validFrom: z.string().datetime({ offset: true }).optional(), rounding: z.enum(['none', '0.05', '0.25', '0.5', '1']).default('none') }).optional() }),
  }, async ({ tx, actor, companyId, body }) => {
    const affected = (await tx.query(`SELECT count(DISTINCT product_id)::int AS products, count(*)::int AS variants FROM cat_variant WHERE id = ANY($1::uuid[])`, [body.variantIds])).rows[0];
    let pricePreview: unknown[] = [];
    if (body.price) {
      if (!companyId) throw new AppError('COMPANY_REQUIRED', 400);
      requirePerm(actor, 'pricing.pricelist.write', { companyId });
      const pl = (await tx.query('SELECT * FROM prc_price_list WHERE id = $1 AND company_id = $2', [body.price.priceListId, companyId])).rows[0];
      if (!pl) throw notFound('PRICE_LIST');
      const cur = (await tx.query(`SELECT DISTINCT ON (i.variant_id, i.uom_id) i.variant_id, i.uom_id, i.price FROM prc_price_list_item i WHERE i.price_list_id = $1 AND i.variant_id = ANY($2::uuid[]) AND i.min_qty = 1
                                   AND i.valid_from <= now() AND (i.valid_to IS NULL OR i.valid_to > now()) ORDER BY i.variant_id, i.uom_id, i.valid_from DESC`, [pl.id, body.variantIds])).rows;
      const inc = body.price.rounding === 'none' ? null : dec(body.price.rounding);
      pricePreview = cur.map((c) => {
        const old = dec(c.price);
        let nv = body.price!.mode === 'set' ? dec(body.price!.value) : body.price!.mode === 'percent' ? old.mul(dec(100).add(dec(body.price!.value))).div(100) : old.add(dec(body.price!.value));
        if (inc) nv = nv.div(inc).toDecimalPlaces(0).mul(inc);
        if (nv.lt(0)) throw invalid('PRICE_NEGATIVE');
        return { variantId: c.variant_id, uomId: c.uom_id, oldPrice: fmt(old, 2), newPrice: fmt(nv, 2) };
      });
      if (!body.dryRun) {
        const from = body.price.validFrom ?? new Date().toISOString();
        for (const p of pricePreview as { variantId: string; uomId: string; newPrice: string }[]) {
          await tx.query(`UPDATE prc_price_list_item SET valid_to = $4 WHERE price_list_id = $1 AND variant_id = $2 AND uom_id = $3 AND min_qty = 1 AND valid_from < $4 AND (valid_to IS NULL OR valid_to > $4)`, [pl.id, p.variantId, p.uomId, from]);
          await tx.query(`INSERT INTO prc_price_list_item (id, tenant_id, price_list_id, variant_id, uom_id, price, valid_from, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [uuidv7(), actor.tenantId, pl.id, p.variantId, p.uomId, p.newPrice, from, actor.userId]);
        }
      }
    }
    if (body.set && !body.dryRun) {
      await tx.query(`UPDATE cat_product SET category_id = coalesce($2, category_id), brand_id = coalesce($3, brand_id), status = coalesce($4, status), tax_class_id = coalesce($5, tax_class_id)
                      WHERE id IN (SELECT product_id FROM cat_variant WHERE id = ANY($1::uuid[]))`, [body.variantIds, body.set.categoryId ?? null, body.set.brandId ?? null, body.set.status ?? null, body.set.taxClassId ?? null]);
    }
    if (!body.dryRun) await audit(tx, actor, 'bulk_update', 'cat_product', 'bulk', { count: body.variantIds.length, set: body.set, price: body.price ? { ...body.price, items: pricePreview.length } : undefined });
    return { dryRun: body.dryRun, affected, pricePreview: pricePreview.slice(0, 200), priceChanges: pricePreview.length };
  });

  // CSV import/export (streaming)
  route(app, 'POST', '/api/v1/products/import', { company: 'optional', perm: 'catalog.product.import', body: z.object({ csv: z.string().min(1).max(50_000_000), dryRun: z.boolean().default(false) }) }, async ({ tx, actor, companyId, body }) =>
    importProductsCsv(tx, actor.tenantId, companyId || null, actor.userId, body.csv, body.dryRun));
  route(app, 'GET', '/api/v1/products/export.csv', { company: 'optional', perm: 'reporting.export', raw: true }, async ({ tx, companyId, reply }) => {
    reply.hijack();
    await streamProductsCsv(tx, companyId || null, reply);
  });
}

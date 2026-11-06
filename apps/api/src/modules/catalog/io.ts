/** Set-based CSV import (staging temp table) and streaming COPY export for million-row catalogs. */
import { uuidv7, detectSymbology, validateBarcode, dec } from '@rc/domain';
import type { FastifyReply } from 'fastify';
import { to as copyTo } from 'pg-copy-streams';
import { finished } from 'node:stream/promises';
import type { Tx } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';

export const IMPORT_COLUMNS = ['sku', 'barcode', 'name_ar', 'name_en', 'category_code', 'brand', 'uom_code', 'tax_class_code', 'retail_price', 'cost', 'tracking', 'is_weighted'] as const;

/** RFC 4180 CSV parser (quotes, escaped quotes, CRLF, BOM). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', i = 0, inQ = false;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); field = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((x) => x !== '')) rows.push(row); }
  return rows;
}

export async function importProductsCsv(tx: Tx, tenantId: string, companyId: string | null, userId: string, csv: string, dryRun: boolean) {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new AppError('CSV_EMPTY', 422);
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const missing = ['sku', 'name_ar', 'category_code', 'uom_code', 'tax_class_code'].filter((c) => !header.includes(c));
  if (missing.length) throw new AppError('CSV_MISSING_COLUMNS', 422, missing.join(', '));
  const idx = Object.fromEntries(IMPORT_COLUMNS.map((c) => [c, header.indexOf(c)])) as Record<(typeof IMPORT_COLUMNS)[number], number>;
  const errors: { row: number; error: string }[] = [];
  const seenSku = new Set<string>(), seenBarcode = new Set<string>();
  const staged: Record<string, unknown>[] = [];
  rows.slice(1).forEach((r, n) => {
    const line = n + 2;
    const g = (c: (typeof IMPORT_COLUMNS)[number]) => (idx[c] >= 0 ? (r[idx[c]] ?? '').trim() : '');
    const sku = g('sku'), barcode = g('barcode');
    if (!/^[A-Za-z0-9._/-]{1,64}$/.test(sku)) return errors.push({ row: line, error: 'INVALID_SKU' });
    if (seenSku.has(sku.toUpperCase())) return errors.push({ row: line, error: 'DUPLICATE_SKU_IN_FILE' });
    seenSku.add(sku.toUpperCase());
    if (!g('name_ar')) return errors.push({ row: line, error: 'NAME_AR_REQUIRED' });
    if (barcode) {
      const e = validateBarcode(barcode, detectSymbology(barcode));
      if (e) return errors.push({ row: line, error: e });
      if (seenBarcode.has(barcode)) return errors.push({ row: line, error: 'DUPLICATE_BARCODE_IN_FILE' });
      seenBarcode.add(barcode);
    }
    for (const c of ['retail_price', 'cost'] as const) if (g(c) && !/^\d{1,13}(\.\d{1,4})?$/.test(g(c))) return errors.push({ row: line, error: `INVALID_${c.toUpperCase()}` });
    const tracking = g('tracking') || 'none';
    if (!['none', 'lot', 'serial'].includes(tracking)) return errors.push({ row: line, error: 'INVALID_TRACKING' });
    staged.push({ line, product_id: uuidv7(), variant_id: uuidv7(), sku, barcode: barcode || null, symbology: barcode ? detectSymbology(barcode) : null, name_ar: g('name_ar'), name_en: g('name_en') || null,
      category_code: g('category_code'), brand: g('brand') || null, uom_code: g('uom_code').toUpperCase(), tax_class_code: g('tax_class_code').toUpperCase(),
      retail_price: g('retail_price') || null, cost: g('cost') || null, tracking, is_weighted: ['1', 'true', 'yes', 'نعم'].includes(g('is_weighted').toLowerCase()) });
  });

  await tx.query(`CREATE TEMP TABLE imp (line int, product_id uuid, variant_id uuid, sku text, barcode text, symbology text, name_ar text, name_en text, category_code text, brand text, uom_code text, tax_class_code text,
                   retail_price numeric, cost numeric, tracking text, is_weighted boolean, category_id uuid, brand_id uuid, uom_id uuid, tax_class_id uuid, existing_variant uuid, error text) ON COMMIT DROP`);
  for (let i = 0; i < staged.length; i += 5000) {
    await tx.query(`INSERT INTO imp (line, product_id, variant_id, sku, barcode, symbology, name_ar, name_en, category_code, brand, uom_code, tax_class_code, retail_price, cost, tracking, is_weighted)
                    SELECT * FROM json_to_recordset($1::json) AS x(line int, product_id uuid, variant_id uuid, sku text, barcode text, symbology text, name_ar text, name_en text, category_code text, brand text, uom_code text, tax_class_code text, retail_price numeric, cost numeric, tracking text, is_weighted boolean)`,
      [JSON.stringify(staged.slice(i, i + 5000))]);
  }
  await tx.query(`UPDATE imp SET category_id = c.id FROM cat_category c WHERE c.code = imp.category_code`);
  await tx.query(`UPDATE imp SET uom_id = u.id FROM cat_uom u WHERE u.code = imp.uom_code`);
  await tx.query(`UPDATE imp SET tax_class_id = t.id FROM tax_class t WHERE t.code = imp.tax_class_code`);
  await tx.query(`UPDATE imp SET existing_variant = v.id FROM cat_variant v WHERE upper(v.sku) = upper(imp.sku)`);
  await tx.query(`UPDATE imp SET error = CASE WHEN category_id IS NULL THEN 'UNKNOWN_CATEGORY' WHEN uom_id IS NULL THEN 'UNKNOWN_UOM' WHEN tax_class_id IS NULL THEN 'UNKNOWN_TAX_CLASS' END`);
  await tx.query(`UPDATE imp SET error = 'BARCODE_BELONGS_TO_OTHER_SKU' FROM cat_barcode b WHERE imp.error IS NULL AND b.code = imp.barcode AND b.status <> 'retired' AND b.variant_id IS DISTINCT FROM imp.existing_variant`);
  const dbErrors = (await tx.query(`SELECT line AS row, error FROM imp WHERE error IS NOT NULL ORDER BY line`)).rows;
  errors.push(...dbErrors);
  const counts = (await tx.query(`SELECT count(*) FILTER (WHERE error IS NULL AND existing_variant IS NULL)::int AS new, count(*) FILTER (WHERE error IS NULL AND existing_variant IS NOT NULL)::int AS updated FROM imp`)).rows[0];
  if (dryRun || errors.length) return { dryRun, valid: !errors.length, rows: rows.length - 1, created: dryRun ? 0 : 0, wouldCreate: counts.new, wouldUpdate: counts.updated, errors: errors.sort((a, b) => a.row - b.row).slice(0, 1000), errorCount: errors.length };

  await tx.query(`INSERT INTO cat_brand (id, tenant_id, name_ar) SELECT gen_random_uuid(), $1, brand FROM (SELECT DISTINCT brand FROM imp WHERE brand IS NOT NULL) b ON CONFLICT (tenant_id, name_ar) DO NOTHING`, [tenantId]);
  await tx.query(`UPDATE imp SET brand_id = b.id FROM cat_brand b WHERE b.name_ar = imp.brand`);
  await tx.query(`INSERT INTO cat_product (id, tenant_id, name_ar, name_en, category_id, brand_id, stock_uom_id, tax_class_id, tracking, is_weighted, status, created_by, updated_by)
                  SELECT product_id, $1, name_ar, name_en, category_id, brand_id, uom_id, tax_class_id, tracking, is_weighted, 'active', $2, $2 FROM imp WHERE existing_variant IS NULL`, [tenantId, userId]);
  await tx.query(`INSERT INTO cat_variant (id, tenant_id, product_id, sku, standard_cost, created_by, updated_by) SELECT variant_id, $1, product_id, sku, cost, $2, $2 FROM imp WHERE existing_variant IS NULL`, [tenantId, userId]);
  await tx.query(`UPDATE cat_product p SET name_ar = imp.name_ar, name_en = coalesce(imp.name_en, p.name_en), category_id = imp.category_id, brand_id = coalesce(imp.brand_id, p.brand_id), tax_class_id = imp.tax_class_id
                  FROM imp JOIN cat_variant v ON v.id = imp.existing_variant WHERE p.id = v.product_id AND (p.name_ar, p.category_id, p.tax_class_id) IS DISTINCT FROM (imp.name_ar, imp.category_id, imp.tax_class_id)`);
  await tx.query(`UPDATE imp SET variant_id = existing_variant WHERE existing_variant IS NOT NULL`);
  await tx.query(`INSERT INTO cat_barcode (id, tenant_id, variant_id, code, symbology, is_primary, created_by)
                  SELECT gen_random_uuid(), $1, variant_id, barcode, symbology, NOT EXISTS (SELECT 1 FROM cat_barcode b2 WHERE b2.variant_id = imp.variant_id AND b2.is_primary AND b2.status = 'active'), $2
                    FROM imp WHERE barcode IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cat_barcode b WHERE b.code = imp.barcode AND b.status <> 'retired')`, [tenantId, userId]);
  let pricesChanged = 0;
  if (companyId) {
    const pl = (await tx.query(`SELECT id FROM prc_price_list WHERE company_id = $1 AND scope = 'company' AND kind = 'retail' ORDER BY priority LIMIT 1`, [companyId])).rows[0];
    if (pl) {
      await tx.query(`CREATE TEMP TABLE imp_price ON COMMIT DROP AS SELECT imp.variant_id, imp.uom_id, imp.retail_price FROM imp
                      LEFT JOIN LATERAL (SELECT price FROM prc_price_list_item i WHERE i.price_list_id = $1 AND i.variant_id = imp.variant_id AND i.uom_id = imp.uom_id AND i.min_qty = 1 AND (i.valid_to IS NULL OR i.valid_to > now()) ORDER BY valid_from DESC LIMIT 1) cur ON true
                      WHERE imp.retail_price IS NOT NULL AND cur.price IS DISTINCT FROM imp.retail_price`, [pl.id]);
      await tx.query(`UPDATE prc_price_list_item i SET valid_to = now() FROM imp_price x WHERE i.price_list_id = $1 AND i.variant_id = x.variant_id AND i.uom_id = x.uom_id AND i.min_qty = 1 AND (i.valid_to IS NULL OR i.valid_to > now()) AND i.valid_from < now()`, [pl.id]);
      pricesChanged = (await tx.query(`INSERT INTO prc_price_list_item (id, tenant_id, price_list_id, variant_id, uom_id, price, valid_from, created_by) SELECT gen_random_uuid(), $1, $2, variant_id, uom_id, retail_price, now(), $3 FROM imp_price`, [tenantId, pl.id, userId])).rowCount ?? 0;
    }
  }
  return { dryRun: false, valid: true, rows: rows.length - 1, created: counts.new, updated: counts.updated, pricesChanged, errors: [], errorCount: 0 };
}

export async function streamProductsCsv(tx: Tx, companyId: string | null, reply: FastifyReply) {
  const sql = `COPY (SELECT v.sku, (SELECT b.code FROM cat_barcode b WHERE b.variant_id = v.id AND b.is_primary AND b.status = 'active' LIMIT 1) AS barcode, p.name_ar, p.name_en, c.code AS category_code,
      br.name_ar AS brand, u.code AS uom_code, t.code AS tax_class_code,
      (SELECT i.price FROM prc_price_list_item i JOIN prc_price_list pl ON pl.id = i.price_list_id WHERE i.variant_id = v.id AND pl.company_id = ${companyId ? `'${companyId.replace(/[^0-9a-f-]/g, '')}'` : 'NULL'}::uuid AND pl.scope = 'company'
         AND i.valid_from <= now() AND (i.valid_to IS NULL OR i.valid_to > now()) ORDER BY pl.priority LIMIT 1) AS retail_price,
      v.standard_cost AS cost, p.tracking, p.is_weighted, p.status
    FROM cat_variant v JOIN cat_product p ON p.id = v.product_id JOIN cat_category c ON c.id = p.category_id JOIN cat_uom u ON u.id = p.stock_uom_id JOIN tax_class t ON t.id = p.tax_class_id LEFT JOIN cat_brand br ON br.id = p.brand_id
    WHERE v.merged_into_id IS NULL ORDER BY v.sku) TO STDOUT WITH (FORMAT csv, HEADER true)`;
  const stream = tx.query(copyTo(sql));
  reply.raw.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="products.csv"' });
  reply.raw.write('﻿');
  stream.pipe(reply.raw);
  await finished(stream);
}
export { dec };

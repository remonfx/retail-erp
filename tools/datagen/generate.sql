-- Synthetic catalog generator for scale tests (run as owner):
--   psql -v tenant=<uuid> -v company=<uuid> -v n=1000000 -f generate.sql
-- Bypasses row triggers (session_replication_role=replica) for bulk speed; writes the change feed set-based.
\set ON_ERROR_STOP on
SET session_replication_role = replica;
BEGIN;
CREATE TEMP TABLE words (w text, i int);
INSERT INTO words SELECT w, row_number() OVER () FROM unnest(ARRAY['زيت','أرز','سكر','مكرونة','شاي','قهوة','لبن','جبنة','زبادي','عصير','بسكويت','شيبسي','صابون','شامبو','معجون','مسحوق','منظف','مناديل','حفاضات','تونة','فول','عدس','دقيق','سمن','زبدة','مربى','عسل','كاتشب','مايونيز','خل','ملح','فلفل','كمون','نسكافيه','كاكاو','شوكولاتة','حلاوة','طحينة','بيض','فراخ']) w;
CREATE TEMP TABLE brands (w text, i int);
INSERT INTO brands SELECT w, row_number() OVER () FROM unnest(ARRAY['كريستال','الضحى','الأسرة','الملكة','العروسة','جهينة','دومتي','المراعي','أريال','بريل','فاين','بامبرز','صن شاين','هاينز','نستله','كادبوري','لاكتيل','إيزيس','الدوحة','حلواني']) w;

CREATE TEMP TABLE g AS
SELECT s AS n, gen_random_uuid() AS pid, gen_random_uuid() AS vid,
       (SELECT w FROM words WHERE i = 1 + (s % 40)) || ' ' || (SELECT w FROM brands WHERE i = 1 + ((s / 40) % 20)) || ' ' || (1 + s % 997) || ' جم' AS name_ar,
       'SYN-' || lpad(s::text, 8, '0') AS sku,
       '29' || lpad(s::text, 10, '0') AS body
  FROM generate_series(1, :n) s;

INSERT INTO cat_product (id, tenant_id, name_ar, name_en, category_id, stock_uom_id, tax_class_id, status, created_by, updated_by)
SELECT pid, :'tenant', name_ar, 'Synthetic ' || n, (SELECT id FROM cat_category WHERE tenant_id = :'tenant' AND code = 'ALL'),
       (SELECT id FROM cat_uom WHERE tenant_id = :'tenant' AND code = 'PCS'), (SELECT id FROM tax_class WHERE tenant_id = :'tenant' AND code = 'STANDARD'), 'active',
       '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000' FROM g;
INSERT INTO cat_variant (id, tenant_id, product_id, sku, created_by, updated_by) SELECT vid, :'tenant', pid, sku, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000' FROM g;
-- valid EAN-13 (GS1 mod-10 check digit)
INSERT INTO cat_barcode (id, tenant_id, variant_id, code, symbology, is_primary)
SELECT gen_random_uuid(), :'tenant', vid, body || ((10 - (
         (substr(body,12,1)::int + substr(body,10,1)::int + substr(body,8,1)::int + substr(body,6,1)::int + substr(body,4,1)::int + substr(body,2,1)::int) * 3
        + substr(body,11,1)::int + substr(body,9,1)::int + substr(body,7,1)::int + substr(body,5,1)::int + substr(body,3,1)::int + substr(body,1,1)::int) % 10) % 10)::text, 'ean13', true FROM g;
INSERT INTO prc_price_list_item (id, tenant_id, price_list_id, variant_id, uom_id, price, valid_from)
SELECT gen_random_uuid(), :'tenant', (SELECT id FROM prc_price_list WHERE company_id = :'company' AND code = 'RETAIL'), vid, (SELECT id FROM cat_uom WHERE tenant_id = :'tenant' AND code = 'PCS'), 5 + (n % 500), now() - interval '1 day' FROM g;
INSERT INTO core_change_log (tenant_id, stream, entity_id, op) SELECT :'tenant', 'catalog', vid, 'upsert' FROM g;
COMMIT;
SET session_replication_role = origin;
ANALYZE cat_product; ANALYZE cat_variant; ANALYZE cat_barcode; ANALYZE prc_price_list_item;
SELECT count(*) AS products FROM cat_product WHERE tenant_id = :'tenant';

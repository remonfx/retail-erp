-- 0011 Catalog search under RLS.
-- Problem (measured on 1M SKUs): with Row-Level Security, PostgreSQL cannot use indexes for predicates whose
-- functions are not LEAKPROOF (LIKE, upper()) because they would run before the security qual → full scans.
-- Fix: SECURITY DEFINER search functions that apply the tenant filter explicitly from the session context
-- (rc_tenant(), never a caller-supplied tenant id) and return only ids. Callers then read rows under RLS as usual.

CREATE INDEX IF NOT EXISTS cat_variant_sku_prefix ON cat_variant (tenant_id, upper(sku) text_pattern_ops);

-- Every word (already Arabic-normalized by the caller) must appear in the product's normalized name.
CREATE OR REPLACE FUNCTION catalog_search_ids(p_words text[], p_limit int DEFAULT 1000)
RETURNS TABLE (variant_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t uuid := rc_tenant();
  cond text := '';
  w text;
BEGIN
  IF t IS NULL OR p_words IS NULL OR cardinality(p_words) = 0 THEN RETURN; END IF;
  FOREACH w IN ARRAY p_words[1:5] LOOP
    IF length(w) >= 2 THEN
      cond := cond || format(' AND p.search_norm LIKE %L', '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%');
    END IF;
  END LOOP;
  IF cond = '' THEN RETURN; END IF;
  RETURN QUERY EXECUTE format(
    'SELECT v.id FROM cat_product p JOIN cat_variant v ON v.product_id = p.id
      WHERE p.tenant_id = $1 AND v.tenant_id = $1 AND v.merged_into_id IS NULL %s LIMIT %s', cond, least(greatest(p_limit, 1), 5000))
    USING t;
END $$;

CREATE OR REPLACE FUNCTION catalog_code_ids(p_code text, p_limit int DEFAULT 200)
RETURNS TABLE (variant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  (SELECT v.id FROM cat_variant v WHERE v.tenant_id = rc_tenant() AND upper(v.sku) = upper(p_code))
  UNION
  (SELECT b.variant_id FROM cat_barcode b WHERE b.tenant_id = rc_tenant() AND b.code = p_code AND b.status <> 'retired')
  UNION
  (SELECT v.id FROM cat_variant v
    WHERE v.tenant_id = rc_tenant() AND length(p_code) >= 2
      AND upper(v.sku) LIKE replace(replace(replace(upper(p_code), '\', '\\'), '%', '\%'), '_', '\_') || '%'
    ORDER BY upper(v.sku) LIMIT least(greatest(p_limit, 1), 1000))
$$;

REVOKE ALL ON FUNCTION catalog_search_ids(text[], int), catalog_code_ids(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog_search_ids(text[], int), catalog_code_ids(text, int) TO rc_app;

-- Prefix search must use a literal pattern (EXECUTE) so the text_pattern_ops index applies; only for SKU-like codes.
CREATE OR REPLACE FUNCTION catalog_code_ids(p_code text, p_limit int DEFAULT 200)
RETURNS TABLE (variant_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE t uuid := rc_tenant();
BEGIN
  IF t IS NULL OR p_code IS NULL OR p_code = '' THEN RETURN; END IF;
  RETURN QUERY SELECT v.id FROM cat_variant v WHERE v.tenant_id = t AND upper(v.sku) = upper(p_code)
               UNION SELECT b.variant_id FROM cat_barcode b WHERE b.tenant_id = t AND b.code = p_code AND b.status <> 'retired';
  IF p_code ~ '^[A-Za-z0-9._/-]{2,64}$' THEN
    RETURN QUERY EXECUTE format('SELECT v.id FROM cat_variant v WHERE v.tenant_id = $1 AND upper(v.sku) LIKE %L ORDER BY upper(v.sku) LIMIT %s',
      replace(replace(upper(p_code), '_', '\_'), '%', '\%') || '%', least(greatest(p_limit, 1), 1000)) USING t;
  END IF;
END $$;
REVOKE ALL ON FUNCTION catalog_code_ids(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog_code_ids(text, int) TO rc_app;

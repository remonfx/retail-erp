-- 0001 Foundation: extensions, helper functions, session context, partition helper
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ===== Session context (set with SET LOCAL by the API per transaction) =====
CREATE OR REPLACE FUNCTION rc_tenant() RETURNS uuid STABLE LANGUAGE sql AS
$$ SELECT nullif(current_setting('rc.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION rc_user() RETURNS uuid STABLE LANGUAGE sql AS
$$ SELECT nullif(current_setting('rc.user_id', true), '')::uuid $$;

-- comma-separated company ids the actor may access; '*' = all companies of the tenant
CREATE OR REPLACE FUNCTION rc_company_ok(cid uuid) RETURNS boolean STABLE LANGUAGE sql AS $$
  SELECT CASE coalesce(current_setting('rc.company_ids', true), '')
           WHEN '' THEN false
           WHEN '*' THEN true
           ELSE cid = ANY (string_to_array(current_setting('rc.company_ids', true), ',')::uuid[])
         END
$$;

-- ===== Arabic normalization: MUST match packages/domain/src/arabic.ts =====
CREATE OR REPLACE FUNCTION rc_norm_ar(t text) RETURNS text IMMUTABLE PARALLEL SAFE LANGUAGE sql AS $$
  SELECT btrim(regexp_replace(lower(
    translate(
      regexp_replace(coalesce(t, ''), '[ـً-ْ]', '', 'g'),
      'أإآٱىةؤئ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
      'اااايهوي01234567890123456789')
  ), '\s+', ' ', 'g'))
$$;

-- ===== Generic guards =====
CREATE OR REPLACE FUNCTION rc_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_RECORD: % rows cannot be %', TG_TABLE_NAME, lower(TG_OP) USING ERRCODE = 'P0001';
END $$;

CREATE OR REPLACE FUNCTION rc_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := coalesce(rc_user(), NEW.updated_by);
  IF TG_OP = 'UPDATE' THEN NEW.version := OLD.version + 1; END IF;
  RETURN NEW;
END $$;

-- ===== Monthly range partitions =====
CREATE OR REPLACE FUNCTION rc_ensure_month_partitions(parent regclass, from_month date, months int) RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  m date := date_trunc('month', from_month)::date;
  created int := 0;
  pname text;
  base text := split_part(parent::text, '.', greatest(1, array_length(string_to_array(parent::text, '.'), 1)));
BEGIN
  FOR i IN 0..months - 1 LOOP
    pname := format('%s_p%s', base, to_char(m + (i || ' month')::interval, 'YYYYMM'));
    IF to_regclass(pname) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)', pname, parent,
                     (m + (i || ' month')::interval)::date, (m + ((i + 1) || ' month')::interval)::date);
      created := created + 1;
    END IF;
  END LOOP;
  IF to_regclass(base || '_pdefault') IS NULL THEN
    EXECUTE format('CREATE TABLE %I PARTITION OF %s DEFAULT', base || '_pdefault', parent);
  END IF;
  RETURN created;
END $$;

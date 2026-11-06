-- 0009 Row-Level Security (tenant + company isolation) and application role grants.
-- The API connects as role rc_app (NOT table owner, NO BYPASSRLS). Migrations run as owner.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rc_app') THEN
    CREATE ROLE rc_app LOGIN PASSWORD 'rc_app_dev_password' NOSUPERUSER NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO rc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rc_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rc_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO rc_app;
REVOKE INSERT, UPDATE, DELETE ON saas_plan FROM rc_app;
REVOKE UPDATE, DELETE ON core_audit_log FROM rc_app;
REVOKE UPDATE, DELETE ON inv_stock_move FROM rc_app;

-- Enable RLS on every table that has tenant_id (partition children inherit policies via parent access)
DO $$
DECLARE r record; has_company boolean;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
  LOOP
    SELECT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = r.relname::regclass AND a.attname = 'company_id' AND NOT a.attisdropped) INTO has_company;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.relname);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.relname);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', r.relname);
    IF has_company AND r.relname NOT IN ('core_audit_log','core_outbox_event','core_change_log','core_job','par_partner','core_role_assignment') THEN
      -- company_id may be NULL only for tenant-shared rows
      EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = rc_tenant() AND (company_id IS NULL OR rc_company_ok(company_id)))
                        WITH CHECK (tenant_id = rc_tenant() AND (company_id IS NULL OR rc_company_ok(company_id)))$p$, r.relname);
    ELSE
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = rc_tenant()) WITH CHECK (tenant_id = rc_tenant())', r.relname);
    END IF;
  END LOOP;
END $$;

-- core_tenant: a tenant sees only itself
ALTER TABLE core_tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE core_tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON core_tenant USING (id = rc_tenant()) WITH CHECK (id = rc_tenant());

-- ===== SECURITY DEFINER entry points (pre-authentication lookups) =====
-- Login: find a user by email across tenants (returns only what authentication needs).
CREATE OR REPLACE FUNCTION auth_lookup_user(p_email text)
RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text, status text, mfa_enabled boolean, tenant_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.tenant_id, u.password_hash, u.status, u.mfa_enabled, t.status
    FROM core_user u JOIN core_tenant t ON t.id = u.tenant_id
   WHERE lower(u.email) = lower(p_email)
$$;

-- Refresh: find token by hash
CREATE OR REPLACE FUNCTION auth_lookup_refresh(p_hash bytea)
RETURNS TABLE (id uuid, tenant_id uuid, user_id uuid, family_id uuid, expires_at timestamptz, revoked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, tenant_id, user_id, family_id, expires_at, revoked_at FROM core_refresh_token WHERE token_hash = p_hash
$$;

-- Device authentication: device id -> tenant + secret hash
CREATE OR REPLACE FUNCTION auth_lookup_device(p_device uuid)
RETURNS TABLE (device_id uuid, tenant_id uuid, company_id uuid, branch_id uuid, secret_hash bytea, status text, enrollment_code_hash bytea, enrollment_expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, tenant_id, company_id, branch_id, secret_hash, status, enrollment_code_hash, enrollment_expires_at FROM core_device WHERE id = p_device
$$;

-- Signup availability check
CREATE OR REPLACE FUNCTION saas_slug_available(p_slug text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT NOT EXISTS (SELECT 1 FROM core_tenant WHERE slug = p_slug)
$$;
CREATE OR REPLACE FUNCTION saas_email_available(p_email text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT NOT EXISTS (SELECT 1 FROM core_user WHERE lower(email) = lower(p_email))
$$;

REVOKE ALL ON FUNCTION auth_lookup_user(text), auth_lookup_refresh(bytea), auth_lookup_device(uuid), saas_slug_available(text), saas_email_available(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_user(text), auth_lookup_refresh(bytea), auth_lookup_device(uuid), saas_slug_available(text), saas_email_available(text) TO rc_app;

-- Default privileges for tables created by later migrations
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO rc_app;

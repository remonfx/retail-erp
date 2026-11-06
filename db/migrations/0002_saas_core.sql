-- 0002 SaaS tenancy & organization & identity
-- Conventions: uuid PK (UUIDv7 from app), tenant_id on every tenant-owned row, RLS in 0009.

-- ---------- SaaS platform (not tenant-owned) ----------
CREATE TABLE saas_plan (
  code text PRIMARY KEY,
  name_ar text NOT NULL, name_en text NOT NULL,
  max_companies int NOT NULL, max_branches int NOT NULL, max_terminals int NOT NULL, max_users int NOT NULL,
  max_skus int NOT NULL,
  monthly_price_egp numeric(19,4) NOT NULL,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE core_tenant (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,40}$'),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial','active','past_due','suspended','cancelled')),
  plan_code text NOT NULL REFERENCES saas_plan(code),
  trial_ends_at timestamptz,
  default_locale text NOT NULL DEFAULT 'ar',
  default_timezone text NOT NULL DEFAULT 'Africa/Cairo',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE saas_subscription (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES core_tenant(id),
  plan_code text NOT NULL REFERENCES saas_plan(code),
  status text NOT NULL CHECK (status IN ('trialing','active','past_due','cancelled')),
  period_start date NOT NULL, period_end date NOT NULL,
  seats_terminals int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start)
);
CREATE INDEX ON saas_subscription (tenant_id, period_end DESC);

CREATE TABLE saas_usage_daily (
  tenant_id uuid NOT NULL REFERENCES core_tenant(id),
  day date NOT NULL,
  pos_transactions bigint NOT NULL DEFAULT 0,
  active_terminals int NOT NULL DEFAULT 0,
  active_users int NOT NULL DEFAULT 0,
  sku_count int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);

-- ---------- Organization ----------
CREATE TABLE core_company (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES core_tenant(id),
  code text NOT NULL,
  legal_name_ar text NOT NULL, legal_name_en text,
  tax_registration_no text,
  commercial_register_no text,
  base_currency char(3) NOT NULL DEFAULT 'EGP',
  costing_method text NOT NULL DEFAULT 'average' CHECK (costing_method IN ('average','fifo')),
  costing_locked boolean NOT NULL DEFAULT false,
  fiscal_year_start_month int NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  prices_include_tax boolean NOT NULL DEFAULT true,
  allow_negative_stock text NOT NULL DEFAULT 'pos_offline' CHECK (allow_negative_stock IN ('never','pos_offline','pos','always')),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

CREATE TABLE core_branch (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9-]{2,12}$'),
  name_ar text NOT NULL, name_en text,
  timezone text NOT NULL DEFAULT 'Africa/Cairo',
  address text, phone text,
  eta_branch_code text,
  default_price_list_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (company_id, code),
  UNIQUE (company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES core_company(tenant_id, id)
);

CREATE TABLE core_cost_center (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL,
  code text NOT NULL, name_ar text NOT NULL, name_en text,
  branch_id uuid,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, code),
  FOREIGN KEY (company_id, branch_id) REFERENCES core_branch(company_id, id)
);

CREATE TABLE core_warehouse (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL, branch_id uuid NOT NULL,
  code text NOT NULL, name_ar text NOT NULL, name_en text,
  kind text NOT NULL DEFAULT 'store' CHECK (kind IN ('store','backstore','dc')),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, code), UNIQUE (company_id, id),
  FOREIGN KEY (company_id, branch_id) REFERENCES core_branch(company_id, id)
);

-- Locations: physical (internal/transit/quarantine/scrap) and virtual (supplier/customer/inventory_loss)
CREATE TABLE inv_location (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL,
  warehouse_id uuid,           -- NULL for company-level virtual locations
  branch_id uuid,
  parent_id uuid REFERENCES inv_location(id),
  code text NOT NULL,
  name_ar text NOT NULL, name_en text,
  type text NOT NULL CHECK (type IN ('internal','transit','quarantine','scrap','supplier','customer','inventory_loss','view')),
  path text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, code), UNIQUE (company_id, id),
  FOREIGN KEY (company_id, warehouse_id) REFERENCES core_warehouse(company_id, id),
  CHECK ((type IN ('supplier','customer','inventory_loss')) OR warehouse_id IS NOT NULL OR type = 'transit')
);
CREATE INDEX ON inv_location (warehouse_id, type);

-- ---------- Identity & access ----------
CREATE TABLE core_user (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES core_tenant(id),
  email text NOT NULL,
  full_name text NOT NULL,
  phone text,
  locale text NOT NULL DEFAULT 'ar',
  password_hash text,
  pos_pin_hash text,
  mfa_secret text,               -- encrypted at app layer (AES-256-GCM)
  mfa_enabled boolean NOT NULL DEFAULT false,
  is_tenant_owner boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','locked','disabled')),
  failed_logins int NOT NULL DEFAULT 0,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);
-- SaaS: email is globally unique (one login identity across the platform)
CREATE UNIQUE INDEX core_user_email_uk ON core_user (lower(email));
CREATE INDEX ON core_user (tenant_id);

CREATE TABLE core_role (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES core_tenant(id),
  code text NOT NULL, name_ar text NOT NULL, name_en text,
  is_system boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, code)
);

CREATE TABLE core_role_permission (
  tenant_id uuid NOT NULL,
  role_id uuid NOT NULL REFERENCES core_role(id) ON DELETE CASCADE,
  permission text NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE core_role_assignment (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES core_user(id),
  role_id uuid NOT NULL REFERENCES core_role(id),
  scope_type text NOT NULL CHECK (scope_type IN ('tenant','company','branch','warehouse')),
  company_id uuid REFERENCES core_company(id),
  branch_id uuid REFERENCES core_branch(id),
  warehouse_id uuid REFERENCES core_warehouse(id),
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {maxLineDiscountPercent, maxBasketDiscountPercent, maxRefundAmount, approvalCeiling}
  valid_from date NOT NULL DEFAULT current_date,
  valid_to date,
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope_type = 'tenant' AND company_id IS NULL AND branch_id IS NULL AND warehouse_id IS NULL)
      OR (scope_type = 'company' AND company_id IS NOT NULL AND branch_id IS NULL)
      OR (scope_type = 'branch' AND company_id IS NOT NULL AND branch_id IS NOT NULL AND warehouse_id IS NULL)
      OR (scope_type = 'warehouse' AND company_id IS NOT NULL AND warehouse_id IS NOT NULL))
);
CREATE INDEX ON core_role_assignment (user_id);

CREATE TABLE core_refresh_token (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES core_user(id),
  family_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid,
  user_agent text, ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON core_refresh_token (family_id);

-- ---------- Devices & POS terminals ----------
CREATE TABLE core_device (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL, branch_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('pos','wms','mobile')),
  name text NOT NULL,
  enrollment_code_hash bytea,
  enrollment_expires_at timestamptz,
  secret_hash bytea,                -- HMAC secret hash for device tokens (device keeps secret)
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','revoked')),
  last_seen_at timestamptz,
  app_version text,
  last_heartbeat jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  FOREIGN KEY (company_id, branch_id) REFERENCES core_branch(company_id, id)
);

CREATE TABLE pos_terminal (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL, branch_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9]{1,6}$'),
  name text NOT NULL,
  warehouse_id uuid NOT NULL,
  stock_location_id uuid NOT NULL REFERENCES inv_location(id),
  device_id uuid UNIQUE REFERENCES core_device(id),
  price_list_id uuid,
  cash_account_id uuid,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {maxOfflineHours, cashRounding, receiptHeader...}
  active boolean NOT NULL DEFAULT true,
  UNIQUE (branch_id, code),
  FOREIGN KEY (company_id, branch_id) REFERENCES core_branch(company_id, id),
  FOREIGN KEY (company_id, warehouse_id) REFERENCES core_warehouse(company_id, id)
);

-- ---------- Numbering ----------
CREATE TABLE core_number_sequence (
  tenant_id uuid NOT NULL, company_id uuid NOT NULL,
  doc_type text NOT NULL, scope_key text NOT NULL DEFAULT '', period text NOT NULL DEFAULT '',
  prefix text NOT NULL, next_value bigint NOT NULL DEFAULT 1, padding int NOT NULL DEFAULT 6,
  PRIMARY KEY (company_id, doc_type, scope_key, period)
);

-- Gapless within the calling transaction (row lock held until commit).
CREATE OR REPLACE FUNCTION rc_next_number(p_tenant uuid, p_company uuid, p_doc text, p_scope text, p_period text, p_prefix text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v bigint; pad int; pre text;
BEGIN
  INSERT INTO core_number_sequence (tenant_id, company_id, doc_type, scope_key, period, prefix)
  VALUES (p_tenant, p_company, p_doc, coalesce(p_scope, ''), coalesce(p_period, ''), p_prefix)
  ON CONFLICT DO NOTHING;
  UPDATE core_number_sequence SET next_value = next_value + 1
   WHERE company_id = p_company AND doc_type = p_doc AND scope_key = coalesce(p_scope, '') AND period = coalesce(p_period, '')
  RETURNING next_value - 1, padding, prefix INTO v, pad, pre;
  RETURN pre || lpad(v::text, pad, '0');
END $$;

-- ---------- Audit, outbox, change feed, jobs, idempotency ----------
CREATE TABLE core_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY,
  created_at timestamptz NOT NULL DEFAULT now(),
  tenant_id uuid NOT NULL,
  company_id uuid,
  user_id uuid, device_id uuid,
  action text NOT NULL,            -- insert/update/delete/<command>
  entity text NOT NULL, entity_id text NOT NULL,
  before jsonb, after jsonb,
  ip inet, request_id text,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX ON core_audit_log (tenant_id, entity, entity_id);
CREATE TRIGGER core_audit_log_immutable BEFORE UPDATE OR DELETE ON core_audit_log FOR EACH ROW EXECUTE FUNCTION rc_forbid_mutation();

-- Generic row-change audit trigger for master data tables
CREATE OR REPLACE FUNCTION rc_audit_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rec jsonb := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  old_j jsonb := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END;
  new_j jsonb := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END;
BEGIN
  IF TG_OP = 'UPDATE' AND old_j - 'updated_at' - 'version' - 'updated_by' = new_j - 'updated_at' - 'version' - 'updated_by' THEN RETURN NULL; END IF;
  INSERT INTO core_audit_log (tenant_id, company_id, user_id, device_id, action, entity, entity_id, before, after, request_id)
  VALUES ((rec->>'tenant_id')::uuid, nullif(rec->>'company_id','')::uuid, rc_user(),
          nullif(current_setting('rc.device_id', true), '')::uuid, lower(TG_OP), TG_TABLE_NAME, coalesce(rec->>'id', ''),
          old_j - 'password_hash' - 'pos_pin_hash' - 'mfa_secret', new_j - 'password_hash' - 'pos_pin_hash' - 'mfa_secret',
          nullif(current_setting('rc.request_id', true), ''));
  RETURN NULL;
END $$;

CREATE TABLE core_outbox_event (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL, company_id uuid,
  aggregate_type text NOT NULL, aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  processed_at timestamptz
);
CREATE INDEX core_outbox_pending ON core_outbox_event (available_at, id) WHERE processed_at IS NULL;

CREATE TABLE core_processed_event (
  consumer text NOT NULL, event_id uuid NOT NULL, processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

-- Pull feed for POS / mobile: monotonic version per row change
CREATE TABLE core_change_log (
  version bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  stream text NOT NULL,           -- catalog, barcodes, prices, promotions, users, tax, settings, customers
  entity_id uuid NOT NULL,
  company_id uuid, branch_id uuid,
  op text NOT NULL CHECK (op IN ('upsert','delete')),
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON core_change_log (tenant_id, stream, version);

CREATE OR REPLACE FUNCTION rc_change_feed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rec jsonb := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
BEGIN
  INSERT INTO core_change_log (tenant_id, stream, entity_id, company_id, branch_id, op)
  VALUES ((rec->>'tenant_id')::uuid, TG_ARGV[0], coalesce((rec->>'id')::uuid, (rec->>(TG_ARGV[1]))::uuid),
          nullif(rec->>'company_id','')::uuid, nullif(rec->>'branch_id','')::uuid,
          CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END);
  RETURN NULL;
END $$;

CREATE TABLE core_job (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress numeric(5,2) NOT NULL DEFAULT 0,
  result jsonb,
  error text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz
);
CREATE INDEX ON core_job (tenant_id, created_at DESC);

CREATE TABLE core_idempotency_key (
  tenant_id uuid NOT NULL, key text NOT NULL, user_id uuid,
  request_hash text NOT NULL,
  status_code int, response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE wf_approval_request (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL, branch_id uuid,
  doc_type text NOT NULL, doc_id uuid NOT NULL,
  summary text NOT NULL,
  amount numeric(19,4),
  required_permission text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by uuid NOT NULL, requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid, decided_at timestamptz, decision_note text,
  CHECK (decided_by IS NULL OR decided_by <> requested_by)   -- no self-approval
);
CREATE INDEX ON wf_approval_request (tenant_id, status, required_permission);
CREATE UNIQUE INDEX wf_one_pending_per_doc ON wf_approval_request (doc_type, doc_id) WHERE status = 'pending';

CREATE TABLE core_notification (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, user_id uuid NOT NULL,
  kind text NOT NULL, title text NOT NULL, body text, link text,
  read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON core_notification (user_id, created_at DESC);

-- audit triggers
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core_company FOR EACH ROW EXECUTE FUNCTION rc_audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core_branch FOR EACH ROW EXECUTE FUNCTION rc_audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core_warehouse FOR EACH ROW EXECUTE FUNCTION rc_audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core_user FOR EACH ROW EXECUTE FUNCTION rc_audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core_role_assignment FOR EACH ROW EXECUTE FUNCTION rc_audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core_role_permission FOR EACH ROW EXECUTE FUNCTION rc_audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON core_device FOR EACH ROW EXECUTE FUNCTION rc_audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON pos_terminal FOR EACH ROW EXECUTE FUNCTION rc_audit_row();
CREATE TRIGGER touch BEFORE UPDATE ON core_company FOR EACH ROW EXECUTE FUNCTION rc_touch();
CREATE TRIGGER touch BEFORE UPDATE ON core_branch FOR EACH ROW EXECUTE FUNCTION rc_touch();
CREATE TRIGGER touch BEFORE UPDATE ON core_user FOR EACH ROW EXECUTE FUNCTION rc_touch();
CREATE TRIGGER users_feed AFTER INSERT OR UPDATE OR DELETE ON core_user FOR EACH ROW EXECUTE FUNCTION rc_change_feed('users');

SELECT rc_ensure_month_partitions('core_audit_log', (date_trunc('month', now()) - interval '1 month')::date, 15);

INSERT INTO saas_plan (code, name_ar, name_en, max_companies, max_branches, max_terminals, max_users, max_skus, monthly_price_egp, features) VALUES
 ('starter',    'المبتدئ',   'Starter',    1,   3,   6,   25,   50000,   2500, '{"fifo":false,"eta":true,"mobile":true}'),
 ('growth',     'النمو',     'Growth',     3,  20,  60,  250,  300000,  12000, '{"fifo":true,"eta":true,"mobile":true,"api":true}'),
 ('enterprise', 'المؤسسات',  'Enterprise', 50, 500, 3000, 10000, 5000000, 0,  '{"fifo":true,"eta":true,"mobile":true,"api":true,"sso":true,"dedicated_support":true}');

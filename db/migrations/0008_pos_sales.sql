-- 0008 POS sessions, sync inbox (idempotency), sales sub-ledger
CREATE TABLE pos_session (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL, branch_id uuid NOT NULL,
  terminal_id uuid NOT NULL REFERENCES pos_terminal(id),
  number text NOT NULL,
  business_date date NOT NULL,
  opened_by uuid NOT NULL, opened_at timestamptz NOT NULL,
  opening_float numeric(19,4) NOT NULL DEFAULT 0,
  closed_by uuid, closed_at timestamptz,
  expected_cash numeric(19,4), counted_cash numeric(19,4), cash_difference numeric(19,4),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed','posted')),
  journal_entry_id uuid,
  stock_document_id uuid,
  orders_count int NOT NULL DEFAULT 0,
  sales_total numeric(19,4) NOT NULL DEFAULT 0,
  returns_total numeric(19,4) NOT NULL DEFAULT 0,
  notes text,
  UNIQUE (company_id, number)
);
CREATE UNIQUE INDEX pos_one_open_session_per_terminal ON pos_session (terminal_id) WHERE state = 'open';

CREATE TABLE pos_cash_movement (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES pos_session(id),
  kind text NOT NULL CHECK (kind IN ('cash_in','cash_out','safe_drop')),
  amount numeric(19,4) NOT NULL CHECK (amount > 0),
  reason text NOT NULL, user_id uuid NOT NULL, at timestamptz NOT NULL
);

-- Global idempotency registry for device pushes (NOT partitioned, see ARCHITECTURE §6.4)
CREATE TABLE pos_sync_inbox (
  client_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  item_type text NOT NULL,
  device_seq bigint NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('applied','quarantined')),
  server_ref uuid,
  payload jsonb,                      -- kept for quarantined items (never discard)
  error text,
  exceptions text[],
  received_at timestamptz NOT NULL DEFAULT now(),
  resolved_by uuid, resolved_at timestamptz,
  UNIQUE (device_id, device_seq)
);
CREATE INDEX ON pos_sync_inbox (tenant_id, status) WHERE status = 'quarantined';

CREATE TABLE pos_order (
  id uuid NOT NULL,
  business_date date NOT NULL,
  tenant_id uuid NOT NULL, company_id uuid NOT NULL, branch_id uuid NOT NULL,
  terminal_id uuid NOT NULL, session_id uuid NOT NULL,
  receipt_no text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('sale','return')),
  return_of_id uuid,
  customer_id uuid,
  cashier_id uuid NOT NULL,
  sold_at timestamptz NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  subtotal numeric(19,4) NOT NULL,
  discount_total numeric(19,4) NOT NULL,
  net_total numeric(19,4) NOT NULL,
  tax_total numeric(19,4) NOT NULL,
  grand_total numeric(19,4) NOT NULL,
  rounding numeric(19,4) NOT NULL DEFAULT 0,
  cost_total numeric(19,4) NOT NULL DEFAULT 0,
  engine_version text NOT NULL,
  server_recalc_delta numeric(19,4) NOT NULL DEFAULT 0,
  offline boolean NOT NULL,
  promotions jsonb,
  eta_status text NOT NULL DEFAULT 'pending' CHECK (eta_status IN ('pending','submitted','accepted','rejected','not_required')),
  eta_uuid text,
  PRIMARY KEY (id, business_date),
  UNIQUE (terminal_id, receipt_no, business_date)
) PARTITION BY RANGE (business_date);
CREATE INDEX ON pos_order (tenant_id, branch_id, business_date);
CREATE INDEX ON pos_order (session_id);
CREATE INDEX ON pos_order (customer_id) WHERE customer_id IS NOT NULL;
CREATE TRIGGER pos_order_immutable BEFORE DELETE ON pos_order FOR EACH ROW EXECUTE FUNCTION rc_forbid_mutation();
SELECT rc_ensure_month_partitions('pos_order', (date_trunc('month', now()) - interval '24 month')::date, 39);

CREATE TABLE pos_order_line (
  id uuid NOT NULL, business_date date NOT NULL,
  order_id uuid NOT NULL,
  tenant_id uuid NOT NULL, company_id uuid NOT NULL, branch_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  qty numeric(19,6) NOT NULL CHECK (qty > 0),
  uom_id uuid NOT NULL,
  unit_price numeric(19,4) NOT NULL,
  price_list_item_id uuid,
  discount_total numeric(19,4) NOT NULL DEFAULT 0,
  net numeric(19,4) NOT NULL, tax numeric(19,4) NOT NULL, total numeric(19,4) NOT NULL,
  tax_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  unit_cost numeric(19,6) NOT NULL DEFAULT 0,
  cost_total numeric(19,4) NOT NULL DEFAULT 0,
  category_id uuid,
  lot_id uuid, serial_no text,
  return_of_line_id uuid,
  override_by uuid,
  PRIMARY KEY (id, business_date),
  FOREIGN KEY (order_id, business_date) REFERENCES pos_order (id, business_date)
) PARTITION BY RANGE (business_date);
CREATE INDEX ON pos_order_line (order_id);
CREATE INDEX ON pos_order_line (variant_id, business_date);
CREATE TRIGGER pos_order_line_immutable BEFORE UPDATE OR DELETE ON pos_order_line FOR EACH ROW EXECUTE FUNCTION rc_forbid_mutation();
SELECT rc_ensure_month_partitions('pos_order_line', (date_trunc('month', now()) - interval '24 month')::date, 39);

CREATE TABLE pos_payment (
  id uuid NOT NULL, business_date date NOT NULL,
  order_id uuid NOT NULL,
  tenant_id uuid NOT NULL, company_id uuid NOT NULL, branch_id uuid NOT NULL, session_id uuid NOT NULL,
  method text NOT NULL,
  amount numeric(19,4) NOT NULL,   -- signed: negative for refunds
  reference text, card_last4 text, approval_code text,
  settled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id, business_date),
  FOREIGN KEY (order_id, business_date) REFERENCES pos_order (id, business_date)
) PARTITION BY RANGE (business_date);
CREATE INDEX ON pos_payment (session_id, method);
CREATE TRIGGER pos_payment_immutable BEFORE DELETE ON pos_payment FOR EACH ROW EXECUTE FUNCTION rc_forbid_mutation();
SELECT rc_ensure_month_partitions('pos_payment', (date_trunc('month', now()) - interval '24 month')::date, 39);

CREATE TABLE pos_pricing_discrepancy (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL, branch_id uuid NOT NULL,
  order_id uuid NOT NULL, business_date date NOT NULL,
  device_total numeric(19,4) NOT NULL, server_total numeric(19,4) NOT NULL, delta numeric(19,4) NOT NULL,
  details jsonb, created_at timestamptz NOT NULL DEFAULT now()
);

-- Operational read model (updated in the same transaction as each synced order)
CREATE TABLE rep_sales_daily (
  tenant_id uuid NOT NULL, company_id uuid NOT NULL, branch_id uuid NOT NULL,
  business_date date NOT NULL, variant_id uuid NOT NULL, category_id uuid,
  qty numeric(19,6) NOT NULL DEFAULT 0,
  gross numeric(19,4) NOT NULL DEFAULT 0,
  discount numeric(19,4) NOT NULL DEFAULT 0,
  net numeric(19,4) NOT NULL DEFAULT 0,
  tax numeric(19,4) NOT NULL DEFAULT 0,
  cost numeric(19,4) NOT NULL DEFAULT 0,
  orders int NOT NULL DEFAULT 0,
  PRIMARY KEY (branch_id, business_date, variant_id)
);
CREATE INDEX ON rep_sales_daily (tenant_id, company_id, business_date);

-- HR-lite
CREATE TABLE hr_employee (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL, branch_id uuid,
  code text NOT NULL, full_name_ar text NOT NULL, full_name_en text,
  user_id uuid REFERENCES core_user(id),
  national_id text, phone text, job_title text, hire_date date,
  cost_center_id uuid REFERENCES core_cost_center(id),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, code)
);
CREATE TABLE hr_attendance (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL,
  employee_id uuid NOT NULL REFERENCES hr_employee(id),
  branch_id uuid,
  check_in timestamptz NOT NULL, check_out timestamptz,
  source text NOT NULL CHECK (source IN ('mobile','device','manual')),
  lat numeric(9,6), lng numeric(9,6),
  CHECK (check_out IS NULL OR check_out > check_in)
);
CREATE TABLE hr_payroll_run (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL,
  period_month date NOT NULL,
  state text NOT NULL DEFAULT 'imported' CHECK (state IN ('imported','posted')),
  totals jsonb NOT NULL,
  lines jsonb NOT NULL,
  journal_entry_id uuid,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, period_month)
);

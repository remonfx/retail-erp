-- 0007 Purchasing: PR -> PO -> GRN -> supplier invoice (3-way match) -> payment; purchase returns
CREATE TABLE pur_request (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL, branch_id uuid NOT NULL,
  number text NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','submitted','approved','rejected','ordered','cancelled')),
  needed_by date, notes text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','replenishment')),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, number)
);
CREATE TABLE pur_request_line (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, request_id uuid NOT NULL REFERENCES pur_request(id),
  variant_id uuid NOT NULL REFERENCES cat_variant(id), qty numeric(19,6) NOT NULL CHECK (qty > 0), uom_id uuid NOT NULL REFERENCES cat_uom(id),
  suggested_supplier_id uuid REFERENCES par_partner(id)
);

CREATE TABLE pur_order (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL, branch_id uuid NOT NULL,
  number text NOT NULL,
  supplier_id uuid NOT NULL REFERENCES par_partner(id),
  warehouse_id uuid NOT NULL REFERENCES core_warehouse(id),
  receive_location_id uuid NOT NULL REFERENCES inv_location(id),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','pending_approval','approved','partially_received','received','closed','cancelled')),
  order_date date NOT NULL DEFAULT current_date,
  expected_date date,
  currency char(3) NOT NULL DEFAULT 'EGP',
  fx_rate numeric(19,8) NOT NULL DEFAULT 1,
  payment_terms_days int NOT NULL DEFAULT 0,
  subtotal numeric(19,4) NOT NULL DEFAULT 0,
  tax_total numeric(19,4) NOT NULL DEFAULT 0,
  total numeric(19,4) NOT NULL DEFAULT 0,
  request_id uuid REFERENCES pur_request(id),
  notes text,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid, approved_at timestamptz,
  version int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  UNIQUE (company_id, number),
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);
CREATE INDEX ON pur_order (tenant_id, company_id, state, order_date DESC);
CREATE TABLE pur_order_line (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, order_id uuid NOT NULL REFERENCES pur_order(id),
  line_no int NOT NULL,
  variant_id uuid NOT NULL REFERENCES cat_variant(id),
  qty numeric(19,6) NOT NULL CHECK (qty > 0),
  uom_id uuid NOT NULL REFERENCES cat_uom(id),
  unit_price numeric(19,6) NOT NULL CHECK (unit_price >= 0),     -- net of VAT
  tax_rate_id uuid REFERENCES tax_rate(id),
  qty_received numeric(19,6) NOT NULL DEFAULT 0,
  qty_invoiced numeric(19,6) NOT NULL DEFAULT 0,
  qty_returned numeric(19,6) NOT NULL DEFAULT 0,
  UNIQUE (order_id, line_no)
);

CREATE TABLE pur_receipt (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL, branch_id uuid NOT NULL,
  number text NOT NULL,
  order_id uuid NOT NULL REFERENCES pur_order(id),
  supplier_id uuid NOT NULL REFERENCES par_partner(id),
  location_id uuid NOT NULL REFERENCES inv_location(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  supplier_delivery_note text,
  state text NOT NULL DEFAULT 'done' CHECK (state IN ('done','cancelled')),
  stock_document_id uuid REFERENCES inv_stock_document(id),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, number)
);
CREATE TABLE pur_receipt_line (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, receipt_id uuid NOT NULL REFERENCES pur_receipt(id),
  order_line_id uuid NOT NULL REFERENCES pur_order_line(id),
  variant_id uuid NOT NULL REFERENCES cat_variant(id),
  qty numeric(19,6) NOT NULL CHECK (qty > 0),
  uom_id uuid NOT NULL,
  qty_stock_uom numeric(19,6) NOT NULL,
  unit_cost numeric(19,6) NOT NULL,          -- PO price in company currency per stock uom
  lot_no text, expiry_date date,
  qty_invoiced numeric(19,6) NOT NULL DEFAULT 0
);

CREATE TABLE pur_invoice (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL, branch_id uuid NOT NULL,
  number text NOT NULL,
  kind text NOT NULL DEFAULT 'invoice' CHECK (kind IN ('invoice','credit_note')),
  supplier_id uuid NOT NULL REFERENCES par_partner(id),
  supplier_invoice_no text NOT NULL,
  invoice_date date NOT NULL,
  due_date date NOT NULL,
  currency char(3) NOT NULL DEFAULT 'EGP',
  subtotal numeric(19,4) NOT NULL, tax_total numeric(19,4) NOT NULL, total numeric(19,4) NOT NULL,
  amount_paid numeric(19,4) NOT NULL DEFAULT 0,
  match_status text NOT NULL DEFAULT 'unmatched' CHECK (match_status IN ('unmatched','matched','exception','exception_approved')),
  match_details jsonb,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','posted','cancelled')),
  journal_entry_id uuid,
  eta_uuid text,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid, posted_at timestamptz,
  UNIQUE (company_id, number),
  UNIQUE (company_id, supplier_id, supplier_invoice_no, kind),          -- duplicate supplier invoice prevention
  CHECK (total = subtotal + tax_total),
  CHECK (amount_paid >= 0 AND amount_paid <= total)
);
CREATE TABLE pur_invoice_line (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, invoice_id uuid NOT NULL REFERENCES pur_invoice(id),
  order_line_id uuid REFERENCES pur_order_line(id),
  receipt_line_id uuid REFERENCES pur_receipt_line(id),
  variant_id uuid REFERENCES cat_variant(id),
  account_id uuid REFERENCES acc_account(id),       -- for non-stock lines (services, freight)
  description text,
  qty numeric(19,6) NOT NULL CHECK (qty > 0),
  unit_price numeric(19,6) NOT NULL CHECK (unit_price >= 0),
  tax_rate_id uuid REFERENCES tax_rate(id),
  net numeric(19,4) NOT NULL, tax numeric(19,4) NOT NULL,
  CHECK (variant_id IS NOT NULL OR account_id IS NOT NULL)
);

CREATE TABLE pur_return (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL, branch_id uuid NOT NULL,
  number text NOT NULL,
  supplier_id uuid NOT NULL REFERENCES par_partner(id),
  order_id uuid REFERENCES pur_order(id),
  location_id uuid NOT NULL REFERENCES inv_location(id),
  reason text NOT NULL,
  state text NOT NULL DEFAULT 'done' CHECK (state IN ('done','cancelled')),
  stock_document_id uuid REFERENCES inv_stock_document(id),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, number)
);
CREATE TABLE pur_return_line (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, return_id uuid NOT NULL REFERENCES pur_return(id),
  variant_id uuid NOT NULL REFERENCES cat_variant(id),
  order_line_id uuid REFERENCES pur_order_line(id),
  qty numeric(19,6) NOT NULL CHECK (qty > 0),
  unit_price numeric(19,6) NOT NULL, tax_rate_id uuid REFERENCES tax_rate(id)
);

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON pur_order FOR EACH ROW EXECUTE FUNCTION rc_audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON pur_invoice FOR EACH ROW EXECUTE FUNCTION rc_audit_row();
CREATE TRIGGER touch BEFORE UPDATE ON pur_order FOR EACH ROW EXECUTE FUNCTION rc_touch();

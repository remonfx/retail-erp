-- 0005 Inventory engine: lots, serials, quants, immutable moves, valuation
CREATE TABLE inv_reason_code (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, code text NOT NULL, name_ar text NOT NULL, name_en text,
  applies_to text NOT NULL CHECK (applies_to IN ('adjustment','scrap','return','count','transfer')),
  direction text NOT NULL CHECK (direction IN ('in','out','both')),
  account_mapping_key text NOT NULL,                      -- e.g. inventory.shrinkage
  requires_approval_above numeric(19,4),                  -- value threshold
  UNIQUE (tenant_id, code)
);

CREATE TABLE inv_lot (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  variant_id uuid NOT NULL REFERENCES cat_variant(id),
  lot_no text NOT NULL,
  production_date date, expiry_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (variant_id, lot_no)
);
CREATE INDEX ON inv_lot (expiry_date) WHERE expiry_date IS NOT NULL;

CREATE TABLE inv_serial (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  variant_id uuid NOT NULL REFERENCES cat_variant(id),
  serial_no text NOT NULL,
  status text NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','sold','returned','scrapped','in_transit')),
  location_id uuid REFERENCES inv_location(id),
  UNIQUE (variant_id, serial_no)
);

-- Materialized balances. lot_id/owner_id use the nil UUID for "none" so they can be part of the PK.
CREATE TABLE inv_stock_quant (
  tenant_id uuid NOT NULL, company_id uuid NOT NULL,
  location_id uuid NOT NULL REFERENCES inv_location(id),
  variant_id uuid NOT NULL REFERENCES cat_variant(id),
  lot_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  owner_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  qty_on_hand numeric(19,6) NOT NULL DEFAULT 0,
  qty_reserved numeric(19,6) NOT NULL DEFAULT 0 CHECK (qty_reserved >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, variant_id, lot_id, owner_id)
);
CREATE INDEX ON inv_stock_quant (variant_id, location_id);

-- Stock documents group moves (receipt, delivery, transfer, adjustment, scrap, count, pos_session)
CREATE TABLE inv_stock_document (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL, branch_id uuid NOT NULL,
  number text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('receipt','issue','transfer','adjustment','scrap','count','sale','sale_return','purchase_return')),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','pending_approval','approved','in_transit','done','cancelled')),
  from_location_id uuid REFERENCES inv_location(id),
  to_location_id uuid REFERENCES inv_location(id),
  dest_branch_id uuid,
  reason_code_id uuid REFERENCES inv_reason_code(id),
  source_type text, source_id uuid,
  notes text,
  total_value numeric(19,4),
  requested_by uuid, approved_by uuid, done_by uuid, done_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (company_id, number)
);
CREATE INDEX ON inv_stock_document (tenant_id, company_id, kind, state, created_at DESC);

CREATE TABLE inv_stock_document_line (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  document_id uuid NOT NULL REFERENCES inv_stock_document(id),
  variant_id uuid NOT NULL REFERENCES cat_variant(id),
  qty numeric(19,6) NOT NULL CHECK (qty > 0),
  uom_id uuid NOT NULL REFERENCES cat_uom(id),
  qty_done numeric(19,6) NOT NULL DEFAULT 0,
  lot_no text, expiry_date date, serial_no text,
  unit_cost numeric(19,6),
  notes text
);
CREATE INDEX ON inv_stock_document_line (document_id);

-- Immutable stock ledger, monthly partitions on moved_at
CREATE TABLE inv_stock_move (
  id uuid NOT NULL,
  moved_at timestamptz NOT NULL,
  tenant_id uuid NOT NULL, company_id uuid NOT NULL, branch_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  from_location_id uuid NOT NULL,
  to_location_id uuid NOT NULL,
  lot_id uuid, serial_no text,
  owner_id uuid,
  qty numeric(19,6) NOT NULL CHECK (qty > 0),
  uom_id uuid NOT NULL,
  qty_stock_uom numeric(19,6) NOT NULL CHECK (qty_stock_uom > 0),
  unit_cost numeric(19,6) NOT NULL DEFAULT 0,
  value numeric(19,4) NOT NULL DEFAULT 0,
  move_type text NOT NULL CHECK (move_type IN ('receipt','purchase_return','sale','sale_return','transfer_out','transfer_in','internal',
                                                'adjustment_gain','adjustment_loss','scrap','count_gain','count_loss','opening')),
  reason_code_id uuid,
  ref_doc_type text NOT NULL,
  ref_doc_id uuid NOT NULL,
  ref_line_id uuid,
  approval_state text NOT NULL DEFAULT 'not_required' CHECK (approval_state IN ('not_required','approved')),
  user_id uuid NOT NULL,
  device_id uuid,
  reversal_of_id uuid,
  negative_exception boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, moved_at),
  CHECK (from_location_id <> to_location_id)
) PARTITION BY RANGE (moved_at);
CREATE INDEX ON inv_stock_move (variant_id, moved_at);
CREATE INDEX ON inv_stock_move (ref_doc_type, ref_doc_id);
CREATE INDEX ON inv_stock_move (tenant_id, company_id, moved_at);
CREATE INDEX ON inv_stock_move USING brin (moved_at);
CREATE TRIGGER inv_stock_move_immutable BEFORE UPDATE OR DELETE ON inv_stock_move FOR EACH ROW EXECUTE FUNCTION rc_forbid_mutation();
SELECT rc_ensure_month_partitions('inv_stock_move', (date_trunc('month', now()) - interval '12 month')::date, 27);

-- Weighted-average state per (company, variant); also tracks totals for FIFO companies
CREATE TABLE inv_product_cost (
  tenant_id uuid NOT NULL, company_id uuid NOT NULL,
  variant_id uuid NOT NULL REFERENCES cat_variant(id),
  qty numeric(19,6) NOT NULL DEFAULT 0,
  value numeric(19,4) NOT NULL DEFAULT 0,
  last_avg numeric(19,6) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, variant_id)
);

-- Valuation layers (FIFO consumption source; audit trail of value for both methods)
CREATE TABLE inv_valuation_layer (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  stock_move_id uuid NOT NULL, moved_at timestamptz NOT NULL,
  qty numeric(19,6) NOT NULL,                 -- signed: + in, - out
  unit_cost numeric(19,6) NOT NULL,
  value numeric(19,4) NOT NULL,               -- signed
  remaining_qty numeric(19,6) NOT NULL DEFAULT 0,
  remaining_value numeric(19,4) NOT NULL DEFAULT 0,
  cogs_adjustment numeric(19,4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inv_layer_fifo ON inv_valuation_layer (company_id, variant_id, created_at, id) WHERE remaining_qty > 0;
CREATE INDEX ON inv_valuation_layer (stock_move_id);

CREATE TABLE inv_valuation_consumption (
  tenant_id uuid NOT NULL,
  layer_id uuid NOT NULL REFERENCES inv_valuation_layer(id),
  stock_move_id uuid NOT NULL,
  qty numeric(19,6) NOT NULL, value numeric(19,4) NOT NULL,
  PRIMARY KEY (layer_id, stock_move_id)
);

CREATE TABLE inv_negative_exception (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL, branch_id uuid NOT NULL,
  location_id uuid NOT NULL, variant_id uuid NOT NULL,
  qty_after numeric(19,6) NOT NULL,
  source_type text NOT NULL, source_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolved_by uuid, resolved_at timestamptz, resolution text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON inv_negative_exception (tenant_id, status);

CREATE TABLE inv_stock_count (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL, branch_id uuid NOT NULL,
  number text NOT NULL,
  warehouse_id uuid NOT NULL,
  location_id uuid NOT NULL REFERENCES inv_location(id),
  kind text NOT NULL DEFAULT 'cycle' CHECK (kind IN ('full','cycle','blind')),
  state text NOT NULL DEFAULT 'counting' CHECK (state IN ('counting','review','pending_approval','posted','cancelled')),
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  category_id uuid,
  posted_document_id uuid REFERENCES inv_stock_document(id),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (company_id, number)
);
CREATE TABLE inv_stock_count_line (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  count_id uuid NOT NULL REFERENCES inv_stock_count(id),
  variant_id uuid NOT NULL REFERENCES cat_variant(id),
  lot_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  snapshot_qty numeric(19,6) NOT NULL,
  counted_qty numeric(19,6),
  counted_by uuid, counted_at timestamptz,
  device_id uuid,
  UNIQUE (count_id, variant_id, lot_id)
);

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON inv_stock_document FOR EACH ROW EXECUTE FUNCTION rc_audit_row();
CREATE TRIGGER touch BEFORE UPDATE ON inv_stock_document FOR EACH ROW EXECUTE FUNCTION rc_touch();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON inv_reason_code FOR EACH ROW EXECUTE FUNCTION rc_audit_row();

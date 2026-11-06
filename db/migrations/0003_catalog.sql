-- 0003 Catalog / PIM, tax master, partners
CREATE TABLE cat_uom_category (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, code text NOT NULL, name_ar text NOT NULL, name_en text,
  UNIQUE (tenant_id, code)
);
CREATE TABLE cat_uom (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  category_id uuid NOT NULL REFERENCES cat_uom_category(id),
  code text NOT NULL, name_ar text NOT NULL, name_en text,
  factor numeric(19,6) NOT NULL CHECK (factor > 0),       -- relative to category reference (=1)
  rounding numeric(19,6) NOT NULL DEFAULT 1 CHECK (rounding > 0),
  UNIQUE (tenant_id, code)
);

CREATE TABLE cat_category (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  parent_id uuid REFERENCES cat_category(id),
  code text NOT NULL,
  name_ar text NOT NULL, name_en text,
  path uuid[] NOT NULL,                  -- ancestors incl. self, root first (materialized path)
  depth int GENERATED ALWAYS AS (cardinality(path)) STORED,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);
CREATE INDEX cat_category_path ON cat_category USING gin (path);

CREATE TABLE cat_brand (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, name_ar text NOT NULL, name_en text, active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, name_ar)
);

CREATE TABLE tax_class (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, code text NOT NULL, name_ar text NOT NULL, name_en text,
  eta_tax_type text, eta_subtype text,
  UNIQUE (tenant_id, code)
);
CREATE TABLE tax_rate (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, code text NOT NULL, name_ar text NOT NULL, name_en text,
  kind text NOT NULL CHECK (kind IN ('vat','table','exempt','zero','withholding')),
  rate numeric(9,6) NOT NULL CHECK (rate >= 0 AND rate <= 100),
  sequence int NOT NULL DEFAULT 0,
  valid_from date NOT NULL DEFAULT '2000-01-01', valid_to date,
  UNIQUE (tenant_id, code)
);
CREATE TABLE tax_class_rate (
  tenant_id uuid NOT NULL, tax_class_id uuid NOT NULL REFERENCES tax_class(id), tax_rate_id uuid NOT NULL REFERENCES tax_rate(id),
  PRIMARY KEY (tax_class_id, tax_rate_id)
);

CREATE TABLE cat_product (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  name_ar text NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 250),
  name_en text,
  description_ar text, description_en text,
  search_norm text GENERATED ALWAYS AS (rc_norm_ar(name_ar || ' ' || coalesce(name_en, ''))) STORED,
  category_id uuid NOT NULL REFERENCES cat_category(id),
  brand_id uuid REFERENCES cat_brand(id),
  stock_uom_id uuid NOT NULL REFERENCES cat_uom(id),
  purchase_uom_id uuid REFERENCES cat_uom(id),
  sales_uom_id uuid REFERENCES cat_uom(id),
  tax_class_id uuid NOT NULL REFERENCES tax_class(id),
  tracking text NOT NULL DEFAULT 'none' CHECK (tracking IN ('none','lot','serial')),
  is_weighted boolean NOT NULL DEFAULT false,
  is_stockable boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','discontinued','archived')),
  blocked_for_sale boolean NOT NULL DEFAULT false,
  blocked_for_purchase boolean NOT NULL DEFAULT false,
  merged_into_id uuid REFERENCES cat_product(id),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);
CREATE INDEX cat_product_trgm ON cat_product USING gin (search_norm gin_trgm_ops);
CREATE INDEX ON cat_product (tenant_id, category_id);
CREATE INDEX ON cat_product (tenant_id, brand_id);

CREATE TABLE cat_attribute (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, code text NOT NULL, name_ar text NOT NULL, name_en text,
  UNIQUE (tenant_id, code)
);
CREATE TABLE cat_attribute_value (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, attribute_id uuid NOT NULL REFERENCES cat_attribute(id),
  code text NOT NULL, name_ar text NOT NULL, name_en text, sort int NOT NULL DEFAULT 0,
  UNIQUE (attribute_id, code)
);

CREATE TABLE cat_variant (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES cat_product(id),
  sku text NOT NULL CHECK (sku ~ '^[A-Za-z0-9._/-]{1,64}$'),
  name_suffix_ar text, name_suffix_en text,         -- e.g. "أحمر / L"
  weight_kg numeric(19,6),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','discontinued','archived')),
  merged_into_id uuid REFERENCES cat_variant(id),
  standard_cost numeric(19,6),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX cat_variant_sku_uk ON cat_variant (tenant_id, upper(sku));
CREATE INDEX ON cat_variant (product_id);

CREATE TABLE cat_variant_attribute_value (
  tenant_id uuid NOT NULL,
  variant_id uuid NOT NULL REFERENCES cat_variant(id),
  attribute_id uuid NOT NULL REFERENCES cat_attribute(id),
  value_id uuid NOT NULL REFERENCES cat_attribute_value(id),
  PRIMARY KEY (variant_id, attribute_id)
);

CREATE TABLE cat_barcode (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  variant_id uuid NOT NULL REFERENCES cat_variant(id),
  code text NOT NULL CHECK (code ~ '^[\x21-\x7e]{1,64}$'),
  symbology text NOT NULL CHECK (symbology IN ('ean13','ean8','upca','code128','internal')),
  uom_id uuid REFERENCES cat_uom(id),
  pack_qty numeric(19,6) NOT NULL DEFAULT 1 CHECK (pack_qty > 0),
  is_primary boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','alias','retired')),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid
);
-- Duplicate barcode detection: one live owner per code per tenant
CREATE UNIQUE INDEX cat_barcode_live_uk ON cat_barcode (tenant_id, code) WHERE status <> 'retired';
CREATE UNIQUE INDEX cat_barcode_one_primary ON cat_barcode (variant_id) WHERE is_primary AND status = 'active';
CREATE INDEX ON cat_barcode (variant_id);

CREATE TABLE cat_embedded_barcode_rule (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  prefix text NOT NULL CHECK (prefix ~ '^2[0-9]$'),
  item_code_length int NOT NULL CHECK (item_code_length BETWEEN 4 AND 6),
  value_length int NOT NULL CHECK (value_length BETWEEN 4 AND 6),
  value_type text NOT NULL CHECK (value_type IN ('weight','price','quantity')),
  value_decimals int NOT NULL CHECK (value_decimals BETWEEN 0 AND 3),
  UNIQUE (tenant_id, prefix)
);
-- Scale item code (PLU) per variant
CREATE TABLE cat_scale_plu (
  tenant_id uuid NOT NULL, item_code text NOT NULL, variant_id uuid NOT NULL REFERENCES cat_variant(id),
  PRIMARY KEY (tenant_id, item_code)
);

CREATE TABLE cat_product_image (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, product_id uuid NOT NULL REFERENCES cat_product(id),
  variant_id uuid REFERENCES cat_variant(id),
  object_key text NOT NULL, content_type text NOT NULL, sort int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Partners: suppliers & customers (one master, roles as flags)
CREATE TABLE par_partner (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  company_id uuid,                   -- NULL = shared across companies of tenant
  code text NOT NULL,
  name_ar text NOT NULL, name_en text,
  search_norm text GENERATED ALWAYS AS (rc_norm_ar(name_ar || ' ' || coalesce(name_en, '') || ' ' || coalesce(phone, ''))) STORED,
  is_supplier boolean NOT NULL DEFAULT false,
  is_customer boolean NOT NULL DEFAULT false,
  kind text NOT NULL DEFAULT 'company' CHECK (kind IN ('company','person')),
  tax_registration_no text, national_id text, commercial_register_no text,
  phone text, phone_norm text, email text, address text,
  currency char(3) NOT NULL DEFAULT 'EGP',
  payment_terms_days int NOT NULL DEFAULT 0 CHECK (payment_terms_days >= 0),
  credit_limit numeric(19,4),
  wht_category text,                 -- withholding tax category for supplier payments
  consignment boolean NOT NULL DEFAULT false,
  customer_group_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, code)
);
CREATE UNIQUE INDEX par_partner_customer_phone_uk ON par_partner (tenant_id, phone_norm) WHERE is_customer AND phone_norm IS NOT NULL AND active;
CREATE INDEX par_partner_trgm ON par_partner USING gin (search_norm gin_trgm_ops);

CREATE TABLE cat_supplier_product (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  supplier_id uuid NOT NULL REFERENCES par_partner(id),
  variant_id uuid NOT NULL REFERENCES cat_variant(id),
  supplier_sku text,
  purchase_uom_id uuid REFERENCES cat_uom(id),
  last_cost numeric(19,6),
  currency char(3) NOT NULL DEFAULT 'EGP',
  lead_time_days int NOT NULL DEFAULT 0,
  moq numeric(19,6) NOT NULL DEFAULT 1,
  pack_multiple numeric(19,6) NOT NULL DEFAULT 1,
  preferred boolean NOT NULL DEFAULT false,
  UNIQUE (supplier_id, variant_id)
);
CREATE UNIQUE INDEX cat_supplier_preferred_uk ON cat_supplier_product (variant_id) WHERE preferred;

CREATE TABLE cat_branch_assortment (
  tenant_id uuid NOT NULL, company_id uuid NOT NULL, branch_id uuid NOT NULL,
  variant_id uuid NOT NULL REFERENCES cat_variant(id),
  sellable boolean NOT NULL DEFAULT true,
  purchasable boolean NOT NULL DEFAULT true,
  reorder_point numeric(19,6), min_qty numeric(19,6), max_qty numeric(19,6),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_id, variant_id),
  FOREIGN KEY (company_id, branch_id) REFERENCES core_branch(company_id, id),
  CHECK (min_qty IS NULL OR max_qty IS NULL OR min_qty <= max_qty)
);
CREATE INDEX ON cat_branch_assortment (variant_id);

CREATE TABLE cat_product_merge (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  source_variant_id uuid NOT NULL REFERENCES cat_variant(id),
  target_variant_id uuid NOT NULL REFERENCES cat_variant(id),
  moved jsonb NOT NULL,
  merged_by uuid NOT NULL, merged_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_variant_id <> target_variant_id)
);

-- audit + change feed
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON cat_product FOR EACH ROW EXECUTE FUNCTION rc_audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON cat_variant FOR EACH ROW EXECUTE FUNCTION rc_audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON cat_barcode FOR EACH ROW EXECUTE FUNCTION rc_audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON par_partner FOR EACH ROW EXECUTE FUNCTION rc_audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON tax_rate FOR EACH ROW EXECUTE FUNCTION rc_audit_row();
CREATE TRIGGER touch BEFORE UPDATE ON cat_product FOR EACH ROW EXECUTE FUNCTION rc_touch();
CREATE TRIGGER touch BEFORE UPDATE ON cat_variant FOR EACH ROW EXECUTE FUNCTION rc_touch();
CREATE TRIGGER touch BEFORE UPDATE ON par_partner FOR EACH ROW EXECUTE FUNCTION rc_touch();
CREATE TRIGGER feed AFTER INSERT OR UPDATE OR DELETE ON cat_product FOR EACH ROW EXECUTE FUNCTION rc_change_feed('catalog');
CREATE TRIGGER feed AFTER INSERT OR UPDATE OR DELETE ON cat_variant FOR EACH ROW EXECUTE FUNCTION rc_change_feed('catalog');
CREATE TRIGGER feed AFTER INSERT OR UPDATE OR DELETE ON cat_barcode FOR EACH ROW EXECUTE FUNCTION rc_change_feed('barcodes');
CREATE TRIGGER feed AFTER INSERT OR UPDATE OR DELETE ON cat_branch_assortment FOR EACH ROW EXECUTE FUNCTION rc_change_feed('assortment', 'variant_id');
CREATE TRIGGER feed AFTER INSERT OR UPDATE OR DELETE ON tax_rate FOR EACH ROW EXECUTE FUNCTION rc_change_feed('tax');
CREATE TRIGGER feed AFTER INSERT OR UPDATE OR DELETE ON par_partner FOR EACH ROW EXECUTE FUNCTION rc_change_feed('customers');

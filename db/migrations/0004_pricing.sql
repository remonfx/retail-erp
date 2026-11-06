-- 0004 Pricing & promotions
CREATE TABLE prc_branch_group (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL, code text NOT NULL, name_ar text NOT NULL, name_en text,
  UNIQUE (company_id, code)
);
CREATE TABLE prc_branch_group_member (
  tenant_id uuid NOT NULL, group_id uuid NOT NULL REFERENCES prc_branch_group(id) ON DELETE CASCADE, branch_id uuid NOT NULL REFERENCES core_branch(id),
  PRIMARY KEY (group_id, branch_id)
);

CREATE TABLE prc_price_list (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL,
  code text NOT NULL, name_ar text NOT NULL, name_en text,
  kind text NOT NULL DEFAULT 'retail' CHECK (kind IN ('retail','wholesale','custom','transfer')),
  scope text NOT NULL CHECK (scope IN ('company','branch_group','branch')),
  branch_id uuid REFERENCES core_branch(id),
  branch_group_id uuid REFERENCES prc_branch_group(id),
  currency char(3) NOT NULL DEFAULT 'EGP',
  prices_include_tax boolean NOT NULL DEFAULT true,
  priority int NOT NULL DEFAULT 10,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, code),
  CHECK ((scope = 'company' AND branch_id IS NULL AND branch_group_id IS NULL)
      OR (scope = 'branch' AND branch_id IS NOT NULL)
      OR (scope = 'branch_group' AND branch_group_id IS NOT NULL))
);

CREATE TABLE prc_price_list_item (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  price_list_id uuid NOT NULL REFERENCES prc_price_list(id),
  variant_id uuid NOT NULL REFERENCES cat_variant(id),
  uom_id uuid NOT NULL REFERENCES cat_uom(id),
  price numeric(19,4) NOT NULL CHECK (price >= 0),
  min_qty numeric(19,6) NOT NULL DEFAULT 1 CHECK (min_qty > 0),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (price_list_id WITH =, variant_id WITH =, uom_id WITH =, min_qty WITH =, tstzrange(valid_from, valid_to) WITH &&)
);
CREATE INDEX ON prc_price_list_item (variant_id, price_list_id, valid_from DESC);

CREATE TABLE prc_promotion (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL,
  code text NOT NULL, name_ar text NOT NULL, name_en text,
  priority int NOT NULL DEFAULT 10,
  exclusive boolean NOT NULL DEFAULT false,
  stackable boolean NOT NULL DEFAULT false,
  valid_from timestamptz NOT NULL, valid_to timestamptz,
  time_from text CHECK (time_from ~ '^[0-2][0-9]:[0-5][0-9]$'), time_to text CHECK (time_to ~ '^[0-2][0-9]:[0-5][0-9]$'),
  coupon_code text,
  customer_group_ids uuid[],
  targets jsonb NOT NULL,
  rule jsonb NOT NULL,
  all_branches boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','active','ended','cancelled')),
  approved_by uuid, approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (company_id, code),
  CHECK (rule ? 'type')
);
CREATE TABLE prc_promotion_branch (
  tenant_id uuid NOT NULL, promotion_id uuid NOT NULL REFERENCES prc_promotion(id) ON DELETE CASCADE, branch_id uuid NOT NULL REFERENCES core_branch(id),
  PRIMARY KEY (promotion_id, branch_id)
);

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON prc_price_list_item FOR EACH ROW EXECUTE FUNCTION rc_audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON prc_promotion FOR EACH ROW EXECUTE FUNCTION rc_audit_row();
CREATE TRIGGER feed AFTER INSERT OR UPDATE OR DELETE ON prc_price_list_item FOR EACH ROW EXECUTE FUNCTION rc_change_feed('prices');
CREATE TRIGGER feed AFTER INSERT OR UPDATE OR DELETE ON prc_promotion FOR EACH ROW EXECUTE FUNCTION rc_change_feed('promotions');

ALTER TABLE core_branch ADD CONSTRAINT core_branch_default_pl_fk FOREIGN KEY (default_price_list_id) REFERENCES prc_price_list(id);

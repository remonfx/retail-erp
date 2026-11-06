-- 0006 Accounting: COA, periods, journals (immutable when posted), mappings, balances
CREATE TABLE acc_account (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL,
  code text NOT NULL,
  name_ar text NOT NULL, name_en text,
  type text NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  subtype text NOT NULL DEFAULT 'other',
  cash_flow_group text CHECK (cash_flow_group IN ('cash','operating','investing','financing','non_cash')),
  parent_id uuid REFERENCES acc_account(id),
  is_postable boolean NOT NULL DEFAULT true,
  reconcilable boolean NOT NULL DEFAULT false,
  intercompany boolean NOT NULL DEFAULT false,
  currency char(3),
  archived_at timestamptz,
  UNIQUE (company_id, code), UNIQUE (company_id, id)
);

CREATE TABLE acc_fiscal_year (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL,
  code text NOT NULL, start_date date NOT NULL, end_date date NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','closing','closed')),
  UNIQUE (company_id, code), CHECK (end_date > start_date)
);
CREATE TABLE acc_fiscal_period (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL,
  fiscal_year_id uuid NOT NULL REFERENCES acc_fiscal_year(id),
  code text NOT NULL, start_date date NOT NULL, end_date date NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','soft_locked','hard_locked')),
  locked_by uuid, locked_at timestamptz,
  UNIQUE (company_id, code),
  EXCLUDE USING gist (company_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
);

CREATE TABLE acc_journal (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL,
  code text NOT NULL, name_ar text NOT NULL, name_en text,
  kind text NOT NULL CHECK (kind IN ('sales','purchase','cash','bank','inventory','general','payroll','closing')),
  default_account_id uuid REFERENCES acc_account(id),
  UNIQUE (company_id, code)
);

CREATE TABLE acc_journal_entry (
  id uuid NOT NULL,
  posting_date date NOT NULL,
  tenant_id uuid NOT NULL, company_id uuid NOT NULL,
  journal_id uuid NOT NULL,
  number text,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','posted','reversed')),
  source_type text NOT NULL,         -- manual, pos_session, goods_receipt, supplier_invoice, payment, stock_document, ...
  source_id uuid,
  source_event_id uuid,
  posting_rule text,
  posting_rule_version int,
  reversal_of_id uuid, reversal_of_date date,
  reversed_by_id uuid,
  memo text,
  total_debit numeric(19,4) NOT NULL DEFAULT 0,
  total_credit numeric(19,4) NOT NULL DEFAULT 0,
  late_posting boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid, posted_at timestamptz,
  PRIMARY KEY (id, posting_date),
  CHECK (state = 'draft' OR (total_debit = total_credit AND total_debit > 0))
) PARTITION BY RANGE (posting_date);
CREATE INDEX ON acc_journal_entry (tenant_id, company_id, posting_date);
CREATE INDEX ON acc_journal_entry (source_type, source_id);
SELECT rc_ensure_month_partitions('acc_journal_entry', (date_trunc('month', now()) - interval '24 month')::date, 39);

-- global idempotency for automated postings (unique across partitions)
CREATE TABLE acc_posting_registry (
  source_event_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  entry_id uuid NOT NULL, posting_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE acc_journal_line (
  id uuid NOT NULL,
  posting_date date NOT NULL,
  entry_id uuid NOT NULL,
  tenant_id uuid NOT NULL, company_id uuid NOT NULL,
  account_id uuid NOT NULL,
  debit numeric(19,4) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(19,4) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  currency char(3) NOT NULL DEFAULT 'EGP',
  amount_currency numeric(19,4),
  fx_rate numeric(19,8),
  partner_id uuid,
  branch_id uuid,
  cost_center_id uuid,
  tax_rate_id uuid, tax_base numeric(19,4),
  variant_id uuid, quantity numeric(19,6),
  due_date date,
  label text,
  reconciled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id, posting_date),
  CHECK ((debit = 0) <> (credit = 0)),
  FOREIGN KEY (entry_id, posting_date) REFERENCES acc_journal_entry (id, posting_date),
  FOREIGN KEY (company_id, account_id) REFERENCES acc_account (company_id, id)
) PARTITION BY RANGE (posting_date);
CREATE INDEX ON acc_journal_line (entry_id);
CREATE INDEX ON acc_journal_line (company_id, account_id, posting_date);
CREATE INDEX ON acc_journal_line (partner_id, account_id) WHERE partner_id IS NOT NULL;
SELECT rc_ensure_month_partitions('acc_journal_line', (date_trunc('month', now()) - interval '24 month')::date, 39);

-- Running balances per period & dimensions (maintained on posting)
CREATE TABLE acc_account_balance (
  tenant_id uuid NOT NULL, company_id uuid NOT NULL, account_id uuid NOT NULL,
  period_month date NOT NULL,
  branch_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  cost_center_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  debit numeric(19,4) NOT NULL DEFAULT 0,
  credit numeric(19,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, account_id, period_month, branch_id, cost_center_id)
);

-- Lines are editable only while their entry is draft
CREATE OR REPLACE FUNCTION acc_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT state INTO st FROM acc_journal_entry
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.entry_id ELSE NEW.entry_id END
     AND posting_date = CASE WHEN TG_OP = 'DELETE' THEN OLD.posting_date ELSE NEW.posting_date END;
  IF st IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'POSTED_ENTRY_IMMUTABLE: lines of a % entry cannot be changed', coalesce(st, 'missing') USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.debit <> OLD.debit OR NEW.credit <> OLD.credit) THEN NULL; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER acc_line_guard BEFORE INSERT OR UPDATE OR DELETE ON acc_journal_line FOR EACH ROW EXECUTE FUNCTION acc_line_guard();

-- Entry state machine: draft -> posted (validates balance + period + accounts), posted -> reversed (flag only)
CREATE OR REPLACE FUNCTION acc_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  d numeric; c numeric; n int; bad int; pstate text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'draft' THEN RAISE EXCEPTION 'POSTED_ENTRY_IMMUTABLE: cannot delete % entry', OLD.state USING ERRCODE = 'P0001'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'draft' THEN RAISE EXCEPTION 'ENTRY_MUST_START_AS_DRAFT' USING ERRCODE = 'P0001'; END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF OLD.state = 'posted' THEN
    IF NEW.state = 'reversed' AND NEW.reversed_by_id IS NOT NULL
       AND (to_jsonb(NEW) - 'state' - 'reversed_by_id') = (to_jsonb(OLD) - 'state' - 'reversed_by_id') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'POSTED_ENTRY_IMMUTABLE: only reversal flag may change' USING ERRCODE = 'P0001';
  ELSIF OLD.state = 'reversed' THEN
    RAISE EXCEPTION 'POSTED_ENTRY_IMMUTABLE: reversed entry' USING ERRCODE = 'P0001';
  END IF;
  -- OLD.state = draft
  IF NEW.state = 'posted' THEN
    SELECT coalesce(sum(debit),0), coalesce(sum(credit),0), count(*) INTO d, c, n
      FROM acc_journal_line WHERE entry_id = NEW.id AND posting_date = NEW.posting_date;
    IF n < 2 OR d <> c OR d = 0 THEN
      RAISE EXCEPTION 'UNBALANCED_ENTRY: debit % credit % lines %', d, c, n USING ERRCODE = 'P0001';
    END IF;
    SELECT count(*) INTO bad FROM acc_journal_line l JOIN acc_account a ON a.id = l.account_id
      WHERE l.entry_id = NEW.id AND l.posting_date = NEW.posting_date AND (NOT a.is_postable OR a.archived_at IS NOT NULL OR a.company_id <> NEW.company_id);
    IF bad > 0 THEN RAISE EXCEPTION 'ACCOUNT_NOT_POSTABLE' USING ERRCODE = 'P0001'; END IF;
    SELECT state INTO pstate FROM acc_fiscal_period WHERE company_id = NEW.company_id AND NEW.posting_date BETWEEN start_date AND end_date;
    IF pstate IS NULL THEN RAISE EXCEPTION 'NO_FISCAL_PERIOD for %', NEW.posting_date USING ERRCODE = 'P0001'; END IF;
    IF pstate = 'hard_locked' THEN RAISE EXCEPTION 'PERIOD_LOCKED: % is hard locked', NEW.posting_date USING ERRCODE = 'P0001'; END IF;
    IF pstate = 'soft_locked' AND coalesce(current_setting('rc.allow_locked_period', true), '') <> 'on' THEN
      RAISE EXCEPTION 'PERIOD_LOCKED: % is soft locked', NEW.posting_date USING ERRCODE = 'P0001';
    END IF;
    NEW.total_debit := d; NEW.total_credit := c;
    NEW.posted_at := now();
    NEW.posted_by := coalesce(rc_user(), NEW.created_by);
    IF NEW.number IS NULL THEN
      NEW.number := rc_next_number(NEW.tenant_id, NEW.company_id, 'JE', NEW.journal_id::text, to_char(NEW.posting_date, 'YYYY'),
                    (SELECT code FROM acc_journal WHERE id = NEW.journal_id) || '/' || to_char(NEW.posting_date, 'YYYY') || '/');
    END IF;
    -- maintain running balances
    INSERT INTO acc_account_balance AS b (tenant_id, company_id, account_id, period_month, branch_id, cost_center_id, debit, credit)
    SELECT NEW.tenant_id, NEW.company_id, l.account_id, date_trunc('month', NEW.posting_date)::date,
           coalesce(l.branch_id, '00000000-0000-0000-0000-000000000000'), coalesce(l.cost_center_id, '00000000-0000-0000-0000-000000000000'),
           sum(l.debit), sum(l.credit)
      FROM acc_journal_line l WHERE l.entry_id = NEW.id AND l.posting_date = NEW.posting_date
     GROUP BY 1,2,3,4,5,6
    ON CONFLICT (company_id, account_id, period_month, branch_id, cost_center_id)
    DO UPDATE SET debit = b.debit + EXCLUDED.debit, credit = b.credit + EXCLUDED.credit;
  ELSIF NEW.state <> 'draft' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION draft->%', NEW.state USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER acc_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON acc_journal_entry FOR EACH ROW EXECUTE FUNCTION acc_entry_guard();

-- Account mappings: most specific match wins (resolved in app)
CREATE TABLE acc_account_mapping (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL,
  key text NOT NULL,
  branch_id uuid, category_id uuid, tender_method text, tax_rate_id uuid, reason_code_id uuid,
  account_id uuid NOT NULL REFERENCES acc_account(id),
  UNIQUE NULLS NOT DISTINCT (company_id, key, branch_id, category_id, tender_method, tax_rate_id, reason_code_id)
);

CREATE TABLE acc_posting_exception (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL,
  source_event_id uuid NOT NULL UNIQUE,
  event_type text NOT NULL, payload jsonb NOT NULL,
  error text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','retried','resolved')),
  created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);

-- Payments (AP/AR), bank accounts, expenses
CREATE TABLE acc_bank_account (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL,
  name_ar text NOT NULL, name_en text, bank_name text, iban text, currency char(3) NOT NULL DEFAULT 'EGP',
  account_id uuid NOT NULL REFERENCES acc_account(id),
  kind text NOT NULL DEFAULT 'bank' CHECK (kind IN ('bank','cash','safe'))
);

CREATE TABLE acc_payment (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL, branch_id uuid,
  number text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('outbound','inbound')),
  partner_id uuid NOT NULL REFERENCES par_partner(id),
  bank_account_id uuid NOT NULL REFERENCES acc_bank_account(id),
  payment_date date NOT NULL,
  amount numeric(19,4) NOT NULL CHECK (amount > 0),
  wht_amount numeric(19,4) NOT NULL DEFAULT 0 CHECK (wht_amount >= 0),
  currency char(3) NOT NULL DEFAULT 'EGP',
  reference text,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','pending_approval','approved','posted','cancelled')),
  journal_entry_id uuid,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid, posted_at timestamptz,
  UNIQUE (company_id, number),
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);
CREATE TABLE acc_payment_allocation (
  tenant_id uuid NOT NULL,
  payment_id uuid NOT NULL REFERENCES acc_payment(id),
  invoice_type text NOT NULL, invoice_id uuid NOT NULL,
  amount numeric(19,4) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (payment_id, invoice_type, invoice_id)
);

CREATE TABLE acc_expense (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, company_id uuid NOT NULL, branch_id uuid NOT NULL,
  number text NOT NULL,
  expense_date date NOT NULL,
  account_id uuid NOT NULL REFERENCES acc_account(id),
  cost_center_id uuid REFERENCES core_cost_center(id),
  partner_id uuid REFERENCES par_partner(id),
  description text NOT NULL,
  net_amount numeric(19,4) NOT NULL CHECK (net_amount > 0),
  tax_rate_id uuid REFERENCES tax_rate(id),
  tax_amount numeric(19,4) NOT NULL DEFAULT 0,
  paid_from_bank_account_id uuid REFERENCES acc_bank_account(id),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','pending_approval','approved','posted','rejected')),
  journal_entry_id uuid,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), approved_by uuid,
  UNIQUE (company_id, number),
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON acc_account FOR EACH ROW EXECUTE FUNCTION rc_audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON acc_fiscal_period FOR EACH ROW EXECUTE FUNCTION rc_audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON acc_account_mapping FOR EACH ROW EXECUTE FUNCTION rc_audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON acc_payment FOR EACH ROW EXECUTE FUNCTION rc_audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON acc_expense FOR EACH ROW EXECUTE FUNCTION rc_audit_row();

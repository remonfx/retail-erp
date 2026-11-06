-- 0010 Worker entry points (cross-tenant claims run as SECURITY DEFINER; processing then runs under tenant RLS)
CREATE OR REPLACE FUNCTION outbox_claim(p_limit int)
RETURNS TABLE (id uuid, tenant_id uuid, company_id uuid, event_type text, payload jsonb, attempts int)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE core_outbox_event e SET available_at = now() + interval '2 minutes', attempts = e.attempts + 1
   WHERE e.id IN (SELECT o.id FROM core_outbox_event o
                   WHERE o.processed_at IS NULL AND o.available_at <= now()
                   ORDER BY o.available_at, o.id
                   LIMIT p_limit FOR UPDATE SKIP LOCKED)
  RETURNING e.id, e.tenant_id, e.company_id, e.event_type, e.payload, e.attempts
$$;
REVOKE ALL ON FUNCTION outbox_claim(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbox_claim(int) TO rc_app;

-- Partition maintenance (called by the scheduler with owner privileges)
CREATE OR REPLACE FUNCTION rc_maintain_partitions(months_ahead int DEFAULT 3) RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int := 0; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['core_audit_log','inv_stock_move','acc_journal_entry','acc_journal_line','pos_order','pos_order_line','pos_payment'] LOOP
    n := n + rc_ensure_month_partitions(t::regclass, date_trunc('month', now())::date, months_ahead + 1);
  END LOOP;
  RETURN n;
END $$;

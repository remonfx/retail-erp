-- 0012 Indexes for global search / drill-down
CREATE INDEX IF NOT EXISTS pos_order_receipt_no ON pos_order (receipt_no);
CREATE INDEX IF NOT EXISTS acc_journal_entry_number ON acc_journal_entry (company_id, number);
CREATE INDEX IF NOT EXISTS acc_journal_entry_source_id ON acc_journal_entry (company_id, source_id);
CREATE INDEX IF NOT EXISTS pur_invoice_supplier ON pur_invoice (company_id, supplier_id, invoice_date DESC);
CREATE INDEX IF NOT EXISTS pur_order_supplier ON pur_order (company_id, supplier_id, created_at DESC);

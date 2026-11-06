'use client';
import { useState } from 'react';
import { get, post, qs } from '@/lib/api';
import { useI18n, money, dt } from '@/lib/i18n';
import { useAsync, useAction, ErrorBox, Ok, PageHead, Table, State, Modal, Field } from '@/components/ui';
import { Go } from '@/components/links';
import { BranchSelect, useMe } from '@/components/shell';

export default function Invoices() {
  const { t, locale } = useI18n();
  const { can } = useMe();
  const [open, setOpen] = useState(false);
  const list = useAsync(() => get(`/api/v1/supplier-invoices${qs({ limit: 100 })}`), []);
  const a = useAction();
  return (
    <>
      <PageHead title={t('supplierInvoices')}>{can('purchasing.invoice.write') ? <button className="btn primary" onClick={() => setOpen(true)}>{t('newInvoice')}</button> : null}</PageHead>
      <ErrorBox error={list.error ?? a.error} /><Ok msg={a.ok} />
      <Table rows={list.data?.data} cols={[
        { key: 'number', label: t('number'), render: (r) => <Go type="supplier_invoice" id={r.id}><span className="mono">{r.number}</span></Go> }, { key: 'supplier_invoice_no', label: t('invoiceNo') }, { key: 'supplier_name', label: t('supplier'), render: (r) => <Go type="supplier" id={r.supplier_id}>{r.supplier_name}</Go> },
        { key: 'invoice_date', label: t('date'), render: (r) => dt(r.invoice_date, locale) }, { key: 'total', label: t('total'), num: true, render: (r) => money(r.total, locale) }, { key: 'balance', label: t('remaining'), num: true, render: (r) => money(r.balance, locale) },
        { key: 'match_status', label: t('matchStatus'), render: (r) => <span title={(r.match_details ?? []).map((m: any) => m.detail).join('\n')}><State s={r.match_status} /></span> }, { key: 'state', label: t('status'), render: (r) => <State s={r.state} /> },
        { key: 'x', label: t('actions'), render: (r) => r.state === 'draft' && r.match_status !== 'exception' ? <button className="btn sm primary" disabled={a.busy} onClick={() => a.run(async () => { await post(`/api/v1/supplier-invoices/${r.id}/post`); await list.reload(); }, t('saved'))}>{t('post')}</button> : null },
      ]} />
      {open ? <NewInvoice onClose={() => { setOpen(false); void list.reload(); }} /> : null}
    </>
  );
}

function NewInvoice({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n();
  const { branches } = useMe();
  const [poId, setPo] = useState(''); const [branchId, setBranch] = useState(branches[0]?.id ?? ''); const [no, setNo] = useState(''); const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const pos = useAsync(() => get(`/api/v1/purchase-orders${qs({ limit: 200 })}`), []);
  const po = useAsync(() => poId ? get(`/api/v1/purchase-orders/${poId}`) : Promise.resolve(null), [poId]);
  const [vals, setVals] = useState<Record<string, { qty: string; price: string }>>({});
  const a = useAction();
  const lines = po.data?.lines ?? [];
  return (
    <Modal title={t('newInvoice')} onClose={onClose}>
      <ErrorBox error={a.error} />
      <div className="form-grid">
        <Field label={t('purchaseOrders')}><select value={poId} onChange={(e) => setPo(e.target.value)}><option value="">—</option>{pos.data?.data?.filter((p: any) => ['partially_received', 'received', 'approved'].includes(p.state)).map((p: any) => <option key={p.id} value={p.id}>{p.number} — {p.supplier_name}</option>)}</select></Field>
        <Field label={t('branch')}><BranchSelect value={branchId} onChange={setBranch} /></Field>
        <Field label={t('invoiceNo')}><input value={no} onChange={(e) => setNo(e.target.value)} required /></Field>
        <Field label={t('date')}><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      {lines.length ? <Table rows={lines} cols={[{ key: 'sku', label: t('sku'), render: (r) => <span className="mono">{r.sku}</span> }, { key: 'qty_received', label: t('received'), num: true },
        { key: 'q', label: t('qty'), render: (r) => <input style={{ width: 90 }} value={vals[r.id]?.qty ?? String(Number(r.qty_received) - Number(r.qty_invoiced))} onChange={(e) => setVals({ ...vals, [r.id]: { qty: e.target.value, price: vals[r.id]?.price ?? r.unit_price } })} /> },
        { key: 'p', label: t('unitPrice'), render: (r) => <input style={{ width: 110 }} value={vals[r.id]?.price ?? Number(r.unit_price).toFixed(2)} onChange={(e) => setVals({ ...vals, [r.id]: { qty: vals[r.id]?.qty ?? String(Number(r.qty_received) - Number(r.qty_invoiced)), price: e.target.value } })} /> },
        { key: 'po', label: 'PO', num: true, render: (r) => money(r.unit_price, locale) }]} /> : null}
      <div style={{ marginTop: 12 }}><button className="btn primary" disabled={a.busy || !po.data || !no} onClick={() => a.run(async () => {
        const r = await post('/api/v1/supplier-invoices', { supplierId: po.data.supplier_id, branchId, supplierInvoiceNo: no, invoiceDate: date,
          lines: lines.map((l: any) => ({ orderLineId: l.id, qty: vals[l.id]?.qty ?? String(Number(l.qty_received) - Number(l.qty_invoiced)), unitPrice: vals[l.id]?.price ?? l.unit_price, taxRateId: l.tax_rate_id })).filter((l: any) => Number(l.qty) > 0) });
        alert(`${r.number}: ${r.matchStatus}${r.mismatches.length ? '\n' + r.mismatches.map((m: any) => m.detail).join('\n') : ''}`);
        onClose();
      })}>{t('create')}</button></div>
    </Modal>
  );
}

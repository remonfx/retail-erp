'use client';
import { use } from 'react';
import Link from 'next/link';
import { get, post } from '@/lib/api';
import { useI18n, money, qty, dt } from '@/lib/i18n';
import { useAsync, useAction, ErrorBox, Ok, PageHead, Table, State } from '@/components/ui';
import { Go } from '@/components/links';

export default function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, locale } = useI18n();
  const inv = useAsync(() => get(`/api/v1/supplier-invoices/${id}`), [id]);
  const je = useAsync(() => get(`/api/v1/journal-entries/by-source/${id}`).catch(() => []), [id]);
  const a = useAction();
  const d = inv.data;
  if (!d) return <ErrorBox error={inv.error} />;
  return <>
    <div className="crumbs"><Link href="/purchasing/invoices">{t('supplierInvoices')}</Link> / <Go type="supplier" id={d.supplier_id}>{d.supplier_name}</Go></div>
    <PageHead title={`${d.number} — ${d.supplier_invoice_no}`}>
      <State s={d.state} /><span title={(d.match_details ?? []).map((m: any) => m.detail).join('\n')}><State s={d.match_status} /></span>
      {(je.data ?? []).map((j: any) => <Go key={j.id} type="journal_entry" id={j.id}><span className="btn">قيد {j.number}</span></Go>)}
      {d.state === 'draft' && d.match_status !== 'exception' ? <button className="btn primary" disabled={a.busy} onClick={() => a.run(async () => { await post(`/api/v1/supplier-invoices/${id}/post`); await inv.reload(); await je.reload(); }, t('saved'))}>{t('post')}</button> : null}
    </PageHead>
    <ErrorBox error={a.error} /><Ok msg={a.ok} />
    {(d.match_details ?? []).length ? <div className="alert warn">{d.match_details.map((m: any, i: number) => <div key={i}>سطر {m.line}: {m.detail}</div>)}</div> : null}
    <div className="card form-grid" style={{ marginBottom: 14 }}>
      <div><h3>{t('supplier')}</h3><Go type="supplier" id={d.supplier_id}>{d.supplier_name}</Go></div><div><h3>{t('date')}</h3>{dt(d.invoice_date, locale)}</div><div><h3>Due</h3>{dt(d.due_date, locale)}</div>
      <div><h3>{t('subtotal')}</h3>{money(d.subtotal, locale)}</div><div><h3>{t('tax')}</h3>{money(d.tax_total, locale)}</div><div><h3>{t('total')}</h3><strong>{money(d.total, locale)}</strong></div><div><h3>{t('remaining')}</h3>{money(d.balance, locale)}</div>
    </div>
    <Table rows={d.lines} cols={[
      { key: 'item', label: t('nameAr'), render: (r) => r.product_id ? <Go type="product" id={r.product_id}>{r.sku} — {r.name_ar}</Go> : <>{r.account_code} {r.account_name ?? r.description}</> },
      { key: 'po', label: t('purchaseOrders'), render: (r) => r.order_id ? <Go type="purchase_order" id={r.order_id}>{r.order_number}</Go> : '—' },
      { key: 'qty', label: t('qty'), num: true, render: (r) => qty(r.qty, locale) }, { key: 'unit_price', label: t('unitPrice'), num: true, render: (r) => money(r.unit_price, locale) },
      { key: 'net', label: t('subtotal'), num: true, render: (r) => money(r.net, locale) }, { key: 'tax', label: t('tax'), num: true, render: (r) => money(r.tax, locale) },
    ]} />
    <h2 style={{ marginTop: 16 }}>المدفوعات</h2>
    <Table rows={d.payments} cols={[{ key: 'number', label: t('number') }, { key: 'payment_date', label: t('date'), render: (r) => dt(r.payment_date, locale) }, { key: 'amount', label: t('amount'), num: true, render: (r) => money(r.amount, locale) },
      { key: 'state', label: t('status'), render: (r) => <State s={r.state} /> }, { key: 'je', label: '', render: (r) => r.journal_entry_id ? <Go type="journal_entry" id={r.journal_entry_id}>القيد</Go> : null }]} />
  </>;
}

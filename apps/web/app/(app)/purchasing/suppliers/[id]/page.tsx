'use client';
import { use, useState } from 'react';
import Link from 'next/link';
import { get } from '@/lib/api';
import { useI18n, money, dt } from '@/lib/i18n';
import { useAsync, ErrorBox, PageHead, Table, State, Kpi } from '@/components/ui';
import { Go } from '@/components/links';

export default function SupplierCard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, locale } = useI18n();
  const c = useAsync(() => get(`/api/v1/partners/${id}`), [id]);
  const [tab, setTab] = useState<'invoices' | 'orders' | 'payments' | 'returns' | 'products'>('invoices');
  const d = c.data;
  if (!d) return <ErrorBox error={c.error} />;
  const p = d.partner;
  return <>
    <div className="crumbs"><Link href="/purchasing/suppliers">{t('suppliers')}</Link></div>
    <PageHead title={p.name_ar}><span className="mono muted">{p.code}</span>{p.consignment ? <span className="badge info">consignment</span> : null}</PageHead>
    {d.summary ? <div className="grid k4">
      <Kpi label="الرصيد المستحق" value={money(d.summary.open_balance, locale)} />
      <Kpi label="متأخر السداد" value={<span style={{ color: Number(d.summary.overdue) > 0 ? 'var(--danger)' : undefined }}>{money(d.summary.overdue, locale)}</span>} />
      <Kpi label="مشتريات السنة" value={money(d.summary.purchases_ytd, locale)} />
      <Kpi label={t('paymentTerms')} value={p.payment_terms_days} hint={`${t('taxRegistrationNo')}: ${p.tax_registration_no ?? '—'}`} />
    </div> : null}
    <div className="tabs" style={{ marginTop: 14 }}>{(['invoices', 'orders', 'payments', 'returns', 'products'] as const).map((k) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{{ invoices: t('supplierInvoices'), orders: t('purchaseOrders'), payments: 'المدفوعات', returns: 'المرتجعات', products: t('products') }[k]}</button>)}</div>
    {tab === 'invoices' ? <Table rows={d.invoices} cols={[{ key: 'number', label: t('number'), render: (r) => <Go type="supplier_invoice" id={r.id}><span className="mono">{r.number}</span></Go> }, { key: 'supplier_invoice_no', label: t('invoiceNo') },
      { key: 'invoice_date', label: t('date'), render: (r) => dt(r.invoice_date, locale) }, { key: 'due_date', label: 'Due', render: (r) => dt(r.due_date, locale) }, { key: 'total', label: t('total'), num: true, render: (r) => <Go type="supplier_invoice" id={r.id}>{money(r.total, locale)}</Go> },
      { key: 'bal', label: t('remaining'), num: true, render: (r) => money(Number(r.total) - Number(r.amount_paid), locale) }, { key: 'state', label: t('status'), render: (r) => <State s={r.state} /> }]} /> : null}
    {tab === 'orders' ? <Table rows={d.orders} cols={[{ key: 'number', label: t('number'), render: (r) => <Go type="purchase_order" id={r.id}><span className="mono">{r.number}</span></Go> }, { key: 'order_date', label: t('date'), render: (r) => dt(r.order_date, locale) },
      { key: 'total', label: t('total'), num: true, render: (r) => money(r.total, locale) }, { key: 'state', label: t('status'), render: (r) => <State s={r.state} /> }]} /> : null}
    {tab === 'payments' ? <Table rows={d.payments} cols={[{ key: 'number', label: t('number') }, { key: 'payment_date', label: t('date'), render: (r) => dt(r.payment_date, locale) }, { key: 'amount', label: t('amount'), num: true, render: (r) => money(r.amount, locale) },
      { key: 'wht_amount', label: 'WHT', num: true, render: (r) => money(r.wht_amount, locale) }, { key: 'state', label: t('status'), render: (r) => <State s={r.state} /> }, { key: 'je', label: '', render: (r) => r.journal_entry_id ? <Go type="journal_entry" id={r.journal_entry_id}>القيد</Go> : null }]} /> : null}
    {tab === 'returns' ? <Table rows={d.returns} cols={[{ key: 'number', label: t('number'), render: (r) => <Go type="pur_return" id={r.id}><span className="mono">{r.number}</span></Go> }, { key: 'created_at', label: t('date'), render: (r) => dt(r.created_at, locale) }, { key: 'reason', label: t('reason') }]} /> : null}
    {tab === 'products' ? <Table rows={d.products} rowKey={(r) => r.variant_id} cols={[{ key: 'sku', label: t('sku'), render: (r) => <Go type="product" id={r.product_id}><span className="mono">{r.sku}</span></Go> }, { key: 'name_ar', label: t('nameAr'), render: (r) => <Go type="product" id={r.product_id}>{r.name_ar}</Go> },
      { key: 'last_cost', label: t('cost'), num: true, render: (r) => money(r.last_cost, locale) }, { key: 'preferred', label: '★', render: (r) => r.preferred ? '★' : '' }]} /> : null}
  </>;
}

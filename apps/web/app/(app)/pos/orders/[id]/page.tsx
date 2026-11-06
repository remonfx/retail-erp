'use client';
import { use } from 'react';
import { get } from '@/lib/api';
import { useI18n, money, qty, dt } from '@/lib/i18n';
import { useAsync, ErrorBox, PageHead, Table, State } from '@/components/ui';
import { Go } from '@/components/links';

export default function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, locale } = useI18n();
  const o = useAsync(() => get(`/api/v1/pos/orders/${id}`), [id]);
  const d = o.data;
  if (!d) return <ErrorBox error={o.error} />;
  return <>
    <div className="crumbs"><Go type="pos_session" id={d.session_id}>{t('sessions')}</Go> / <span>{d.receipt_no}</span></div>
    <PageHead title={d.receipt_no}>
      <State s={d.kind === 'sale' ? 'posted' : 'reversed'} />{d.offline ? <span className="badge warn">{t('offline')}</span> : null}
      {d.return_of_id ? <Go type="pos_order" id={d.return_of_id}><span className="btn">الإيصال الأصلي</span></Go> : null}
      <Go type="stock_source" id={d.id}><span className="btn">{t('movements')}</span></Go>
      <Go type="pos_session" id={d.session_id}><span className="btn">{t('sessions')}</span></Go>
    </PageHead>
    <div className="card form-grid" style={{ marginBottom: 14 }}>
      <div><h3>{t('date')}</h3>{dt(d.sold_at, locale)}</div><div><h3>{t('subtotal')}</h3>{money(d.subtotal, locale)}</div><div><h3>Discount</h3>{money(d.discount_total, locale)}</div>
      <div><h3>{t('tax')}</h3>{money(d.tax_total, locale)}</div><div><h3>{t('total')}</h3><strong>{money(d.grand_total, locale)}</strong></div><div><h3>{t('cost')}</h3>{money(d.cost_total, locale)}</div>
      {Number(d.server_recalc_delta) ? <div><h3>Pricing delta</h3><span className="badge warn">{money(d.server_recalc_delta, locale)}</span></div> : null}
    </div>
    <Table rows={d.lines} cols={[
      { key: 'sku', label: t('sku'), render: (r) => <Go type="product" id={r.product_id ?? null}><span className="mono">{r.sku}</span></Go> },
      { key: 'name_ar', label: t('nameAr'), render: (r) => <Go type="product" id={r.product_id ?? null}>{locale === 'ar' ? r.name_ar : r.name_en ?? r.name_ar}</Go> },
      { key: 'qty', label: t('qty'), num: true, render: (r) => qty(r.qty, locale) }, { key: 'unit_price', label: t('price'), num: true, render: (r) => money(r.unit_price, locale) },
      { key: 'discount_total', label: 'Discount', num: true, render: (r) => money(r.discount_total, locale) }, { key: 'total', label: t('total'), num: true, render: (r) => money(r.total, locale) },
      { key: 'cost_total', label: t('cost'), num: true, render: (r) => money(r.cost_total, locale) }, { key: 'returned_qty', label: 'مرتجع', num: true, render: (r) => Number(r.returned_qty) ? qty(r.returned_qty, locale) : '' },
    ]} />
    <h2 style={{ marginTop: 16 }}>المدفوعات</h2>
    <Table rows={d.payments} cols={[{ key: 'method', label: t('type') }, { key: 'amount', label: t('amount'), num: true, render: (r) => money(r.amount, locale) }, { key: 'card_last4', label: 'Card' }, { key: 'approval_code', label: 'Approval' }]} />
  </>;
}

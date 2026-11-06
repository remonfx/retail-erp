'use client';
import { use } from 'react';
import Link from 'next/link';
import { get, qs } from '@/lib/api';
import { useI18n, money, dt } from '@/lib/i18n';
import { useAsync, ErrorBox, PageHead, Table, State, Kpi } from '@/components/ui';
import { Go } from '@/components/links';

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, locale } = useI18n();
  const z = useAsync(() => get(`/api/v1/pos/sessions/${id}/z-report`), [id]);
  const orders = useAsync(() => get(`/api/v1/pos/orders${qs({ sessionId: id, limit: 500 })}`), [id]);
  const d = z.data;
  if (!d) return <ErrorBox error={z.error} />;
  const s = d.session;
  const sale = d.byKind.find((k: any) => k.kind === 'sale'), ret = d.byKind.find((k: any) => k.kind === 'return');
  return <>
    <div className="crumbs"><Link href="/pos/sessions">{t('sessions')}</Link> / <span>{s.terminal_code}</span></div>
    <PageHead title={s.number}><State s={s.state} />{s.journal_entry_id ? <Go type="journal_entry" id={s.journal_entry_id}><span className="btn">قيد الوردية</span></Go> : null}<button className="btn no-print" onClick={() => window.print()}>{t('print')}</button></PageHead>
    <div className="grid k4">
      <Kpi label={t('netSales')} value={money(sale?.total, locale)} hint={`${sale?.orders ?? 0} ${t('ordersCount')}`} />
      <Kpi label="المرتجعات" value={money(ret?.total, locale)} hint={`${ret?.orders ?? 0}`} />
      <Kpi label={t('expectedCash')} value={money(s.expected_cash, locale)} hint={`${t('countedCash')}: ${money(s.counted_cash, locale)}`} />
      <Kpi label={t('difference')} value={<span style={{ color: Number(s.cash_difference) < 0 ? 'var(--danger)' : undefined }}>{money(s.cash_difference, locale)}</span>} />
    </div>
    <div className="grid c2" style={{ marginTop: 14 }}>
      <Table rows={d.tenders} rowKey={(x) => x.method} cols={[{ key: 'method', label: t('type') }, { key: 'count', label: '#', num: true }, { key: 'amount', label: t('amount'), num: true, render: (x) => money(x.amount, locale) }]} />
      <Table rows={d.taxes} rowKey={(x) => x.code} cols={[{ key: 'code', label: t('tax') }, { key: 'base', label: 'Base', num: true, render: (x) => money(x.base, locale) }, { key: 'amount', label: t('amount'), num: true, render: (x) => money(x.amount, locale) }]} />
    </div>
    <h2 style={{ marginTop: 16 }}>{t('orders')}</h2>
    <Table rows={orders.data?.data} cols={[
      { key: 'receipt_no', label: t('number'), render: (r) => <Go type="pos_order" id={r.id}><span className="mono">{r.receipt_no}</span></Go> },
      { key: 'kind', label: t('type'), render: (r) => <State s={r.kind === 'sale' ? 'posted' : 'reversed'} /> },
      { key: 'sold_at', label: t('date'), render: (r) => dt(r.sold_at, locale) }, { key: 'cashier_name', label: t('cashier') },
      { key: 'offline', label: '', render: (r) => r.offline ? <span className="badge warn">{t('offline')}</span> : null },
      { key: 'grand_total', label: t('total'), num: true, render: (r) => <Go type="pos_order" id={r.id}>{money(r.grand_total, locale)}</Go> },
    ]} />
  </>;
}

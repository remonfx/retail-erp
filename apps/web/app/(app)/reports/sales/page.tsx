'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { get, qs } from '@/lib/api';
import { useI18n, money, qty } from '@/lib/i18n';
import { useAsync, ErrorBox, PageHead, Table, Field } from '@/components/ui';
import { BranchSelect } from '@/components/shell';

type G = 'day' | 'month' | 'branch' | 'category' | 'product' | 'cashier';
const LABELS: Record<G, string> = { day: 'يوم', month: 'شهر', branch: 'فرع', category: 'تصنيف', product: 'منتج', cashier: 'كاشير' };

/** Sales analysis with drill-down: month → days → (branch) → categories → products → product card. */
function Sales() {
  const { t, locale } = useI18n();
  const sp = useSearchParams();
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ from: sp.get('from') ?? today.slice(0, 8) + '01', to: sp.get('to') ?? today, branchId: sp.get('branchId') ?? '', categoryId: sp.get('categoryId') ?? '', groupBy: (sp.get('groupBy') as G) ?? 'day' });
  const r = useAsync(() => get(`/api/v1/reports/sales${qs(f)}`), [f]);
  const drill = (row: any) => {
    if (f.groupBy === 'month') setF({ ...f, from: `${row.key}-01`, to: new Date(Number(row.key.slice(0, 4)), Number(row.key.slice(5, 7)), 0).toISOString().slice(0, 10), groupBy: 'day' });
    else if (f.groupBy === 'day') setF({ ...f, from: row.key, to: row.key, groupBy: 'category' });
    else if (f.groupBy === 'branch') setF({ ...f, branchId: row.key, groupBy: 'category' });
    else if (f.groupBy === 'category') setF({ ...f, categoryId: row.key, groupBy: 'product' });
  };
  const rows = r.data ?? null;
  const tot = (rows ?? []).reduce((s: any, x: any) => ({ net: s.net + Number(x.net ?? x.total ?? 0), gp: s.gp + Number(x.gross_profit ?? 0) }), { net: 0, gp: 0 });
  return <>
    <PageHead title={t('salesAnalysis')}>
      <Field label={t('from')}><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
      <Field label={t('to')}><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
      <Field label={t('branch')}><BranchSelect allowAll value={f.branchId} onChange={(v) => setF({ ...f, branchId: v })} /></Field>
    </PageHead>
    <div className="tabs">{(Object.keys(LABELS) as G[]).map((g) => <button key={g} className={f.groupBy === g ? 'active' : ''} onClick={() => setF({ ...f, groupBy: g })}>{LABELS[g]}</button>)}
      {f.categoryId || f.branchId ? <button onClick={() => setF({ ...f, categoryId: '', branchId: '' })}>✕ إلغاء الفلاتر</button> : null}</div>
    <ErrorBox error={r.error} />
    <p className="muted">{t('drillHint')}</p>
    {f.groupBy === 'cashier' ? <Table rows={rows} rowKey={(x) => x.key ?? 'none'} cols={[{ key: 'label', label: t('cashier') }, { key: 'orders', label: t('ordersCount'), num: true }, { key: 'returns', label: 'مرتجعات', num: true },
      { key: 'offline_orders', label: t('offline'), num: true }, { key: 'discounts', label: 'Discount', num: true, render: (x) => money(x.discounts, locale) }, { key: 'total', label: t('total'), num: true, render: (x) => money(x.total, locale) }]} />
      : <Table rows={rows} rowKey={(x) => x.key ?? 'none'} cols={[
        { key: 'label', label: LABELS[f.groupBy], render: (x) => f.groupBy === 'product' ? <Link className="go" href={`/products?q=${encodeURIComponent(String(x.label).split(' — ')[0] ?? '')}`}>{x.label}</Link> : <button className="btn sm" style={{ border: 'none', background: 'none', padding: 0, color: 'var(--primary)', textDecoration: 'underline dotted' }} onClick={() => drill(x)}>{x.label ?? '—'}</button> },
        { key: 'qty', label: t('qty'), num: true, render: (x) => qty(x.qty, locale) }, { key: 'gross', label: t('grossSales'), num: true, render: (x) => money(x.gross, locale) }, { key: 'discount', label: 'Discount', num: true, render: (x) => money(x.discount, locale) },
        { key: 'net', label: t('netSales'), num: true, render: (x) => money(x.net, locale) }, { key: 'cost', label: t('cogs'), num: true, render: (x) => money(x.cost, locale) }, { key: 'gross_profit', label: t('grossProfit'), num: true, render: (x) => money(x.gross_profit, locale) }, { key: 'margin_pct', label: '%', num: true },
      ]} footer={rows?.length ? <tr><td>{t('total')}</td><td /><td /><td /><td className="num">{money(tot.net, locale)}</td><td /><td className="num">{money(tot.gp, locale)}</td><td /></tr> : undefined} />}
  </>;
}
export default function Page() { return <Suspense><Sales /></Suspense>; }

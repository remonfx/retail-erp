'use client';
import { useState } from 'react';
import { get, qs } from '@/lib/api';
import { useI18n, money, qty } from '@/lib/i18n';
import { useAsync, ErrorBox, Kpi, PageHead, Table, Field } from '@/components/ui';
import { BranchSelect, useMe } from '@/components/shell';

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => today().slice(0, 8) + '01';

export default function Dashboard() {
  const { t, locale } = useI18n();
  const { can } = useMe();
  const [f, setF] = useState({ from: monthStart(), to: today(), branchId: '' });
  const [applied, setApplied] = useState(f);
  const { data, error } = useAsync(() => can('reporting.dashboard.read') ? get(`/api/v1/dashboard${qs(applied)}`) : Promise.resolve(null), [applied]);
  if (!can('reporting.dashboard.read')) return <PageHead title={t('dashboard')} />;
  const max = Math.max(1, ...(data?.byBranch ?? []).map((b: any) => Number(b.net_sales)));
  return (
    <>
      <PageHead title={t('dashboard')}>
        <div className="row no-print">
          <Field label={t('from')}><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
          <Field label={t('to')}><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
          <Field label={t('branch')}><BranchSelect allowAll value={f.branchId} onChange={(v) => setF({ ...f, branchId: v })} /></Field>
          <button className="btn primary" style={{ alignSelf: 'end' }} onClick={() => setApplied(f)}>{t('apply')}</button>
        </div>
      </PageHead>
      <ErrorBox error={error} />
      <p className="muted">{t('operationalNote')}</p>
      <div className="grid k4">
        <Kpi label={t('grossSales')} value={money(data?.kpi.gross_sales, locale)} />
        <Kpi label={t('netSales')} value={money(data?.kpi.net_sales, locale)} />
        <Kpi label={t('grossProfit')} value={money(data?.kpi.gross_profit, locale)} hint={`${t('margin')}: ${data?.kpi.gross_margin_pct ?? '—'}%`} />
        <Kpi label={t('cogs')} value={money(data?.kpi.cogs, locale)} />
        <Kpi label={t('ordersCount')} value={qty(data?.kpi.orders, locale)} hint={`${t('avgBasket')}: ${money(data?.kpi.avg_basket, locale)}`} />
        {data?.finance ? <>
          <Kpi label={t('cashPosition')} value={money(data.finance.cash_position, locale)} />
          <Kpi label={t('inventoryValue')} value={money(data.finance.inventory_value, locale)} />
          <Kpi label={t('payables')} value={money(data.finance.payables, locale)} />
        </> : null}
      </div>
      <div className="grid c2" style={{ marginTop: 14 }}>
        <div className="card"><h2>{t('byBranch')}</h2>
          <div className="bars">{(data?.byBranch ?? []).map((b: any) => (
            <div className="r" key={b.branch_id}><span>{b.code}</span><div className="bar" style={{ width: `${(Number(b.net_sales) / max) * 100}%` }} /><span className="num">{money(b.net_sales, locale)}</span></div>
          ))}{data && !data.byBranch.length ? <span className="muted">{t('noData')}</span> : null}</div>
        </div>
        <div className="card"><h2>{t('topProducts')}</h2>
          <Table rows={data?.topProducts} cols={[{ key: 'sku', label: t('sku'), render: (r) => <span className="mono">{r.sku}</span> }, { key: 'name_ar', label: t('nameAr') }, { key: 'qty', label: t('qty'), num: true, render: (r) => qty(r.qty, locale) }, { key: 'net_sales', label: t('netSales'), num: true, render: (r) => money(r.net_sales, locale) }]} rowKey={(r) => r.variant_id} />
        </div>
      </div>
    </>
  );
}

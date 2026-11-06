'use client';
import { useState } from 'react';
import { get, qs } from '@/lib/api';
import { useI18n, money } from '@/lib/i18n';
import { useAsync, ErrorBox, PageHead, Table, Field } from '@/components/ui';
import { BranchSelect } from '@/components/shell';

type Tab = 'tb' | 'is' | 'bs' | 'cf' | 'vat' | 'ap' | 'rec';
const today = () => new Date().toISOString().slice(0, 10);

export default function Reports() {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<Tab>('tb');
  const [f, setF] = useState({ from: today().slice(0, 4) + '-01-01', to: today(), branchId: '' });
  const [applied, setApplied] = useState(f);
  const url = { tb: `/api/v1/reports/trial-balance${qs(applied)}`, is: `/api/v1/reports/income-statement${qs(applied)}`, bs: `/api/v1/reports/balance-sheet${qs({ asOf: applied.to })}`, cf: `/api/v1/reports/cash-flow${qs({ from: applied.from, to: applied.to })}`,
    vat: `/api/v1/reports/vat${qs({ from: applied.from, to: applied.to })}`, ap: `/api/v1/reports/ap-aging${qs({ asOf: applied.to })}`, rec: '/api/v1/reports/inventory-reconciliation' }[tab];
  const r = useAsync(() => get(url), [url]);
  const d = r.data;
  const m = (v: unknown) => money(v as string, locale);
  const tabs: [Tab, string][] = [['tb', t('trialBalance')], ['is', t('incomeStatement')], ['bs', t('balanceSheet')], ['cf', t('cashFlow')], ['vat', t('vatReport')], ['ap', t('apAging')], ['rec', t('inventoryRec')]];
  return (
    <>
      <PageHead title={t('reports')}>
        <div className="row no-print">
          <Field label={t('from')}><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
          <Field label={t('to')}><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
          <Field label={t('branch')}><BranchSelect allowAll value={f.branchId} onChange={(v) => setF({ ...f, branchId: v })} /></Field>
          <button className="btn primary" style={{ alignSelf: 'end' }} onClick={() => setApplied(f)}>{t('apply')}</button>
          <button className="btn" style={{ alignSelf: 'end' }} onClick={() => window.print()}>{t('print')}</button>
        </div>
      </PageHead>
      <div className="tabs no-print">{tabs.map(([k, l]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      <ErrorBox error={r.error} />
      {d && tab === 'tb' ? <>
        <p><span className={`badge ${d.balanced ? 'ok' : 'danger'}`}>{d.balanced ? t('balanced') : t('notBalanced')}</span></p>
        <Table rows={d.rows} rowKey={(x) => x.accountId} cols={[{ key: 'code', label: t('code'), render: (x) => <span className="mono">{x.code}</span> }, { key: 'name', label: t('account'), render: (x) => locale === 'ar' ? x.nameAr : x.nameEn },
          { key: 'opening', label: t('opening'), num: true, render: (x) => m(x.opening) }, { key: 'debit', label: t('debit'), num: true, render: (x) => m(x.debit) }, { key: 'credit', label: t('credit'), num: true, render: (x) => m(x.credit) }, { key: 'closing', label: t('closing'), num: true, render: (x) => m(x.closing) }]}
          footer={<tr><td colSpan={3}>{t('total')}</td><td className="num">{m(d.totals.debit)}</td><td className="num">{m(d.totals.credit)}</td><td /></tr>} />
      </> : null}
      {d && tab === 'is' ? <div className="grid c2">
        <div className="card"><Table rows={Object.entries(d.summary).map(([k, v]) => ({ id: k, k, v }))} cols={[{ key: 'k', label: '' }, { key: 'v', label: t('amount'), num: true, render: (x) => x.k === 'grossMarginPct' ? `${x.v}%` : m(x.v) }]} /></div>
        <Table rows={d.lines} rowKey={(x) => x.code} cols={[{ key: 'code', label: t('code'), render: (x) => <span className="mono">{x.code}</span> }, { key: 'nameAr', label: t('account'), render: (x) => locale === 'ar' ? x.nameAr : x.nameEn }, { key: 'amount', label: t('amount'), num: true, render: (x) => m(x.amount) }]} />
      </div> : null}
      {d && tab === 'bs' ? <>
        <p><span className={`badge ${d.balanced ? 'ok' : 'danger'}`}>{d.balanced ? t('balanced') : t('notBalanced')}</span></p>
        <div className="grid c2">{(['asset', 'liability', 'equity'] as const).map((g) => <div key={g}><h2>{g}</h2><Table rows={d.groups[g]} rowKey={(x) => x.code} cols={[{ key: 'code', label: t('code') }, { key: 'nameAr', label: t('account'), render: (x) => locale === 'ar' ? x.nameAr : x.nameEn }, { key: 'amount', label: t('amount'), num: true, render: (x) => m(x.amount) }]} /></div>)}</div>
        <div className="card" style={{ marginTop: 12 }}>Assets {m(d.totals.assets)} = Liabilities + Equity {m(d.totals.liabilitiesAndEquity)}</div>
      </> : null}
      {d && tab === 'cf' ? <div className="card"><Table rows={[['netIncome', d.netIncome], ['operating', d.operating], ['investing', d.investing], ['financing', d.financing], ['netChangeInCash', d.netChangeInCash], ['cashAccountsChange', d.cashAccountsChange]].map(([k, v]) => ({ id: k, k, v }))} cols={[{ key: 'k', label: '' }, { key: 'v', label: t('amount'), num: true, render: (x) => m(x.v) }]} /><p><span className={`badge ${d.reconciles ? 'ok' : 'danger'}`}>{d.reconciles ? t('balanced') : t('notBalanced')}</span></p></div> : null}
      {d && tab === 'vat' ? <Table rows={d} rowKey={(x, i) => `${x.code}-${i}`} cols={[{ key: 'code', label: t('code') }, { key: 'name_ar', label: t('account') }, { key: 'tax_code', label: t('tax') }, { key: 'base', label: 'Base', num: true, render: (x) => m(x.base) }, { key: 'output_minus_input', label: t('amount'), num: true, render: (x) => m(x.output_minus_input) }]} /> : null}
      {d && tab === 'ap' ? <Table rows={d} rowKey={(x) => x.supplier_id} cols={[{ key: 'name_ar', label: t('supplier') }, ...['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus', 'balance'].map((k) => ({ key: k, label: k, num: true, render: (x: any) => m(x[k]) }))]} /> : null}
      {d && tab === 'rec' ? <div className="grid k4"><div className="card kpi"><div className="label">Sub-ledger</div><div className="val">{m(d.subledger)}</div></div><div className="card kpi"><div className="label">GL</div><div className="val">{m(d.gl)}</div></div><div className="card kpi"><div className="label">{t('difference')}</div><div className="val">{m(d.difference)}</div><span className={`badge ${d.reconciled ? 'ok' : 'danger'}`}>{d.reconciled ? t('balanced') : t('notBalanced')}</span></div><div className="card kpi"><div className="label">Pending</div><div className="val">{d.pendingPostings}</div></div></div> : null}
    </>
  );
}

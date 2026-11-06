'use client';
import { useState } from 'react';
import { get, qs } from '@/lib/api';
import { useI18n, money, dt } from '@/lib/i18n';
import { useAsync, ErrorBox, PageHead, Table, State, Modal } from '@/components/ui';
import { BranchSelect } from '@/components/shell';

export default function Sessions() {
  const { t, locale } = useI18n();
  const [branchId, setBranch] = useState('');
  const [z, setZ] = useState<string | null>(null);
  const list = useAsync(() => get(`/api/v1/pos/sessions${qs({ branchId, limit: 100 })}`), [branchId]);
  return (
    <>
      <PageHead title={t('sessions')}><div style={{ width: 240 }}><BranchSelect allowAll value={branchId} onChange={setBranch} /></div></PageHead>
      <ErrorBox error={list.error} />
      <Table rows={list.data?.data} cols={[
        { key: 'number', label: t('number'), render: (r) => <span className="mono">{r.number}</span> }, { key: 'branch_code', label: t('branch') }, { key: 'terminal_code', label: t('terminal') }, { key: 'opened_by_name', label: t('cashier') },
        { key: 'opened_at', label: t('openedAt'), render: (r) => dt(r.opened_at, locale) }, { key: 'closed_at', label: t('closedAt'), render: (r) => dt(r.closed_at, locale) },
        { key: 'sales_total', label: t('total'), num: true, render: (r) => money(r.sales_total, locale) },
        { key: 'cash_difference', label: t('difference'), num: true, render: (r) => <span style={{ color: Number(r.cash_difference) < 0 ? 'var(--danger)' : undefined }}>{money(r.cash_difference, locale)}</span> },
        { key: 'state', label: t('status'), render: (r) => <State s={r.state} /> }, { key: 'x', label: '', render: (r) => <button className="btn sm" onClick={() => setZ(r.id)}>{t('zReport')}</button> },
      ]} />
      {z ? <ZReport id={z} onClose={() => setZ(null)} /> : null}
    </>
  );
}

function ZReport({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const r = useAsync(() => get(`/api/v1/pos/sessions/${id}/z-report`), [id]);
  const d = r.data;
  return (
    <Modal title={`${t('zReport')} ${d?.session.number ?? ''}`} onClose={onClose}>
      <ErrorBox error={r.error} />
      {d ? <div className="grid">
        <div className="form-grid"><div><h3>{t('openedAt')}</h3>{dt(d.session.opened_at, locale)}</div><div><h3>{t('expectedCash')}</h3>{money(d.session.expected_cash, locale)}</div><div><h3>{t('countedCash')}</h3>{money(d.session.counted_cash, locale)}</div><div><h3>{t('difference')}</h3>{money(d.session.cash_difference, locale)}</div></div>
        <Table rows={d.byKind} rowKey={(x) => x.kind} cols={[{ key: 'kind', label: t('type') }, { key: 'orders', label: t('ordersCount'), num: true }, { key: 'total', label: t('total'), num: true, render: (x) => money(x.total, locale) }, { key: 'tax', label: t('tax'), num: true, render: (x) => money(x.tax, locale) }, { key: 'discount', label: 'Discount', num: true, render: (x) => money(x.discount, locale) }]} />
        <Table rows={d.tenders} rowKey={(x) => x.method} cols={[{ key: 'method', label: t('type') }, { key: 'count', label: '#', num: true }, { key: 'amount', label: t('amount'), num: true, render: (x) => money(x.amount, locale) }]} />
        <Table rows={d.taxes} rowKey={(x) => x.code} cols={[{ key: 'code', label: t('tax') }, { key: 'base', label: 'Base', num: true, render: (x) => money(x.base, locale) }, { key: 'amount', label: t('amount'), num: true, render: (x) => money(x.amount, locale) }]} />
        {d.quarantinedItems ? <div className="alert warn">{t('quarantine')}: {d.quarantinedItems}</div> : null}
        <button className="btn no-print" onClick={() => window.print()}>{t('print')}</button>
      </div> : null}
    </Modal>
  );
}

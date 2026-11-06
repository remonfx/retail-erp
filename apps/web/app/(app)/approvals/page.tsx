'use client';
import { useState } from 'react';
import { get, post, qs } from '@/lib/api';
import { useI18n, money, dt } from '@/lib/i18n';
import { useAsync, useAction, ErrorBox, Ok, PageHead, Table, State } from '@/components/ui';

export default function Approvals() {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState('pending');
  const { data, error, reload } = useAsync(() => get(`/api/v1/approvals${qs({ status })}`), [status]);
  const a = useAction();
  const decide = (id: string, decision: 'approve' | 'reject') => a.run(async () => {
    const note = decision === 'reject' ? prompt(t('reason')) ?? undefined : undefined;
    await post(`/api/v1/approvals/${id}/decide`, { decision, note });
    await reload();
  }, t('saved'));
  return (
    <>
      <PageHead title={t('approvals')}>
        <div className="tabs" style={{ margin: 0, border: 'none' }}>{['pending', 'approved', 'rejected'].map((s) => <button key={s} className={status === s ? 'active' : ''} onClick={() => setStatus(s)}>{s}</button>)}</div>
      </PageHead>
      <ErrorBox error={error ?? a.error} /><Ok msg={a.ok} />
      <Table rows={data} cols={[
        { key: 'doc_type', label: t('type'), render: (r) => <span className="badge info">{r.doc_type.replace(/_/g, ' ')}</span> },
        { key: 'summary', label: t('details') },
        { key: 'branch_code', label: t('branch') },
        { key: 'amount', label: t('amount'), num: true, render: (r) => money(r.amount, locale) },
        { key: 'requested_by_name', label: t('requestedBy') },
        { key: 'requested_at', label: t('date'), render: (r) => dt(r.requested_at, locale) },
        { key: 'status', label: t('status'), render: (r) => <State s={r.status} /> },
        { key: 'x', label: t('actions'), render: (r) => r.canDecide ? <div className="row"><button className="btn sm primary" disabled={a.busy} onClick={() => decide(r.id, 'approve')}>{t('approve')}</button><button className="btn sm danger" disabled={a.busy} onClick={() => decide(r.id, 'reject')}>{t('reject')}</button></div> : null },
      ]} />
    </>
  );
}

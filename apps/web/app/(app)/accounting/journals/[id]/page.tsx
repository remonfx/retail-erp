'use client';
import { use } from 'react';
import { get, post } from '@/lib/api';
import { useI18n, money, dt } from '@/lib/i18n';
import { useAsync, useAction, ErrorBox, Ok, PageHead, Table, State } from '@/components/ui';
import { Go, sourceHref } from '@/components/links';
import { useMe } from '@/components/shell';
import Link from 'next/link';

export default function EntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, locale } = useI18n();
  const { can, me } = useMe();
  const e = useAsync(() => get(`/api/v1/journal-entries/${id}`), [id]);
  const a = useAction();
  const d = e.data;
  if (!d) return <ErrorBox error={e.error} />;
  const src = sourceHref(d.source_type, d.source_id);
  const range = { from: d.posting_date.slice(0, 8) + '01', to: d.posting_date };
  return <>
    <div className="crumbs"><Link href="/accounting/journals">{t('journals')}</Link> / <span>{d.journal_code}</span></div>
    <PageHead title={d.number ?? 'draft'}>
      <State s={d.state} />{d.late_posting ? <span className="badge warn">late posting</span> : null}
      {src ? <Link className="btn" href={src}>{t('source')}: {d.source_type.replace(/_/g, ' ')}</Link> : <span className="badge">{d.source_type}</span>}
      {d.reversal_of_id ? <Go type="journal_entry" id={d.reversal_of_id}>↩ {t('reverse')}</Go> : null}
      {d.reversed_by_id ? <Go type="journal_entry" id={d.reversed_by_id}>{t('reverse')} →</Go> : null}
      {d.state === 'draft' && can('accounting.journal.post') && d.created_by !== me?.user.id ? <button className="btn primary" disabled={a.busy} onClick={() => a.run(async () => { await post(`/api/v1/journal-entries/${id}/post`, { postingDate: d.posting_date }); await e.reload(); }, t('saved'))}>{t('post')}</button> : null}
      {d.state === 'posted' && can('accounting.journal.reverse') ? <button className="btn danger" disabled={a.busy} onClick={() => a.run(async () => { const reason = prompt(t('reason')); if (!reason) return; await post(`/api/v1/journal-entries/${id}/reverse`, { reversalDate: new Date().toISOString().slice(0, 10), reason }); await e.reload(); }, t('saved'))}>{t('reverse')}</button> : null}
      <button className="btn no-print" onClick={() => window.print()}>{t('print')}</button>
    </PageHead>
    <ErrorBox error={a.error} /><Ok msg={a.ok} />
    <div className="card form-grid" style={{ marginBottom: 14 }}>
      <div><h3>{t('date')}</h3>{dt(d.posting_date, locale)}</div><div><h3>{t('memo')}</h3>{d.memo ?? '—'}</div><div><h3>{t('total')}</h3>{money(d.total_debit, locale)}</div><div><h3>Rule</h3><span className="mono">{d.posting_rule ?? 'manual'}</span></div>
    </div>
    <Table rows={d.lines} cols={[
      { key: 'account_code', label: t('account'), render: (r) => <Go type="account" id={r.account_id} extra={range}><span className="mono">{r.account_code}</span> {r.account_name}</Go> },
      { key: 'branch_code', label: t('branch') },
      { key: 'partner_name', label: t('supplier'), render: (r) => r.partner_id ? <Go type="supplier" id={r.partner_id}>{r.partner_name}</Go> : '—' },
      { key: 'label', label: t('memo') },
      { key: 'debit', label: t('debit'), num: true, render: (r) => Number(r.debit) ? <Go type="account" id={r.account_id} extra={range}>{money(r.debit, locale)}</Go> : '' },
      { key: 'credit', label: t('credit'), num: true, render: (r) => Number(r.credit) ? <Go type="account" id={r.account_id} extra={range}>{money(r.credit, locale)}</Go> : '' },
    ]} footer={<tr><td colSpan={4}>{t('total')}</td><td className="num">{money(d.total_debit, locale)}</td><td className="num">{money(d.total_credit, locale)}</td></tr>} />
  </>;
}

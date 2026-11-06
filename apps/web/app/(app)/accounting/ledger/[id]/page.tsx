'use client';
import { Suspense, use, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { get, qs } from '@/lib/api';
import { useI18n, money, dt } from '@/lib/i18n';
import { useAsync, ErrorBox, PageHead, Table, Field } from '@/components/ui';
import { Go } from '@/components/links';

function Ledger({ id }: { id: string }) {
  const { t, locale } = useI18n();
  const sp = useSearchParams();
  const year = new Date().getFullYear();
  const [f, setF] = useState({ from: sp.get('from') ?? `${year}-01-01`, to: sp.get('to') ?? new Date().toISOString().slice(0, 10) });
  const [applied, setApplied] = useState(f);
  const acct = useAsync(async () => (await get('/api/v1/accounts')).find((a: any) => a.id === id), [id]);
  const gl = useAsync(() => get(`/api/v1/reports/general-ledger${qs({ accountId: id, ...applied })}`), [id, applied]);
  return <>
    <div className="crumbs"><Link href="/accounting/reports">{t('reports')}</Link> / <span>{t('account')}</span></div>
    <PageHead title={acct.data ? `${acct.data.code} — ${locale === 'ar' ? acct.data.name_ar : acct.data.name_en}` : '…'}>
      <Field label={t('from')}><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
      <Field label={t('to')}><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
      <button className="btn primary" style={{ alignSelf: 'end' }} onClick={() => setApplied(f)}>{t('apply')}</button>
    </PageHead>
    <ErrorBox error={gl.error} />
    <p className="muted">{t('drillHint')}</p>
    <Table rows={gl.data?.lines} rowKey={(r, i) => `${r.entry_id}-${i}`} cols={[
      { key: 'posting_date', label: t('date'), render: (r) => dt(r.posting_date, locale) },
      { key: 'number', label: t('number'), render: (r) => <Go type="journal_entry" id={r.entry_id}><span className="mono">{r.number}</span></Go> },
      { key: 'source_type', label: t('source'), render: (r) => r.source_type },
      { key: 'memo', label: t('memo'), render: (r) => r.label ?? r.memo },
      { key: 'partner_name', label: t('supplier') }, { key: 'branch_code', label: t('branch') },
      { key: 'debit', label: t('debit'), num: true, render: (r) => Number(r.debit) ? money(r.debit, locale) : '' },
      { key: 'credit', label: t('credit'), num: true, render: (r) => Number(r.credit) ? money(r.credit, locale) : '' },
      { key: 'balance', label: t('closing'), num: true, render: (r) => money(r.balance, locale) },
    ]} footer={gl.data ? <tr><td colSpan={6}>{t('opening')} {money(gl.data.opening, locale)}</td><td colSpan={3} className="num">{t('closing')} {money(gl.data.closing, locale)}</td></tr> : undefined} />
  </>;
}
export default function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = use(params); return <Suspense><Ledger id={id} /></Suspense>; }

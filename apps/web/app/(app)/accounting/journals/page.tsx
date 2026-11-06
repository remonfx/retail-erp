'use client';
import { useState } from 'react';
import { get, post, qs } from '@/lib/api';
import { useI18n, money, dt } from '@/lib/i18n';
import { useAsync, useAction, ErrorBox, Ok, PageHead, Table, State, Modal, Field } from '@/components/ui';
import { Go } from '@/components/links';
import { useMe } from '@/components/shell';

export default function Journals() {
  const { t, locale } = useI18n();
  const { can } = useMe();
  const [f, setF] = useState({ journal: '', state: '' });
  const [rows, setRows] = useState<any[] | null>(null);
  const list = useAsync(async () => { const r = await get(`/api/v1/journal-entries${qs({ ...f, limit: 100 })}`); setRows(r.data); return r; }, [f]);
  const [view, setView] = useState<string | null>(null); const [create, setCreate] = useState(false);
  return (
    <>
      <PageHead title={t('journals')}>
        <select style={{ width: 140 }} value={f.journal} onChange={(e) => setF({ ...f, journal: e.target.value })}><option value="">{t('all')}</option>{['SAL', 'PUR', 'INV', 'BNK', 'GEN', 'PAY'].map((j) => <option key={j}>{j}</option>)}</select>
        <select style={{ width: 140 }} value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })}><option value="">{t('all')}</option>{['draft', 'posted', 'reversed'].map((s) => <option key={s}>{s}</option>)}</select>
        {can('accounting.journal.write') ? <button className="btn primary" onClick={() => setCreate(true)}>{t('newJournal')}</button> : null}
      </PageHead>
      <ErrorBox error={list.error} />
      <Table rows={rows} cols={[{ key: 'posting_date', label: t('date'), render: (r) => dt(r.posting_date, locale) }, { key: 'number', label: t('number'), render: (r) => <Go type="journal_entry" id={r.id}><span className="mono">{r.number ?? 'draft'}</span></Go> },
        { key: 'journal_code', label: 'J' }, { key: 'source_type', label: t('type') }, { key: 'memo', label: t('memo') }, { key: 'total_debit', label: t('debit'), num: true, render: (r) => money(r.total_debit, locale) },
        { key: 'state', label: t('status'), render: (r) => <>{<State s={r.state} />}{r.late_posting ? <span className="badge warn">late</span> : null}</> }]} />
      {view ? <EntryView id={view} onClose={() => { setView(null); void list.reload(); }} /> : null}
      {create ? <NewJournal onClose={() => { setCreate(false); void list.reload(); }} /> : null}
    </>
  );
}

function EntryView({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const { can, me } = useMe();
  const e = useAsync(() => get(`/api/v1/journal-entries/${id}`), [id]);
  const a = useAction();
  const d = e.data;
  return (
    <Modal title={d?.number ?? 'draft'} onClose={onClose}>
      <ErrorBox error={e.error ?? a.error} /><Ok msg={a.ok} />
      {d ? <>
        <p>{d.memo} — <State s={d.state} /> {d.reversal_of_id ? <span className="badge">reversal</span> : null}</p>
        <Table rows={d.lines} cols={[{ key: 'account_code', label: t('account'), render: (r) => <><span className="mono">{r.account_code}</span> {r.account_name}</> }, { key: 'branch_code', label: t('branch') }, { key: 'partner_name', label: t('supplier') }, { key: 'label', label: t('memo') },
          { key: 'debit', label: t('debit'), num: true, render: (r) => Number(r.debit) ? money(r.debit, locale) : '' }, { key: 'credit', label: t('credit'), num: true, render: (r) => Number(r.credit) ? money(r.credit, locale) : '' }]}
          footer={<tr><td colSpan={4}>{t('total')}</td><td className="num">{money(d.lines.reduce((s: number, l: any) => s + Number(l.debit), 0), locale)}</td><td className="num">{money(d.lines.reduce((s: number, l: any) => s + Number(l.credit), 0), locale)}</td></tr>} />
        <div className="row" style={{ marginTop: 12 }}>
          {d.state === 'draft' && can('accounting.journal.post') && d.created_by !== me?.user.id ? <button className="btn primary" disabled={a.busy} onClick={() => a.run(async () => { await post(`/api/v1/journal-entries/${id}/post`, { postingDate: d.posting_date }); await e.reload(); }, t('saved'))}>{t('post')}</button> : null}
          {d.state === 'posted' && can('accounting.journal.reverse') ? <button className="btn danger" disabled={a.busy} onClick={() => a.run(async () => { const reason = prompt(t('reason')); if (!reason) return; await post(`/api/v1/journal-entries/${id}/reverse`, { reversalDate: new Date().toISOString().slice(0, 10), reason }); await e.reload(); }, t('saved'))}>{t('reverse')}</button> : null}
        </div>
      </> : null}
    </Modal>
  );
}

function NewJournal({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n();
  const accts = useAsync(() => get('/api/v1/accounts'), []);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10)); const [memo, setMemo] = useState('');
  const [lines, setLines] = useState([{ accountId: '', debit: '', credit: '' }, { accountId: '', debit: '', credit: '' }]);
  const a = useAction();
  const d = lines.reduce((s, l) => s + Number(l.debit || 0), 0), c = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  const upd = (i: number, k: string, v: string) => setLines(lines.map((l, j) => j === i ? { ...l, [k]: v } : l));
  return (
    <Modal title={t('newJournal')} onClose={onClose}>
      <ErrorBox error={a.error} />
      <div className="form-grid"><Field label={t('date')}><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field><Field label={t('memo')}><input value={memo} onChange={(e) => setMemo(e.target.value)} /></Field></div>
      <div className="grid" style={{ marginTop: 12 }}>
        {lines.map((l, i) => <div key={i} className="row">
          <select style={{ flex: 2 }} value={l.accountId} onChange={(e) => upd(i, 'accountId', e.target.value)}><option value="">{t('account')}</option>{accts.data?.filter((x: any) => x.is_postable).map((x: any) => <option key={x.id} value={x.id}>{x.code} — {locale === 'ar' ? x.name_ar : x.name_en}</option>)}</select>
          <input style={{ flex: 1 }} placeholder={t('debit')} value={l.debit} onChange={(e) => upd(i, 'debit', e.target.value)} />
          <input style={{ flex: 1 }} placeholder={t('credit')} value={l.credit} onChange={(e) => upd(i, 'credit', e.target.value)} />
        </div>)}
        <div className="row"><button className="btn sm" onClick={() => setLines([...lines, { accountId: '', debit: '', credit: '' }])}>+ {t('add')}</button><div style={{ flex: 1 }} /><span className={`badge ${d === c && d > 0 ? 'ok' : 'danger'}`}>{d.toFixed(2)} / {c.toFixed(2)}</span></div>
      </div>
      <div style={{ marginTop: 12 }}><button className="btn primary" disabled={a.busy || d !== c || d === 0 || memo.length < 3} onClick={() => a.run(async () => {
        await post('/api/v1/journal-entries', { date, memo, lines: lines.filter((l) => l.accountId).map((l) => ({ accountId: l.accountId, debit: l.debit || '0', credit: l.credit || '0' })) });
        onClose();
      })}>{t('save')}</button></div>
    </Modal>
  );
}

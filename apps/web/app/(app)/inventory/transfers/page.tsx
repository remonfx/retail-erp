'use client';
import { useState } from 'react';
import { get, post, qs } from '@/lib/api';
import { useI18n, money, qty, dt } from '@/lib/i18n';
import { useAsync, useAction, ErrorBox, Ok, PageHead, Table, State, Modal, Field } from '@/components/ui';
import { Go } from '@/components/links';
import { ProductPicker, LocationSelect, type PickedProduct } from '@/components/product-picker';
import { useMe } from '@/components/shell';

export default function Transfers() {
  const { t, locale } = useI18n();
  const { can } = useMe();
  const [open, setOpen] = useState(false);
  const [receiving, setReceiving] = useState<string | null>(null);
  const docs = useAsync(() => get(`/api/v1/stock-documents${qs({ kind: 'transfer', limit: 100 })}`), []);
  const a = useAction();
  const dispatch = (id: string) => a.run(async () => { await post(`/api/v1/transfers/${id}/dispatch`); await docs.reload(); }, t('saved'));
  return (
    <>
      <PageHead title={t('transfers')}>{can('inventory.transfer.write') ? <button className="btn primary" onClick={() => setOpen(true)}>{t('newTransfer')}</button> : null}</PageHead>
      <ErrorBox error={docs.error ?? a.error} /><Ok msg={a.ok} />
      <Table rows={docs.data?.data} cols={[
        { key: 'number', label: t('number'), render: (r) => <Go type="stock_source" id={r.id}><span className="mono">{r.number}</span></Go> }, { key: 'branch_code', label: t('branch') },
        { key: 'total_value', label: t('value'), num: true, render: (r) => money(r.total_value, locale) }, { key: 'created_at', label: t('date'), render: (r) => dt(r.created_at, locale) }, { key: 'state', label: t('status'), render: (r) => <State s={r.state} /> },
        { key: 'x', label: t('actions'), render: (r) => r.state === 'draft' ? <button className="btn sm primary" disabled={a.busy} onClick={() => dispatch(r.id)}>{t('dispatch')}</button> : r.state === 'in_transit' ? <button className="btn sm primary" onClick={() => setReceiving(r.id)}>{t('receive')}</button> : null },
      ]} />
      {open ? <NewTransfer onClose={() => { setOpen(false); void docs.reload(); }} /> : null}
      {receiving ? <Receive id={receiving} onClose={() => { setReceiving(null); void docs.reload(); }} /> : null}
    </>
  );
}

function NewTransfer({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const locs = useAsync(() => get('/api/v1/locations'), []);
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [lines, setLines] = useState<{ p: PickedProduct; qty: string }[]>([]);
  const a = useAction();
  return (
    <Modal title={t('newTransfer')} onClose={onClose}>
      <ErrorBox error={a.error} />
      <div className="form-grid">
        <Field label={t('fromLocation')}><LocationSelect value={from} onChange={setFrom} locations={locs.data} /></Field>
        <Field label={t('toLocation')}><LocationSelect value={to} onChange={setTo} locations={locs.data} /></Field>
      </div>
      <div style={{ margin: '12px 0' }}><ProductPicker onPick={(p) => setLines([...lines, { p, qty: '1' }])} /></div>
      <Table rows={lines} rowKey={(r, i) => `${r.p.id}-${i}`} cols={[{ key: 'sku', label: t('sku'), render: (r) => <span className="mono">{r.p.sku}</span> }, { key: 'n', label: t('nameAr'), render: (r) => r.p.name_ar },
        { key: 'qty', label: t('qty'), render: (r) => <input style={{ width: 110 }} value={r.qty} onChange={(e) => setLines(lines.map((x) => x === r ? { ...x, qty: e.target.value } : x))} /> },
        { key: 'x', label: '', render: (r) => <button className="btn sm danger" onClick={() => setLines(lines.filter((x) => x !== r))}>✕</button> }]} />
      <div style={{ marginTop: 12 }}><button className="btn primary" disabled={a.busy || !lines.length || !from || !to} onClick={() => a.run(async () => { await post('/api/v1/transfers', { fromLocationId: from, toLocationId: to, lines: lines.map((l) => ({ variantId: l.p.id, qty: l.qty })) }); onClose(); })}>{t('create')}</button></div>
    </Modal>
  );
}

function Receive({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const doc = useAsync(() => get(`/api/v1/stock-documents/${id}`), [id]);
  const reasons = useAsync(() => get('/api/v1/inventory/reason-codes'), []);
  const [rec, setRec] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const a = useAction();
  const lines = doc.data?.lines ?? [];
  const shortage = lines.some((l: any) => Number(rec[l.id] ?? l.qty) < Number(l.qty));
  return (
    <Modal title={`${t('receive')} ${doc.data?.number ?? ''}`} onClose={onClose}>
      <ErrorBox error={a.error ?? doc.error} />
      <Table rows={lines} cols={[{ key: 'sku', label: t('sku'), render: (r) => <span className="mono">{r.sku}</span> }, { key: 'name_ar', label: t('nameAr') }, { key: 'qty', label: t('inTransit'), num: true, render: (r) => qty(r.qty, locale) },
        { key: 'r', label: t('received'), render: (r) => <input style={{ width: 110 }} value={rec[r.id] ?? r.qty} onChange={(e) => setRec({ ...rec, [r.id]: e.target.value })} /> }]} />
      {shortage ? <Field label={t('reason')}><select value={reason} onChange={(e) => setReason(e.target.value)}><option value="">—</option>{reasons.data?.filter((r: any) => r.applies_to === 'transfer').map((r: any) => <option key={r.id} value={r.id}>{r.name_ar}</option>)}</select></Field> : null}
      <div style={{ marginTop: 12 }}><button className="btn primary" disabled={a.busy || (shortage && !reason)} onClick={() => a.run(async () => { await post(`/api/v1/transfers/${id}/receive`, { lines: lines.map((l: any) => ({ lineId: l.id, qtyReceived: rec[l.id] ?? l.qty })), shortageReasonCodeId: reason || undefined }); onClose(); })}>{t('confirm')}</button></div>
    </Modal>
  );
}

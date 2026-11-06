'use client';
import { useState } from 'react';
import Link from 'next/link';
import { get, post, qs } from '@/lib/api';
import { useI18n, money, dt } from '@/lib/i18n';
import { useAsync, useAction, ErrorBox, Ok, PageHead, Table, State, Modal, Field } from '@/components/ui';
import { Go } from '@/components/links';
import { ProductPicker, LocationSelect, type PickedProduct } from '@/components/product-picker';
import { useMe } from '@/components/shell';

export default function Adjustments() {
  const { t, locale } = useI18n();
  const { can } = useMe();
  const [open, setOpen] = useState(false);
  const docs = useAsync(() => get(`/api/v1/stock-documents${qs({ limit: 100 })}`), []);
  return (
    <>
      <PageHead title={t('adjustments')}>{can('inventory.adjustment.write') ? <button className="btn primary" onClick={() => setOpen(true)}>{t('newAdjustment')}</button> : null}</PageHead>
      <ErrorBox error={docs.error} />
      <Table rows={docs.data?.data?.filter((d: any) => ['adjustment', 'scrap', 'transfer'].includes(d.kind))} cols={[
        { key: 'number', label: t('number'), render: (r) => <Go type="stock_source" id={r.id}><span className="mono">{r.number}</span></Go> }, { key: 'kind', label: t('type') }, { key: 'branch_code', label: t('branch') }, { key: 'reason_name', label: t('reason') },
        { key: 'total_value', label: t('value'), num: true, render: (r) => money(r.total_value, locale) }, { key: 'created_at', label: t('date'), render: (r) => dt(r.created_at, locale) }, { key: 'state', label: t('status'), render: (r) => <State s={r.state} /> },
      ]} />
      {open ? <NewAdjustment onClose={() => { setOpen(false); void docs.reload(); }} /> : null}
    </>
  );
}

function NewAdjustment({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n();
  const locs = useAsync(() => get('/api/v1/locations'), []);
  const reasons = useAsync(() => get('/api/v1/inventory/reason-codes'), []);
  const [kind, setKind] = useState<'adjustment' | 'scrap'>('adjustment');
  const [locationId, setLoc] = useState(''); const [reasonCodeId, setReason] = useState(''); const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<{ p: PickedProduct; qty: string; lotNo: string }[]>([]);
  const a = useAction();
  const submit = () => a.run(async () => {
    const r = await post('/api/v1/stock-adjustments', { kind, locationId, reasonCodeId, notes: notes || undefined, lines: lines.map((l) => ({ variantId: l.p.id, qty: l.qty, lotNo: l.lotNo || undefined })) });
    alert(`${r.number}: ${r.state}`);
    onClose();
  });
  return (
    <Modal title={t('newAdjustment')} onClose={onClose}>
      <ErrorBox error={a.error} />
      <div className="form-grid">
        <Field label={t('type')}><select value={kind} onChange={(e) => setKind(e.target.value as never)}><option value="adjustment">{t('adjustment')}</option><option value="scrap">{t('scrap')}</option></select></Field>
        <Field label={t('location')}><LocationSelect value={locationId} onChange={setLoc} locations={locs.data} types={['internal', 'quarantine']} /></Field>
        <Field label={t('reason')}><select value={reasonCodeId} onChange={(e) => setReason(e.target.value)} required><option value="">—</option>{reasons.data?.filter((r: any) => (kind === 'scrap' ? r.applies_to === 'scrap' : ['adjustment', 'count'].includes(r.applies_to))).map((r: any) => <option key={r.id} value={r.id}>{locale === 'ar' ? r.name_ar : r.name_en}</option>)}</select></Field>
        <Field label={t('notes')}><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
      <div style={{ margin: '12px 0' }}><ProductPicker onPick={(p) => setLines([...lines, { p, qty: kind === 'scrap' ? '1' : '-1', lotNo: '' }])} /></div>
      <Table rows={lines} rowKey={(r, i) => `${r.p.id}-${i}`} cols={[
        { key: 'sku', label: t('sku'), render: (r) => <span className="mono">{r.p.sku}</span> }, { key: 'n', label: t('nameAr'), render: (r) => r.p.name_ar },
        { key: 'qty', label: kind === 'scrap' ? t('qty') : t('gainLoss'), render: (r) => <input style={{ width: 110 }} value={r.qty} onChange={(e) => setLines(lines.map((x) => x === r ? { ...x, qty: e.target.value } : x))} /> },
        { key: 'lot', label: t('lot'), render: (r) => <input style={{ width: 110 }} value={r.lotNo} onChange={(e) => setLines(lines.map((x) => x === r ? { ...x, lotNo: e.target.value } : x))} /> },
        { key: 'x', label: '', render: (r) => <button className="btn sm danger" onClick={() => setLines(lines.filter((x) => x !== r))}>✕</button> },
      ]} />
      <div className="row" style={{ marginTop: 12 }}><button className="btn primary" disabled={a.busy || !lines.length || !locationId || !reasonCodeId} onClick={submit}>{t('confirm')}</button><Link href="/approvals" className="muted">{t('approvals')}</Link></div>
    </Modal>
  );
}

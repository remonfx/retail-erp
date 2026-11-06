'use client';
import { use, useState } from 'react';
import { get, post } from '@/lib/api';
import { useI18n, money, qty, dt } from '@/lib/i18n';
import { useAsync, useAction, ErrorBox, Ok, PageHead, Table, State, Modal } from '@/components/ui';
import { useMe } from '@/components/shell';

export default function OrderDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, locale } = useI18n();
  const { can } = useMe();
  const o = useAsync(() => get(`/api/v1/purchase-orders/${id}`), [id]);
  const a = useAction();
  const [rcv, setRcv] = useState(false);
  if (!o.data) return <ErrorBox error={o.error} />;
  const d = o.data;
  const act = (path: string) => a.run(async () => { await post(`/api/v1/purchase-orders/${id}/${path}`); await o.reload(); }, t('saved'));
  return (
    <>
      <PageHead title={d.number}>
        <State s={d.state} />
        {d.state === 'draft' && can('purchasing.order.write') ? <button className="btn primary" disabled={a.busy} onClick={() => act('submit')}>{t('submit')}</button> : null}
        {['approved', 'partially_received'].includes(d.state) && can('inventory.receipt.write') ? <button className="btn primary" onClick={() => setRcv(true)}>{t('receiveGoods')}</button> : null}
        {['draft', 'pending_approval', 'approved'].includes(d.state) ? <button className="btn danger" disabled={a.busy} onClick={() => confirm(t('confirm')) && act('cancel')}>{t('cancel')}</button> : null}
        <button className="btn no-print" onClick={() => window.print()}>{t('print')}</button>
      </PageHead>
      <ErrorBox error={a.error} /><Ok msg={a.ok} />
      <div className="card form-grid" style={{ marginBottom: 14 }}>
        <div><h3>{t('supplier')}</h3>{d.supplier_name}</div><div><h3>{t('date')}</h3>{dt(d.order_date, locale)}</div>
        <div><h3>{t('subtotal')}</h3>{money(d.subtotal, locale)}</div><div><h3>{t('tax')}</h3>{money(d.tax_total, locale)}</div><div><h3>{t('total')}</h3><strong>{money(d.total, locale)}</strong></div>
      </div>
      <Table rows={d.lines} cols={[{ key: 'line_no', label: '#' }, { key: 'sku', label: t('sku'), render: (r) => <span className="mono">{r.sku}</span> }, { key: 'name_ar', label: t('nameAr') },
        { key: 'qty', label: t('ordered'), num: true, render: (r) => qty(r.qty, locale) }, { key: 'qty_received', label: t('received'), num: true, render: (r) => qty(r.qty_received, locale) }, { key: 'qty_invoiced', label: 'Invoiced', num: true, render: (r) => qty(r.qty_invoiced, locale) },
        { key: 'unit_price', label: t('unitPrice'), num: true, render: (r) => money(r.unit_price, locale) }]} />
      {d.receipts?.length ? <><h2 style={{ marginTop: 16 }}>GRN</h2><Table rows={d.receipts} cols={[{ key: 'number', label: t('number'), render: (r) => <span className="mono">{r.number}</span> }, { key: 'received_at', label: t('date'), render: (r) => dt(r.received_at, locale) }]} /></> : null}
      {rcv ? <ReceiveModal order={d} onClose={() => { setRcv(false); void o.reload(); }} /> : null}
    </>
  );
}

function ReceiveModal({ order, onClose }: { order: any; onClose: () => void }) {
  const { t, locale } = useI18n();
  const open = order.lines.filter((l: any) => Number(l.qty_received) < Number(l.qty));
  const [vals, setVals] = useState<Record<string, { qty: string; lotNo: string; expiryDate: string }>>(Object.fromEntries(open.map((l: any) => [l.id, { qty: String(Number(l.qty) - Number(l.qty_received)), lotNo: '', expiryDate: '' }])));
  const a = useAction();
  return (
    <Modal title={t('receiveGoods')} onClose={onClose}>
      <ErrorBox error={a.error} />
      <Table rows={open} cols={[{ key: 'sku', label: t('sku'), render: (r) => <span className="mono">{r.sku}</span> }, { key: 'rem', label: t('remaining'), num: true, render: (r) => qty(Number(r.qty) - Number(r.qty_received), locale) },
        { key: 'q', label: t('qty'), render: (r) => <input style={{ width: 90 }} value={vals[r.id]!.qty} onChange={(e) => setVals({ ...vals, [r.id]: { ...vals[r.id]!, qty: e.target.value } })} /> },
        { key: 'lot', label: t('lot'), render: (r) => <input style={{ width: 100 }} value={vals[r.id]!.lotNo} onChange={(e) => setVals({ ...vals, [r.id]: { ...vals[r.id]!, lotNo: e.target.value } })} /> },
        { key: 'exp', label: t('expiry'), render: (r) => <input type="date" value={vals[r.id]!.expiryDate} onChange={(e) => setVals({ ...vals, [r.id]: { ...vals[r.id]!, expiryDate: e.target.value } })} /> }]} />
      <div style={{ marginTop: 12 }}><button className="btn primary" disabled={a.busy} onClick={() => a.run(async () => {
        await post(`/api/v1/purchase-orders/${order.id}/receive`, { lines: Object.entries(vals).filter(([, v]) => Number(v.qty) > 0).map(([orderLineId, v]) => ({ orderLineId, qty: v.qty, lotNo: v.lotNo || undefined, expiryDate: v.expiryDate || undefined })) });
        onClose();
      })}>{t('confirm')}</button></div>
    </Modal>
  );
}

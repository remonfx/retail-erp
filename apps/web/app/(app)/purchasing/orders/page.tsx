'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { get, post, qs } from '@/lib/api';
import { useI18n, money, dt } from '@/lib/i18n';
import { useAsync, useAction, ErrorBox, PageHead, Table, State, Modal, Field } from '@/components/ui';
import { ProductPicker, type PickedProduct } from '@/components/product-picker';
import { BranchSelect, useMe } from '@/components/shell';

export default function Orders() {
  const { t, locale } = useI18n();
  const { can } = useMe();
  const [state, setState] = useState('');
  const [open, setOpen] = useState(false);
  const list = useAsync(() => get(`/api/v1/purchase-orders${qs({ state, limit: 100 })}`), [state]);
  return (
    <>
      <PageHead title={t('purchaseOrders')}>
        <select style={{ width: 200 }} value={state} onChange={(e) => setState(e.target.value)}><option value="">{t('all')}</option>{['draft', 'pending_approval', 'approved', 'partially_received', 'received', 'cancelled'].map((s) => <option key={s}>{s}</option>)}</select>
        {can('purchasing.order.write') ? <button className="btn primary" onClick={() => setOpen(true)}>{t('newPO')}</button> : null}
      </PageHead>
      <ErrorBox error={list.error} />
      <Table rows={list.data?.data} cols={[
        { key: 'number', label: t('number'), render: (r) => <Link className="mono" href={`/purchasing/orders/${r.id}`}>{r.number}</Link> }, { key: 'supplier_name', label: t('supplier') }, { key: 'branch_code', label: t('branch') },
        { key: 'order_date', label: t('date'), render: (r) => dt(r.order_date, locale) }, { key: 'total', label: t('total'), num: true, render: (r) => money(r.total, locale) }, { key: 'state', label: t('status'), render: (r) => <State s={r.state} /> },
      ]} />
      {open ? <NewPO onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function NewPO({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const router = useRouter();
  const { branches } = useMe();
  const sups = useAsync(() => get('/api/v1/partners?role=supplier&limit=500'), []);
  const taxes = useAsync(() => get('/api/v1/tax-rates'), []);
  const [supplierId, setSup] = useState(''); const [branchId, setBranch] = useState(branches[0]?.id ?? '');
  const [lines, setLines] = useState<{ p: PickedProduct; qty: string; unitPrice: string; taxRateId: string }[]>([]);
  const a = useAction();
  const vat = taxes.data?.find((x: any) => x.code === 'VAT14')?.id ?? '';
  const total = lines.reduce((s, l) => s + Number(l.qty) * Number(l.unitPrice) * (1 + (l.taxRateId === vat ? 0.14 : 0)), 0);
  const upd = (r: any, k: string, v: string) => setLines(lines.map((x) => x === r ? { ...x, [k]: v } : x));
  return (
    <Modal title={t('newPO')} onClose={onClose}>
      <ErrorBox error={a.error} />
      <div className="form-grid">
        <Field label={t('supplier')}><select value={supplierId} onChange={(e) => setSup(e.target.value)} required><option value="">—</option>{sups.data?.data?.map((s: any) => <option key={s.id} value={s.id}>{s.name_ar}</option>)}</select></Field>
        <Field label={t('branch')}><BranchSelect value={branchId} onChange={setBranch} /></Field>
      </div>
      <div style={{ margin: '12px 0' }}><ProductPicker onPick={(p) => setLines([...lines, { p, qty: '1', unitPrice: p.avg_cost ? Number(p.avg_cost).toFixed(2) : '0', taxRateId: vat }])} /></div>
      <Table rows={lines} rowKey={(r, i) => `${r.p.id}-${i}`} cols={[{ key: 'sku', label: t('sku'), render: (r) => <span className="mono">{r.p.sku}</span> }, { key: 'n', label: t('nameAr'), render: (r) => r.p.name_ar },
        { key: 'qty', label: t('qty'), render: (r) => <input style={{ width: 90 }} value={r.qty} onChange={(e) => upd(r, 'qty', e.target.value)} /> },
        { key: 'price', label: t('unitPrice'), render: (r) => <input style={{ width: 110 }} value={r.unitPrice} onChange={(e) => upd(r, 'unitPrice', e.target.value)} /> },
        { key: 'tax', label: t('tax'), render: (r) => <select style={{ width: 110 }} value={r.taxRateId} onChange={(e) => upd(r, 'taxRateId', e.target.value)}><option value="">—</option>{taxes.data?.map((x: any) => <option key={x.id} value={x.id}>{x.code}</option>)}</select> },
        { key: 'x', label: '', render: (r) => <button className="btn sm danger" onClick={() => setLines(lines.filter((x) => x !== r))}>✕</button> }]} />
      <div className="row" style={{ marginTop: 12 }}><strong>{t('total')}: {total.toFixed(2)}</strong><div style={{ flex: 1 }} />
        <button className="btn primary" disabled={a.busy || !supplierId || !lines.length} onClick={() => a.run(async () => {
          const r = await post('/api/v1/purchase-orders', { supplierId, branchId, lines: lines.map((l) => ({ variantId: l.p.id, qty: l.qty, unitPrice: l.unitPrice, taxRateId: l.taxRateId || null })) });
          router.push(`/purchasing/orders/${r.id}`);
        })}>{t('create')}</button></div>
    </Modal>
  );
}

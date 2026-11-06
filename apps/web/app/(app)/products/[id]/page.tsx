'use client';
import { use, useState } from 'react';
import { get, post, api } from '@/lib/api';
import { useI18n, money, qty, dt } from '@/lib/i18n';
import { useAsync, useAction, ErrorBox, Ok, PageHead, Table, State, Field } from '@/components/ui';
import { useMe } from '@/components/shell';
import { Go } from '@/components/links';

export default function ProductDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, locale } = useI18n();
  const { can, branches } = useMe();
  const { data: p, error, reload } = useAsync(() => get(`/api/v1/products/${id}`), [id]);
  const hist = useAsync(() => get(`/api/v1/products/${id}/history`), [id]);
  const [tab, setTab] = useState<'info' | 'stock' | 'moves' | 'history'>('info');
  const moves = useAsync(() => (tab === 'moves' ? get(`/api/v1/products/${id}/movements`) : Promise.resolve(null)), [id, tab]);
  const [bc, setBc] = useState('');
  const a = useAction();
  const vid = p?.variants?.[0]?.id;
  const stock = useAsync(() => vid ? get(`/api/v1/stock/availability?variantIds=${vid}`) : Promise.resolve([]), [vid]);
  if (!p) return <ErrorBox error={error} />;
  const setStatus = (status: string) => a.run(async () => { await api('PATCH', `/api/v1/products/${id}`, { version: p.version, status }); await reload(); }, t('saved'));
  const addBarcode = (variantId: string) => a.run(async () => { await post(`/api/v1/variants/${variantId}/barcodes`, { code: bc }); setBc(''); await reload(); }, t('saved'));
  return (
    <>
      <PageHead title={locale === 'ar' ? p.name_ar : p.name_en ?? p.name_ar}>
        <State s={p.status} />
        {can('catalog.product.write') ? <select style={{ width: 'auto' }} value={p.status} onChange={(e) => setStatus(e.target.value)}>{['active', 'discontinued', 'archived'].map((s) => <option key={s}>{s}</option>)}</select> : null}
      </PageHead>
      <ErrorBox error={a.error} /><Ok msg={a.ok} />
      <div className="tabs">{(['info', 'stock', 'moves', 'history'] as const).map((x) => <button key={x} className={tab === x ? 'active' : ''} onClick={() => setTab(x)}>{t(x === 'info' ? 'details' : x === 'stock' ? 'stock' : x === 'moves' ? 'movements' : 'history')}</button>)}</div>
      {tab === 'info' ? <div className="grid">
        <div className="card form-grid">
          <div><h3>{t('category')}</h3>{p.category_name_ar}</div><div><h3>{t('tracking')}</h3>{p.tracking}</div><div><h3>{t('weighted')}</h3>{p.is_weighted ? '✓' : '—'}</div>
          {p.costs?.[0] ? <div><h3>{t('avgCost')}</h3>{money(Number(p.costs[0].qty) > 0 ? Number(p.costs[0].value) / Number(p.costs[0].qty) : p.costs[0].last_avg, locale)}</div> : null}
        </div>
        <h2>{t('variants')}</h2>
        {p.variants.map((v: any) => (
          <div className="card" key={v.id}>
            <div className="row"><strong className="mono">{v.sku}</strong><State s={v.status} /></div>
            <Table rows={v.barcodes} cols={[{ key: 'code', label: t('barcode'), render: (r) => <span className="mono">{r.code}</span> }, { key: 'symbology', label: t('type') }, { key: 'pack_qty', label: t('qty'), num: true, render: (r) => qty(r.pack_qty, locale) }, { key: 'status', label: t('status'), render: (r) => <State s={r.status} /> }, { key: 'is_primary', label: '★', render: (r) => r.is_primary ? '★' : '' }]} />
            {can('catalog.product.write') ? <div className="row" style={{ marginTop: 8 }}><Field label={t('barcode')}><input dir="ltr" value={bc} onChange={(e) => setBc(e.target.value)} /></Field><button className="btn" style={{ alignSelf: 'end' }} disabled={!bc || a.busy} onClick={() => addBarcode(v.id)}>{t('add')}</button></div> : null}
          </div>
        ))}
        <h2>{t('price')}</h2>
        <Table rows={p.prices} cols={[{ key: 'price_list_code', label: 'List' }, { key: 'scope', label: t('scope') }, { key: 'price', label: t('price'), num: true, render: (r) => money(r.price, locale) }, { key: 'min_qty', label: 'Min', num: true, render: (r) => qty(r.min_qty, locale) }, { key: 'valid_from', label: t('from'), render: (r) => dt(r.valid_from, locale) }, { key: 'valid_to', label: t('to'), render: (r) => dt(r.valid_to, locale) }]} />
      </div> : null}
      {tab === 'stock' ? <Table rows={stock.data} rowKey={(r) => `${r.branch_id}-${r.warehouse_id}`} cols={[{ key: 'branch_id', label: t('branch'), render: (r) => branches.find((b) => b.id === r.branch_id)?.code ?? '—' }, { key: 'on_hand', label: t('onHand'), num: true, render: (r) => qty(r.on_hand, locale) }, { key: 'reserved', label: t('reserved'), num: true, render: (r) => qty(r.reserved, locale) }, { key: 'available', label: t('available'), num: true, render: (r) => qty(r.available, locale) }]} /> : null}
      {tab === 'moves' ? <Table rows={moves.data} cols={[
        { key: 'moved_at', label: t('date'), render: (r) => dt(r.moved_at, locale) }, { key: 'branch_code', label: t('branch') },
        { key: 'move_type', label: t('type'), render: (r) => <>{r.move_type}{r.negative_exception ? <span className="badge danger">&lt;0</span> : null}</> },
        { key: 'src', label: t('source'), render: (r) => <Go type={r.ref_doc_type === 'pos_order' ? 'pos_order' : 'stock_source'} id={r.ref_doc_id}>{t('openDoc')}</Go> },
        { key: 'from_code', label: t('fromLocation') }, { key: 'to_code', label: t('toLocation') },
        { key: 'qty', label: t('qty'), num: true, render: (r) => qty(r.qty_stock_uom, locale) }, { key: 'unit_cost', label: t('cost'), num: true, render: (r) => money(r.unit_cost, locale) }, { key: 'value', label: t('value'), num: true, render: (r) => money(r.value, locale) },
      ]} /> : null}
      {tab === 'history' ? <Table rows={hist.data} rowKey={(r, i) => `${r.created_at}-${i}`} cols={[{ key: 'created_at', label: t('date'), render: (r) => dt(r.created_at, locale) }, { key: 'user_name', label: t('users') }, { key: 'entity', label: t('type') }, { key: 'action', label: t('actions') },
        { key: 'diff', label: t('details'), render: (r) => <span className="mono" style={{ fontSize: 11 }}>{r.before && r.after ? Object.keys(r.after).filter((k) => JSON.stringify(r.after[k]) !== JSON.stringify(r.before[k]) && !['updated_at', 'version', 'search_norm'].includes(k)).map((k) => `${k}: ${JSON.stringify(r.before[k])} → ${JSON.stringify(r.after[k])}`).join('; ') : ''}</span> }]} /> : null}
    </>
  );
}

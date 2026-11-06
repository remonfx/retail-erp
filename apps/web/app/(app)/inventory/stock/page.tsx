'use client';
import { useEffect, useState } from 'react';
import { get, qs } from '@/lib/api';
import { useI18n, money, qty, dt } from '@/lib/i18n';
import { ErrorBox, PageHead, Table, errText, Field } from '@/components/ui';
import { Go } from '@/components/links';
import { BranchSelect } from '@/components/shell';

export default function Stock() {
  const { t, locale } = useI18n();
  const [f, setF] = useState({ q: '', branchId: '', onlyNegative: false });
  const [rows, setRows] = useState<any[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async (reset: boolean) => {
    try { const r = await get(`/api/v1/stock${qs({ ...f, onlyNegative: f.onlyNegative || undefined, limit: 100, cursor: reset ? undefined : cursor })}`); setRows(reset ? r.data : [...(rows ?? []), ...r.data]); setCursor(r.nextCursor); } catch (e) { setError(errText(e)); }
  };
  useEffect(() => { const h = setTimeout(() => void load(true), 250); return () => clearTimeout(h); /* eslint-disable-next-line */ }, [f]);
  return (
    <>
      <PageHead title={t('stock')}>
        <input style={{ width: 280 }} placeholder={t('searchProducts')} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <div style={{ width: 220 }}><BranchSelect allowAll value={f.branchId} onChange={(v) => setF({ ...f, branchId: v })} /></div>
        <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={f.onlyNegative} onChange={(e) => setF({ ...f, onlyNegative: e.target.checked })} />&lt; 0</label>
      </PageHead>
      <ErrorBox error={error} />
      <Table rows={rows} cols={[
        { key: 'sku', label: t('sku'), render: (r) => <Go type="product" id={r.product_id}><span className="mono">{r.sku}</span></Go> },
        { key: 'name', label: t('nameAr'), render: (r) => <Go type="product" id={r.product_id}>{locale === 'ar' ? r.name_ar : r.name_en ?? r.name_ar}</Go> },
        { key: 'location_code', label: t('location') },
        { key: 'lot_no', label: t('lot'), render: (r) => r.lot_no ? <>{r.lot_no} <span className="muted">{dt(r.expiry_date, locale)}</span></> : '—' },
        { key: 'qty_on_hand', label: t('onHand'), num: true, render: (r) => <span style={{ color: Number(r.qty_on_hand) < 0 ? 'var(--danger)' : undefined }}>{qty(r.qty_on_hand, locale)}</span> },
        { key: 'qty_reserved', label: t('reserved'), num: true, render: (r) => qty(r.qty_reserved, locale) },
        { key: 'qty_available', label: t('available'), num: true, render: (r) => qty(r.qty_available, locale) },
        { key: 'value', label: t('value'), num: true, render: (r) => money(r.value, locale) },
      ]} />
      {cursor ? <div style={{ marginTop: 12 }}><button className="btn" onClick={() => load(false)}>{t('loadMore')}</button></div> : null}
    </>
  );
}

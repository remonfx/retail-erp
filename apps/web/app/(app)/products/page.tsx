'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { get, qs, api, API_URL, session } from '@/lib/api';
import { useI18n, money } from '@/lib/i18n';
import { ErrorBox, PageHead, Table, State, errText, Modal, useAction, Ok } from '@/components/ui';
import { useMe } from '@/components/shell';

export default function Products() {
  const { t, locale } = useI18n();
  const { can } = useMe();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<any[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const load = async (reset: boolean, query = q) => {
    try {
      const r = await get(`/api/v1/products${qs({ q: query, limit: 50, cursor: reset ? undefined : cursor })}`);
      setRows(reset ? r.data : [...(rows ?? []), ...r.data]); setCursor(r.nextCursor);
    } catch (e) { setError(errText(e)); }
  };
  useEffect(() => { const h = setTimeout(() => void load(true, q), 250); return () => clearTimeout(h); /* eslint-disable-next-line */ }, [q]);
  const exportCsv = async () => {
    const res = await fetch(`${API_URL}/api/v1/products/export.csv`, { headers: { authorization: `Bearer ${session.access}`, 'x-company-id': session.company ?? '' } });
    const blob = await res.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'products.csv'; a.click();
  };
  return (
    <>
      <PageHead title={t('products')}>
        <input style={{ width: 320 }} placeholder={t('searchProducts')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus aria-label={t('search')} />
        {can('reporting.export') ? <button className="btn" onClick={exportCsv}>{t('exportCsv')}</button> : null}
        {can('catalog.product.import') ? <button className="btn" onClick={() => setImportOpen(true)}>{t('importCsv')}</button> : null}
        {can('catalog.product.write') ? <Link className="btn primary" href="/products/new">{t('newProduct')}</Link> : null}
      </PageHead>
      <ErrorBox error={error} />
      <Table rows={rows} cols={[
        { key: 'sku', label: t('sku'), render: (r) => <Link className="mono" href={`/products/${r.product_id}`}>{r.sku}</Link> },
        { key: 'barcode', label: t('barcode'), render: (r) => <span className="mono">{r.barcode ?? '—'}</span> },
        { key: 'name', label: t('nameAr'), render: (r) => <>{locale === 'ar' ? r.name_ar : r.name_en ?? r.name_ar}{r.name_suffix_ar ? <span className="muted"> — {r.name_suffix_ar}</span> : null}</> },
        { key: 'category_name_ar', label: t('category') },
        { key: 'retail_price', label: t('retailPrice'), num: true, render: (r) => money(r.retail_price, locale) },
        { key: 'avg_cost', label: t('avgCost'), num: true, render: (r) => r.avg_cost === undefined || r.avg_cost === null ? '—' : money(r.avg_cost, locale) },
        { key: 'status', label: t('status'), render: (r) => <State s={r.status} /> },
      ]} />
      {cursor ? <div style={{ marginTop: 12 }}><button className="btn" onClick={() => load(false)}>{t('loadMore')}</button></div> : null}
      {importOpen ? <ImportModal onClose={() => { setImportOpen(false); void load(true); }} /> : null}
    </>
  );
}

function ImportModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<any>(null);
  const a = useAction();
  const run = (dryRun: boolean) => a.run(async () => setResult(await api('POST', '/api/v1/products/import', { csv, dryRun })));
  return (
    <Modal title={t('importCsv')} onClose={onClose}>
      <p className="muted mono" style={{ fontSize: 12 }}>sku,barcode,name_ar,name_en,category_code,brand,uom_code,tax_class_code,retail_price,cost,tracking,is_weighted</p>
      <input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} />
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn" disabled={!csv || a.busy} onClick={() => run(true)}>Dry run</button>
        <button className="btn primary" disabled={!csv || a.busy} onClick={() => run(false)}>{t('importCsv')}</button>
      </div>
      <ErrorBox error={a.error} />
      {result ? <div style={{ marginTop: 10 }}>
        <Ok msg={result.valid ? `rows ${result.rows} — new ${result.created ?? result.wouldCreate} — updated ${result.updated ?? result.wouldUpdate}` : null} />
        {result.errorCount ? <Table rows={result.errors} rowKey={(r, i) => `${r.row}-${i}`} cols={[{ key: 'row', label: '#' }, { key: 'error', label: t('error') }]} /> : null}
      </div> : null}
    </Modal>
  );
}

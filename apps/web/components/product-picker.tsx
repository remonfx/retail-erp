'use client';
import { useEffect, useState } from 'react';
import { get, qs } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export interface PickedProduct { id: string; sku: string; name_ar: string; name_en: string | null; retail_price: string | null; avg_cost?: string | null }

/** Server-side search (never loads the full catalog). Enter on exact barcode/SKU picks immediately. */
export function ProductPicker({ onPick, placeholder }: { onPick: (p: PickedProduct) => void; placeholder?: string }) {
  const { t, locale } = useI18n();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<PickedProduct[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setRes([]); return; }
    const h = setTimeout(async () => setRes((await get(`/api/v1/products${qs({ q, limit: 10 })}`)).data), 200);
    return () => clearTimeout(h);
  }, [q]);
  const pick = (p: PickedProduct) => { onPick(p); setQ(''); setRes([]); };
  return (
    <div style={{ position: 'relative' }}>
      <input value={q} placeholder={placeholder ?? t('searchProducts')} onChange={(e) => setQ(e.target.value)} aria-label={t('search')}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (res[0]) pick(res[0]); } }} />
      {res.length ? <div className="card" style={{ position: 'absolute', insetInlineStart: 0, insetInlineEnd: 0, zIndex: 20, padding: 4, marginTop: 4, maxHeight: 280, overflowY: 'auto' }}>
        {res.map((p) => <button key={p.id} type="button" className="btn" style={{ width: '100%', justifyContent: 'space-between', border: 'none' }} onClick={() => pick(p)}>
          <span>{locale === 'ar' ? p.name_ar : p.name_en ?? p.name_ar}</span><span className="mono muted">{p.sku}</span></button>)}
      </div> : null}
    </div>
  );
}

export function LocationSelect({ value, onChange, locations, types = ['internal'] }: { value: string; onChange: (v: string) => void; locations: any[] | null; types?: string[] }) {
  const { locale } = useI18n();
  return <select value={value} onChange={(e) => onChange(e.target.value)} required>
    <option value="">—</option>
    {(locations ?? []).filter((l) => types.includes(l.type)).map((l) => <option key={l.id} value={l.id}>{l.code} — {locale === 'ar' ? l.name_ar : l.name_en ?? l.name_ar}</option>)}
  </select>;
}

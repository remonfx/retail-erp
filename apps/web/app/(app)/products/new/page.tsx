'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { get, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAsync, useAction, ErrorBox, Field, PageHead } from '@/components/ui';

export default function NewProduct() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const ref = useAsync(async () => ({ uoms: await get('/api/v1/uoms'), taxes: await get('/api/v1/tax-classes'), cats: await get('/api/v1/categories'), brands: await get('/api/v1/brands') }));
  const [f, setF] = useState({ nameAr: '', nameEn: '', categoryId: '', brandId: '', stockUomId: '', taxClassId: '', tracking: 'none', isWeighted: false, sku: '', barcode: '', retailPrice: '', standardCost: '' });
  const [dups, setDups] = useState<any>(null);
  const a = useAction();
  useEffect(() => {
    if (ref.data && !f.stockUomId) setF((x) => ({ ...x, stockUomId: ref.data!.uoms.find((u: any) => u.code === 'PCS')?.id ?? '', taxClassId: ref.data!.taxes.find((c: any) => c.code === 'STANDARD')?.id ?? '', categoryId: ref.data!.cats[0]?.id ?? '' }));
  }, [ref.data, f.stockUomId]);
  useEffect(() => {
    if (f.nameAr.length < 3 && !f.sku && !f.barcode) return;
    const h = setTimeout(async () => setDups(await post('/api/v1/products/check-duplicates', { nameAr: f.nameAr, nameEn: f.nameEn || undefined, skus: f.sku ? [f.sku] : [], barcodes: f.barcode ? [f.barcode] : [] })), 400);
    return () => clearTimeout(h);
  }, [f.nameAr, f.nameEn, f.sku, f.barcode]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value });
  const submit = (e: React.FormEvent) => { e.preventDefault(); void a.run(async () => {
    const r = await post('/api/v1/products', { nameAr: f.nameAr, nameEn: f.nameEn || undefined, categoryId: f.categoryId, brandId: f.brandId || undefined, stockUomId: f.stockUomId, taxClassId: f.taxClassId, tracking: f.tracking, isWeighted: f.isWeighted,
      variants: [{ sku: f.sku, barcodes: f.barcode ? [{ code: f.barcode }] : [], retailPrice: f.retailPrice || undefined, standardCost: f.standardCost || undefined }] });
    router.push(`/products/${r.id}`);
  }); };
  const hasDup = dups && (dups.duplicateSkus.length || dups.duplicateBarcodes.length || dups.similarNames.length);
  return (
    <form onSubmit={submit}>
      <PageHead title={t('newProduct')}><button className="btn primary" disabled={a.busy}>{t('save')}</button></PageHead>
      <ErrorBox error={a.error ?? ref.error} />
      {hasDup ? <div className="alert warn"><strong>{t('duplicatesFound')}</strong>
        <ul style={{ margin: '6px 0 0' }}>
          {dups.duplicateSkus.map((d: any) => <li key={d.variant_id}>SKU {d.sku}</li>)}
          {dups.duplicateBarcodes.map((d: any) => <li key={d.code}>{t('barcode')} {d.code} → {d.sku}</li>)}
          {dups.similarNames.map((d: any) => <li key={d.id}><a href={`/products/${d.id}`} target="_blank">{d.name_ar}</a> ({Math.round(d.score * 100)}%)</li>)}
        </ul></div> : null}
      <div className="card form-grid">
        <Field label={t('nameAr')}><input required value={f.nameAr} onChange={set('nameAr')} /></Field>
        <Field label={t('nameEn')}><input value={f.nameEn} onChange={set('nameEn')} dir="ltr" /></Field>
        <Field label={t('sku')}><input required pattern="[A-Za-z0-9._/\-]{1,64}" value={f.sku} onChange={set('sku')} dir="ltr" /></Field>
        <Field label={t('barcode')}><input value={f.barcode} onChange={set('barcode')} dir="ltr" inputMode="numeric" /></Field>
        <Field label={t('category')}><select required value={f.categoryId} onChange={set('categoryId')}>{ref.data?.cats.map((c: any) => <option key={c.id} value={c.id}>{'— '.repeat(c.depth - 1)}{locale === 'ar' ? c.name_ar : c.name_en ?? c.name_ar}</option>)}</select></Field>
        <Field label={t('brand')}><select value={f.brandId} onChange={set('brandId')}><option value="">—</option>{ref.data?.brands.map((b: any) => <option key={b.id} value={b.id}>{b.name_ar}</option>)}</select></Field>
        <Field label={t('uom')}><select value={f.stockUomId} onChange={set('stockUomId')}>{ref.data?.uoms.map((u: any) => <option key={u.id} value={u.id}>{u.code} — {u.name_ar}</option>)}</select></Field>
        <Field label={t('taxClass')}><select value={f.taxClassId} onChange={set('taxClassId')}>{ref.data?.taxes.map((c: any) => <option key={c.id} value={c.id}>{c.code} — {c.name_ar}</option>)}</select></Field>
        <Field label={t('tracking')}><select value={f.tracking} onChange={set('tracking')}><option value="none">—</option><option value="lot">{t('lot')}</option><option value="serial">Serial</option></select></Field>
        <Field label={t('retailPrice')}><input inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={f.retailPrice} onChange={set('retailPrice')} /></Field>
        <Field label={t('cost')}><input inputMode="decimal" pattern="\d+(\.\d{1,4})?" value={f.standardCost} onChange={set('standardCost')} /></Field>
        <label className="row" style={{ alignSelf: 'end' }}><input type="checkbox" style={{ width: 'auto' }} checked={f.isWeighted} onChange={set('isWeighted')} />{t('weighted')}</label>
      </div>
    </form>
  );
}

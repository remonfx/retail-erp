'use client';
import { useState } from 'react';
import { get, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAsync, useAction, ErrorBox, PageHead, Table, Modal, Field } from '@/components/ui';
import { useMe } from '@/components/shell';

export default function Branches() {
  const { t, locale } = useI18n();
  const { can } = useMe();
  const list = useAsync(() => get('/api/v1/branches'), []);
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHead title={t('branches')}>{can('core.org.manage') ? <button className="btn primary" onClick={() => setOpen(true)}>{t('newBranch')}</button> : null}</PageHead>
      <ErrorBox error={list.error} />
      <Table rows={list.data} cols={[{ key: 'code', label: t('code'), render: (r) => <span className="mono">{r.code}</span> }, { key: 'name', label: t('nameAr'), render: (r) => locale === 'ar' ? r.name_ar : r.name_en ?? r.name_ar }, { key: 'timezone', label: 'TZ' },
        { key: 'warehouses', label: t('inventory'), render: (r) => (r.warehouses ?? []).map((w: any) => w.code).join(', ') }, { key: 'active', label: t('status'), render: (r) => r.active ? '✓' : '✕' }]} />
      {open ? <NewBranch onClose={() => { setOpen(false); location.reload(); }} /> : null}
    </>
  );
}
function NewBranch({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ code: '', nameAr: '', nameEn: '', address: '', phone: '' });
  const a = useAction();
  return <Modal title={t('newBranch')} onClose={onClose}><ErrorBox error={a.error} />
    <div className="form-grid">
      <Field label={t('code')}><input dir="ltr" pattern="[A-Z0-9-]{2,12}" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
      <Field label={t('nameAr')}><input value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></Field>
      <Field label={t('nameEn')}><input value={f.nameEn} onChange={(e) => setF({ ...f, nameEn: e.target.value })} /></Field>
      <Field label={t('phone')}><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
    </div>
    <div style={{ marginTop: 12 }}><button className="btn primary" disabled={a.busy} onClick={() => a.run(async () => { await post('/api/v1/branches', { code: f.code, nameAr: f.nameAr, nameEn: f.nameEn || undefined, phone: f.phone || undefined }); onClose(); })}>{t('save')}</button></div>
  </Modal>;
}

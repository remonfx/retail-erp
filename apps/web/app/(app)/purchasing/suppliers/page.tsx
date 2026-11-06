'use client';
import { useState } from 'react';
import { get, post, qs } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAsync, useAction, ErrorBox, PageHead, Table, Modal, Field } from '@/components/ui';
import { Go } from '@/components/links';
import { useMe } from '@/components/shell';

export default function Suppliers() {
  const { t } = useI18n();
  const { can } = useMe();
  const [q, setQ] = useState(''); const [open, setOpen] = useState(false);
  const list = useAsync(() => get(`/api/v1/partners${qs({ role: 'supplier', q, limit: 200 })}`), [q]);
  return (
    <>
      <PageHead title={t('suppliers')}><input style={{ width: 260 }} placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} />{can('purchasing.supplier.write') ? <button className="btn primary" onClick={() => setOpen(true)}>{t('newSupplier')}</button> : null}</PageHead>
      <ErrorBox error={list.error} />
      <Table rows={list.data?.data} cols={[{ key: 'code', label: t('code'), render: (r) => <span className="mono">{r.code}</span> }, { key: 'name_ar', label: t('nameAr'), render: (r) => <Go type="supplier" id={r.id}>{r.name_ar}</Go> }, { key: 'tax_registration_no', label: t('taxRegistrationNo') }, { key: 'phone', label: t('phone') }, { key: 'payment_terms_days', label: t('paymentTerms'), num: true }, { key: 'consignment', label: 'Consignment', render: (r) => r.consignment ? '✓' : '' }]} />
      {open ? <NewSupplier onClose={() => { setOpen(false); void list.reload(); }} /> : null}
    </>
  );
}
function NewSupplier({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ nameAr: '', nameEn: '', taxRegistrationNo: '', phone: '', paymentTermsDays: '30', consignment: false });
  const a = useAction();
  return (
    <Modal title={t('newSupplier')} onClose={onClose}>
      <ErrorBox error={a.error} />
      <div className="form-grid">
        <Field label={t('nameAr')}><input value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></Field>
        <Field label={t('nameEn')}><input value={f.nameEn} onChange={(e) => setF({ ...f, nameEn: e.target.value })} /></Field>
        <Field label={t('taxRegistrationNo')}><input value={f.taxRegistrationNo} onChange={(e) => setF({ ...f, taxRegistrationNo: e.target.value })} /></Field>
        <Field label={t('phone')}><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label={t('paymentTerms')}><input type="number" min={0} value={f.paymentTermsDays} onChange={(e) => setF({ ...f, paymentTermsDays: e.target.value })} /></Field>
        <label className="row" style={{ alignSelf: 'end' }}><input type="checkbox" style={{ width: 'auto' }} checked={f.consignment} onChange={(e) => setF({ ...f, consignment: e.target.checked })} />Consignment</label>
      </div>
      <div style={{ marginTop: 12 }}><button className="btn primary" disabled={a.busy || f.nameAr.length < 2} onClick={() => a.run(async () => { await post('/api/v1/partners', { ...f, nameEn: f.nameEn || undefined, taxRegistrationNo: f.taxRegistrationNo || undefined, phone: f.phone || undefined, paymentTermsDays: Number(f.paymentTermsDays), isSupplier: true }); onClose(); })}>{t('save')}</button></div>
    </Modal>
  );
}

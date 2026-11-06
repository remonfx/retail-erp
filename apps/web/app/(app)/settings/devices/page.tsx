'use client';
import { useState } from 'react';
import { get, post } from '@/lib/api';
import { useI18n, dt } from '@/lib/i18n';
import { useAsync, useAction, ErrorBox, Ok, PageHead, Table, State, Modal, Field } from '@/components/ui';
import { BranchSelect, useMe } from '@/components/shell';

export default function Devices() {
  const { t, locale } = useI18n();
  const { branches } = useMe();
  const devices = useAsync(() => get('/api/v1/devices'), []);
  const terminals = useAsync(() => get('/api/v1/terminals'), []);
  const [open, setOpen] = useState(false); const [code, setCode] = useState<{ id: string; enrollmentCode: string } | null>(null);
  const a = useAction();
  return (
    <>
      <PageHead title={t('devices')}><button className="btn primary" onClick={() => setOpen(true)}>{t('newDevice')}</button></PageHead>
      <ErrorBox error={devices.error ?? a.error} /><Ok msg={a.ok} />
      {code ? <div className="alert warn"><strong>{t('enrollmentCode')}</strong><div className="mono" style={{ fontSize: 18 }}>Device ID: {code.id}<br />Code: {code.enrollmentCode}</div></div> : null}
      <Table rows={devices.data} cols={[{ key: 'name', label: t('devices') }, { key: 'kind', label: t('type') }, { key: 'branch', label: t('branch'), render: (r) => branches.find((b) => b.id === r.branch_id)?.code }, { key: 'terminal_code', label: t('terminal') },
        { key: 'status', label: t('status'), render: (r) => <State s={r.status} /> }, { key: 'last_seen_at', label: t('lastSeen'), render: (r) => dt(r.last_seen_at, locale) }, { key: 'app_version', label: 'App' },
        { key: 'x', label: '', render: (r) => r.status !== 'revoked' ? <button className="btn sm danger" onClick={() => confirm(t('confirm')) && a.run(async () => { await post(`/api/v1/devices/${r.id}/revoke`); await devices.reload(); }, t('saved'))}>{t('revoke')}</button> : null }]} />
      <h2 style={{ marginTop: 18 }}>{t('terminal')}</h2>
      <Table rows={terminals.data} cols={[{ key: 'code', label: t('code') }, { key: 'name', label: t('nameAr') }, { key: 'branch', label: t('branch'), render: (r) => branches.find((b) => b.id === r.branch_id)?.code }, { key: 'device_status', label: t('status'), render: (r) => <State s={r.device_status} /> }, { key: 'open_session', label: t('sessions'), render: (r) => r.open_session ? <span className="badge info">open</span> : '—' }]} />
      {open ? <NewDevice onClose={(c) => { setOpen(false); if (c) setCode(c); void devices.reload(); void terminals.reload(); }} /> : null}
    </>
  );
}
function NewDevice({ onClose }: { onClose: (c?: { id: string; enrollmentCode: string }) => void }) {
  const { t } = useI18n();
  const { branches } = useMe();
  const [branchId, setBranch] = useState(branches[0]?.id ?? ''); const [name, setName] = useState(''); const [termCode, setTermCode] = useState('');
  const a = useAction();
  return <Modal title={t('newDevice')} onClose={() => onClose()}><ErrorBox error={a.error} />
    <div className="form-grid">
      <Field label={t('branch')}><BranchSelect value={branchId} onChange={setBranch} /></Field>
      <Field label={t('nameAr')}><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label={`${t('terminal')} ${t('code')}`}><input dir="ltr" pattern="[A-Z0-9]{1,6}" value={termCode} onChange={(e) => setTermCode(e.target.value.toUpperCase())} /></Field>
    </div>
    <div style={{ marginTop: 12 }}><button className="btn primary" disabled={a.busy || !name || !termCode} onClick={() => a.run(async () => {
      const d = await post('/api/v1/devices', { branchId, kind: 'pos', name });
      await post('/api/v1/terminals', { branchId, code: termCode, name, deviceId: d.id });
      onClose({ id: d.id, enrollmentCode: d.enrollmentCode });
    })}>{t('create')}</button></div>
  </Modal>;
}

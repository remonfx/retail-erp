'use client';
import { useState } from 'react';
import { get, post, api } from '@/lib/api';
import { useI18n, dt } from '@/lib/i18n';
import { useAsync, useAction, ErrorBox, Ok, PageHead, Table, State, Modal, Field } from '@/components/ui';
import { BranchSelect, useMe } from '@/components/shell';

export default function Users() {
  const { t, locale } = useI18n();
  const { can, companyId, branches } = useMe();
  const users = useAsync(() => get('/api/v1/users'), []);
  const roles = useAsync(() => get('/api/v1/roles'), []);
  const [newOpen, setNewOpen] = useState(false); const [assign, setAssign] = useState<any>(null);
  const a = useAction();
  return (
    <>
      <PageHead title={t('users')}>
        {can('core.user.manage') ? <button className="btn primary" onClick={() => setNewOpen(true)}>{t('newUser')}</button> : null}
      </PageHead>

      <ErrorBox error={users.error ?? a.error} /><Ok msg={a.ok} />
      <Table rows={users.data} cols={[{ key: 'full_name', label: t('fullName') }, { key: 'email', label: t('email'), render: (r) => <span dir="ltr">{r.email}</span> }, { key: 'status', label: t('status'), render: (r) => <State s={r.status} /> },
        { key: 'mfa_enabled', label: 'MFA', render: (r) => r.mfa_enabled ? '✓' : '—' }, { key: 'last_login_at', label: t('lastSeen'), render: (r) => dt(r.last_login_at, locale) },
        { key: 'assignments', label: t('role'), render: (r) => r.assignments.map((x: any) => <span key={x.id} className="badge info" style={{ marginInlineEnd: 4 }}>{locale === 'ar' ? x.roleNameAr : x.role} · {x.scopeType}{x.branchId ? ' ' + (branches.find((b) => b.id === x.branchId)?.code ?? '') : ''}</span>) },
        { key: 'x', label: t('actions'), render: (r) => r.is_tenant_owner ? null : <div className="row">
          {can('core.role.manage') ? <button className="btn sm" onClick={() => setAssign(r)}>{t('assignRole')}</button> : null}
          {can('core.user.manage') ? <button className="btn sm danger" onClick={() => a.run(async () => { await api('PATCH', `/api/v1/users/${r.id}`, { status: r.status === 'active' ? 'disabled' : 'active' }); await users.reload(); }, t('saved'))}>{r.status === 'active' ? 'Disable' : 'Enable'}</button> : null}
        </div> }]} />
      {newOpen ? <NewUser onClose={() => { setNewOpen(false); void users.reload(); }} /> : null}
      {assign ? <Assign user={assign} roles={roles.data ?? []} companyId={companyId} onClose={() => { setAssign(null); void users.reload(); }} /> : null}
    </>
  );
}

function NewUser({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ fullName: '', email: '', password: '', locale: 'ar' });
  const a = useAction();
  return <Modal title={t('newUser')} onClose={onClose}><ErrorBox error={a.error} />
    <div className="form-grid">
      <Field label={t('fullName')}><input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
      <Field label={t('email')}><input type="email" dir="ltr" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
      <Field label={t('password')}><input type="password" minLength={12} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
    </div>
    <div style={{ marginTop: 12 }}><button className="btn primary" disabled={a.busy} onClick={() => a.run(async () => { await post('/api/v1/users', f); onClose(); })}>{t('save')}</button></div>
  </Modal>;
}

function Assign({ user, roles, companyId, onClose }: { user: any; roles: any[]; companyId: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const [roleId, setRole] = useState(''); const [scopeType, setScope] = useState('branch'); const [branchId, setBranch] = useState('');
  const [maxDisc, setMaxDisc] = useState(''); const [ceiling, setCeiling] = useState('');
  const a = useAction();
  return <Modal title={`${t('assignRole')} — ${user.full_name}`} onClose={onClose}><ErrorBox error={a.error} />
    <div className="form-grid">
      <Field label={t('role')}><select value={roleId} onChange={(e) => setRole(e.target.value)}><option value="">—</option>{roles.map((r) => <option key={r.id} value={r.id}>{locale === 'ar' ? r.name_ar : r.name_en ?? r.code}</option>)}</select></Field>
      <Field label={t('scope')}><select value={scopeType} onChange={(e) => setScope(e.target.value)}>{['tenant', 'company', 'branch'].map((s) => <option key={s}>{s}</option>)}</select></Field>
      {scopeType === 'branch' ? <Field label={t('branch')}><BranchSelect value={branchId} onChange={setBranch} /></Field> : null}
      <Field label="Max line discount %"><input type="number" value={maxDisc} onChange={(e) => setMaxDisc(e.target.value)} /></Field>
      <Field label="Approval ceiling (EGP)"><input type="number" value={ceiling} onChange={(e) => setCeiling(e.target.value)} /></Field>
    </div>
    <div style={{ marginTop: 12 }}><button className="btn primary" disabled={a.busy || !roleId || (scopeType === 'branch' && !branchId)} onClick={() => a.run(async () => {
      await post(`/api/v1/users/${user.id}/assignments`, { roleId, scopeType, companyId: scopeType === 'tenant' ? undefined : companyId, branchId: scopeType === 'branch' ? branchId : undefined,
        limits: { ...(maxDisc ? { maxLineDiscountPercent: Number(maxDisc) } : {}), ...(ceiling ? { approvalCeiling: Number(ceiling) } : {}) } });
      onClose();
    })}>{t('save')}</button></div>
  </Modal>;
}

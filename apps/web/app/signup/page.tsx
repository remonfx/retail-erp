'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { post, session } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { ErrorBox, Field, errText } from '@/components/ui';

export default function SignupPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [f, setF] = useState({ tenantName: '', slug: '', ownerName: '', email: '', password: '', companyNameAr: '', taxRegistrationNo: '', branchNameAr: '', branchCode: 'MAIN', planCode: 'starter' });
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await post<{ accessToken: string; refreshToken: string; companyId: string }>('/api/v1/auth/signup', { ...f, taxRegistrationNo: f.taxRegistrationNo || undefined });
      session.set(r.accessToken, r.refreshToken); session.setCompany(r.companyId);
      router.replace('/');
    } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  };
  return (
    <div className="auth-page">
      <form className="card grid" style={{ width: 'min(640px, 100%)' }} onSubmit={submit}>
        <h1>{t('signup')}</h1>
        <ErrorBox error={error} />
        <div className="form-grid">
          <Field label={t('tenantName')}><input required minLength={2} value={f.tenantName} onChange={set('tenantName')} /></Field>
          <Field label={t('slug')}><input required pattern="[a-z0-9][a-z0-9-]{2,40}" value={f.slug} onChange={set('slug')} dir="ltr" /></Field>
          <Field label={t('ownerName')}><input required minLength={2} value={f.ownerName} onChange={set('ownerName')} /></Field>
          <Field label={t('email')}><input type="email" required value={f.email} onChange={set('email')} dir="ltr" /></Field>
          <Field label={t('password')}><input type="password" required minLength={12} value={f.password} onChange={set('password')} /></Field>
          <Field label={t('companyNameAr')}><input required minLength={2} value={f.companyNameAr} onChange={set('companyNameAr')} /></Field>
          <Field label={t('taxRegistrationNo')}><input value={f.taxRegistrationNo} onChange={set('taxRegistrationNo')} dir="ltr" /></Field>
          <Field label={t('branchNameAr')}><input required minLength={2} value={f.branchNameAr} onChange={set('branchNameAr')} /></Field>
          <Field label={t('branchCode')}><input required pattern="[A-Z0-9-]{2,12}" value={f.branchCode} onChange={set('branchCode')} dir="ltr" /></Field>
          <Field label={t('plan')}><select value={f.planCode} onChange={set('planCode')}><option value="starter">Starter</option><option value="growth">Growth</option><option value="enterprise">Enterprise</option></select></Field>
        </div>
        <button className="btn primary" disabled={busy}>{t('create')}</button>
        <div className="muted">{t('haveAccount')} <Link href="/login">{t('login')}</Link></div>
      </form>
    </div>
  );
}

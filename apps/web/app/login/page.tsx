'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { post, session, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { ErrorBox, Field, errText } from '@/components/ui';

export default function LoginPage() {
  const { t, locale, setLocale } = useI18n();
  const router = useRouter();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [totp, setTotp] = useState('');
  const [needMfa, setNeedMfa] = useState(false); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await post<{ accessToken: string; refreshToken: string }>('/api/v1/auth/login', { email, password, totp: needMfa ? totp : undefined });
      session.set(r.accessToken, r.refreshToken);
      router.replace('/');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MFA_REQUIRED') setNeedMfa(true); else setError(errText(err));
    } finally { setBusy(false); }
  };
  return (
    <div className="auth-page">
      <form className="card auth-card grid" onSubmit={submit}>
        <div className="row"><div className="brand" style={{ padding: 0 }}><div className="brand-mark">R</div>{t('appName')}</div><div style={{ flex: 1 }} /><button type="button" className="btn sm" onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}>{t('language')}</button></div>
        <p className="muted" style={{ margin: 0 }}>{t('tagline')}</p>
        <ErrorBox error={error} />
        <Field label={t('email')}><input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label={t('password')}><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        {needMfa ? <Field label={t('totp')}><input inputMode="numeric" pattern="\d{6}" autoFocus required value={totp} onChange={(e) => setTotp(e.target.value)} /></Field> : null}
        <button className="btn primary" disabled={busy}>{t('login')}</button>
        <div className="muted">{t('noAccount')} <Link href="/signup">{t('signup')}</Link></div>
      </form>
    </div>
  );
}

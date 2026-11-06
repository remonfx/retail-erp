'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { get, post, session } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export interface Me {
  user: { id: string; email: string; full_name: string; is_tenant_owner: boolean; mfa_enabled: boolean };
  tenant: { id: string; slug: string; name: string; status: string; plan_code: string; trial_ends_at: string | null };
  companies: { id: string; code: string; legal_name_ar: string; legal_name_en: string | null }[];
  branches: { id: string; company_id: string; code: string; name_ar: string; name_en: string | null }[];
  permissions: string[];
}
const MeCtx = createContext<{ me: Me | null; companyId: string; can: (p: string) => boolean; branches: Me['branches'] }>({ me: null, companyId: '', can: () => false, branches: [] });
export const useMe = () => useContext(MeCtx);

const NAV: { group: string; items: { href: string; label: string; perm?: string }[] }[] = [
  { group: '', items: [{ href: '/', label: 'dashboard', perm: 'reporting.dashboard.read' }, { href: '/approvals', label: 'approvals' }] },
  { group: 'catalog', items: [{ href: '/products', label: 'products', perm: 'catalog.product.read' }] },
  { group: 'inventory', items: [{ href: '/inventory/stock', label: 'stock', perm: 'inventory.stock.read' }, { href: '/inventory/adjustments', label: 'adjustments', perm: 'inventory.stock.read' }, { href: '/inventory/transfers', label: 'transfers', perm: 'inventory.stock.read' }] },
  { group: 'purchasing', items: [{ href: '/purchasing/orders', label: 'purchaseOrders', perm: 'purchasing.supplier.read' }, { href: '/purchasing/invoices', label: 'supplierInvoices', perm: 'purchasing.supplier.read' }, { href: '/purchasing/suppliers', label: 'suppliers', perm: 'purchasing.supplier.read' }] },
  { group: 'pos', items: [{ href: '/pos/sessions', label: 'sessions', perm: 'sales.order.read' }, { href: '/pos/sync', label: 'syncMonitor', perm: 'pos.sync.monitor' }] },
  { group: 'accounting', items: [{ href: '/accounting/journals', label: 'journals', perm: 'accounting.read' }, { href: '/accounting/reports', label: 'reports', perm: 'accounting.reports.read' }] },
  { group: 'settings', items: [{ href: '/settings/users', label: 'users', perm: 'core.user.read' }, { href: '/settings/branches', label: 'branches', perm: 'core.org.read' }, { href: '/settings/devices', label: 'devices', perm: 'core.device.manage' }, { href: '/settings/subscription', label: 'subscription' }] },
];

export function Shell({ children }: { children: ReactNode }) {
  const { t, locale, setLocale } = useI18n();
  const router = useRouter();
  const path = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [companyId, setCompanyId] = useState('');
  const [theme, setTheme] = useState<'auto' | 'light' | 'dark'>('auto');

  useEffect(() => {
    if (!session.access) { router.replace('/login'); return; }
    get<Me>('/api/v1/auth/me').then((m) => {
      setMe(m);
      const saved = session.company;
      const cid = m.companies.find((c) => c.id === saved)?.id ?? m.companies[0]?.id ?? '';
      if (cid) session.setCompany(cid);
      setCompanyId(cid);
    }).catch(() => router.replace('/login'));
    try { const th = localStorage.getItem('rc.theme') as typeof theme | null; if (th) setTheme(th); } catch { /* ignore */ }
  }, [router]);
  useEffect(() => {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('rc.theme', theme); } catch { /* ignore */ }
  }, [theme]);

  if (!me) return <div className="auth-page muted">{t('loading')}</div>;
  const perms = new Set(me.permissions);
  const can = (p: string) => perms.has(p);
  const logout = async () => { try { await post('/api/v1/auth/logout', { refreshToken: session.refresh }); } catch { /* ignore */ } session.clear(); router.replace('/login'); };

  return (
    <MeCtx.Provider value={{ me, companyId, can, branches: me.branches.filter((b) => b.company_id === companyId) }}>
      <div className="layout">
        <aside className="sidebar">
          <div className="brand"><div className="brand-mark">R</div><div>{t('appName')}<div className="muted" style={{ fontSize: 11.5, fontWeight: 400 }}>{me.tenant.name}</div></div></div>
          <nav className="nav" aria-label="main">
            {NAV.map((g) => {
              const items = g.items.filter((i) => !i.perm || can(i.perm));
              if (!items.length) return null;
              return (
                <div key={g.group || 'root'}>
                  {g.group ? <div className="nav-group">{t(g.group as never)}</div> : null}
                  {items.map((i) => <Link key={i.href} href={i.href} className={(i.href === '/' ? path === '/' : path.startsWith(i.href)) ? 'active' : undefined}>{t(i.label as never)}</Link>)}
                </div>
              );
            })}
          </nav>
        </aside>
        <div className="main">
          <header className="topbar">
            {me.companies.length > 1 ? (
              <select aria-label={t('company')} style={{ width: 'auto' }} value={companyId} onChange={(e) => { session.setCompany(e.target.value); setCompanyId(e.target.value); router.refresh(); location.reload(); }}>
                {me.companies.map((c) => <option key={c.id} value={c.id}>{locale === 'ar' ? c.legal_name_ar : c.legal_name_en ?? c.legal_name_ar}</option>)}
              </select>
            ) : <strong>{me.companies[0] ? (locale === 'ar' ? me.companies[0].legal_name_ar : me.companies[0].legal_name_en ?? me.companies[0].legal_name_ar) : ''}</strong>}
            {me.tenant.status === 'trial' ? <span className="badge warn">trial</span> : null}
            <div className="spacer" />
            <button className="btn sm" onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'auto' : 'dark')} title={t('theme')}>{theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐'}</button>
            <button className="btn sm" onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}>{t('language')}</button>
            <span className="muted">{me.user.full_name}</span>
            <button className="btn sm" onClick={logout}>{t('logout')}</button>
          </header>
          <main className="content">{children}</main>
        </div>
      </div>
    </MeCtx.Provider>
  );
}

export function BranchSelect({ value, onChange, allowAll = false }: { value: string; onChange: (v: string) => void; allowAll?: boolean }) {
  const { branches } = useMe();
  const { t, locale } = useI18n();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={t('branch')}>
      {allowAll ? <option value="">{t('all')}</option> : null}
      {branches.map((b) => <option key={b.id} value={b.id}>{b.code} — {locale === 'ar' ? b.name_ar : b.name_en ?? b.name_ar}</option>)}
    </select>
  );
}

'use client';
import { get, post } from '@/lib/api';
import { useI18n, money, dt } from '@/lib/i18n';
import { useAsync, useAction, ErrorBox, Ok, PageHead, Table, Kpi } from '@/components/ui';
import { useMe } from '@/components/shell';

export default function Subscription() {
  const { t, locale } = useI18n();
  const { can } = useMe();
  const s = useAsync(() => get('/api/v1/saas/subscription'), []);
  const plans = useAsync(() => get('/api/v1/saas/plans'), []);
  const a = useAction();
  const d = s.data;
  return (
    <>
      <PageHead title={t('subscription')} />
      <ErrorBox error={s.error ?? a.error} /><Ok msg={a.ok} />
      {d ? <div className="grid k4">
        <Kpi label={t('plan')} value={locale === 'ar' ? d.tenant.plan_name_ar : d.tenant.plan_name_en} hint={<>{d.tenant.status}{d.tenant.trial_ends_at ? ` → ${dt(d.tenant.trial_ends_at, locale)}` : ''}</>} />
        <Kpi label={t('branches')} value={`${d.usage.branches} / ${d.tenant.max_branches}`} />
        <Kpi label={t('terminal')} value={`${d.usage.terminals} / ${d.tenant.max_terminals}`} />
        <Kpi label={t('users')} value={`${d.usage.users} / ${d.tenant.max_users}`} />
        <Kpi label="SKUs" value={`${d.usage.skus.toLocaleString()} / ${Number(d.tenant.max_skus).toLocaleString()}`} />
      </div> : null}
      <h2 style={{ marginTop: 18 }}>{t('plan')}</h2>
      <Table rows={plans.data} rowKey={(p) => p.code} cols={[{ key: 'name', label: t('plan'), render: (p) => locale === 'ar' ? p.name_ar : p.name_en }, { key: 'max_branches', label: t('branches'), num: true }, { key: 'max_terminals', label: t('terminal'), num: true }, { key: 'max_skus', label: 'SKUs', num: true, render: (p) => Number(p.max_skus).toLocaleString() },
        { key: 'monthly_price_egp', label: 'EGP / month', num: true, render: (p) => Number(p.monthly_price_egp) ? money(p.monthly_price_egp, locale) : '—' },
        { key: 'x', label: '', render: (p) => can('saas.subscription.manage') && d?.tenant.plan_code !== p.code ? <button className="btn sm" disabled={a.busy} onClick={() => a.run(async () => { await post('/api/v1/saas/subscription/change-plan', { planCode: p.code }); await s.reload(); }, t('saved'))}>Switch</button> : d?.tenant.plan_code === p.code ? <span className="badge ok">✓</span> : null }]} />
    </>
  );
}

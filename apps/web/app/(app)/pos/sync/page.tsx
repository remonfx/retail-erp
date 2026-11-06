'use client';
import { get, post } from '@/lib/api';
import { useI18n, money, dt } from '@/lib/i18n';
import { useAsync, useAction, ErrorBox, Ok, PageHead, Table, State } from '@/components/ui';

export default function SyncMonitor() {
  const { t, locale } = useI18n();
  const s = useAsync(() => get('/api/v1/pos/sync-status'), []);
  const a = useAction();
  const resolve = (id: string) => a.run(async () => {
    const resolution = prompt('accepted_manually | duplicate | voided', 'accepted_manually'); if (!resolution) return;
    const note = prompt(t('notes')) ?? ''; await post(`/api/v1/pos/quarantine/${id}/resolve`, { resolution, note }); await s.reload();
  }, t('saved'));
  return (
    <>
      <PageHead title={t('syncMonitor')}><button className="btn" onClick={() => s.reload()}>↻</button></PageHead>
      <ErrorBox error={s.error ?? a.error} /><Ok msg={a.ok} />
      <Table rows={s.data?.devices} cols={[
        { key: 'branch_code', label: t('branch') }, { key: 'terminal_code', label: t('terminal') }, { key: 'name', label: t('devices') }, { key: 'status', label: t('status'), render: (r) => <State s={r.status} /> },
        { key: 'conn', label: '', render: (r) => r.seconds_since_seen !== null && r.seconds_since_seen < 900 ? <span className="badge ok">{t('online')}</span> : <span className="badge danger">{t('offline')}</span> },
        { key: 'last_seen_at', label: t('lastSeen'), render: (r) => dt(r.last_seen_at, locale) }, { key: 'queue', label: t('queue'), num: true, render: (r) => r.last_heartbeat?.queueDepth ?? '—' },
        { key: 'app_version', label: 'App' }, { key: 'quarantined', label: t('quarantine'), num: true },
      ]} />
      <h2 style={{ marginTop: 18 }}>{t('quarantine')}</h2>
      <Table rows={s.data?.quarantine} rowKey={(r) => r.client_id} cols={[{ key: 'received_at', label: t('date'), render: (r) => dt(r.received_at, locale) }, { key: 'item_type', label: t('type') }, { key: 'receipt_no', label: t('number') },
        { key: 'grand_total', label: t('total'), num: true, render: (r) => money(r.grand_total, locale) }, { key: 'error', label: t('error'), render: (r) => <span className="mono" style={{ fontSize: 11 }}>{r.error}</span> },
        { key: 'x', label: '', render: (r) => <button className="btn sm" onClick={() => resolve(r.client_id)}>{t('resolve')}</button> }]} />
    </>
  );
}

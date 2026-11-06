'use client';
import { use } from 'react';
import { get } from '@/lib/api';
import { useI18n, money, qty, dt } from '@/lib/i18n';
import { useAsync, ErrorBox, PageHead, Table, State } from '@/components/ui';
import { Go } from '@/components/links';

const TITLES: Record<string, string> = { stock_document: 'مستند مخزون', stock_count: 'جرد', pur_receipt: 'استلام بضاعة', pur_return: 'مرتجع مشتريات', pos_order: 'إيصال بيع' };

/** Any stock-movement source: header + moves + resulting journal entries, each linked further. */
export default function SourcePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, locale } = useI18n();
  const s = useAsync(() => get(`/api/v1/stock/sources/${id}`), [id]);
  const d = s.data;
  if (!d) return <ErrorBox error={s.error} />;
  const h = d.header ?? {};
  return <>
    <PageHead title={`${TITLES[d.type] ?? d.type} ${h.title ?? ''}`}>
      {h.state ? <State s={h.state} /> : null}
      {d.type === 'pos_order' ? <Go type="pos_order" id={id}><span className="btn">{t('openDoc')}</span></Go> : null}
      {h.order_id ? <Go type="purchase_order" id={h.order_id}><span className="btn">{t('purchaseOrders')} {h.order_number}</span></Go> : null}
      {h.supplier_id ? <Go type="supplier" id={h.supplier_id}><span className="btn">{h.supplier_name}</span></Go> : null}
      {d.journal.map((j: any) => <Go key={j.id} type="journal_entry" id={j.id}><span className="btn">قيد {j.number}</span></Go>)}
    </PageHead>
    <div className="card form-grid" style={{ marginBottom: 14 }}>
      {h.kind ? <div><h3>{t('type')}</h3>{h.kind}</div> : null}
      {h.created_at || h.received_at ? <div><h3>{t('date')}</h3>{dt(h.received_at ?? h.created_at, locale)}</div> : null}
      {h.reason ? <div><h3>{t('reason')}</h3>{h.reason}</div> : null}
      {h.notes ? <div><h3>{t('notes')}</h3>{h.notes}</div> : null}
      {h.total_value ? <div><h3>{t('value')}</h3>{money(h.total_value, locale)}</div> : null}
    </div>
    <Table rows={d.moves} cols={[
      { key: 'moved_at', label: t('date'), render: (r) => dt(r.moved_at, locale) },
      { key: 'sku', label: t('sku'), render: (r) => <Go type="product" id={r.product_id}><span className="mono">{r.sku}</span></Go> },
      { key: 'name_ar', label: t('nameAr'), render: (r) => <Go type="product" id={r.product_id}>{r.name_ar}</Go> },
      { key: 'move_type', label: t('type'), render: (r) => <>{r.move_type}{r.negative_exception ? <span className="badge danger">&lt;0</span> : null}</> },
      { key: 'from', label: t('fromLocation'), render: (r) => r.from_code }, { key: 'to', label: t('toLocation'), render: (r) => r.to_code },
      { key: 'qty', label: t('qty'), num: true, render: (r) => qty(r.qty_stock_uom, locale) },
      { key: 'unit_cost', label: t('cost'), num: true, render: (r) => money(r.unit_cost, locale) }, { key: 'value', label: t('value'), num: true, render: (r) => money(r.value, locale) },
      { key: 'user_name', label: t('users') },
    ]} />
  </>;
}

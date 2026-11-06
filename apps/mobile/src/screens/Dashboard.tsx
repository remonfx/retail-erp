import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { Btn, Card, ErrorText, T, money } from '../ui';
import type { Me } from '../App';

const iso = (d: Date) => d.toISOString().slice(0, 10);
export function Dashboard({ me }: { me: Me }) {
  const [range, setRange] = useState<'today' | 'month'>('today');
  const [d, setD] = useState<any>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const now = new Date();
    const from = range === 'today' ? iso(now) : iso(new Date(now.getFullYear(), now.getMonth(), 1));
    api('GET', `/api/v1/dashboard?from=${from}&to=${iso(now)}`).then(setD).catch((e) => setError(e.message));
  }, [range]);
  return <View style={{ gap: 12 }}>
    <T size={18} bold>أهلًا {me.user.full_name}</T>
    <View style={{ flexDirection: 'row-reverse', gap: 8 }}><Btn title="اليوم" kind={range === 'today' ? 'primary' : 'default'} onPress={() => setRange('today')} /><Btn title="الشهر" kind={range === 'month' ? 'primary' : 'default'} onPress={() => setRange('month')} /></View>
    <ErrorText error={error} />
    {d ? <>
      <View style={{ flexDirection: 'row-reverse', gap: 8 }}>
        <View style={{ flex: 1 }}><Card><T muted>صافي المبيعات</T><T size={20} bold>{money(d.kpi.net_sales)}</T></Card></View>
        <View style={{ flex: 1 }}><Card><T muted>مجمل الربح</T><T size={20} bold>{money(d.kpi.gross_profit)}</T><T muted>{d.kpi.gross_margin_pct}%</T></Card></View>
      </View>
      <View style={{ flexDirection: 'row-reverse', gap: 8 }}>
        <View style={{ flex: 1 }}><Card><T muted>الفواتير</T><T size={20} bold>{d.kpi.orders}</T></Card></View>
        <View style={{ flex: 1 }}><Card><T muted>متوسط السلة</T><T size={20} bold>{money(d.kpi.avg_basket)}</T></Card></View>
      </View>
      <Card><T bold>حسب الفرع</T>{d.byBranch.map((b: any) => <View key={b.branch_id} style={{ flexDirection: 'row-reverse', justifyContent: 'space-between' }}><T>{b.code} — {b.name_ar}</T><T>{money(b.net_sales)}</T></View>)}</Card>
      {d.finance ? <Card><T bold>المركز المالي</T><T>النقدية: {money(d.finance.cash_position)}</T><T>قيمة المخزون: {money(d.finance.inventory_value)}</T><T>مستحقات الموردين: {money(d.finance.payables)}</T></Card> : null}
    </> : null}
  </View>;
}

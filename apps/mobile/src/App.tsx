import { useEffect, useState } from 'react';
import { I18nManager, Pressable, SafeAreaView, ScrollView, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { api, logout } from './api';
import { useTheme } from './ui';
import { Login } from './screens/Login';
import { Dashboard } from './screens/Dashboard';
import { Lookup } from './screens/Lookup';
import { Approvals } from './screens/Approvals';
import { Stocktake } from './screens/Stocktake';
import { Attendance } from './screens/Attendance';

I18nManager.allowRTL(true);
export interface Me { user: { full_name: string }; companies: { id: string; legal_name_ar: string }[]; branches: { id: string; code: string; name_ar: string }[]; permissions: string[] }
type Tab = 'dashboard' | 'lookup' | 'approvals' | 'count' | 'attendance';
const TABS: { key: Tab; label: string; perm?: string }[] = [
  { key: 'dashboard', label: 'الأداء', perm: 'reporting.dashboard.read' }, { key: 'lookup', label: 'استعلام', perm: 'inventory.stock.read' },
  { key: 'approvals', label: 'موافقات' }, { key: 'count', label: 'جرد', perm: 'inventory.count.write' }, { key: 'attendance', label: 'حضور' },
];

export default function App() {
  const t = useTheme();
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);
  const [tab, setTab] = useState<Tab>('dashboard');
  const load = async () => { try { setMe(await api<Me>('GET', '/api/v1/auth/me')); } catch { setMe(null); } finally { setChecked(true); } };
  useEffect(() => { void load(); }, []);
  if (!checked) return null;
  if (!me) return <Login onDone={load} />;
  const tabs = TABS.filter((x) => !x.perm || me.permissions.includes(x.perm));
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <StatusBar style="auto" />
      <View style={{ flexDirection: 'row-reverse', padding: 12, alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: t.text, fontWeight: '700', fontSize: 17 }}>{me.companies[0]?.legal_name_ar}</Text>
        <Pressable onPress={async () => { await logout(); setMe(null); }}><Text style={{ color: t.muted }}>خروج</Text></Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
        {tab === 'dashboard' ? <Dashboard me={me} /> : tab === 'lookup' ? <Lookup /> : tab === 'approvals' ? <Approvals /> : tab === 'count' ? <Stocktake /> : <Attendance />}
      </ScrollView>
      <View style={{ flexDirection: 'row-reverse', borderTopWidth: 1, borderColor: t.border, backgroundColor: t.surface }}>
        {tabs.map((x) => <Pressable key={x.key} accessibilityRole="tab" onPress={() => setTab(x.key)} style={{ flex: 1, paddingVertical: 14, alignItems: 'center' }}>
          <Text style={{ color: tab === x.key ? t.primary : t.muted, fontWeight: tab === x.key ? '700' : '400' }}>{x.label}</Text></Pressable>)}
      </View>
    </SafeAreaView>
  );
}

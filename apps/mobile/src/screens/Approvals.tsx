import { useEffect, useState } from 'react';
import { Alert, View } from 'react-native';
import { api } from '../api';
import { Btn, Card, ErrorText, T, money } from '../ui';

export function Approvals() {
  const [rows, setRows] = useState<any[]>([]); const [error, setError] = useState<string | null>(null);
  const load = () => api('GET', '/api/v1/approvals?status=pending').then(setRows).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);
  const decide = async (id: string, decision: 'approve' | 'reject') => {
    try { await api('POST', `/api/v1/approvals/${id}/decide`, { decision }); await load(); } catch (e) { Alert.alert('خطأ', (e as Error).message); }
  };
  return <View style={{ gap: 10 }}>
    <ErrorText error={error} />
    {!rows.length ? <T muted>لا توجد طلبات معلقة</T> : null}
    {rows.map((r) => <Card key={r.id}>
      <T bold>{r.doc_type.replace(/_/g, ' ')}</T><T>{r.summary}</T>{r.amount ? <T>المبلغ: {money(r.amount)}</T> : null}<T muted>{r.requested_by_name} — {r.branch_code ?? ''}</T>
      {r.canDecide ? <View style={{ flexDirection: 'row-reverse', gap: 8, marginTop: 6 }}><Btn kind="primary" title="اعتماد" onPress={() => decide(r.id, 'approve')} /><Btn kind="danger" title="رفض" onPress={() => decide(r.id, 'reject')} /></View> : <T muted>بانتظار مستخدم آخر</T>}
    </Card>)}
  </View>;
}

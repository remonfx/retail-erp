import { useState } from 'react';
import { View } from 'react-native';
import * as Location from 'expo-location';
import { api } from '../api';
import { Btn, Card, ErrorText, T } from '../ui';

export function Attendance() {
  const [msg, setMsg] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  const act = async (action: 'in' | 'out') => {
    setError(null); setMsg(null);
    try {
      let coords: { lat?: number; lng?: number } = {};
      const p = await Location.requestForegroundPermissionsAsync();
      if (p.granted) { const l = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }); coords = { lat: l.coords.latitude, lng: l.coords.longitude }; }
      await api('POST', '/api/v1/attendance/check', { action, ...coords });
      setMsg(action === 'in' ? `تم تسجيل الحضور ${new Date().toLocaleTimeString('ar-EG')}` : `تم تسجيل الانصراف ${new Date().toLocaleTimeString('ar-EG')}`);
    } catch (e) { setError((e as Error).message); }
  };
  return <Card>
    <T size={17} bold>الحضور والانصراف</T>
    <View style={{ flexDirection: 'row-reverse', gap: 8, marginTop: 8 }}><Btn kind="primary" title="تسجيل حضور" onPress={() => act('in')} /><Btn title="تسجيل انصراف" onPress={() => act('out')} /></View>
    {msg ? <T>{msg}</T> : null}<ErrorText error={error} />
  </Card>;
}

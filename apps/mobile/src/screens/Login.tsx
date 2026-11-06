import { useState } from 'react';
import { SafeAreaView, View } from 'react-native';
import { api, ApiError, saveTokens, setCompany } from '../api';
import { Btn, Card, ErrorText, Input, T, useTheme } from '../ui';

export function Login({ onDone }: { onDone: () => void }) {
  const t = useTheme();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [totp, setTotp] = useState(''); const [mfa, setMfa] = useState(false);
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api('POST', '/api/v1/auth/login', { email: email.trim(), password, totp: mfa ? totp : undefined });
      await saveTokens(r.accessToken, r.refreshToken);
      const me = await api('GET', '/api/v1/auth/me');
      if (me.companies[0]) await setCompany(me.companies[0].id);
      onDone();
    } catch (e) { if (e instanceof ApiError && e.code === 'MFA_REQUIRED') setMfa(true); else setError((e as Error).message); } finally { setBusy(false); }
  };
  return <SafeAreaView style={{ flex: 1, backgroundColor: t.bg, justifyContent: 'center', padding: 20 }}>
    <Card>
      <T size={22} bold>ريتيل كور</T>
      <View style={{ gap: 10, marginTop: 8 }}>
        <Input placeholder="البريد الإلكتروني" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
        <Input placeholder="كلمة المرور" secureTextEntry value={password} onChangeText={setPassword} />
        {mfa ? <Input placeholder="رمز التحقق" keyboardType="number-pad" value={totp} onChangeText={setTotp} /> : null}
        <ErrorText error={error} />
        <Btn kind="primary" title="دخول" disabled={busy} onPress={go} />
      </View>
    </Card>
  </SafeAreaView>;
}

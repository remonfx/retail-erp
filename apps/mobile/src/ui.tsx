import { type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, useColorScheme, type TextInputProps } from 'react-native';

export function useTheme() {
  const dark = useColorScheme() === 'dark';
  return dark
    ? { bg: '#0f1419', surface: '#161c23', border: '#2a3440', text: '#e6ebf0', muted: '#94a1b2', primary: '#3bb59d', onPrimary: '#06231d', danger: '#ef6b62', ok: '#4cc98a' }
    : { bg: '#f6f7f9', surface: '#ffffff', border: '#e3e6eb', text: '#1b2330', muted: '#637083', primary: '#0f6b5c', onPrimary: '#ffffff', danger: '#c2372f', ok: '#19794a' };
}
export const money = (v: unknown) => new Intl.NumberFormat('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v ?? 0));

export function Card({ children }: { children: ReactNode }) { const t = useTheme(); return <View style={[s.card, { backgroundColor: t.surface, borderColor: t.border }]}>{children}</View>; }
export function T({ children, muted, size, bold }: { children: ReactNode; muted?: boolean; size?: number; bold?: boolean }) { const t = useTheme(); return <Text style={{ color: muted ? t.muted : t.text, fontSize: size ?? 15, fontWeight: bold ? '700' : '400', textAlign: 'right' }}>{children}</Text>; }
export function Btn({ title, onPress, kind = 'default', disabled }: { title: string; onPress: () => void; kind?: 'default' | 'primary' | 'danger'; disabled?: boolean }) {
  const t = useTheme();
  const bg = kind === 'primary' ? t.primary : t.surface;
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={({ pressed }) => [s.btn, { backgroundColor: bg, borderColor: kind === 'danger' ? t.danger : kind === 'primary' ? t.primary : t.border, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 }]}>
    <Text style={{ color: kind === 'primary' ? t.onPrimary : kind === 'danger' ? t.danger : t.text, fontWeight: '600' }}>{title}</Text></Pressable>;
}
export function Input(p: TextInputProps) { const t = useTheme(); return <TextInput placeholderTextColor={t.muted} {...p} style={[s.input, { color: t.text, borderColor: t.border, backgroundColor: t.surface }, p.style]} />; }
export function ErrorText({ error }: { error: string | null }) { const t = useTheme(); return error ? <Text style={{ color: t.danger, textAlign: 'right' }}>{error}</Text> : null; }

const s = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 6 },
  btn: { borderWidth: 1, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  input: { borderWidth: 1, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, fontSize: 16, textAlign: 'right' },
});

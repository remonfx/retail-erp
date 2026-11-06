import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { uuidv7 } from '@rc/domain';

// EXPO_PUBLIC_API_URL (set in eas.json or the shell) wins; app.json extra.apiUrl is the emulator default.
export const API_URL: string = process.env.EXPO_PUBLIC_API_URL ?? (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ?? 'http://localhost:4000';

export class ApiError extends Error { constructor(public status: number, public code: string, msg: string) { super(msg); } }

async function tokens() { return { access: await SecureStore.getItemAsync('rc.access'), refresh: await SecureStore.getItemAsync('rc.refresh'), company: await SecureStore.getItemAsync('rc.company') }; }
export async function saveTokens(access: string, refresh: string) { await SecureStore.setItemAsync('rc.access', access); await SecureStore.setItemAsync('rc.refresh', refresh); }
export async function setCompany(id: string) { await SecureStore.setItemAsync('rc.company', id); }
export async function logout() { for (const k of ['rc.access', 'rc.refresh']) await SecureStore.deleteItemAsync(k); }

async function refresh(): Promise<boolean> {
  const t = await tokens();
  if (!t.refresh) return false;
  const r = await fetch(`${API_URL}/api/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: t.refresh }) });
  if (!r.ok) return false;
  const b = await r.json();
  await saveTokens(b.accessToken, b.refreshToken);
  return true;
}

export async function api<T = any>(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  const go = async () => {
    const t = await tokens();
    return fetch(`${API_URL}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(t.access ? { authorization: `Bearer ${t.access}` } : {}), ...(t.company ? { 'x-company-id': t.company } : {}), ...(method !== 'GET' ? { 'idempotency-key': idempotencyKey ?? uuidv7() } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  let r = await go();
  if (r.status === 401 && (await refresh())) r = await go();
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new ApiError(r.status, data?.code ?? 'ERROR', data?.detail ?? r.statusText);
  return data as T;
}

/** Offline queue for count entries: persisted in AsyncStorage, flushed with stable idempotency keys. */
interface Queued { key: string; path: string; body: unknown; at: string }
const QKEY = 'rc.offlineQueue';
export async function enqueue(path: string, body: unknown) {
  const q: Queued[] = JSON.parse((await AsyncStorage.getItem(QKEY)) ?? '[]');
  q.push({ key: uuidv7(), path, body, at: new Date().toISOString() });
  await AsyncStorage.setItem(QKEY, JSON.stringify(q));
  return q.length;
}
export async function queueSize() { return (JSON.parse((await AsyncStorage.getItem(QKEY)) ?? '[]') as Queued[]).length; }
export async function flushQueue(): Promise<{ sent: number; left: number }> {
  const q: Queued[] = JSON.parse((await AsyncStorage.getItem(QKEY)) ?? '[]');
  let sent = 0;
  while (q.length) {
    const item = q[0]!;
    try { await api('POST', item.path, item.body, item.key); } catch (e) { if (e instanceof ApiError && e.status < 500 && e.status !== 401) { /* business rejection: drop but keep a record */ await AsyncStorage.setItem(`rc.rejected.${item.key}`, JSON.stringify({ ...item, error: (e as Error).message })); } else break; }
    q.shift(); sent++;
    await AsyncStorage.setItem(QKEY, JSON.stringify(q));
  }
  return { sent, left: q.length };
}

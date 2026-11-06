'use client';
/** Typed fetch client: bearer auth with automatic refresh-token rotation, company header, idempotency keys. */
import { uuidv7 } from '@rc/domain';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

const store = {
  get access() { return typeof window === 'undefined' ? null : localStorage.getItem('rc.access'); },
  get refresh() { return typeof window === 'undefined' ? null : localStorage.getItem('rc.refresh'); },
  get company() { return typeof window === 'undefined' ? null : localStorage.getItem('rc.company'); },
  set(access: string, refresh: string) { localStorage.setItem('rc.access', access); localStorage.setItem('rc.refresh', refresh); },
  setCompany(id: string) { localStorage.setItem('rc.company', id); },
  clear() { ['rc.access', 'rc.refresh'].forEach((k) => localStorage.removeItem(k)); },
};
export const session = store;

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  if (!store.refresh) return false;
  refreshing ??= (async () => {
    try {
      const r = await fetch(`${API_URL}/api/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: store.refresh }) });
      if (!r.ok) { store.clear(); return false; }
      const b = await r.json();
      store.set(b.accessToken, b.refreshToken);
      return true;
    } finally { setTimeout(() => { refreshing = null; }, 0); }
  })();
  return refreshing;
}

export async function api<T = any>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown, opts: { idempotencyKey?: string; raw?: boolean } = {}): Promise<T> {
  const doFetch = () => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (store.access) headers.authorization = `Bearer ${store.access}`;
    if (store.company) headers['x-company-id'] = store.company;
    if (method !== 'GET') headers['idempotency-key'] = opts.idempotencyKey ?? uuidv7();
    return fetch(`${API_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  let res = await doFetch();
  if (res.status === 401 && (await refresh())) res = await doFetch();
  if (res.status === 401 && typeof window !== 'undefined' && !path.includes('/auth/')) { store.clear(); window.location.href = '/login'; }
  if (opts.raw) return res as unknown as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.code ?? 'ERROR', data?.detail ?? res.statusText, data?.errors);
  return data as T;
}

export const get = <T = any>(path: string) => api<T>('GET', path);
export const post = <T = any>(path: string, body?: unknown, key?: string) => api<T>('POST', path, body ?? {}, { idempotencyKey: key });

export function qs(params: Record<string, string | number | boolean | null | undefined>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
}

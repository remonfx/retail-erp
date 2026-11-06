'use client';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const run = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await fn()); } catch (e) { setError(errText(e)); } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { void run(); }, [run]);
  return { data, error, loading, reload: run, setData };
}

export function errText(e: unknown) {
  if (e instanceof ApiError) return `${e.code}${e.message && e.message !== e.code ? ' — ' + e.message : ''}`;
  return (e as Error)?.message ?? String(e);
}

export function ErrorBox({ error }: { error: string | null }) { return error ? <div className="alert error" role="alert">{error}</div> : null; }
export function Ok({ msg }: { msg: string | null }) { return msg ? <div className="alert ok" role="status">{msg}</div> : null; }

export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="page-head"><h1>{title}</h1><div className="spacer" />{children}</div>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

export function Kpi({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return <div className="card kpi"><div className="label">{label}</div><div className="val">{value}</div>{hint ? <div className="muted" style={{ fontSize: 12 }}>{hint}</div> : null}</div>;
}

export interface Col<T> { key: string; label: string; render?: (row: T) => ReactNode; num?: boolean }
export function Table<T extends Record<string, any>>({ cols, rows, empty, footer, rowKey }: { cols: Col<T>[]; rows: T[] | null | undefined; empty?: string; footer?: ReactNode; rowKey?: (r: T, i: number) => string }) {
  const { t } = useI18n();
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{cols.map((c) => <th key={c.key} className={c.num ? 'num' : undefined}>{c.label}</th>)}</tr></thead>
        <tbody>
          {!rows ? <tr><td colSpan={cols.length} className="muted">{t('loading')}</td></tr>
            : rows.length === 0 ? <tr><td colSpan={cols.length} className="muted">{empty ?? t('noData')}</td></tr>
            : rows.map((r, i) => <tr key={rowKey ? rowKey(r, i) : (r.id ?? i)}>{cols.map((c) => <td key={c.key} className={c.num ? 'num' : undefined}>{c.render ? c.render(r) : (r[c.key] ?? '—')}</td>)}</tr>)}
        </tbody>
        {footer ? <tfoot>{footer}</tfoot> : null}
      </table>
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  return <div className="modal-bg" onClick={onClose}><div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}><div className="page-head"><h2 style={{ margin: 0 }}>{title}</h2><div className="spacer" /><button className="btn sm" onClick={onClose} aria-label="close">✕</button></div>{children}</div></div>;
}

const STATE_TONE: Record<string, string> = { done: 'ok', posted: 'ok', approved: 'ok', active: 'ok', matched: 'ok', received: 'ok', applied: 'ok', closed: 'info', open: 'info', draft: '', pending_approval: 'warn', pending: 'warn', in_transit: 'warn', partially_received: 'warn', exception: 'danger', quarantined: 'danger', cancelled: 'danger', rejected: 'danger', reversed: 'danger', revoked: 'danger', hard_locked: 'danger', soft_locked: 'warn', trial: 'warn', exception_approved: 'warn' };
export function State({ s }: { s: string | null | undefined }) { return s ? <span className={`badge ${STATE_TONE[s] ?? ''}`}>{s.replace(/_/g, ' ')}</span> : null; }

/** Run an async action with busy + error state for buttons. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(true); setError(null); setOk(null);
    try { const r = await fn(); if (okMsg) setOk(okMsg); return r; } catch (e) { setError(errText(e)); return undefined; } finally { setBusy(false); }
  };
  return { busy, error, ok, run, setError };
}

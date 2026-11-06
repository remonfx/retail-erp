'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { ar } from './messages-ar';
import { en } from './messages-en';

export type Locale = 'ar' | 'en';
type Dict = typeof ar;
const dicts: Record<Locale, Dict> = { ar, en };

const Ctx = createContext<{ locale: Locale; t: (k: keyof Dict, vars?: Record<string, string | number>) => string; setLocale: (l: Locale) => void; dir: 'rtl' | 'ltr' }>({
  locale: 'ar', t: (k) => String(k), setLocale: () => undefined, dir: 'rtl',
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('ar');
  useEffect(() => {
    const saved = (typeof window !== 'undefined' && localStorage.getItem('rc.locale')) as Locale | null;
    if (saved === 'ar' || saved === 'en') setLocaleState(saved);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }, [locale]);
  const setLocale = (l: Locale) => { setLocaleState(l); try { localStorage.setItem('rc.locale', l); } catch { /* ignore */ } };
  const t = (k: keyof Dict, vars?: Record<string, string | number>) => {
    let s: string = dicts[locale][k] ?? dicts.en[k] ?? String(k);
    if (vars) for (const [n, v] of Object.entries(vars)) s = s.replace(`{${n}}`, String(v));
    return s;
  };
  return <Ctx.Provider value={{ locale, t, setLocale, dir: locale === 'ar' ? 'rtl' : 'ltr' }}>{children}</Ctx.Provider>;
}
export const useI18n = () => useContext(Ctx);

export function money(v: string | number | null | undefined, locale: Locale = 'ar') {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}
export function qty(v: string | number | null | undefined, locale: Locale = 'ar') {
  if (v === null || v === undefined || v === '') return '—';
  return new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-EG', { maximumFractionDigits: 3 }).format(Number(v));
}
export function dt(v: string | null | undefined, locale: Locale = 'ar') {
  if (!v) return '—';
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', { dateStyle: 'medium', timeStyle: v.length > 10 ? 'short' : undefined, timeZone: 'Africa/Cairo' }).format(new Date(v));
}

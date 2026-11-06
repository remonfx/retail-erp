'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { get } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { hrefFor } from './links';

const LABEL: Record<string, string> = { product: 'منتج', purchase_order: 'أمر شراء', supplier_invoice: 'فاتورة مورد', stock_document: 'مستند مخزون', journal_entry: 'قيد', pos_session: 'وردية', pos_order: 'إيصال', supplier: 'مورد' };
const PAGES: { href: string; ar: string; en: string }[] = [
  { href: '/', ar: 'لوحة التحكم', en: 'Dashboard' }, { href: '/products', ar: 'المنتجات', en: 'Products' }, { href: '/products/new', ar: 'منتج جديد', en: 'New product' },
  { href: '/inventory/stock', ar: 'أرصدة المخزون', en: 'Stock' }, { href: '/inventory/adjustments', ar: 'التسويات', en: 'Adjustments' }, { href: '/inventory/transfers', ar: 'التحويلات', en: 'Transfers' },
  { href: '/purchasing/orders', ar: 'أوامر الشراء', en: 'Purchase orders' }, { href: '/purchasing/invoices', ar: 'فواتير الموردين', en: 'Supplier invoices' }, { href: '/purchasing/suppliers', ar: 'الموردون', en: 'Suppliers' },
  { href: '/reports/sales', ar: 'تحليل المبيعات', en: 'Sales analysis' }, { href: '/pos/sessions', ar: 'الورديات', en: 'Sessions' }, { href: '/pos/sync', ar: 'مراقبة المزامنة', en: 'Sync monitor' },
  { href: '/accounting/journals', ar: 'القيود', en: 'Journals' }, { href: '/accounting/reports', ar: 'التقارير المالية', en: 'Financial reports' }, { href: '/approvals', ar: 'الموافقات', en: 'Approvals' },
  { href: '/settings/users', ar: 'المستخدمون', en: 'Users' }, { href: '/settings/branches', ar: 'الفروع', en: 'Branches' }, { href: '/settings/devices', ar: 'الأجهزة', en: 'Devices' },
];

/** Ctrl+K / ⌘K: jump to any page, product or document number. */
export function CommandPalette() {
  const { locale } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ type: string; id: string; title: string; subtitle?: string }[]>([]);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(true); } if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);
  useEffect(() => { if (open) setTimeout(() => input.current?.focus(), 0); else { setQ(''); setRes([]); } }, [open]);
  useEffect(() => {
    if (q.trim().length < 2) { setRes([]); return; }
    const h = setTimeout(async () => { try { setRes(await get(`/api/v1/search?q=${encodeURIComponent(q.trim())}`)); setSel(0); } catch { setRes([]); } }, 180);
    return () => clearTimeout(h);
  }, [q]);
  const pages = PAGES.filter((p) => q && (p.ar.includes(q) || p.en.toLowerCase().includes(q.toLowerCase()))).map((p) => ({ href: p.href, title: locale === 'ar' ? p.ar : p.en, kind: locale === 'ar' ? 'صفحة' : 'Page' }));
  const items = [...pages, ...res.map((r) => ({ href: hrefFor(r.type, r.id) ?? '#', title: `${r.title}${r.subtitle ? ' — ' + r.subtitle : ''}`, kind: LABEL[r.type] ?? r.type }))];
  const go = (href: string) => { setOpen(false); router.push(href); };
  return <>
    <button className="btn sm" onClick={() => setOpen(true)} title="Ctrl+K">🔍 {locale === 'ar' ? 'بحث' : 'Search'} <kbd>Ctrl K</kbd></button>
    {open ? <div className="modal-bg" onClick={() => setOpen(false)}>
      <div className="modal palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="search">
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={locale === 'ar' ? 'ابحث عن صفحة، منتج، باركود، رقم أمر شراء، إيصال، قيد…' : 'Search pages, products, barcodes, PO, receipts, entries…'}
          onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); } if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); } if (e.key === 'Enter' && items[sel]) go(items[sel]!.href); }} />
        <div className="palette-list">
          {items.map((it, i) => <button key={i} className={`palette-item ${i === sel ? 'active' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => go(it.href)}><span>{it.title}</span><span className="badge">{it.kind}</span></button>)}
          {q.length >= 2 && !items.length ? <div className="muted" style={{ padding: 12 }}>{locale === 'ar' ? 'لا نتائج' : 'No results'}</div> : null}
        </div>
      </div>
    </div> : null}
  </>;
}

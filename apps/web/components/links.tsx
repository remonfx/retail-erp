'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';

/** Single source of truth for "where does this record live" — every clickable value uses it. */
export type DocType =
  | 'product' | 'purchase_order' | 'supplier_invoice' | 'supplier' | 'journal_entry' | 'pos_session' | 'pos_order'
  | 'stock_document' | 'stock_count' | 'pur_receipt' | 'pur_return' | 'stock_source' | 'account' | 'payment' | 'expense' | 'promotion' | 'manual' | 'reversal' | 'opening' | 'payroll';

export function hrefFor(type: string | null | undefined, id: string | null | undefined, extra?: Record<string, string>): string | null {
  if (!type || !id) return null;
  const q = extra ? '?' + new URLSearchParams(extra).toString() : '';
  switch (type) {
    case 'product': return `/products/${id}`;
    case 'purchase_order': return `/purchasing/orders/${id}`;
    case 'supplier_invoice': return `/purchasing/invoices/${id}`;
    case 'supplier': return `/purchasing/suppliers/${id}`;
    case 'journal_entry': case 'manual': case 'reversal': case 'opening': return `/accounting/journals/${id}`;
    case 'pos_session': return `/pos/sessions/${id}`;
    case 'pos_order': return `/pos/orders/${id}`;
    case 'stock_document': case 'stock_count': case 'pur_receipt': case 'pur_return': case 'stock_source': return `/inventory/sources/${id}`;
    case 'account': return `/accounting/ledger/${id}${q}`;
    default: return null;
  }
}

/** Journal entries point to their originating document via (source_type, source_id). */
export function sourceHref(sourceType: string | null | undefined, sourceId: string | null | undefined) {
  const map: Record<string, string> = { pos_session: 'pos_session', supplier_invoice: 'supplier_invoice', stock_document: 'stock_source', stock_count: 'stock_source', pur_receipt: 'stock_source', purchase_return: 'stock_source', reversal: 'journal_entry' };
  return hrefFor(map[sourceType ?? ''] ?? null, sourceId);
}

export function Go({ type, id, children, extra, className }: { type: string | null | undefined; id: string | null | undefined; children: ReactNode; extra?: Record<string, string>; className?: string }) {
  const href = hrefFor(type, id, extra);
  if (!href) return <>{children}</>;
  return <Link href={href} className={`go ${className ?? ''}`} onClick={(e) => e.stopPropagation()}>{children}</Link>;
}

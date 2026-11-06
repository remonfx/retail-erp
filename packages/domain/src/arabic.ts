/**
 * Arabic search normalization. MUST stay identical to SQL function rc_norm_ar() (db/migrations).
 * - alef variants (أ إ آ ٱ) → ا ; ى → ي ; ة → ه ; ؤ → و ; ئ → ي
 * - remove tatweel (ـ) and harakat (U+064B..U+0652)
 * - Arabic-Indic digits → ASCII digits
 * - lowercase, collapse whitespace
 */
const MAP: Record<string, string> = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ى': 'ي', 'ة': 'ه', 'ؤ': 'و', 'ئ': 'ي' };

export function normalizeArabic(input: string | null | undefined): string {
  if (!input) return '';
  let s = '';
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (ch === 'ـ' || (code >= 0x064b && code <= 0x0652)) continue;
    if (code >= 0x0660 && code <= 0x0669) { s += String(code - 0x0660); continue; }
    if (code >= 0x06f0 && code <= 0x06f9) { s += String(code - 0x06f0); continue; }
    s += MAP[ch] ?? ch;
  }
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Normalize an Egyptian mobile number to E.164-like digits (2010xxxxxxxx). Returns null if invalid. */
export function normalizeEgyptPhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = normalizeArabic(input).replace(/\D/g, '');
  let d = digits;
  if (d.startsWith('0020')) d = d.slice(4);
  else if (d.startsWith('20') && d.length === 12) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  if (!/^1[0125]\d{8}$/.test(d)) return null;
  return '20' + d;
}

/** Trigram similarity (same definition as pg_trgm) for client-side duplicate hints. */
export function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const word of normalizeArabic(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    const w = `  ${word} `;
    for (let i = 0; i < w.length - 2; i++) out.add(w.slice(i, i + 3));
  }
  return out;
}

export function similarity(a: string, b: string): number {
  const A = trigrams(a), B = trigrams(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

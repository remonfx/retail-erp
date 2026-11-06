import { Decimal } from 'decimal.js';

/** Isolated Decimal constructor: 40 significant digits, banker-safe ROUND_HALF_UP. Never use JS number for money. */
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof D>;
export type DecInput = string | number | Dec;

export const ZERO = new D(0);

export function dec(v: DecInput | null | undefined): Dec {
  if (v === null || v === undefined || v === '') return ZERO;
  return v instanceof D ? v : new D(v);
}

/** Round to currency minor units (EGP = 2). */
export function roundMoney(v: DecInput, decimals = 2): Dec {
  return dec(v).toDecimalPlaces(decimals, D.ROUND_HALF_UP);
}

/** Round to a cash increment, e.g. 0.25 or 0.5 EGP. */
export function roundToIncrement(v: DecInput, increment: DecInput): Dec {
  const inc = dec(increment);
  if (inc.lte(0)) return dec(v);
  return dec(v).div(inc).toDecimalPlaces(0, D.ROUND_HALF_UP).mul(inc);
}

export function sum(values: DecInput[]): Dec {
  return values.reduce<Dec>((acc, v) => acc.add(dec(v)), ZERO);
}

/** Serialize for DB/API: fixed decimals as string. */
export function fmt(v: DecInput, decimals = 4): string {
  return dec(v).toFixed(decimals);
}

/**
 * Allocate `total` across `weights` proportionally, rounding each share to `decimals`
 * and assigning the rounding remainder to the largest weight so Σ shares == total exactly.
 */
export function allocate(total: DecInput, weights: DecInput[], decimals = 2): Dec[] {
  const t = dec(total);
  const w = weights.map(dec);
  const wSum = sum(w);
  if (w.length === 0) return [];
  if (wSum.isZero()) {
    const out = w.map(() => ZERO);
    out[0] = t;
    return out;
  }
  const shares = w.map((x) => t.mul(x).div(wSum).toDecimalPlaces(decimals, D.ROUND_HALF_UP));
  const diff = t.sub(sum(shares));
  if (!diff.isZero()) {
    let maxIdx = 0;
    w.forEach((x, i) => { if (x.gt(w[maxIdx]!)) maxIdx = i; });
    shares[maxIdx] = shares[maxIdx]!.add(diff);
  }
  return shares;
}

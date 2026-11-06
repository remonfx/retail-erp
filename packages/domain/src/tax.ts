import { dec, roundMoney, ZERO, type Dec, type DecInput } from './money.js';

export interface TaxRate {
  id: string;
  code: string;          // e.g. VAT14, VAT0, EXEMPT, TABLE5
  rate: DecInput;        // percent, e.g. "14"
  kind: 'vat' | 'table' | 'exempt' | 'zero';
  /** Table tax is included in VAT base in Egypt; modeled as compounding order. */
  sequence?: number;
}

export interface TaxLineResult { taxRateId: string; code: string; base: Dec; amount: Dec }
export interface TaxComputation { net: Dec; tax: Dec; gross: Dec; lines: TaxLineResult[] }

/**
 * Compute taxes on a line amount (already discounted).
 * - priceIncludesTax=true: amount is gross; back-calculate net.
 * - Multiple rates are applied in `sequence` order and compound (each later base includes earlier taxes),
 *   which models Egyptian table tax → VAT. Exact legal treatment must be configured per ETA rules.
 * Rounding: per tax line to `decimals`.
 */
export function computeTax(amount: DecInput, rates: TaxRate[], priceIncludesTax: boolean, decimals = 2): TaxComputation {
  const ordered = [...rates].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const factors = ordered.map((r) => dec(r.rate).div(100));
  const amt = dec(amount);
  if (ordered.length === 0) return { net: roundMoney(amt, decimals), tax: ZERO, gross: roundMoney(amt, decimals), lines: [] };

  let net: Dec;
  if (priceIncludesTax) {
    const multiplier = factors.reduce<Dec>((m, f) => m.mul(dec(1).add(f)), dec(1));
    const gross = roundMoney(amt, decimals);
    net = roundMoney(gross.div(multiplier), decimals);
    // compute line taxes forward, then force Σ = gross - net (assign rounding residue to last tax line)
    const lines = forward(net, ordered, factors, decimals);
    const totalTax = gross.sub(net);
    const computed = lines.reduce<Dec>((s, l) => s.add(l.amount), ZERO);
    const residue = totalTax.sub(computed);
    if (!residue.isZero() && lines.length) {
      const last = lines[lines.length - 1]!;
      last.amount = last.amount.add(residue);
    }
    return { net, tax: totalTax, gross, lines };
  }
  net = roundMoney(amt, decimals);
  const lines = forward(net, ordered, factors, decimals);
  const tax = lines.reduce<Dec>((s, l) => s.add(l.amount), ZERO);
  return { net, tax, gross: net.add(tax), lines };
}

function forward(net: Dec, rates: TaxRate[], factors: Dec[], decimals: number): TaxLineResult[] {
  let base = net;
  return rates.map((r, i) => {
    const amount = roundMoney(base.mul(factors[i]!), decimals);
    const line = { taxRateId: r.id, code: r.code, base, amount };
    base = base.add(amount);
    return line;
  });
}

import { dec, type Dec, type DecInput } from './money.js';

export type PriceScope = 'branch' | 'branch_group' | 'company';

export interface PriceCandidate {
  priceListItemId: string;
  priceListId: string;
  scope: PriceScope;
  priority: number;          // lower wins within same scope
  variantId: string;
  uomId: string;
  price: DecInput;
  minQty: DecInput;
  validFrom: string;         // ISO
  validTo: string | null;
}

const SCOPE_RANK: Record<PriceScope, number> = { branch: 0, branch_group: 1, company: 2 };

/**
 * Price resolution (documented rule, REQUIREMENTS FR-PRC-02):
 * 1. Filter candidates valid at `at` for the variant & UoM, with minQty ≤ qty.
 * 2. Most specific scope wins (branch → branch_group → company).
 * 3. Within scope: lower priority number wins, then highest minQty (tier), then latest validFrom.
 */
export function resolvePrice(cands: PriceCandidate[], variantId: string, uomId: string, qty: DecInput, at: Date): (PriceCandidate & { unitPrice: Dec }) | null {
  const q = dec(qty);
  const t = at.getTime();
  const valid = cands.filter((c) =>
    c.variantId === variantId && c.uomId === uomId &&
    dec(c.minQty).lte(q.abs()) &&
    Date.parse(c.validFrom) <= t && (c.validTo === null || Date.parse(c.validTo) > t));
  if (!valid.length) return null;
  valid.sort((a, b) =>
    SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] ||
    a.priority - b.priority ||
    dec(b.minQty).cmp(dec(a.minQty)) ||
    Date.parse(b.validFrom) - Date.parse(a.validFrom));
  const best = valid[0]!;
  return { ...best, unitPrice: dec(best.price) };
}

import { dec, D, ZERO, type Dec, type DecInput } from './money.js';

/** Weighted-average perpetual state for (company, variant). value is authoritative; avg = value/qty. */
export interface AvgState { qty: Dec; value: Dec; lastAvg: Dec }

export function avgOf(s: AvgState): Dec {
  return s.qty.gt(0) ? s.value.div(s.qty) : s.lastAvg;
}

export function avgReceive(s: AvgState, qtyIn: DecInput, unitCost: DecInput): { state: AvgState; value: Dec; inventoryValue: Dec; cogsAdjustment: Dec } {
  const q = dec(qtyIn), c = dec(unitCost);
  const value = q.mul(c).toDecimalPlaces(4);
  if (s.qty.lt(0)) {
    // Receiving into negative stock: the negative units were issued at lastAvg; they are re-costed at c.
    // Inventory debit = value - cogsAdjustment ; COGS debit = cogsAdjustment (may be negative = credit).
    const covered = D.min(q, s.qty.neg());
    const cogsAdjustment = covered.mul(c.sub(s.lastAvg)).toDecimalPlaces(4);
    const newQty = s.qty.add(q);
    const state: AvgState = newQty.gt(0)
      ? { qty: newQty, value: newQty.mul(c).toDecimalPlaces(4), lastAvg: c }
      : { qty: newQty, value: newQty.mul(s.lastAvg).toDecimalPlaces(4), lastAvg: s.lastAvg };
    // keep the invariant exact: inventoryValue == state.value - s.value
    const inventoryValue = state.value.sub(s.value);
    return { state, value, inventoryValue, cogsAdjustment: value.sub(inventoryValue) };
  }
  const newQty = s.qty.add(q);
  const newValue = s.value.add(value);
  return { state: { qty: newQty, value: newValue, lastAvg: newQty.gt(0) ? newValue.div(newQty) : c }, value, inventoryValue: value, cogsAdjustment: ZERO };
}

/** Issue at average. Issuing the full quantity releases the exact remaining value (no drift). */
export function avgIssue(s: AvgState, qtyOut: DecInput): { state: AvgState; value: Dec; unitCost: Dec } {
  const q = dec(qtyOut);
  const avg = avgOf(s);
  let value: Dec;
  if (s.qty.gt(0) && q.eq(s.qty)) value = s.value;
  else if (s.qty.gt(0) && q.lt(s.qty)) value = s.value.mul(q).div(s.qty).toDecimalPlaces(4);
  else {
    // issue beyond available: value what exists exactly, the rest at last known avg
    const avail = D.max(s.qty, ZERO);
    value = (avail.gt(0) ? s.value : ZERO).add(q.sub(avail).mul(avg)).toDecimalPlaces(4);
  }
  const newQty = s.qty.sub(q);
  const newValue = newQty.gt(0) ? s.value.sub(value) : newQty.mul(avg).toDecimalPlaces(4);
  return { state: { qty: newQty, value: newValue, lastAvg: avg }, value, unitCost: q.gt(0) ? value.div(q) : avg };
}

export interface FifoLayer { id: string; remainingQty: Dec; remainingValue: Dec }

/** Consume FIFO layers oldest-first. Returns consumption per layer; shortfall valued at `fallbackUnitCost`. */
export function fifoConsume(layers: FifoLayer[], qtyOut: DecInput, fallbackUnitCost: DecInput = 0) {
  let need = dec(qtyOut);
  const consumed: { layerId: string; qty: Dec; value: Dec }[] = [];
  for (const l of layers) {
    if (need.lte(0)) break;
    if (l.remainingQty.lte(0)) continue;
    const take = D.min(need, l.remainingQty);
    const value = take.eq(l.remainingQty) ? l.remainingValue : l.remainingValue.mul(take).div(l.remainingQty).toDecimalPlaces(4);
    consumed.push({ layerId: l.id, qty: take, value });
    need = need.sub(take);
  }
  const shortfallQty = need;
  const shortfallValue = need.mul(dec(fallbackUnitCost)).toDecimalPlaces(4);
  const total = consumed.reduce<Dec>((s, c) => s.add(c.value), ZERO).add(shortfallValue);
  return { consumed, shortfallQty, shortfallValue, value: total };
}

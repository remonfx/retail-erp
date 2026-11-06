import { dec, type Dec, type DecInput } from './money.js';

export interface Uom { id: string; categoryId: string; /** factor relative to category reference unit (reference = 1) */ factor: DecInput; rounding: DecInput }

/** Convert qty from one UoM to another of the same category. Throws on category mismatch. */
export function convertQty(qty: DecInput, from: Uom, to: Uom): Dec {
  if (from.categoryId !== to.categoryId) throw new Error('UOM_CATEGORY_MISMATCH');
  if (from.id === to.id) return dec(qty);
  return dec(qty).mul(dec(from.factor)).div(dec(to.factor)).toDecimalPlaces(6);
}

/** Convert a unit price expressed per `from` into price per `to`. */
export function convertPrice(price: DecInput, from: Uom, to: Uom): Dec {
  if (from.categoryId !== to.categoryId) throw new Error('UOM_CATEGORY_MISMATCH');
  return dec(price).mul(dec(to.factor)).div(dec(from.factor)).toDecimalPlaces(6);
}

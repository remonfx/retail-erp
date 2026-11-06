import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  dec, allocate, sum, roundMoney, normalizeArabic, normalizeEgyptPhone, similarity, uuidv7, uuidv7Timestamp, UUID_RE,
  isValidGtin, makeEan13, parseEmbeddedBarcode, computeTax, resolvePrice, computeCart, settleTenders,
  avgReceive, avgIssue, fifoConsume, ZERO, ROLE_TEMPLATES, sodViolations, posTransactionSchema, stableStringify, convertQty,
  type Promotion, type TaxRate, type AvgState,
} from '../src/index.js';

const VAT14: TaxRate = { id: 't14', code: 'VAT14', rate: '14', kind: 'vat' };
const ctx = { at: new Date('2026-11-06T10:00:00Z'), localTime: '12:00', couponCodes: [], customerGroupIds: [] };

describe('money', () => {
  it('allocate preserves total exactly', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 10_000_000 }), fc.array(fc.integer({ min: 0, max: 100000 }), { minLength: 1, maxLength: 20 }), (cents, ws) => {
      const total = dec(cents).div(100);
      expect(sum(allocate(total, ws)).eq(total)).toBe(true);
    }));
  });
  it('rounds half up', () => { expect(roundMoney('2.345').toFixed(2)).toBe('2.35'); expect(roundMoney('2.344').toFixed(2)).toBe('2.34'); });
});

describe('arabic', () => {
  it('normalizes alef/ya/ta marbuta/harakat/digits', () => {
    expect(normalizeArabic('أحمد إبراهيم آمنة')).toBe('احمد ابراهيم امنه');
    expect(normalizeArabic('مُصْطَفَى ـــ ٢٠٢٦')).toBe('مصطفي 2026');
  });
  it('similar product names score high', () => {
    expect(similarity('زيت عباد الشمس كريستال ١ لتر', 'زيت عباد شمس كريستال 1 لتر')).toBeGreaterThan(0.6);
    expect(similarity('شامبو', 'مكرونة')).toBeLessThan(0.2);
  });
  it('egypt phone', () => {
    expect(normalizeEgyptPhone('٠١٠٠١٢٣٤٥٦٧')).toBe('201001234567');
    expect(normalizeEgyptPhone('+20 100 123 4567')).toBe('201001234567');
    expect(normalizeEgyptPhone('0123')).toBeNull();
  });
});

describe('ids', () => {
  it('uuidv7 valid, ordered, timestamped', () => {
    const ids = Array.from({ length: 1000 }, () => uuidv7());
    ids.forEach((i) => expect(i).toMatch(UUID_RE));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(1000);
    expect(Math.abs(uuidv7Timestamp(ids[0]!) - Date.now())).toBeLessThan(5000);
  });
});

describe('barcode', () => {
  it('validates GTIN', () => {
    expect(isValidGtin('6221007012345'.slice(0, 12) + '0')).toBe(isValidGtin(makeEan13('622100701234')) && makeEan13('622100701234').endsWith('0'));
    expect(isValidGtin(makeEan13('622100701234'))).toBe(true);
    expect(isValidGtin('6221007012340'.replace(/0$/, '9'))).toBe(false);
  });
  it('parses weighted barcode', () => {
    const code = makeEan13('211234501234');
    const r = parseEmbeddedBarcode(code, [{ prefix: '21', itemCodeLength: 5, valueLength: 5, valueType: 'weight', valueDecimals: 3 }]);
    expect(r?.itemCode).toBe('12345');
    expect(r?.value.toString()).toBe('1.234');
  });
});

describe('tax', () => {
  it('inclusive 14%: 114.00 → net 100, tax 14', () => {
    const t = computeTax('114', [VAT14], true);
    expect(t.net.toFixed(2)).toBe('100.00'); expect(t.tax.toFixed(2)).toBe('14.00'); expect(t.gross.toFixed(2)).toBe('114.00');
  });
  it('inclusive: net + tax == gross always', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 10_000_000 }), (cents) => {
      const g = dec(cents).div(100);
      const t = computeTax(g, [VAT14, { id: 'tt', code: 'TABLE5', rate: '5', kind: 'table', sequence: -1 }], true);
      expect(t.net.add(t.tax).eq(t.gross)).toBe(true);
      expect(sum(t.lines.map((l) => l.amount)).eq(t.tax)).toBe(true);
    }));
  });
  it('exclusive', () => { const t = computeTax('100', [VAT14], false); expect(t.gross.toFixed(2)).toBe('114.00'); });
});

describe('pricing', () => {
  const base = { variantId: 'v1', uomId: 'u1', validTo: null, priority: 0 };
  it('branch beats company; tier by minQty; validity respected', () => {
    const cands = [
      { ...base, priceListItemId: 'c', priceListId: 'L1', scope: 'company' as const, price: '10', minQty: '1', validFrom: '2026-01-01T00:00:00Z' },
      { ...base, priceListItemId: 'b', priceListId: 'L2', scope: 'branch' as const, price: '9', minQty: '1', validFrom: '2026-01-01T00:00:00Z' },
      { ...base, priceListItemId: 'b12', priceListId: 'L2', scope: 'branch' as const, price: '8', minQty: '12', validFrom: '2026-01-01T00:00:00Z' },
      { ...base, priceListItemId: 'future', priceListId: 'L2', scope: 'branch' as const, price: '1', minQty: '1', validFrom: '2027-01-01T00:00:00Z' },
    ];
    expect(resolvePrice(cands, 'v1', 'u1', 1, ctx.at)?.priceListItemId).toBe('b');
    expect(resolvePrice(cands, 'v1', 'u1', 12, ctx.at)?.priceListItemId).toBe('b12');
    expect(resolvePrice(cands, 'v2', 'u1', 1, ctx.at)).toBeNull();
  });
});

const promo = (p: Partial<Promotion> & Pick<Promotion, 'rule' | 'targets'>): Promotion => ({
  id: p.id ?? 'p' + Math.random(), code: p.code ?? 'P', nameAr: 'عرض', priority: p.priority ?? 10, exclusive: p.exclusive ?? false, stackable: p.stackable ?? false,
  validFrom: '2026-01-01T00:00:00Z', validTo: null, ...p,
});
const line = (id: string, qty: string, price: string, extra: object = {}) => ({ lineId: id, variantId: 'v' + id, qty, unitPrice: price, priceIncludesTax: true, taxRates: [VAT14], categoryPath: ['cat'], ...extra });

describe('cart & promotions', () => {
  it('percent off + VAT inclusive totals consistent', () => {
    const r = computeCart({ lines: [line('1', '2', '57')], promotions: [promo({ targets: { all: true }, rule: { type: 'percent_off', percent: 10 } })], context: ctx });
    expect(r.subtotal.toFixed(2)).toBe('114.00');
    expect(r.discountTotal.toFixed(2)).toBe('11.40');
    expect(r.grandTotal.toFixed(2)).toBe('102.60');
    expect(r.netTotal.add(r.taxTotal).eq(r.grandTotal)).toBe(true);
  });
  it('buy 2 get 1 free gives cheapest free', () => {
    const r = computeCart({ lines: [line('a', '2', '30'), line('b', '1', '20')], promotions: [promo({ targets: { categoryIds: ['cat'] }, rule: { type: 'buy_x_get_y', buyQty: 2, getQty: 1, getPercent: 100 } })], context: ctx });
    expect(r.discountTotal.toFixed(2)).toBe('20.00');
    expect(r.grandTotal.toFixed(2)).toBe('60.00');
  });
  it('bundle 3 for 50', () => {
    const r = computeCart({ lines: [line('a', '3', '20')], promotions: [promo({ targets: { all: true }, rule: { type: 'bundle_price', qty: 3, price: 50 } })], context: ctx });
    expect(r.grandTotal.toFixed(2)).toBe('50.00');
  });
  it('exclusive promotion blocks later ones, basket threshold applies after', () => {
    const r = computeCart({
      lines: [line('a', '1', '1000')],
      promotions: [
        promo({ id: 'x', priority: 1, exclusive: true, targets: { all: true }, rule: { type: 'percent_off', percent: 10 } }),
        promo({ id: 'y', priority: 2, targets: { all: true }, rule: { type: 'percent_off', percent: 50 }, stackable: true }),
        promo({ id: 'z', priority: 3, targets: { all: true }, rule: { type: 'basket_threshold', threshold: 500, amount: 100 } }),
      ], context: ctx,
    });
    expect(r.promotions.map((p) => p.promotionId)).toEqual(['x', 'z']);
    expect(r.grandTotal.toFixed(2)).toBe('800.00');
  });
  it('coupon & time window', () => {
    const p = promo({ couponCode: 'RAMADAN', targets: { all: true }, rule: { type: 'percent_off', percent: 20 }, timeFrom: '22:00', timeTo: '02:00' });
    expect(computeCart({ lines: [line('a', '1', '100')], promotions: [p], context: ctx }).discountTotal.toFixed(2)).toBe('0.00');
    expect(computeCart({ lines: [line('a', '1', '100')], promotions: [p], context: { ...ctx, localTime: '23:30', couponCodes: ['ramadan'] } }).discountTotal.toFixed(2)).toBe('20.00');
  });
  it('discount never exceeds line; limits reported', () => {
    const r = computeCart({ lines: [line('a', '1', '10', { manualDiscountAmount: '50' })], context: ctx, limits: { maxLineDiscountPercent: 10, maxBasketDiscountPercent: 5 } });
    expect(r.grandTotal.toFixed(2)).toBe('0.00');
    expect(r.violations[0]?.code).toBe('LINE_DISCOUNT_LIMIT');
  });
  it('property: totals always reconcile', () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 100000 }), fc.integer({ min: 0, max: 100 })), { minLength: 1, maxLength: 15 }), fc.integer({ min: 0, max: 30 }), (ls, basketPct) => {
      const r = computeCart({ lines: ls.map(([q, c, d], i) => line(String(i), String(q), dec(c).div(100).toFixed(2), { manualDiscountPercent: String(d) })), context: ctx, basketManualDiscountPercent: String(basketPct) });
      expect(r.netTotal.add(r.taxTotal).eq(r.grandTotal)).toBe(true);
      expect(r.subtotal.sub(r.discountTotal).eq(r.grandTotal)).toBe(true);
      r.lines.forEach((l) => expect(l.total.gte(0)).toBe(true));
    }));
  });
  it('tenders: change, rounding, overpay rules', () => {
    expect(settleTenders('102.60', [{ method: 'cash', amount: '200' }])).toMatchObject({ ok: true });
    const s = settleTenders('102.60', [{ method: 'cash', amount: '200' }], '0.5');
    expect(s.ok && s.change.toFixed(2)).toBe('97.50');
    expect(settleTenders('100', [{ method: 'card', amount: '150' }]).ok).toBe(false);
    expect(settleTenders('100', [{ method: 'card', amount: '60' }, { method: 'cash', amount: '30' }]).ok).toBe(false);
  });
});

describe('costing', () => {
  const S0: AvgState = { qty: ZERO, value: ZERO, lastAvg: ZERO };
  it('weighted average receive/issue no drift', () => {
    let s = avgReceive(S0, 3, '10').state;
    s = avgReceive(s, 7, '11.37').state;
    let issued = ZERO;
    for (let i = 0; i < 10; i++) { const r = avgIssue(s, 1); issued = issued.add(r.value); s = r.state; }
    expect(s.qty.isZero() && s.value.isZero()).toBe(true);
    expect(issued.toFixed(4)).toBe(dec(30).add(dec('79.59')).toFixed(4));
  });
  it('negative stock receipt produces COGS adjustment and exact inventory value', () => {
    let s = avgReceive(S0, 2, 10).state;            // 2 @10
    const iss = avgIssue(s, 5); s = iss.state;       // -3, issued 20 + 3×10
    expect(iss.value.toFixed(2)).toBe('50.00');
    const rec = avgReceive(s, 10, 12);              // 3 negative recosted at 12 → +6 COGS
    expect(rec.cogsAdjustment.toFixed(2)).toBe('6.00');
    expect(rec.state.qty.toString()).toBe('7');
    expect(rec.state.value.toFixed(2)).toBe('84.00');
    expect(rec.state.value.sub(s.value).eq(rec.inventoryValue)).toBe(true);
  });
  it('fifo consumes oldest first', () => {
    const r = fifoConsume([{ id: 'a', remainingQty: dec(2), remainingValue: dec(20) }, { id: 'b', remainingQty: dec(5), remainingValue: dec(60) }], 4);
    expect(r.consumed.map((c) => [c.layerId, c.qty.toString(), c.value.toFixed(2)])).toEqual([['a', '2', '20.00'], ['b', '2', '24.00']]);
    expect(r.value.toFixed(2)).toBe('44.00');
  });
});

describe('uom', () => {
  it('converts within category', () => {
    expect(convertQty(2, { id: 'box', categoryId: 'unit', factor: 12, rounding: 1 }, { id: 'pc', categoryId: 'unit', factor: 1, rounding: 1 }).toString()).toBe('24');
    expect(() => convertQty(1, { id: 'kg', categoryId: 'w', factor: 1, rounding: 0.001 }, { id: 'pc', categoryId: 'unit', factor: 1, rounding: 1 })).toThrow();
  });
});

describe('permissions', () => {
  it('spec rules hold for templates', () => {
    expect(ROLE_TEMPLATES.cashier!.permissions.some((p) => p.startsWith('accounting'))).toBe(false);
    expect(ROLE_TEMPLATES.warehouse_clerk!.permissions.some((p) => p.startsWith('accounting'))).toBe(false);
    expect(ROLE_TEMPLATES.financial_controller!.permissions.some((p) => p.startsWith('core.user') || p.startsWith('core.role'))).toBe(false);
    for (const [k, r] of Object.entries(ROLE_TEMPLATES)) expect(sodViolations(r.permissions), k).toEqual([]);
  });
});

describe('schemas', () => {
  it('stableStringify is key-order independent', () => {
    expect(stableStringify({ b: 1, a: [{ y: 2, x: 1 }] })).toBe(stableStringify({ a: [{ x: 1, y: 2 }], b: 1 }));
  });
  it('rejects bad pos txn', () => {
    expect(posTransactionSchema.safeParse({ id: 'x' }).success).toBe(false);
  });
});

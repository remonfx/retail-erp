import { z } from 'zod';

export const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'INVALID_UUID');
/** Decimal transported as string; up to 15 integer digits, 6 fraction digits. */
export const decimalStr = z.union([z.string(), z.number()]).transform(String).refine((s) => /^-?\d{1,15}(\.\d{1,6})?$/.test(s), 'INVALID_DECIMAL');
export const positiveDecimal = decimalStr.refine((s) => Number(s) > 0, 'MUST_BE_POSITIVE');
export const nonNegDecimal = decimalStr.refine((s) => Number(s) >= 0, 'MUST_BE_NON_NEGATIVE');
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'INVALID_DATE');
export const isoDateTime = z.string().datetime({ offset: true });

export const TENDER_METHODS = ['cash', 'card', 'wallet', 'instapay', 'bnpl', 'voucher', 'store_credit', 'customer_account'] as const;
export const OFFLINE_ALLOWED_TENDERS = ['cash', 'card', 'wallet', 'instapay', 'bnpl'] as const;

export const posLineSchema = z.object({
  lineId: uuid,
  variantId: uuid,
  barcode: z.string().max(64).nullish(),
  qty: positiveDecimal,
  uomId: uuid,
  unitPrice: nonNegDecimal,
  priceListItemId: uuid.nullish(),
  manualDiscountPercent: nonNegDecimal.nullish(),
  manualDiscountAmount: nonNegDecimal.nullish(),
  overrideBy: uuid.nullish(),
  lotId: uuid.nullish(),
  serialNo: z.string().max(100).nullish(),
  returnOfLineId: uuid.nullish(),
  // totals calculated on device by @rc/domain (server recomputes and records delta)
  discountTotal: nonNegDecimal,
  net: decimalStr,
  tax: decimalStr,
  total: decimalStr,
});

export const posPaymentSchema = z.object({
  id: uuid,
  method: z.enum(TENDER_METHODS),
  amount: positiveDecimal,
  reference: z.string().max(100).nullish(),
  cardLast4: z.string().regex(/^\d{4}$/).nullish(),
  approvalCode: z.string().max(32).nullish(),
});

export const posTransactionSchema = z.object({
  id: uuid,                          // client-generated UUIDv7 == idempotency key
  sessionId: uuid,
  receiptNo: z.string().min(1).max(40),
  kind: z.enum(['sale', 'return']),
  returnOfId: uuid.nullish(),
  businessDate: isoDate,
  soldAt: isoDateTime,
  cashierId: uuid,
  customerId: uuid.nullish(),
  couponCodes: z.array(z.string().max(40)).max(10).default([]),
  basketManualDiscountPercent: nonNegDecimal.nullish(),
  basketManualDiscountAmount: nonNegDecimal.nullish(),
  offline: z.boolean(),
  engineVersion: z.string().max(40),
  lines: z.array(posLineSchema).min(1).max(500),
  payments: z.array(posPaymentSchema).min(1).max(10),
  subtotal: decimalStr,
  discountTotal: decimalStr,
  taxTotal: decimalStr,
  grandTotal: decimalStr,
  rounding: decimalStr.default('0'),
  change: decimalStr.default('0'),
});
export type PosTransactionPayload = z.infer<typeof posTransactionSchema>;

export const posSessionOpenSchema = z.object({ id: uuid, terminalId: uuid, openedBy: uuid, openedAt: isoDateTime, businessDate: isoDate, openingFloat: nonNegDecimal });
export const posSessionCloseSchema = z.object({ id: uuid, closedBy: uuid, closedAt: isoDateTime, countedCash: nonNegDecimal, notes: z.string().max(500).nullish() });
export const posCashMovementSchema = z.object({ id: uuid, sessionId: uuid, kind: z.enum(['cash_in', 'cash_out', 'safe_drop']), amount: positiveDecimal, reason: z.string().max(200), at: isoDateTime, userId: uuid });

export const syncItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session_open'), id: uuid, seq: z.number().int().positive(), payload: posSessionOpenSchema }),
  z.object({ type: z.literal('pos_txn'), id: uuid, seq: z.number().int().positive(), payload: posTransactionSchema }),
  z.object({ type: z.literal('cash_movement'), id: uuid, seq: z.number().int().positive(), payload: posCashMovementSchema }),
  z.object({ type: z.literal('session_close'), id: uuid, seq: z.number().int().positive(), payload: posSessionCloseSchema }),
]);
export const syncPushSchema = z.object({ batchId: uuid, items: z.array(syncItemSchema).min(1).max(200) });
export type SyncItem = z.infer<typeof syncItemSchema>;
export type SyncPush = z.infer<typeof syncPushSchema>;

export type SyncItemStatus = 'applied' | 'duplicate_ack' | 'quarantined' | 'rejected_retry';
export interface SyncItemResult { id: string; status: SyncItemStatus; serverRef?: string; exceptions?: string[]; error?: string }

/** Stable JSON (sorted keys) used for payload hashing on both client & server. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}

import { dec, type Dec } from './money.js';

export type Symbology = 'ean13' | 'ean8' | 'upca' | 'code128' | 'internal';

/** GS1 mod-10 check digit for GTIN-8/12/13/14 (body without check digit). */
export function gs1CheckDigit(body: string): number {
  let total = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = body.charCodeAt(body.length - 1 - i) - 48;
    total += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (total % 10)) % 10;
}

export function isValidGtin(code: string): boolean {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  return gs1CheckDigit(code.slice(0, -1)) === Number(code[code.length - 1]);
}

export function detectSymbology(code: string): Symbology {
  if (/^\d{13}$/.test(code) && isValidGtin(code)) return 'ean13';
  if (/^\d{8}$/.test(code) && isValidGtin(code)) return 'ean8';
  if (/^\d{12}$/.test(code) && isValidGtin(code)) return 'upca';
  return /^[\x20-\x7e]+$/.test(code) ? 'code128' : 'internal';
}

export function validateBarcode(code: string, symbology: Symbology): string | null {
  if (!code || code.length > 64) return 'BARCODE_LENGTH';
  if (/\s/.test(code)) return 'BARCODE_WHITESPACE';
  if (symbology === 'ean13' && !(code.length === 13 && isValidGtin(code))) return 'BARCODE_EAN13_INVALID';
  if (symbology === 'ean8' && !(code.length === 8 && isValidGtin(code))) return 'BARCODE_EAN8_INVALID';
  if (symbology === 'upca' && !(code.length === 12 && isValidGtin(code))) return 'BARCODE_UPCA_INVALID';
  return null;
}

/**
 * Scale / price-embedded barcode rule (GS1 restricted-circulation prefixes 20–29).
 * Example rule {prefix:'21', itemCodeLength:5, valueLength:5, valueType:'weight', valueDecimals:3}
 *  → "2112345012342" = item "12345", weight 1.234 kg.
 */
export interface EmbeddedBarcodeRule {
  prefix: string;
  itemCodeLength: number;
  valueLength: number;
  valueType: 'weight' | 'price' | 'quantity';
  valueDecimals: number;
  totalLength?: number; // default 13
}

export interface EmbeddedParseResult { itemCode: string; value: Dec; valueType: EmbeddedBarcodeRule['valueType']; rule: EmbeddedBarcodeRule }

export function parseEmbeddedBarcode(code: string, rules: EmbeddedBarcodeRule[]): EmbeddedParseResult | null {
  for (const rule of rules) {
    const len = rule.totalLength ?? 13;
    if (code.length !== len || !code.startsWith(rule.prefix) || !/^\d+$/.test(code)) continue;
    if (len === 13 && !isValidGtin(code)) continue;
    const start = rule.prefix.length;
    const itemCode = code.slice(start, start + rule.itemCodeLength);
    const rawValue = code.slice(start + rule.itemCodeLength, start + rule.itemCodeLength + rule.valueLength);
    if (itemCode.length !== rule.itemCodeLength || rawValue.length !== rule.valueLength) continue;
    const value = dec(rawValue).div(dec(10).pow(rule.valueDecimals));
    return { itemCode, value, valueType: rule.valueType, rule };
  }
  return null;
}

/** Build a valid EAN-13 from a 12-digit body (used for internal barcode generation). */
export function makeEan13(body12: string): string {
  if (!/^\d{12}$/.test(body12)) throw new Error('EAN13 body must be 12 digits');
  return body12 + gs1CheckDigit(body12);
}

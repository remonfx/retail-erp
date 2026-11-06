import { randomBytes } from './random.js';

/** RFC 9562 UUIDv7: 48-bit unix ms timestamp + random. Monotonic within a process. */
let lastMs = 0;
let seq = 0;
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  let ms = now;
  if (ms <= lastMs) { ms = lastMs; seq = (seq + 1) & 0xfff; if (seq === 0) ms = ++lastMs; }
  else { seq = ((bytes[6]! & 0x0f) << 8) | bytes[7]!; }
  lastMs = ms;
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function uuidv7Timestamp(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Cross-runtime CSPRNG (Node ≥19, browsers, React Native with crypto polyfill, Tauri webview). */
export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!c?.getRandomValues) throw new Error('crypto.getRandomValues unavailable');
  c.getRandomValues(b);
  return b;
}

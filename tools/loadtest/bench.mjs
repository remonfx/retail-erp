// HTTP latency benchmark against a running API. Usage: node bench.mjs [requests] [concurrency]
const API = process.env.API_URL ?? 'http://localhost:4000';
const N = Number(process.argv[2] ?? 600), C = Number(process.argv[3] ?? 20);
const login = await (await fetch(`${API}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.DEMO_EMAIL ?? 'demo@retailcore.app', password: process.env.DEMO_PASSWORD ?? 'DemoPassw0rd!2026' }) })).json();
const me = await (await fetch(`${API}/api/v1/auth/me`, { headers: { authorization: `Bearer ${login.accessToken}` } })).json();
const H = { authorization: `Bearer ${login.accessToken}`, 'x-company-id': me.companies[0].id };
const words = ['زيت', 'أرز كريستال', 'شاي العروسة', 'جبنة دومتي 250', 'مكرونه', 'صابون فاين', 'SYN-00123', 'نسكافيه نستله', 'حفاضات بامبرز 77', 'طحينه'];
const ean = (n) => { const b = '29' + String(n).padStart(10, '0'); let s = 0; for (let i = 0; i < 12; i++) s += Number(b[11 - i]) * (i % 2 === 0 ? 3 : 1); return b + ((10 - (s % 10)) % 10); };
const scenarios = {
  'product search (name/SKU, Arabic-normalized)': (i) => `/api/v1/products?q=${encodeURIComponent(words[i % words.length])}&limit=50`,
  'barcode lookup (exact)': (i) => `/api/v1/barcodes/${ean(1 + ((i * 7919) % 1_000_000))}`,
  'product list page (keyset)': () => `/api/v1/products?limit=50`,
  'dashboard (month)': () => `/api/v1/dashboard?from=${new Date().toISOString().slice(0, 8)}01&to=${new Date().toISOString().slice(0, 10)}`,
};
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
const out = [];
for (const [name, url] of Object.entries(scenarios)) {
  const times = []; let errors = 0, i = 0;
  const worker = async () => { while (i < N) { const k = i++; const t0 = performance.now(); const r = await fetch(API + url(k), { headers: H }); await r.arrayBuffer(); times.push(performance.now() - t0); if (r.status >= 400) errors++; } };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: C }, worker));
  const secs = (performance.now() - t0) / 1000;
  times.sort((a, b) => a - b);
  out.push({ scenario: name, requests: N, concurrency: C, p50_ms: pct(times, 50).toFixed(1), p95_ms: pct(times, 95).toFixed(1), p99_ms: pct(times, 99).toFixed(1), rps: (N / secs).toFixed(0), errors });
}
console.table(out);
console.log(JSON.stringify(out));

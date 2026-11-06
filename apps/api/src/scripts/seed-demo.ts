/**
 * Demo tenant seeder — exercises the real API end to end (no direct inserts):
 * signup → users → branches → catalog → opening stock → PO/GRN/invoice → POS device + sales → session close → GL.
 * Usage: DATABASE_URL=... DATABASE_OWNER_URL=... pnpm --filter @rc/api seed:demo
 */
import { uuidv7, computeCart, settleTenders, fmt, CALC_ENGINE_VERSION } from '@rc/domain';
import { buildApp } from '../app.js';
import { drainOutbox } from '../lib/outbox.js';
import { closePool } from '../lib/db.js';

const EMAIL = process.env.DEMO_EMAIL ?? 'demo@retailcore.app';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'DemoPassw0rd!2026';

const app = await buildApp({ logger: false, rateLimit: false });
async function call(method: string, url: string, body?: unknown, h: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...h };
  if (method !== 'GET') headers['idempotency-key'] = uuidv7();
  const r = await app.inject({ method: method as 'GET', url, payload: body as object, headers });
  const b = r.body ? JSON.parse(r.body) : null;
  if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
  return b;
}

const s = await call('POST', '/api/v1/auth/signup', { tenantName: 'هايبر النيل', slug: `nile-${Date.now().toString(36)}`, ownerName: 'مالك تجريبي', email: EMAIL, password: PASSWORD,
  companyNameAr: 'شركة النيل للتجارة', companyNameEn: 'Nile Trading Co.', taxRegistrationNo: '100-200-300', branchNameAr: 'فرع مدينة نصر', branchCode: 'CAI01', planCode: 'enterprise' });
const H = { authorization: `Bearer ${s.accessToken}`, 'x-company-id': s.companyId };
const alx = await call('POST', '/api/v1/branches', { code: 'ALX01', nameAr: 'فرع سموحة', nameEn: 'Smouha' }, H);
const [uoms, taxes, cats, locs, reasons] = await Promise.all(['/api/v1/uoms', '/api/v1/tax-classes', '/api/v1/categories', '/api/v1/locations', '/api/v1/inventory/reason-codes'].map((u) => call('GET', u, undefined, H)));
const pcs = uoms.find((u: any) => u.code === 'PCS').id, kg = uoms.find((u: any) => u.code === 'KG').id;
const std = taxes.find((t: any) => t.code === 'STANDARD'), exempt = taxes.find((t: any) => t.code === 'EXEMPT');
const root = cats[0].id;
const catIds: Record<string, string> = {};
for (const [code, ar, en] of <[string, string, string][]>[['FOOD', 'مواد غذائية', 'Grocery'], ['DAIRY', 'ألبان', 'Dairy'], ['CLEAN', 'منظفات', 'Cleaning'], ['ELEC', 'أجهزة كهربائية', 'Electronics'], ['FRESH', 'خضار وفاكهة', 'Fresh produce']]) {
  catIds[code] = (await call('POST', '/api/v1/categories', { parentId: root, code, nameAr: ar, nameEn: en }, H)).id;
}
const stock = locs.find((l: any) => l.type === 'internal' && l.branch_id === s.branchId).id;
const PRODUCTS: [string, string, string, string, string, string, boolean?][] = [
  ['زيت عباد الشمس كريستال 1 لتر', 'Crystal sunflower oil 1L', 'FOOD', '89.00', '68', '6221007012340'],
  ['أرز الضحى 1 كجم', 'Al Doha rice 1kg', 'FOOD', '42.00', '31', '6221036001017'],
  ['سكر الأسرة 1 كجم', 'Al Osra sugar 1kg', 'FOOD', '38.50', '29', '6224000271018'],
  ['مكرونة الملكة 400 جم', 'El Malika pasta 400g', 'FOOD', '17.50', '12', '6221024002213'],
  ['شاي العروسة 250 جم', 'El Arosa tea 250g', 'FOOD', '65.00', '48', '6221155010014'],
  ['لبن جهينة كامل الدسم 1 لتر', 'Juhayna full cream milk 1L', 'DAIRY', '48.00', '39', '6223000510016'],
  ['جبنة دومتي فيتا 500 جم', 'Domty feta 500g', 'DAIRY', '55.00', '41', '6222001010120'],
  ['زبادي جهينة 105 جم', 'Juhayna yoghurt 105g', 'DAIRY', '9.50', '6.8', '6223000510122'],
  ['مسحوق أريال 2.5 كجم', 'Ariel powder 2.5kg', 'CLEAN', '285.00', '221', '6221047003019'],
  ['صابون بريل 650 مل', 'Pril dish soap 650ml', 'CLEAN', '52.00', '38', '6221098001015'],
  ['خلاط توشيبا 600 وات', 'Toshiba blender 600W', 'ELEC', '2450.00', '1890', '6223004970019'],
  ['غلاية كهربائية 1.7 لتر', 'Electric kettle 1.7L', 'ELEC', '899.00', '640', '6223004970026'],
];
const variants: { id: string; price: string; cost: string; cat: string }[] = [];
let n = 0;
for (const [ar, en, cat, price, cost, barcode] of PRODUCTS) {
  n++;
  const p = await call('POST', '/api/v1/products', { nameAr: ar, nameEn: en, categoryId: catIds[cat], stockUomId: pcs, taxClassId: std.id, variants: [{ sku: `NL-${String(n).padStart(4, '0')}`, barcodes: [{ code: barcode, symbology: 'internal' }], retailPrice: price, standardCost: cost }] }, H);
  variants.push({ id: p.variants[0].id, price, cost, cat });
}
// fresh produce sold by weight (scale label prefix 21, PLU 10001)
const tomato = await call('POST', '/api/v1/products', { nameAr: 'طماطم', nameEn: 'Tomatoes', categoryId: catIds.FRESH, stockUomId: kg, taxClassId: exempt.id, isWeighted: true, scalePlu: '10001', variants: [{ sku: 'NL-FR-0001', retailPrice: '18.00', standardCost: '11' }] }, H);
// opening stock
await call('POST', '/api/v1/stock-adjustments', { kind: 'adjustment', locationId: stock, reasonCodeId: reasons.find((r: any) => r.code === 'OPENING').id, opening: true,
  lines: [...variants.map((v) => ({ variantId: v.id, qty: v.cat === 'ELEC' ? '15' : '240', unitCost: v.cost })), { variantId: tomato.variants[0].id, qty: '300', unitCost: '11' }] }, H);
// supplier + PO (pending approval — visible in approvals screen)
const sup = await call('POST', '/api/v1/partners', { nameAr: 'المتحدة للتوزيع', nameEn: 'United Distribution', isSupplier: true, paymentTermsDays: 45, taxRegistrationNo: '555-111-222' }, H);
const po = await call('POST', '/api/v1/purchase-orders', { supplierId: sup.id, branchId: s.branchId, lines: variants.slice(0, 4).map((v) => ({ variantId: v.id, qty: '120', unitPrice: v.cost, taxRateId: std.rates[0].id })) }, H);
await call('POST', `/api/v1/purchase-orders/${po.id}/submit`, {}, H);
// POS device & terminal
const users = await call('GET', '/api/v1/roles', undefined, H);
const cashierEmail = `cashier.${Date.now().toString(36)}@retailcore.app`;
const cashier = await call('POST', '/api/v1/users', { email: cashierEmail, fullName: 'كاشير تجريبي', password: PASSWORD }, H);
await call('POST', `/api/v1/users/${cashier.id}/assignments`, { roleId: users.find((r: any) => r.code === 'cashier').id, scopeType: 'branch', companyId: s.companyId, branchId: s.branchId }, H);
const dev = await call('POST', '/api/v1/devices', { branchId: s.branchId, kind: 'pos', name: 'كاشير 1' }, H);
const term = await call('POST', '/api/v1/terminals', { branchId: s.branchId, code: 'T01', name: 'كاشير 1', deviceId: dev.id }, H);
const en = await call('POST', '/api/v1/devices/enroll', { deviceId: dev.id, enrollmentCode: dev.enrollmentCode, appVersion: 'seed' });
const D = { authorization: `Device ${dev.id}:${en.secret}` };
const today = new Date().toISOString().slice(0, 10);
const sessionId = uuidv7();
let seq = 0;
const items: unknown[] = [{ type: 'session_open', id: sessionId, seq: ++seq, payload: { id: sessionId, terminalId: term.id, openedBy: cashier.id, openedAt: new Date().toISOString(), businessDate: today, openingFloat: '1000' } }];
let cashTotal = 0;
for (let i = 0; i < 25; i++) {
  const picks = variants.filter((_, j) => (i + j) % 4 === 0).slice(0, 3);
  const lines = picks.map((v) => ({ lineId: uuidv7(), variantId: v.id, qty: String(1 + (i % 3)), unitPrice: v.price, priceIncludesTax: true, taxRates: [{ id: std.rates[0].id, code: 'VAT14', rate: '14', kind: 'vat' as const }] }));
  const cart = computeCart({ lines, context: { at: new Date(), localTime: '12:00', couponCodes: [], customerGroupIds: [] } });
  const method = i % 3 === 0 ? 'card' : 'cash';
  const tendered = method === 'card' ? fmt(cart.grandTotal, 2) : String(Math.ceil(Number(cart.grandTotal) / 50) * 50);
  const st = settleTenders(cart.grandTotal, [{ method, amount: tendered }]);
  if (!st.ok) throw new Error('tender');
  if (method === 'cash') cashTotal += Number(cart.grandTotal);
  const id = uuidv7();
  items.push({ type: 'pos_txn', id, seq: ++seq, payload: { id, sessionId, receiptNo: `CAI01-T01-${String(i + 1).padStart(6, '0')}`, kind: 'sale', businessDate: today, soldAt: new Date().toISOString(), cashierId: cashier.id, couponCodes: [], offline: i % 5 === 0, engineVersion: CALC_ENGINE_VERSION,
    lines: cart.lines.map((l) => ({ lineId: l.lineId, variantId: l.variantId, qty: l.qty.toString(), uomId: pcs, unitPrice: fmt(l.unitPrice, 2), discountTotal: fmt(l.discountTotal, 2), net: fmt(l.net, 2), tax: fmt(l.tax, 2), total: fmt(l.total, 2) })),
    payments: [{ id: uuidv7(), method, amount: tendered, ...(method === 'card' ? { cardLast4: '4242', approvalCode: 'A1B2C3' } : {}) }],
    subtotal: fmt(cart.subtotal, 2), discountTotal: fmt(cart.discountTotal, 2), taxTotal: fmt(cart.taxTotal, 2), grandTotal: fmt(cart.grandTotal, 2), rounding: '0', change: fmt(st.change, 2) } });
}
items.push({ type: 'session_close', id: uuidv7(), seq: ++seq, payload: { id: sessionId, closedBy: cashier.id, closedAt: new Date().toISOString(), countedCash: (1000 + cashTotal - 5).toFixed(2) } });
const pushed = await call('POST', '/api/v1/sync/push', { batchId: uuidv7(), items }, D);
const statuses = pushed.results.reduce((m: Record<string, number>, r: any) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
// a second, still-open session on the same terminal for the live POS demo is left to the POS app
await drainOutbox();
console.log(JSON.stringify({ login: { email: EMAIL, password: PASSWORD }, cashier: { email: cashierEmail, password: PASSWORD }, tenantId: s.tenantId, companyId: s.companyId, branches: [s.branchId, alx.branchId],
  posDevice: { deviceId: dev.id, note: 'secret already enrolled by seed; create a new device in Settings → Devices for the POS app' }, syncResults: statuses }, null, 2));
await app.close();
await closePool();

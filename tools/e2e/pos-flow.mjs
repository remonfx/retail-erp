// POS browser flow: provision device via API → enroll in UI → PIN login → open session → scan → pay cash → verify server got the sale.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const API = process.env.API_URL ?? 'http://localhost:4000';
const POS = process.env.POS_URL ?? 'http://localhost:1420';
const OUT = process.env.SHOTS ?? '../../docs/screenshots';
const EMAIL = process.env.DEMO_EMAIL ?? 'demo@retailcore.app', PASS = process.env.DEMO_PASSWORD ?? 'DemoPassw0rd!2026';
const j = async (method, path, body, token, company) => {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(company ? { 'x-company-id': company } : {}), ...(method !== 'GET' ? { 'idempotency-key': crypto.randomUUID() } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const b = await r.json(); if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(b)}`); return b;
};
const owner = await j('POST', '/api/v1/auth/login', { email: EMAIL, password: PASS });
const me = await j('GET', '/api/v1/auth/me', null, owner.accessToken);
const company = me.companies[0].id, branch = me.branches.find((b) => b.code === 'CAI01').id;
// cashier with a PIN
const cEmail = `pos.${Date.now()}@retailcore.app`;
const u = await j('POST', '/api/v1/users', { email: cEmail, fullName: 'أحمد الكاشير', password: PASS }, owner.accessToken);
const roles = await j('GET', '/api/v1/roles', null, owner.accessToken);
await j('POST', `/api/v1/users/${u.id}/assignments`, { roleId: roles.find((r) => r.code === 'shift_supervisor').id, scopeType: 'branch', companyId: company, branchId: branch }, owner.accessToken);
const cl = await j('POST', '/api/v1/auth/login', { email: cEmail, password: PASS });
await j('POST', '/api/v1/auth/pos-pin', { pin: '482915', password: PASS }, cl.accessToken);
const d = await j('POST', '/api/v1/devices', { branchId: branch, kind: 'pos', name: 'كاشير المتصفح' }, owner.accessToken, company);
await j('POST', '/api/v1/terminals', { branchId: branch, code: `B${Date.now().toString().slice(-4)}`, name: 'كاشير المتصفح', deviceId: d.id }, owner.accessToken, company);

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1366, height: 820 } })).newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));
await page.goto(POS);
await page.locator('input').nth(1).fill(d.id);
await page.locator('input').nth(2).fill(d.enrollmentCode);
await page.getByRole('button', { name: /تفعيل/ }).click();
await page.locator('select').waitFor({ timeout: 60000 });
await page.selectOption('select', u.id);
await page.fill('input[type=password]', '482915');
await page.getByRole('button', { name: 'دخول' }).click();
await page.getByRole('button', { name: 'فتح الوردية' }).click();
const scan = page.getByLabel('scan');
await scan.fill('6221007012340'); await scan.press('Enter');
await scan.fill('6221036001017'); await scan.press('Enter');
await scan.fill('6221007012340'); await scan.press('Enter');
await scan.fill('2110001015007'); await scan.press('Enter'); // scale label: PLU 10001, 1.500 kg
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/pos-sale.png` });
const rows = await page.locator('.lines tbody tr').count();
if (rows !== 3) problems.push(`expected 3 cart lines (oil x2, rice, tomatoes 1.5kg), got ${rows}`);
await page.keyboard.press('F10');
await page.getByRole('button', { name: '500' }).click();
page.on('dialog', (dlg) => dlg.dismiss());
await page.evaluate(() => { window.print = () => {}; });
await page.getByRole('button', { name: 'تأكيد وطباعة' }).click();
await page.waitForTimeout(1500);
const orders = await j('GET', `/api/v1/pos/orders?branchId=${branch}&limit=5`, null, owner.accessToken, company);
const last = orders.data[0];
console.log('server last receipt:', last?.receipt_no, last?.grand_total);
if (!last || !String(last.receipt_no).includes('CAI01-B')) problems.push('sale not found on server');
await browser.close();
console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'OK — POS enroll → login → session → scan (incl. scale label) → pay → synced');
process.exit(problems.length ? 1 : 0);

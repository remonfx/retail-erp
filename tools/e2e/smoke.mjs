// Browser smoke test: logs in as the demo owner and visits every screen, failing on console errors or error banners.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const OUT = process.env.SHOTS ?? '../../docs/screenshots';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const problems = [];
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) problems.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
await page.goto(`${BASE}/login`);
await page.fill('input[type=email]', process.env.DEMO_EMAIL ?? 'demo@retailcore.app');
await page.fill('input[type=password]', process.env.DEMO_PASSWORD ?? 'DemoPassw0rd!2026');
await page.click('button.primary');
await page.waitForURL(`${BASE}/`);
const routes = ['/', '/approvals', '/products', '/inventory/stock', '/inventory/adjustments', '/inventory/transfers', '/purchasing/orders', '/purchasing/invoices', '/purchasing/suppliers',
  '/pos/sessions', '/pos/sync', '/accounting/journals', '/accounting/reports', '/settings/users', '/settings/branches', '/settings/devices', '/settings/subscription'];
for (const r of routes) {
  await page.goto(`${BASE}${r}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
  const err = await page.locator('.alert.error').allTextContents();
  if (err.length) problems.push(`${r}: ${err.join(' | ')}`);
  const name = r === '/' ? 'dashboard' : r.slice(1).replace(/\//g, '-');
  if (['dashboard', 'products', 'accounting-reports', 'pos-sessions', 'inventory-stock', 'approvals'].includes(name)) await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
}
// English LTR + dark mode variant
await page.goto(`${BASE}/`);
await page.getByRole('button', { name: 'English' }).click();
await page.locator('.topbar button.btn.sm').first().click();
await page.waitForTimeout(500);
const dir = await page.evaluate(() => document.documentElement.dir);
if (dir !== 'ltr') problems.push(`expected ltr after switching to English, got ${dir}`);
await page.screenshot({ path: `${OUT}/dashboard-en-dark.png` });
// mobile width check (no horizontal scroll)
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}/products`);
await page.waitForLoadState('networkidle');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
if (overflow > 2) problems.push(`horizontal overflow at 390px: ${overflow}px`);
await browser.close();
console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : `OK — ${routes.length} screens clean`);
process.exit(problems.length ? 1 : 0);

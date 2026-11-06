// Drill-down browser test: follows real click chains and fails if any hop is missing or shows an error.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const OUT = process.env.SHOTS ?? '../../docs/screenshots';
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
const settle = async () => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(250); const e = await page.locator('.alert.error').allTextContents(); if (e.length) problems.push(`${page.url()}: ${e.join('|')}`); };
const hop = async (label, locator, expectUrl) => {
  try { await locator.first().click({ timeout: 8000 }); await page.waitForURL(expectUrl, { timeout: 10000 }); await settle(); console.log(`✓ ${label} → ${new URL(page.url()).pathname}`); }
  catch (e) { problems.push(`✗ ${label}: ${e.message.split('\n')[0]}`); }
};

await page.goto(`${BASE}/login`);
await page.fill('input[type=email]', process.env.DEMO_EMAIL ?? 'demo@retailcore.app');
await page.fill('input[type=password]', process.env.DEMO_PASSWORD ?? 'DemoPassw0rd!2026');
await page.click('button.primary');
await page.waitForURL(`${BASE}/`); await settle();

// 1) Dashboard KPI → sales analysis → drill category → product rows
await hop('dashboard: net sales KPI', page.locator('a.kpi-link').nth(1), /\/reports\/sales/);
await page.screenshot({ path: `${OUT}/sales-analysis.png` });
await hop('dashboard top product → product card', (await page.goto(`${BASE}/`), await settle(), page.locator('.card a.go').filter({ hasText: /NL-/ })), /\/products\/[0-9a-f-]+$/);
await hop('product → movements → source document', (await page.getByRole('button', { name: /حركة الصنف|Movements/ }).click(), await settle(), page.locator('a.go').filter({ hasText: /فتح المستند|Open document/ })), /\/(inventory\/sources|pos\/orders)\//);

// 2) Trial balance → account ledger → journal entry → source document
await page.goto(`${BASE}/accounting/reports`); await settle();
await hop('trial balance row → ledger', page.locator('td a.go').filter({ hasText: '1101' }), /\/accounting\/ledger\//);
await hop('ledger line → journal entry', page.locator('td a.go').filter({ hasText: /SAL\// }), /\/accounting\/journals\//);
await page.screenshot({ path: `${OUT}/journal-entry.png` });
await hop('journal entry → its source (POS session)', page.getByRole('link', { name: /المصدر|Source/ }), /\/pos\/sessions\//);
await hop('session → receipt', page.locator('td a.go').filter({ hasText: /CAI01-T01-/ }), /\/pos\/orders\//);
await hop('receipt → product', page.locator('td a.go').filter({ hasText: /NL-/ }), /\/products\//);

// 3) Purchase order → supplier card → order
await page.goto(`${BASE}/purchasing/orders`); await settle();
await hop('PO list → supplier card', page.locator('td a.go').first(), /\/purchasing\/suppliers\//);
await page.screenshot({ path: `${OUT}/supplier-card.png` });
await hop('supplier card → purchase order', (await page.getByRole('button', { name: /أوامر الشراء|Purchase orders/ }).click(), page.locator('td a.go').filter({ hasText: /PO-/ })), /\/purchasing\/orders\//);

// 4) Approvals → document under review
await page.goto(`${BASE}/approvals`); await settle();
await hop('approval → document', page.locator('td a.go').first(), /\/purchasing\/orders\/|\/inventory\/sources\//);

// 5) Ctrl+K command palette → document number
await page.goto(`${BASE}/`); await settle();
await page.keyboard.press('Control+k');
await page.locator('.palette input').fill('PO-');
await page.waitForTimeout(700);
await hop('Ctrl+K search → PO', page.locator('.palette-item').filter({ hasText: /PO-/ }), /\/purchasing\/orders\//);

await browser.close();
console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'OK — all drill-down chains work');
process.exit(problems.length ? 1 : 0);

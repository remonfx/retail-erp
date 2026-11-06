# RetailCore — SaaS Retail ERP (Egypt-first)

Multi-tenant SaaS ERP for retail chains: web back-office (Next.js), offline-first POS (React + Tauri/Rust + local SQLite), mobile app (Expo/React Native), and one TypeScript API (Fastify) on PostgreSQL with Row-Level Security.

Arabic RTL first, English LTR, light/dark, EGP, Africa/Cairo.

## What works today (verified by automated tests)

| Area | Status | Evidence |
|---|---|---|
| SaaS signup & provisioning (tenant, company, branch, COA, fiscal periods, roles, taxes, UoM) | ✅ | `apps/api/test/saas-auth.test.ts` |
| Auth: Argon2id, JWT + rotating refresh with reuse detection, TOTP MFA, POS PIN | ✅ | same |
| Tenant + company isolation (API **and** PostgreSQL RLS), branch scoping, SoD, self-approval blocks | ✅ | same |
| Catalog: variants, multi-barcode, pack barcodes, scale/price-embedded labels, duplicate & Arabic similar-name detection, merge, bulk price, CSV import/export (streaming) | ✅ | API + browser smoke |
| Pricing: price lists (company/branch/group, effective-dated, tiers), promotions engine (%/amount/BxGy/bundle/basket/coupon/time window, maker-checker) | ✅ | `packages/domain/test` (property-based) |
| Inventory: immutable moves, quants, weighted average + FIFO, lots/expiry, serials, negative-stock policy, threshold approvals, 2-step transfers with shortage, cycle counts with moves-since-snapshot | ✅ | `inventory-accounting.test.ts` |
| Accounting: double entry, posting engine via outbox, immutable posted entries (DB triggers), period locks, reversal, TB / P&L / BS / cash flow (indirect, reconciles), VAT, AP aging, inventory sub-ledger ↔ GL reconciliation | ✅ | same |
| Purchasing: PO → approval → GRN (partial, tolerance) → 3-way match → exception approval → AP → payment with WHT → returns (GRNI vs AP split) | ✅ | `purchasing.test.ts` |
| POS sync: exactly-once under concurrent replays, tampered payload quarantine, never-discard quarantine, offline negative stock exceptions, returns, session close → balanced GL | ✅ | `pos.test.ts` |
| POS app engine: offline commit, durable outbox, power-loss atomicity, lost-ack retry without duplicates, PIN login, X/Z | ✅ | `apps/pos-desktop/test/engine.e2e.test.ts` (engine ↔ real API ↔ PostgreSQL) |
| POS UI in browser: enroll → login → session → scan (incl. 1.5 kg scale label) → pay → synced | ✅ | `tools/e2e/pos-flow.mjs` |
| Web back-office: 32 routes, all 17 list screens load with zero errors; RTL/LTR + dark; no horizontal scroll at 390 px | ✅ | `tools/e2e/smoke.mjs` |
| Drill-down: every KPI, total, document number and product links to its source; Ctrl+K search (12 click chains) | ✅ | `tools/e2e/drilldown.mjs` |
| Rust local journal (SQLite WAL + synchronous=FULL, atomic tx) | ✅ | `cargo test -p pos-store` |
| Mobile app (dashboard, camera barcode lookup, approvals, offline stocktake, attendance) | ✅ typecheck + Android bundle | `npx expo export` |
| Scale: 1,000,013 SKUs — product search p95 **210 ms**, barcode p95 **36 ms** (20 concurrent) | ✅ | `docs/TESTING.md` §6 |

**Not done / not verified here** (see `docs/IMPLEMENTATION_ROADMAP.md` for the full list): ETA e-Invoice/e-Receipt integration, Tauri desktop binary build (needs WebView libs; Rust store is tested), card-terminal SDKs, OpenAPI generation, XLSX/PDF exports, loyalty/gift cards, native payroll engine, SSE notifications, OpenSearch (not needed at 1M SKUs per benchmark), billing/payment gateway for subscriptions, security pentest, DR drill.

## Quick start (local)

Requirements: Node 22, pnpm 10, PostgreSQL 16 (+ `pg_trgm`, `btree_gist`), optionally Redis, Rust (for the POS store crate).

```bash
pnpm install
```

```bash
createdb rc_dev && DATABASE_OWNER_URL=postgres://postgres:postgres@localhost:5432/rc_dev pnpm --filter @rc/api migrate
```

```bash
pnpm --filter @rc/domain build && ./scripts/dev-up.sh
```

```bash
DATABASE_URL=postgres://rc_app:rc_app_dev_password@localhost:5432/rc_dev DATABASE_OWNER_URL=postgres://postgres:postgres@localhost:5432/rc_dev pnpm --filter @rc/api seed:demo
```

Then open http://localhost:3000 (back-office) and http://localhost:1420 (POS). Demo login: `demo@retailcore.app` / `DemoPassw0rd!2026`. For the POS, create a device in **Settings → Devices** and enter its ID + enrollment code; each cashier sets a 6-digit PIN from the **POS PIN** button in the web top bar (it syncs to terminals as an Argon2 hash).

Docker: `cp .env.example .env` (set secrets) then `docker compose up --build`.

## Tests

```bash
pnpm --filter @rc/domain test && pnpm --filter @rc/api test && pnpm --filter @rc/pos-desktop test && cargo test -p pos-store
```

Browser checks (servers running): `node tools/e2e/smoke.mjs` and `node tools/e2e/pos-flow.mjs`. Scale: `psql -v tenant=… -v company=… -v n=1000000 -f tools/datagen/generate.sql` then `node tools/loadtest/bench.mjs 600 20` (start the API with `RATE_LIMIT_MAX=1000000` for load tests).

## Repository

```
apps/api            Fastify API + worker (outbox → GL posting), migrations runner, demo seeder
apps/web            Next.js back-office (Arabic/English, RTL/LTR, dark mode)
apps/pos-desktop    POS UI (React/Vite) + offline engine; src-tauri = desktop shell (Rust)
apps/mobile         Expo React Native app
packages/domain     Shared business rules: money, tax, pricing, promotions, cart, costing, barcodes, permissions, schemas
crates/pos-store    Rust SQLite journal used by the Tauri shell
db/migrations       SQL migrations (schema, triggers, RLS, partitions, search functions)
tools/              e2e browser tests, data generator, load test, API doc generator
docs/               Architecture, requirements, rules, security, testing, deployment, roadmap
```

## Documentation
[REQUIREMENTS](docs/REQUIREMENTS.md) · [ARCHITECTURE](docs/ARCHITECTURE.md) · [DATABASE_SCHEMA](docs/DATABASE_SCHEMA.md) · [ACCOUNTING_RULES](docs/ACCOUNTING_RULES.md) · [INVENTORY_RULES](docs/INVENTORY_RULES.md) · [API](docs/API_DOCUMENTATION.md) · [SECURITY](docs/SECURITY.md) · [TESTING](docs/TESTING.md) · [DEPLOYMENT](docs/DEPLOYMENT.md) · [ROADMAP](docs/IMPLEMENTATION_ROADMAP.md) · [CHANGELOG](docs/CHANGELOG.md)

# Implementation Roadmap & Project Checklist

**Version:** 0.1 — Draft · Status legend: ☐ not started · ◐ in progress · ☑ done (tests green)

Sequencing principle: **financial spine first** (core → catalog → inventory → accounting), highest-risk items **spiked early** (POS sync, 1M-SKU search), clients after APIs exist.

Duration estimates assume a team of ~6–8 engineers (2 BE, 2 FE, 1 Rust/desktop, 1 mobile (from M6), 1 QA, part-time DevOps) and are **estimates, not commitments**. A smaller team scales the timeline roughly linearly.

| # | Milestone | Content | Exit criteria | Est. |
|---|---|---|---|---|
| M0 | Architecture sign-off | This document set reviewed; decisions D1–D10 approved | Signed decision log | 1–2 wk |
| M1 | Foundation | Monorepo, CI, Docker Compose, migrations framework, auth (MFA), org hierarchy, RBAC+scope+RLS, audit log, numbering, settings, i18n/RTL shell, design tokens, outbox + jobs | Authorization matrix tests green; RLS isolation tests green | 5–6 wk |
| M2 | Catalog + datagen + **spikes** | PIM (products, variants, barcodes, UoM, categories, brands, assortment), duplicates/similar-name, import/export, bulk ops, history; OpenSearch indexing; synthetic 1M-SKU dataset. **Spike:** POS sync protocol prototype (push/pull, idempotency) | Search p95 < 300 ms on 1M dataset; import 1M rows; sync spike passes duplicate-replay test | 6–7 wk |
| M3 | Inventory engine | Locations, moves, quants, reservations, transfers (2-step), adjustments, lots/serials/expiry, counts (web), valuation (avg + FIFO), negative stock policy | Conservation & quant=Σmoves invariants; concurrency tests (no deadlocks at 200 parallel writers) | 6–8 wk |
| M4 | Accounting core | COA + Egyptian template, journals, posting engine + mappings, periods/locks, GL, TB, P&L, BS, cash-flow, inventory→GL postings, reversal | Zero unbalanced; sub-ledger = GL; period lock DB tests | 7–8 wk |
| M5 | Pricing + Purchasing + AP | Price lists, scheduled prices, promotions engine (`@rc/domain`), suppliers, PR→PO→GRN→Invoice, 3-way match, returns, AP, payments, WHT, supplier statements | Full P2P acceptance suite | 7–8 wk |
| M6 | POS desktop (online) | Tauri app, hardware (printer, drawer, scanner), checkout, payments, returns/exchanges, shifts, X/Z reports, sales sub-ledger, session GL posting, cashier KPIs | Checkout acceptance + hardware certification on standard models | 7–8 wk |
| M7 | POS offline + sync hardening | SQLCipher store, journal, outbox, snapshots, device enrollment/revocation, conflict policies, quarantine UI, sync monitoring, crash recovery | Chaos tests (kill -9, power loss), reconnect storm test | 5–6 wk |
| M8 | AR, bank, cash, expenses, ETA | Customers/AR, bank statement import & reconciliation, card settlement reconciliation, expenses + approvals, ETA e-Receipt/e-Invoice integration (per validated spec) | ETA preprod certification; reconciliation acceptance | 6–8 wk |
| M9 | Reporting | Read models, operational dashboards, report builder (filters/grouping/drill-down), saved reports, async XLSX/CSV/PDF | Report performance targets | 5–6 wk |
| M10 | Mobile | Executive dashboard, lookup, scanning, offline stocktake, approvals, notifications, attendance | Offline count sync tests | 6–7 wk (parallel from M8) |
| M11 | HR-lite | Employees, attendance import, payroll import → posting | Payroll posting acceptance | 3 wk |
| M12 | Hardening & pilot | Full load test, security review/pentest, DR drill, data migration tooling, pilot branch go-live | Go-live checklist | 6–8 wk |

Indicative total: **~16–20 months** to a production pilot with the full v1 scope. Fastest path to business value: a **"Core Retail MVP" = M1–M7** (catalog, inventory, accounting, purchasing, POS offline) ≈ 11–13 months.

---

## Project-wide checklist

### Documentation
- ☑ REQUIREMENTS.md (draft) · ☑ ARCHITECTURE.md (draft) · ☑ DATABASE_SCHEMA.md (draft) · ☑ ACCOUNTING_RULES.md (draft) · ☑ INVENTORY_RULES.md (draft) · ☑ API_DOCUMENTATION.md (draft) · ☑ SECURITY.md (draft) · ☑ DEPLOYMENT.md (draft) · ☑ TESTING.md (draft) · ☑ CHANGELOG.md · ☑ IMPLEMENTATION_ROADMAP.md
- ☐ Decision log D1–D24 approved
- ☐ ADR files written for each ADR (docs/adr/)

### M1 Foundation
☐ monorepo & CI · ☐ DB migrations framework · ☐ auth + MFA · ☐ org hierarchy · ☐ RBAC + scopes · ☐ RLS · ☐ audit log · ☐ numbering · ☐ settings hierarchy · ☐ outbox + BullMQ · ☐ web shell (RTL/LTR, dark/light, tokens) · ☐ authz matrix test harness

### M2 Catalog
☐ products/variants · ☐ barcodes (+aliases, pack, weighted) · ☐ UoM & conversions · ☐ categories/brands · ☐ supplier links · ☐ branch assortment · ☐ duplicate & similar-name detection · ☐ merge workflow · ☐ bulk edit/price/category · ☐ import/export streaming · ☐ history · ☐ OpenSearch · ☐ datagen 1M · ☐ sync spike

### M3 Inventory
☐ locations · ☐ moves & quants · ☐ reservations · ☐ transfers 2-step · ☐ adjustments + reasons + approvals · ☐ scrap/damage/loss · ☐ lots/expiry · ☐ serials · ☐ counts · ☐ avg costing · ☐ FIFO costing · ☐ negative stock policy · ☐ analytics (aging, ABC, turnover, dead stock) · ☐ replenishment

### M4 Accounting
☐ COA + template · ☐ journals · ☐ posting engine & mappings · ☐ periods/locks · ☐ reversal · ☐ GL/TB · ☐ P&L/BS/CF · ☐ inventory postings · ☐ cost centers & allocations

### M5 Pricing & Purchasing
☐ price lists · ☐ scheduled prices · ☐ promotions engine · ☐ suppliers · ☐ PR · ☐ RFQ · ☐ PO + approvals · ☐ GRN · ☐ supplier invoice · ☐ 3-way match · ☐ purchase returns/credit notes · ☐ AP + payments + WHT · ☐ supplier statements/performance · ☐ landed costs

### M6–M7 POS
☐ Tauri shell · ☐ hardware drivers · ☐ checkout · ☐ payments/split · ☐ returns/exchanges · ☐ shifts/X/Z · ☐ cashier KPIs · ☐ SQLCipher store · ☐ journal/outbox · ☐ push/pull · ☐ snapshots · ☐ device enrollment · ☐ conflict policies · ☐ quarantine UI · ☐ monitoring · ☐ crash recovery

### M8–M12
☐ AR · ☐ bank recon · ☐ card settlement recon · ☐ expenses · ☐ ETA · ☐ read models · ☐ dashboards · ☐ report builder · ☐ exports · ☐ mobile · ☐ HR-lite · ☐ load test · ☐ pentest · ☐ DR drill · ☐ migration tooling · ☐ pilot

## Top risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Scope creep / everything in parallel | High | High | Milestone gates; MVP = M1–M7 |
| ETA spec/obligation changes | Medium | High | Isolated `eta` module; early tax-advisor validation (D8) |
| POS sync edge cases (duplicates, lost sales) | Medium | Critical | Early spike (M2), chaos testing, quarantine-not-discard |
| Costing errors discovered after go-live | Medium | Critical | Invariant tests, sub-ledger=GL check, controller sign-off on rules |
| Hardware diversity in stores | High | Medium | Certified hardware list (D24) |
| Rust/Tauri skill gap | Medium | Medium | Keep Rust core thin; Electron fallback documented (ADR-010) |
| Data migration from legacy | High | High | Dedicated migration tooling + dry runs in M12 |

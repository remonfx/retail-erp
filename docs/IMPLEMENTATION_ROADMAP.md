# Implementation Roadmap & Status

**Version:** 0.2 · **Date:** 2026-11-06 · Legend: ☑ done and covered by automated tests · ◐ built, partially verified · ☐ not started

Deployment model decided: **SaaS multi-tenant** (D1). Other §9 decisions were taken at their proposed defaults so work could proceed without blocking; each is configurable and listed in REQUIREMENTS.md §9.4 for business confirmation.

## Status by milestone

| # | Milestone | Status | Notes |
|---|---|---|---|
| M0 | Architecture sign-off | ☑ | Docs v0.1 → v0.2 reflect what was built |
| M1 | Foundation (SaaS tenancy, auth, RBAC+scope, RLS, audit, numbering, outbox, web shell) | ☑ | |
| M2 | Catalog + datagen + sync spike | ☑ | 1M-SKU dataset and benchmark done |
| M3 | Inventory engine | ☑ | |
| M4 | Accounting core | ☑ | |
| M5 | Pricing + purchasing + AP | ☑ | Landed costs ☐ |
| M6 | POS desktop (online) | ◐ | UI + engine verified in browser; Tauri binary not built in CI env; ESC/POS command written, not tested on hardware |
| M7 | POS offline + sync hardening | ☑ | Snapshot download ☐ (initial load pages through delta feed) |
| M8 | AR, bank, cash, expenses, **ETA** | ◐ | Expenses, payments, AP ☑; bank statement import ☐; card settlement reconciliation ☐; **ETA e-Invoice/e-Receipt ☐** |
| M9 | Reporting | ◐ | Dashboards, statements, sales/inventory analytics ☑; saved reports ☐; XLSX/PDF ☐ (CSV + print ☑) |
| M10 | Mobile | ◐ | Typecheck + Android bundle ☑; not run on a device |
| M11 | HR-lite | ◐ | Employees, attendance, payroll import → GL built; payroll posting not yet covered by a test |
| M12 | Hardening & pilot | ☐ | Pentest, DR drill, legacy migration tooling, pilot branch |

## Detailed checklist

### Platform / SaaS
☑ tenant signup & provisioning · ☑ plans & limits (companies/branches/terminals/users/SKUs) · ☑ plan change with downgrade guard · ☐ billing / payment gateway (Paymob/Fawry) · ☐ tenant data export & deletion (PDPL) · ☐ custom domains / SSO

### Security
☑ Argon2id · ☑ JWT + refresh rotation & reuse detection · ☑ TOTP MFA · ☑ RBAC × scope · ☑ RLS (tenant + company) · ☑ SoD rules · ☑ maker-checker (journals, approvals, counts) · ☑ audit log (row triggers + commands) · ☑ idempotency keys · ☑ per-credential rate limiting · ☐ MFA enforced by role policy (currently opt-in) · ☐ 4-eyes for privileged role grants · ☐ audit hash chain · ☐ WebAuthn · ☐ device key-pair signing (v1 uses per-device secret over TLS)

### Catalog & pricing
☑ products/variants/barcodes/UoM · ☑ scale & price-embedded barcodes · ☑ duplicates & similar names · ☑ merge · ☑ bulk edit / price · ☑ CSV import (set-based) & streaming export · ☑ branch assortment · ☑ price lists & tiers · ☑ promotions + approval · ☐ product images upload (table exists, no storage integration) · ☐ bundles/kits

### Inventory
☑ moves/quants · ☑ avg & FIFO · ☑ lots/expiry · ☑ serials · ☑ adjustments/scrap with thresholds · ☑ transfers 2-step · ☑ counts · ☑ negative-stock exceptions · ☑ ABC / dead stock / aging / turnover / expiring lots · ☑ replenishment suggestions · ☐ reservations from sales orders · ☐ bin-level put-away · ☐ landed cost

### Accounting
☑ COA template · ☑ posting engine & mappings · ☑ periods & locks · ☑ reversal · ☑ TB/P&L/BS/CF/VAT/GL/AP aging · ☑ payments & WHT · ☑ expenses · ☑ opening balances · ☐ bank statement import & reconciliation · ☐ card settlement matching · ☐ multi-currency revaluation · ☐ year-end closing entry · ☐ intercompany elimination · ☐ cost allocations

### POS
☑ engine (offline journal, outbox, sync, X/Z, returns with receipt, cash movements, supervisor override) · ☑ web/Tauri UI · ☑ device enrollment & revocation · ☑ quarantine & monitoring · ◐ Tauri shell (code written; build needs WebView libs) · ◐ ESC/POS printing (browser print works; raw printer untested) · ☐ customer display · ☐ integrated card terminals · ☐ gift cards / loyalty · ☐ ETA e-Receipt QR

### Mobile
◐ dashboard · ◐ barcode lookup (camera) · ◐ approvals · ◐ offline stocktake queue · ◐ attendance with location — all compile; device testing pending

## Highest-value next steps (in order)
1. **ETA e-Receipt / e-Invoice** — legal blocker for go-live; needs official ETA SDK specs and test credentials.
2. **Tauri build & hardware certification** on the chosen printer/scanner/drawer models (D24).
3. **Bank & card settlement reconciliation** — closes the cash loop for month-end.
4. **Billing for the SaaS** (subscription invoices + payment gateway).
5. **Security hardening**: enforce MFA for finance/admin roles, pentest, restore drill.

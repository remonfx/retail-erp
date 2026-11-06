# Software Requirements Specification (SRS)

**Project:** Enterprise Retail ERP (working name: `RetailCore`)
**Version:** 0.1 — Architecture Draft (for review)
**Date:** 2026-11-05
**Status:** DRAFT — awaiting business-rule approval. No implementation starts before sign-off of §9.

---

## 1. Purpose & Scope

A multi-company, multi-branch, multi-warehouse retail ERP for large department stores, hypermarkets and retail chains operating primarily in Egypt (EGP, Arabic-first, Africa/Cairo), with international expansion designed in from day one.

### 1.1 In scope (v1 product)
| # | Module | Code |
|---|--------|------|
| 1 | Platform core: tenancy, org hierarchy, users, RBAC, audit, numbering, settings | `core` |
| 2 | Product Information Management (PIM) | `catalog` |
| 3 | Pricing & promotions | `pricing` |
| 4 | Inventory & warehouse engine | `inventory` |
| 5 | Purchasing & suppliers | `purchasing` |
| 6 | POS (desktop, offline-first) | `pos` |
| 7 | Sales back-office (returns, customers, AR) | `sales` |
| 8 | Accounting (GL, AP, AR, cash/bank, tax, periods) | `accounting` |
| 9 | Reporting & dashboards | `reporting` |
| 10 | Approvals & notifications | `workflow` |
| 11 | Mobile app (approvals, lookup, stocktake, dashboards, attendance) | `mobile` |
| 12 | HR-lite: employees, attendance, payroll *journal import* | `hr` |
| 13 | Egyptian Tax Authority (ETA) e-Invoice / e-Receipt integration | `eta` |

### 1.2 Explicitly out of scope for v1 (proposed — needs approval)
- Native payroll calculation engine (Egyptian social insurance & income tax brackets). **v1 imports payroll results and posts journals.** Rationale in §9.
- E-commerce storefront (API-ready; storefront integration is v2).
- Manufacturing / BOM / kitting beyond simple bundles.
- Full CRM / marketing automation (v1 = customer master + loyalty hooks).
- Consolidation with currency translation for foreign subsidiaries (v1 = same-currency consolidation + intercompany elimination).

---

## 2. Stakeholders & User Classes

| User class | Primary app | Key goals |
|---|---|---|
| Owner / Executive | Web, Mobile | Consolidated KPIs, approvals, branch comparison |
| General Manager | Web, Mobile | Operations oversight, approvals |
| Financial Controller | Web | Period close, statements, posting rules, reconciliation |
| Accountant / AP / AR clerk | Web | Invoices, payments, journals, reconciliation |
| Inventory Manager | Web, Mobile | Stock health, replenishment, adjustments approval |
| Warehouse Clerk | Desktop (WMS station), Mobile | Receiving, picking, transfers, counting |
| Purchasing Manager / Buyer | Web | PR → PO → GRN → Invoice, supplier performance |
| Branch Manager | Web, Mobile | Branch P&L, staff, local approvals |
| Shift Supervisor | Desktop POS | Overrides, voids, refunds approval, shift close |
| Cashier | Desktop POS | Fast checkout, minimal clicks |
| HR Manager | Web | Employees, attendance, payroll import |
| Internal / External Auditor | Web (read-only) | Audit trail, ledgers, evidence |
| System Administrator (IT) | Web | Users, devices, integrations — **no financial posting rights** |

---

## 3. Operating Environment & Constraints

| Item | Requirement |
|---|---|
| Default country / currency | Egypt / EGP (2 decimals); multi-currency transactions supported for imports |
| Languages | Arabic (RTL, default) and English (LTR); all master data has `name_ar`, `name_en` |
| Timezone | Africa/Cairo for business dates; **all timestamps stored in UTC (`timestamptz`)** |
| Business date | Derived per branch timezone; POS shift business date can differ from calendar date (after-midnight shifts) |
| Tax | Configurable tax engine. Egyptian VAT standard rate is 14% (Law 67/2016) — **all rates, exemptions, table tax, and withholding rules must be configured and validated against current ETA rules before go-live** |
| E-invoicing | ETA e-Invoice (B2B) and e-Receipt (B2C POS) — **mandatory scope to validate with a tax advisor; technical specs must be pulled from official ETA SDK docs at implementation time** |
| Data protection | Egypt Personal Data Protection Law 151/2020 — hosting location and cross-border transfer must be validated |
| Browsers | Last 2 versions of Chrome, Edge, Safari, Firefox |
| Desktop OS | Windows 10/11 (primary POS), Linux optional |
| Mobile OS | Android 10+ (primary, incl. rugged scanners), iOS 16+ |

---

## 4. Functional Requirements

Notation: `FR-<module>-<nn>`. Priority: **M** = Must (v1), **S** = Should (v1 if time), **C** = Could (later).

### 4.1 Core / Platform
| ID | Requirement | P |
|---|---|---|
| FR-CORE-01 | Hierarchy: Tenant → Company (legal entity) → Branch → Warehouse → Location (tree) | M |
| FR-CORE-02 | Every operational record carries `company_id` and, where applicable, `branch_id` and `warehouse_id` | M |
| FR-CORE-03 | Users can be assigned roles per scope (company / branch / warehouse); a user may hold different roles in different branches | M |
| FR-CORE-04 | Immutable audit log for every create/update/delete/state transition (who, when, device, IP, before/after) | M |
| FR-CORE-05 | Configurable document numbering per company/branch/doc type/fiscal year (e.g. `PO-CAI01-2026-000123`) | M |
| FR-CORE-06 | Global search across documents, products, partners (permission-filtered) | M |
| FR-CORE-07 | Settings hierarchy: system → company → branch → terminal (override with audit) | M |
| FR-CORE-08 | Attachments on any document (object storage, virus scan) | S |
| FR-CORE-09 | Bilingual UI with per-user language and RTL/LTR switching without reload | M |

### 4.2 Catalog (PIM)
| ID | Requirement | P |
|---|---|---|
| FR-CAT-01 | Product template + variants (size, color, any attribute); SKU per variant | M |
| FR-CAT-02 | Multiple barcodes per variant (EAN-13, EAN-8, UPC, Code128, internal), each with optional UoM/pack (e.g. barcode for carton of 12) | M |
| FR-CAT-03 | Barcode aliases & retired barcodes kept for historical lookup | M |
| FR-CAT-04 | **Weighted / price-embedded barcodes** (scale labels, e.g. prefix 2x) with configurable parsing rules | M (hypermarket) |
| FR-CAT-05 | Category tree (unlimited depth, materialized path), brand, supplier links (supplier SKU, cost, lead time, MOQ, preferred) | M |
| FR-CAT-06 | UoM with categories and conversion factors; purchase UoM, sales UoM, stock UoM | M |
| FR-CAT-07 | Images (multi, ordered), descriptions AR/EN | M |
| FR-CAT-08 | Tax class per product (overridable per company) | M |
| FR-CAT-09 | Status lifecycle: draft → active → discontinued → archived; blocked-for-sale / blocked-for-purchase flags | M |
| FR-CAT-10 | Branch assortment: which products are sellable/stockable in which branch, with branch reorder point/min/max | M |
| FR-CAT-11 | Uniqueness: duplicate SKU and active-barcode detection (DB-enforced) | M |
| FR-CAT-12 | Similar-name detection (Arabic-normalized trigram similarity) at creation and as a batch report | M |
| FR-CAT-13 | Product merge workflow: choose survivor, re-point barcodes/supplier links/assortment; historical transactions keep original IDs with `merged_into` redirect | M |
| FR-CAT-14 | Bulk edit, bulk price update, bulk category assignment — executed as background jobs with preview, approval (above threshold) and per-row result report | M |
| FR-CAT-15 | Import/export (CSV/XLSX) for ≥1M rows via streaming jobs with validation report | M |
| FR-CAT-16 | Full change history per product (field-level) | M |
| FR-CAT-17 | Bundles / packs (sell a pack, deduct components) | S |

### 4.3 Pricing & Promotions
| ID | Requirement | P |
|---|---|---|
| FR-PRC-01 | Price lists (retail, wholesale, custom) with currency, effective-from/to dates, scope (company / branch / branch group) | M |
| FR-PRC-02 | Price resolution order: branch price list → branch-group → company default; documented and unit-tested | M |
| FR-PRC-03 | Scheduled price changes (future-dated), shelf-label print list of changed items | M |
| FR-PRC-04 | Promotions: % / amount off, buy X get Y, mix-and-match, bundle price, tiered quantity, basket threshold, coupon codes; scope by branch, date/time window, customer group | M |
| FR-PRC-05 | Promotion stacking & priority rules; exclusivity flags | M |
| FR-PRC-06 | Manual discount limits per role (line %, basket %); above-limit requires supervisor override (PIN/badge) | M |
| FR-PRC-07 | Margin guard: warn/block selling below cost (configurable) | S |

### 4.4 Inventory & Warehouse
See [INVENTORY_RULES.md](INVENTORY_RULES.md) for normative rules.
| ID | Requirement | P |
|---|---|---|
| FR-INV-01 | All stock changes are immutable stock moves between two locations (no direct quantity edits) | M |
| FR-INV-02 | Operations: receipt, issue, sale, sale return, purchase return, internal transfer, inter-branch transfer (2-step via transit), adjustment, stock count, scrap/damage, loss | M |
| FR-INV-03 | Stock states: on-hand, reserved, available, in-transit, quarantined | M |
| FR-INV-04 | Costing: Weighted Average (default) and FIFO, chosen per company (or per category), locked once movements exist | M |
| FR-INV-05 | Lot/batch tracking with expiry; FEFO suggestion; expiry alerts; block sale of expired lots | M |
| FR-INV-06 | Serial number tracking (electronics, appliances) | M |
| FR-INV-07 | Negative stock blocked by default; controlled exceptions (per branch / category / POS offline) create a flagged exception record | M |
| FR-INV-08 | Adjustments require reason code + approval above value/qty thresholds | M |
| FR-INV-09 | Stocktaking: full, cycle, blind counts; freeze snapshot; multi-counter; variance review & approval; mobile counting offline | M |
| FR-INV-10 | Analytics: valuation, aging, ABC (by value/qty/margin), turnover, dead stock, days of cover | M |
| FR-INV-11 | Replenishment: min/max & reorder-point suggestions per branch → draft PR / transfer request | M |
| FR-INV-12 | Landed costs (freight, customs, clearance) allocated to receipts by value/qty/weight | S (M if importing) |

### 4.5 Purchasing
| ID | Requirement | P |
|---|---|---|
| FR-PUR-01 | Supplier master (tax ID, commercial register, payment terms, bank accounts, contacts, currency) | M |
| FR-PUR-02 | Purchase request → RFQ/quotation → PO → approval → GRN → supplier invoice → payment | M |
| FR-PUR-03 | Approval matrix by amount, category, branch | M |
| FR-PUR-04 | Partial receipts, back-orders, over/under-receipt tolerance | M |
| FR-PUR-05 | Three-way match (PO / GRN / invoice) with price & qty tolerances; mismatches routed for approval | M |
| FR-PUR-06 | Purchase returns & supplier credit/debit notes | M |
| FR-PUR-07 | Payment scheduling by due date; supplier statement; aging | M |
| FR-PUR-08 | Supplier performance: on-time %, fill rate, price variance, return rate | S |
| FR-PUR-09 | **Consignment purchasing** (supplier-owned stock, settle on sale) | **Needs decision** |
| FR-PUR-10 | Supplier rebates / volume incentives | C |

### 4.6 POS
| ID | Requirement | P |
|---|---|---|
| FR-POS-01 | Scan-to-cart < 100 ms local; keyboard-only checkout; F-key mapping | M |
| FR-POS-02 | Instant search (local index of branch assortment) by barcode, SKU, AR/EN name | M |
| FR-POS-03 | Qty change, line void (with reason), price override (permission), discounts, promotions auto-apply | M |
| FR-POS-04 | Payments: cash, card (integrated or standalone terminal ref), wallet/InstaPay ref, voucher, store credit, split tender | M |
| FR-POS-05 | Refunds & exchanges (with original receipt lookup; no-receipt refunds by permission) | M |
| FR-POS-06 | Customer selection/creation (phone-based) | M |
| FR-POS-07 | Receipt print (ESC/POS thermal, AR/EN, QR for e-receipt), reprint with "COPY" mark | M |
| FR-POS-08 | Shift open (float), cash in/out, X-report, Z-report, blind cash count, over/short | M |
| FR-POS-09 | Suspend/resume transaction | M |
| FR-POS-10 | Offline operation with durable local journal & idempotent sync (see ARCHITECTURE §6) | M |
| FR-POS-11 | Cashier performance (items/min, scans/min, voids, overrides, over/short) | M |
| FR-POS-12 | Hardware: thermal printer, scanner (HID/serial), cash drawer, customer display, scale | M (scale = S) |

### 4.7 Accounting
See [ACCOUNTING_RULES.md](ACCOUNTING_RULES.md).
| ID | Requirement | P |
|---|---|---|
| FR-ACC-01 | Chart of accounts per company (template-based, Egyptian template provided) | M |
| FR-ACC-02 | Double-entry journals; posted journals immutable; corrections via reversal | M |
| FR-ACC-03 | Automatic posting from operational events via configurable posting rules | M |
| FR-ACC-04 | GL, trial balance, P&L, balance sheet, cash-flow (indirect method), all with branch/cost-center dimensions | M |
| FR-ACC-05 | AP, AR with aging, partial payments, matching/reconciliation | M |
| FR-ACC-06 | Cash & bank accounts, bank statement import & reconciliation, card settlement reconciliation | M |
| FR-ACC-07 | Expenses with approvals, cost center allocation | M |
| FR-ACC-08 | Tax engine: VAT output/input, withholding tax, tax reports | M |
| FR-ACC-09 | Fiscal years, periods, soft/hard lock, closing procedures, year-end close | M |
| FR-ACC-10 | Multi-currency with exchange rates & realized/unrealized FX differences | S |
| FR-ACC-11 | Intercompany transactions & elimination for consolidation | S |
| FR-ACC-12 | Budgets vs actuals by cost center | C |

### 4.8 Reporting
| ID | Requirement | P |
|---|---|---|
| FR-REP-01 | Operational dashboards (near-real-time) separate from formal statements (GL-sourced) | M |
| FR-REP-02 | Filters: date, branch, warehouse, product, category, supplier, employee; dynamic grouping; drill-down to document | M |
| FR-REP-03 | Saved reports & views (per user / shared) | M |
| FR-REP-04 | Export XLSX / CSV / PDF; async generation for large outputs with notification & download link | M |
| FR-REP-05 | Scheduled reports by email | S |

### 4.9 Mobile
FR-MOB-01..10: executive dashboard, branch performance, inventory lookup, barcode scan (camera + rugged scanner intent), stocktaking (offline), transfer / purchase / expense approvals, push notifications, attendance check-in (geofence + selfie optional), management reports. All **M** except attendance geofence (**S**).

### 4.10 HR-lite
FR-HR-01 employee master linked to users & branches (M); FR-HR-02 attendance (mobile/biometric import) (M); FR-HR-03 payroll result import → journal posting (M); FR-HR-04 native payroll engine (C — v2).

---

## 5. Non-Functional Requirements

| ID | Category | Requirement (engineering target, validated by load test — see TESTING.md) |
|---|---|---|
| NFR-01 | Scale | ≥ 1,000,000 active SKUs; ≥ 3,000,000 barcodes; ≥ 100 branches; ≥ 1,000 POS terminals |
| NFR-02 | Volume | ≥ 500 M stock moves and ≥ 1 B journal lines over lifetime without redesign (partitioning) |
| NFR-03 | Concurrency | 300+ concurrent back-office users (initial benchmark) + POS sync traffic |
| NFR-04 | Latency | Product search p95 < 300 ms; common API p95 < 500 ms; POS local scan-to-line p95 < 100 ms |
| NFR-05 | Integrity | 0 duplicate sales from sync retries; 0 unbalanced posted journals; 0 stock moves without source document |
| NFR-06 | Availability | Back-office 99.5% monthly (v1 target); POS unaffected by back-office outage (offline mode) |
| NFR-07 | Durability | RPO ≤ 5 min, RTO ≤ 2 h (proposed); POS local journal survives power loss (SQLite WAL + fsync) |
| NFR-08 | Security | See SECURITY.md: RBAC+scope, MFA for privileged roles, encryption in transit/at rest, audit |
| NFR-09 | Usability | Core POS sale ≤ 3 interactions beyond scanning; WCAG 2.1 AA for web |
| NFR-10 | i18n | 100% UI strings externalized; RTL-correct layouts; Arabic-normalized search |
| NFR-11 | Maintainability | Modular monolith with enforced module boundaries; ≥ 80% domain-logic test coverage |
| NFR-12 | Observability | Structured logs, traces (OpenTelemetry), metrics, sync-health dashboard |

---

## 6. External Interfaces
- **ETA** e-Invoice/e-Receipt APIs (OAuth client credentials, document signing). Spec to be confirmed from official docs.
- **Card terminals** (bank-provided). v1: standalone with manual reference capture; integrated SDK per acquirer = S.
- **Bank statements**: CSV/MT940/CAMT import.
- **Biometric attendance devices**: CSV/API import.
- **Payroll provider**: import format TBD.
- **Email/SMS/WhatsApp** notifications provider: TBD.

---

## 7. Data Retention
- Financial and tax records: minimum retention per Egyptian law — **to be confirmed by legal/tax advisor** (design assumes ≥ 10 years online-or-archived).
- Audit logs: ≥ 7 years (proposed), partitioned & archived to cold storage after 24 months.
- POS local journal: purged only after server-confirmed sync + configurable grace period (default 30 days).

---

## 8. Assumptions (explicit)
| # | Assumption | Impact if wrong |
|---|---|---|
| A1 | One central backend (cloud or customer data-center); not one server per branch | Branch servers would require a different sync topology |
| A2 | A single tenant per deployment is acceptable for v1 (dedicated instance per customer), schema still multi-company | SaaS multi-tenant would require tenant_id + RLS from day one — **design already includes `tenant_id` to keep this open** |
| A3 | Branch assortment ≪ global catalog (typ. 30k–150k SKUs per branch) | If a branch sells all 1M SKUs, POS local DB grows to ~2–4 GB; still feasible but slower initial provisioning |
| A4 | Card payments v1 = standalone terminals | Integrated terminals need per-bank SDKs and certification |
| A5 | Inventory valuation at company level (one average cost per product per company) | Per-branch costing changes transfer and COGS rules |
| A6 | Payroll computed outside the system in v1 | Native payroll adds ~3–4 months |

---

## 9. Missing Business Requirements & Decisions Needed (BLOCKING)

These must be answered/approved before the relevant module is implemented. Proposed default is in **bold**.

### 9.1 Critical (block Milestone 1–3)
| # | Question | Proposed default | Why it matters |
|---|---|---|---|
| D1 | Deployment model: single-customer (on-prem/private cloud) or multi-tenant SaaS? | **Single-customer deployment, multi-tenant-ready schema** | Affects RLS, billing, isolation, ops |
| D2 | Inventory costing method | **Weighted average (perpetual), company level** | Changes COGS, valuation, transfers; cannot change after go-live without migration |
| D3 | Are there consignment / concession suppliers (very common in Egyptian department stores)? | **Yes — model supplier-owned stock (ownership field on quants)** | Consignment stock must not appear in our balance sheet; settlement on sale |
| D4 | Weighted/scale barcodes in fresh departments? Prefix and format? | **Support configurable GS1 prefix 20–29 rules** | Hypermarket checkout blocker |
| D5 | POS GL posting granularity | **Sub-ledger per receipt; GL summarized per shift session** | Per-receipt GL = ~10–30× more journal lines |
| D6 | Discount accounting | **Gross revenue + "Sales Discounts" contra account** | Visibility vs simplicity |
| D7 | Negative stock exceptions | **Blocked online; allowed offline POS with exception record; never for serial/lot items** | Hypermarket reality vs control |
| D8 | ETA e-Receipt / e-Invoice — are all companies in scope now, and which phase? | **Build integration in M8; validate obligation with tax advisor** | Legal compliance |
| D9 | Withholding tax (advance payment system) on supplier payments — applicable rates/categories? | **Configurable WHT per supplier/service category** | AP payment amounts & tax reports |
| D10 | Fiscal year | **Jan–Dec, monthly periods** | Period setup |

### 9.2 Important (block Milestone 4–7)
| # | Question | Proposed default |
|---|---|---|
| D11 | Maximum allowed offline duration for a POS terminal | **72 h, then sales blocked until sync (configurable)** |
| D12 | Offline returns policy | **Allowed only for receipts in local DB, same branch; otherwise online required** |
| D13 | Offline payment methods | **Cash, standalone card (ref captured), vouchers issued offline blocked; store-credit redemption blocked** |
| D14 | Loyalty program & gift cards in v1? | **Gift cards/vouchers yes (online validation); loyalty points v2** |
| D15 | Customer credit sales at POS (B2B accounts)? | **Allowed online only, credit-limit check server-side** |
| D16 | Inter-company transfers between legal entities — at cost or at transfer price? | **Transfer price list; intercompany invoices auto-generated** |
| D17 | Landed cost needed (direct importing)? | **Yes, if any company imports** |
| D18 | Installment providers (valU, Aman, Souhoola…) & wallets — integrate or record as tender types? | **Record as tender types with clearing accounts in v1** |
| D19 | Approval thresholds (PO, adjustments, price changes, expenses) | Needs values from business |
| D20 | Return window & refund method rules | Needs values from business |
| D21 | Number of companies/branches/terminals at go-live and in 3 years | Needed for capacity plan |
| D22 | Data migration source system(s) and scope (opening balances only vs history) | **Opening balances + 2 years sales summary** |
| D23 | Hosting location & data-residency requirement | Needs legal confirmation (PDPL 151/2020) |
| D24 | Hardware standard (printer models, scanners, scales, card terminals) | Needed for driver certification |

### 9.3 Scope challenge (recommendation)
The specification describes roughly the surface area of a mature ERP suite. Building **everything** to production quality concurrently is the main project risk. Recommendation:
1. **Build the "financial spine" first** — core, catalog, inventory engine, accounting engine — because every other module posts into them. Mistakes there are the most expensive to fix later.
2. **POS offline is the second highest-risk component** — prototype the sync protocol early (Milestone 2 spike) even though the full POS ships later.
3. **Defer native payroll, loyalty, e-commerce, budgets** — they don't affect the core data model if hooks are designed now.
4. **Mobile app ships after web approvals exist** — it is a client of existing APIs, low architectural risk.

---

### 9.4 Decision log (2026-11-06)
| # | Decision | Status |
|---|---|---|
| D1 | **SaaS multi-tenant** (one database, `tenant_id` on every row, PostgreSQL RLS) | **Decided by owner** |
| D2 | Weighted average, company level (FIFO available per company on Growth+) | Default adopted — confirm with controller |
| D3 | Consignment supported (`owner_id` on quants, supplier flag; no GL on receipt) | Default adopted |
| D4 | Scale labels: prefix 21 = weight (5+5, 3 decimals), 22 = price (5+5, 2 decimals), configurable | Default adopted |
| D5 | POS GL summarized per session; receipt-level sub-ledger | Default adopted |
| D6 | Gross revenue + Sales Discounts contra account | Default adopted |
| D7 | Negative stock blocked for back-office docs; POS sync accepts sale + exception | Default adopted |
| D8 | ETA integration **not built yet** — top of roadmap | Open |
| D9 | WHT entered per payment (`whtAmount`); category rates table not yet | Partially done |
| D10 | Calendar fiscal year, monthly periods (3 years provisioned) | Default adopted |
| D11 | Max offline 72 h (terminal setting) | Default adopted |
| D12 | Offline returns only for receipts present on the terminal | Default adopted |
| D13 | Offline tenders: cash, card, wallet, InstaPay, BNPL refs; vouchers/store credit blocked | Default adopted |
| D19 | Approval thresholds: PO/payment/expense = 0 (everything approved) — **set real values per company** in company settings | Needs business values |

# Changelog

All notable changes to this project are documented here. Format: Keep a Changelog; versioning: SemVer.

## [Unreleased]

### Added — 2026-11-05 — Architecture draft 0.1
- SRS with functional/non-functional requirements, assumptions, and 24 open business decisions (REQUIREMENTS.md).
- System architecture, module dependency map, multi-branch design, POS offline sync protocol, API and performance strategy (ARCHITECTURE.md).
- ERDs and normative DDL excerpts for org, catalog, inventory, accounting, POS (DATABASE_SCHEMA.md).
- Posting rules (ACCOUNTING_RULES.md) and inventory/costing rules (INVENTORY_RULES.md).
- Permission matrix and security controls (SECURITY.md), API conventions, testing strategy, deployment outline, roadmap with checklist.
- No application code yet — implementation blocked pending architecture review (Part 16).

## [0.2.0] — 2026-11-06 — First working system (SaaS)
### Added
- `packages/domain`: decimal money, Egyptian VAT engine (inclusive/exclusive, compounding), price resolution, promotions engine, cart, tender settlement with cash rounding, weighted-average/FIFO costing, GS1 & scale barcodes, Arabic normalization, permission catalog & role templates, sync schemas.
- 11 SQL migrations: SaaS tenancy, org hierarchy, identity, catalog, pricing, inventory ledger (partitioned), accounting with DB-enforced immutability/balance/period locks, purchasing, POS & sync inbox, HR-lite, RLS, worker functions, RLS-safe search.
- API (Fastify, 142 endpoints) with outbox-driven GL posting worker, idempotency keys, rate limiting, audit.
- Web back-office (Next.js, 23 routes, Arabic/English, dark mode).
- POS: offline engine, React UI, Tauri shell, Rust SQLite journal.
- Mobile (Expo): dashboard, barcode lookup, approvals, offline stocktake, attendance.
- Demo seeder, 1M-SKU data generator, HTTP load test, browser e2e scripts, Docker Compose, GitHub Actions CI.
### Changed (vs architecture draft 0.1)
- Fastify instead of NestJS; raw SQL (`pg`) instead of Kysely; PostgreSQL outbox polling instead of BullMQ; `pg_trgm` instead of OpenSearch (benchmark shows it meets target at 1M SKUs); device auth = per-device secret over TLS (key-pair signing planned).
### Fixed
- Catalog search under RLS: 17 s → p95 210 ms on 1M SKUs.

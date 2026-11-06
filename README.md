# RetailCore — Enterprise Retail ERP (working name)

Multi-company, multi-branch retail ERP for large Egyptian retailers: web back-office (Next.js), offline-first POS (Tauri + SQLite), mobile (React Native), one TypeScript backend (NestJS modular monolith) on PostgreSQL.

**Status:** Architecture draft 0.1 — under review. No implementation until critical business decisions (docs/REQUIREMENTS.md §9) are approved.

## Documentation
| Doc | Content |
|---|---|
| [REQUIREMENTS.md](docs/REQUIREMENTS.md) | SRS, NFRs, assumptions, **open decisions (blocking)** |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture, trade-offs, dependency map, multi-branch, POS sync, API, performance |
| [DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md) | ERDs, DDL, partitioning, indexing, migrations |
| [ACCOUNTING_RULES.md](docs/ACCOUNTING_RULES.md) | Invariants, posting engine, posting rules, closing |
| [INVENTORY_RULES.md](docs/INVENTORY_RULES.md) | Ledger, states, costing, lots/serials, counts, analytics |
| [SECURITY.md](docs/SECURITY.md) | RBAC × scope, SoD, permission matrix, auth, DR |
| [API_DOCUMENTATION.md](docs/API_DOCUMENTATION.md) | API conventions, sync API |
| [TESTING.md](docs/TESTING.md) | Test pyramid, invariants, acceptance & performance targets |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Environments, topology, releases |
| [IMPLEMENTATION_ROADMAP.md](docs/IMPLEMENTATION_ROADMAP.md) | Milestones, checklist, risks |
| [CHANGELOG.md](docs/CHANGELOG.md) | Changes |

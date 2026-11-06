# Testing Strategy

**Version:** 0.1 — Draft

## 1. Test pyramid
| Level | Tool | Scope | Gate |
|---|---|---|---|
| Unit | Vitest | `@rc/domain` (pricing, promo, tax, rounding, UoM, costing math) — property-based tests with fast-check | 90% branch coverage on domain |
| Integration | Vitest + Testcontainers (real PostgreSQL 16, Redis, OpenSearch) | Module services incl. triggers, RLS, constraints | Every module |
| Contract | OpenAPI schema tests; generated client compile | API ↔ clients | Every PR |
| E2E web | Playwright (ar + en, RTL + LTR, light + dark) | Critical journeys | Nightly + release |
| E2E POS | Playwright on Tauri webview + Rust integration tests | Checkout, offline, recovery | Nightly + release |
| Authorization | Generated matrix tests from SECURITY.md role templates | Every endpoint × role × scope | Every PR |
| Performance | k6 + synthetic data (tools/datagen) | Targets in §4 | Weekly + pre-release |
| Chaos/recovery | Kill -9 POS during commit, network flaps, DB failover | Offline & sync | Pre-release |
| Migration | Run migrations on prod-size snapshot, measure lock times | DB | Every migration PR touching big tables |

## 2. Financial & inventory invariant tests (must always pass)
1. **Balanced journals:** `SELECT entry_id FROM journal_line GROUP BY entry_id HAVING sum(debit) <> sum(credit)` → 0 rows (posted).
2. **Immutability:** UPDATE/DELETE on posted lines/moves raises.
3. **Stock conservation:** per variant Σ quant (all locations incl. virtual) = 0; quant = Σ moves.
4. **Sub-ledger = GL:** inventory valuation total = inventory GL balance per company; AP sub-ledger = AP control account; AR likewise.
5. **No orphan moves:** every move has a valid ref document.
6. **Idempotency:** replaying the same sync batch N times (N=1..50, concurrent) → exactly one order, one set of moves, one GL effect.
7. **Period lock:** posting into hard-locked period rejected at DB level even bypassing the API.
8. **Isolation:** user of company A/branch X cannot read or write company B / branch Y (API + direct SQL under app role with RLS).

## 3. Acceptance test examples (Gherkin-style, per module)
```
Scenario: Offline sale is never duplicated
  Given terminal T1 is offline and sells receipt R1 for 250.00 EGP cash
  And the network returns and T1 pushes R1, but the ack is lost
  When T1 retries the push 3 times
  Then the server has exactly 1 pos_order with client_id R1
  And exactly 1 sale stock move per line
  And the session journal includes R1 once

Scenario: Three-way match blocks overbilling
  Given PO-1 for 100 units @ 10.00 and GRN for 90 units
  When supplier invoice for 100 units @ 10.00 is entered
  Then the invoice is "match_exception: qty" and cannot be posted without Purchasing Manager approval

Scenario: Branch manager cannot see other branches
  Given user BM assigned Branch Manager on CAI-01 only
  When BM requests GET /pos-orders?branchId=ALX-02
  Then response is 403
  And GET /pos-orders/{an ALX-02 id} is 404
```

## 4. Performance acceptance (engineering targets, defined conditions)
Dataset: 1,000,000 variants, 3,000,000 barcodes, 100 branches, 50 price lists, 20M quants, 200M stock moves, 2 years POS history (≈ 150M orders), 300 concurrent back-office virtual users, 500 POS devices syncing.
Environment: documented hardware (e.g., PG 16 cores / 64 GB / NVMe; 2 API pods × 4 vCPU) — results are only valid for the stated environment.
| Test | Target |
|---|---|
| Product search (name, AR/EN, fuzzy) | p95 < 300 ms |
| Barcode lookup API | p95 < 50 ms |
| Common API (lists, detail, create docs) | p95 < 500 ms |
| Sync push, 200-item batch | p95 < 2 s; sustained ≥ 200 receipts/s |
| Reconnect storm: 500 devices × 2,000 queued receipts | Drains < 30 min without back-office p95 degradation > 20% |
| POS local scan→line | p95 < 100 ms on reference hardware (Celeron-class, 8 GB) |
| Trial balance (1 company, 1 year) | < 2 s |
| Export 1M products CSV | < 5 min, constant memory |

## 5. Definition of Done (per module)
Requirements traced → schema + migrations → backend + permissions + audit → UI (ar/en, RTL) → unit/integration/authorization tests green → acceptance tests green → docs updated (module section + CHANGELOG) → no invariant test failures → reviewed.

---

## 6. Results (2026-11-06, single 16-vCPU / 15 GB container, PostgreSQL 16, Node 22)

| Suite | Result |
|---|---|
| Domain unit + property tests (`packages/domain`) | 27 / 27 ✅ |
| API integration (real PostgreSQL, RLS, invariants) | 28 / 28 ✅ |
| POS engine ↔ API ↔ PostgreSQL e2e | 6 / 6 ✅ |
| Rust journal (`pos-store`) | 3 / 3 ✅ |
| Browser smoke — 17 back-office screens, RTL/LTR, dark, 390 px | ✅ 0 errors |
| Browser POS flow — enroll → PIN → session → scan (incl. scale label) → pay → synced | ✅ |

Invariant checks (TESTING §2) run inside the suites after every scenario: unbalanced entries 0, quant ≠ Σmoves 0, conservation violations 0, orphan moves 0, cost-qty mismatches 0.

### Scale benchmark — 1,000,013 SKUs (1M products, 1M variants, 1M EAN-13 barcodes, 1M price items)
HTTP through the full stack (auth, RLS, JSON), 600 requests per scenario, 20 concurrent clients, same host:

| Scenario | p50 | p95 | p99 | req/s |
|---|---|---|---|---|
| Product search (Arabic-normalized name / SKU) | 139 ms | **210 ms** | 277 ms | 139 |
| Barcode lookup (exact) | 26 ms | **36 ms** | 39 ms | 768 |
| Product list page (keyset) | 44 ms | 60 ms | 71 ms | 447 |
| Dashboard (month) | 50 ms | 66 ms | 71 ms | 400 |

Finding: the first search implementation took **17 s** at p50 because RLS prevents index use for non-LEAKPROOF operators (`LIKE`, `upper()`). Fixed with SECURITY DEFINER id-lookup functions that apply the tenant filter from the session (migration 0011). Targets met: search p95 < 300 ms ✅, common API p95 < 500 ms ✅. Not yet measured: 300 concurrent users, POS reconnect storm, 200 M stock moves.

# Security Architecture & Permission Matrix

**Version:** 0.1 — Draft

## 1. Authorization model: RBAC × Scope
`effective permission = permission ∈ role AND resource scope ∈ assignment scope`

- **Permission**: `<module>.<resource>.<action>` e.g. `inventory.adjustment.approve`, `accounting.journal.post`.
- **Role**: named bundle of permissions (system templates + company-defined custom roles).
- **Assignment**: (user, role, scope_type ∈ {tenant, company, branch, warehouse}, scope_id, valid_from/to).
- **Field-level guards**: cost price, margin, supplier cost visible only with `catalog.cost.view`.
- **Limits** (attributes on assignment): max discount %, max refund amount, approval amount ceiling.
- Enforcement points: API guard (every endpoint declares required permission + scope resolver), query scope predicates, PostgreSQL RLS, UI (hiding only — never the control).

## 2. Segregation of Duties (hard rules, validated when assigning roles)
| Conflict | Rule |
|---|---|
| Create supplier + approve supplier payment | Not same user |
| Create PO + approve same PO | Not same user (self-approval blocked) |
| Post adjustment + approve same adjustment | Not same user |
| System Admin + any `accounting.*.post` | Blocked |
| User admin granting privileged roles | Requires 2nd admin approval (4-eyes); cannot modify own assignments |
| Cashier + cash reconciliation approval of own shift | Blocked |

## 3. Permission Matrix (system role templates)
Legend: **F** full · **A** approve · **C** create/edit · **R** read · **O** own records only · **—** none · (B) = limited to assigned branches · (W) = assigned warehouses

| Area | Owner/Exec | Fin. Controller | Accountant | Branch Mgr | Shift Sup. | Cashier | Inventory Mgr | Warehouse Clerk | Purchasing Mgr | Buyer | HR Mgr | Auditor | System Admin |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Org setup (companies/branches) | R | R | — | R(B) | — | — | R | — | R | — | R | R | F |
| Users & roles | R | — | — | R(B) | — | — | — | — | — | — | — | R | F (4-eyes) |
| Devices / terminals | R | — | — | R(B) | — | — | — | — | — | — | — | R | F |
| Catalog master data | R | R | R | R(B) | R | R | C | R | C | C | — | R | — |
| Cost / margin visibility | R | R | R | R(B) | — | — | R | — | R | R | — | R | — |
| Price lists & price changes | A | R | — | C(B)* | — | — | — | — | C | C | — | R | — |
| Promotions | A | R | — | C(B)* | — | — | — | — | C | — | — | R | — |
| POS sell | — | — | — | F(B) | F(B) | F(B) | — | — | — | — | — | — | — |
| POS discount override / void / refund | — | — | — | A(B) | A(B) limit | — | — | — | — | — | — | — | — |
| Shift close / cash reconciliation | R | R | R | A(B) | C(B) | O | — | — | — | — | — | R | — |
| Stock view | R | R | R | R(B) | R(B) | R(B) | R | R(W) | R | R | — | R | — |
| Receipts / transfers | R | R | — | A(B) | — | — | A | C(W) | R | R | — | R | — |
| Adjustments / scrap | R | R | R | A(B) ≤ limit | — | — | A | C(W) | — | — | — | R | — |
| Stock counts | R | R | R | A(B) | — | — | A | C(W) | — | — | — | R | — |
| Purchase requests / POs | A | R | R | C(B) | — | — | C | — | A | C | — | R | — |
| Supplier master | R | R | R | — | — | — | — | — | C | C | — | R | — |
| Supplier invoices (AP) | R | A | C | — | — | — | — | — | R | — | — | R | — |
| Payments (AP/payroll) | A | A | C | — | — | — | — | — | — | — | — | R | — |
| Journals (manual) | R | A/Post | C | — | — | — | — | — | — | — | — | R | — |
| Posting rules & account mappings | — | F | R | — | — | — | — | — | — | — | — | R | — |
| Period lock / close | R | F | R | — | — | — | — | — | — | — | — | R | — |
| Financial statements | R | R | R | R(B) branch P&L | — | — | — | — | — | — | — | R | — |
| Expenses | A | A | C | C(B) | — | — | — | — | — | — | — | R | — |
| Employees / attendance | R | — | — | R(B) | — | O | — | O | — | — | F | R | — |
| Payroll import & posting | A | A | R | — | — | — | — | — | — | — | C | R | — |
| Audit log | R | R | — | R(B) | — | — | — | — | — | — | — | R | R (security events) |
| Integrations (ETA, banks) config | — | A | — | — | — | — | — | — | — | — | — | R | C |

\* Branch price overrides only if company policy allows branch pricing; else none.

Required statements from the spec — verified by automated authorization tests:
- Cashier ⟶ no `accounting.*` permission at any scope.
- Warehouse clerk ⟶ no write on `accounting.*` or financial documents.
- Branch manager ⟶ all queries filtered to assigned branches (API + RLS tests for cross-branch IDs → 404).
- Financial controller ⟶ full accounting, **no** user/role/device administration.

## 4. Authentication
- Passwords: Argon2id, breach list check, min length 12 for back-office.
- MFA: TOTP mandatory for Owner, Controller, Accountant, Admin, Purchasing Mgr; WebAuthn supported (S).
- Sessions: access JWT 10 min, refresh token rotation with reuse detection (revoke family), device-bound; idle timeout 30 min back-office.
- POS: device certificate + cashier PIN (6 digits, Argon2, lockout after 5 tries) or badge; supervisor override = separate PIN/badge, logged.
- Mobile: biometric unlock of stored refresh token (secure enclave/keystore).

## 5. Data protection
- TLS 1.2+ everywhere, HSTS; internal service TLS in production.
- At rest: DB volume encryption + encrypted backups; SQLCipher on POS; mobile SQLite encrypted.
- Secrets in a vault (cloud KMS / HashiCorp Vault); never in env files in repo.
- PII minimization (customer phone, name); masking in logs; data subject export/delete workflow (PDPL 151/2020 — to validate).

## 6. API security
- Rate limiting (Redis, per user/IP/device), stricter on auth endpoints.
- Input validation by Zod on every endpoint; output DTOs (no entity leakage).
- Idempotency keys; replay protection on signed device batches (timestamp + nonce).
- CORS allow-list, CSRF protection for cookie-based web sessions (SameSite=strict + token).
- Dependency scanning (Renovate + `pnpm audit`/OSV), SAST (CodeQL/Semgrep), container scanning, secret scanning in CI.
- OWASP ASVS L2 as the checklist target.

## 7. Audit & monitoring
- Audit log append-only, hash-chained, partitioned; includes reads of sensitive data (cost exports, payroll, customer PII export).
- Security alerts: impossible travel, privilege grant, bulk export > N rows, repeated override attempts, device revoked activity.

## 8. Backup & DR (proposed targets)
- PostgreSQL: continuous WAL archiving + daily base backup (pgBackRest), PITR; RPO ≤ 5 min, RTO ≤ 2 h.
- Backups encrypted, copied off-site/other region; **quarterly restore drill** (documented evidence).
- Object storage versioning + lifecycle rules.
- POS: local journal keeps un-synced transactions indefinitely; server outage ≠ data loss.

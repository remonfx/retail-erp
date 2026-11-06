# Deployment

**Version:** 0.1 — Draft (finalized after D1/D23 decisions)

## 1. Environments
`local` (Docker Compose) → `ci` (ephemeral) → `staging` (prod-size anonymized data) → `production`.

## 2. Topology (production, initial)
| Component | Spec (starting point, tune from load tests) |
|---|---|
| PostgreSQL primary + 1 sync/async replica | 16 vCPU / 64 GB / NVMe; pgBackRest; PgBouncer |
| API pods | 2–4 × (4 vCPU / 8 GB), autoscale on CPU/latency |
| Sync gateway pods | 2+ isolated from API |
| Workers | 2+ (queues partitioned: posting, reports, search, eta, imports) |
| Redis | 3-node (Sentinel) or managed |
| OpenSearch | 3 nodes (managed or self-hosted) |
| Object storage | S3 / MinIO |
| Observability | OTel collector → metrics/logs/traces store |

Runtime: Kubernetes (Helm) recommended for multi-pod; Docker Compose + systemd acceptable for single-customer on-prem with smaller scale.

## 3. Release process
- Trunk-based, PR checks (lint, types, tests, authz matrix, migrations dry-run).
- Versioned Docker images; DB migrations run as a pre-deploy job (expand phase), app rollout, contract migrations in a later release.
- Blue/green or rolling with readiness probes; feature flags for risky features.
- POS desktop: signed installers (Windows code signing), staged auto-update (pilot branch → 10% → 100%), rollback channel; server supports N-1 client versions.
- Mobile: EAS builds; OTA updates for JS-only changes, store releases for native changes.

## 4. Operations
- Runbooks: sync backlog, posting exceptions, partition creation failure, replica lag, OpenSearch reindex, device revocation, restore drill.
- Monitoring SLOs: API p95, error rate, sync oldest-pending age, posting lag, outbox lag, replica lag.

## 5. Open items
Hosting region & data residency (D23), on-prem vs cloud (D1), customer IT support model.

---

## 6. What exists now
- `docker-compose.yml`: postgres, redis, one-shot `migrate`, `api`, `worker`, `web`. Requires `JWT_SECRET` and `MFA_ENCRYPTION_KEY` (the API refuses to start in production with dev defaults).
- `apps/api/Dockerfile` (API + worker image), `apps/web/Dockerfile`.
- `.github/workflows/ci.yml`: typecheck all packages, domain + API + POS e2e tests against PostgreSQL 16, web & POS builds, Rust tests.
- `scripts/dev-up.sh`: local all-in-one.

**Before production:** change the `rc_app` role password created by migration 0009 (`ALTER ROLE rc_app PASSWORD '…'`) and use it in `DATABASE_URL`; run the API as `rc_app` (never the owner); schedule `rc_maintain_partitions()` (the worker does it every 6 h with the owner URL); enable PITR backups; put the API behind TLS.

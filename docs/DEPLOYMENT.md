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

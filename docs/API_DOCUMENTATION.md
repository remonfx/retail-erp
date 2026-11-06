# API Conventions

**Version:** 0.1 — Draft. Endpoint reference is generated from OpenAPI (`/api/v1/openapi.json`) once implemented; this file defines the contract rules.

## 1. Basics
- Base: `https://<host>/api/v1`; JSON UTF-8; timestamps ISO-8601 UTC; dates `YYYY-MM-DD` (business dates in branch tz).
- Money as **strings** (`"1234.5000"`) to avoid float issues; currency code alongside.
- Language: `Accept-Language: ar|en` for messages; data returns both `nameAr` and `nameEn`.
- Scope: `X-Company-Id` header (required for company-scoped endpoints); branch filters as query params, always validated against user scope.

## 2. Resource vs command endpoints
```
GET    /products?cursor=…&limit=50&q=…&categoryId=…&status=active
GET    /products/{id}
POST   /products                         (create)
PATCH  /products/{id}                    (If-Match: <version>)
POST   /purchase-orders/{id}:submit
POST   /purchase-orders/{id}:approve
POST   /stock-adjustments/{id}:post
POST   /journal-entries/{id}:reverse     { reason, reversalDate }
```
State transitions are commands only — `PATCH {"state":"posted"}` is rejected.

## 3. Headers
| Header | Use |
|---|---|
| `Authorization: Bearer <jwt>` / `Device <token>` | Users / POS devices |
| `Idempotency-Key: <uuid>` | **Required** on all POST/PATCH/DELETE; server stores (key, user, request hash, response) 24 h (sync: permanent via inbox) |
| `If-Match: <version>` | Required on updates; 412 if stale |
| `X-Request-Id` | Correlation; echoed back |

## 4. Pagination, filtering, sorting
- Keyset: `?limit=50&cursor=<opaque>` → `{ data: [], nextCursor, hasMore }`. Max limit 500 (sync 5000).
- Filters: explicit params; complex filters `filter=` JSON (validated AST: field/op/value with an allow-list per resource).
- Sort: `sort=-createdAt,sku` limited to indexed fields.
- Totals: `?count=estimate|exact` (exact may be slow; estimate uses planner stats).

## 5. Errors (RFC 9457)
```json
{ "type": "https://errors.retailcore/insufficient-stock",
  "title": "Insufficient stock", "status": 409, "code": "INV_INSUFFICIENT_STOCK",
  "detail": "Available 3, requested 5", "instance": "/api/v1/stock-transfers/…",
  "errors": [{ "path": "lines[0].qty", "code": "INV_INSUFFICIENT_STOCK" }],
  "requestId": "…" }
```
Status use: 400 validation, 401, 403 (permission), 404 (also for out-of-scope ids — no existence leak), 409 business conflict, 412 version conflict, 422 rule violation, 429 rate limit.

## 6. Bulk & async
- `POST /jobs/product-import` (multipart or pre-signed upload ref) → `202 { jobId }`; `GET /jobs/{id}` → progress, result file URL, error report.
- Bulk edits: `POST /products:bulk-update` with filter or id list → preview (`dryRun=true`) → execute → job.

## 7. Sync API (devices)
- `POST /sync/push` — see ARCHITECTURE §6.4.
- `GET /sync/pull?stream=&since=&limit=` — delta feed.
- `GET /sync/snapshot?branchId=` → signed URL of SQLite snapshot + version.
- `POST /sync/heartbeat` — queue depth, oldest pending, app version, hardware status.

## 8. Real-time
- `GET /events/stream` (SSE): notifications, approval requests, dashboard tick updates (scoped by permissions).

## 9. Versioning & deprecation
Additive changes in v1; breaking → v2 with ≥ 6 months overlap. POS clients send `X-Client-Version`; server can refuse unsupported versions with `426`.

# Inventory Rules

**Version:** 0.1 — Draft

## 1. Ledger model
- Stock changes **only** via `inv_stock_move` rows (immutable). Each move transfers `qty` of a variant from one location to another. Virtual locations (`supplier`, `customer`, `inventory_loss`, `scrap`, `transit`) ensure conservation: Σ qty over all locations including virtual = 0 per variant.
- `inv_stock_quant` is the materialized balance per (location, variant, lot, owner), updated **in the same transaction** as the move, with `SELECT … FOR UPDATE` on affected quants ordered by `(location_id, variant_id, lot_id)` to prevent deadlocks.
- Invariant (nightly job + test): `quant.qty_on_hand == Σ moves in − Σ moves out` for sampled/all keys. Any mismatch = P1 incident.
- Corrections: reversal move (`reversal_of_id`) — never update/delete.

## 2. Stock states
| State | Definition |
|---|---|
| On-hand | Σ quant.qty_on_hand in `internal` locations of a warehouse |
| Reserved | Σ qty_reserved (open transfers, customer orders, pick lists) |
| Available | On-hand − Reserved − Quarantined |
| In-transit | Balance in `transit` location linked to a transfer |
| Quarantined | Balance in `quarantine` locations (returns, QC hold, recalls) — not sellable |
| Consignment | Quants with `owner_id = supplier` — sellable, not valued in our balance sheet |

## 3. Move types & required data
| Move type | From → To | Source document | Approval |
|---|---|---|---|
| receipt | supplier → internal | GRN | per PO approval |
| purchase_return | internal → supplier | Purchase return | Purchasing mgr above threshold |
| sale | internal → customer | POS order / customer invoice | — |
| sale_return | customer → internal or quarantine | POS return | supervisor (POS) |
| transfer_out / transfer_in | internal A → transit → internal B | Transfer order | Sender & receiver confirm |
| internal | internal → internal (same WH) | Internal move doc | — |
| adjustment_loss / gain | internal ↔ inventory_loss | Adjustment doc + reason | Threshold-based |
| scrap / damage / expiry | internal/quarantine → scrap | Scrap doc + reason | Threshold-based |
| count_loss / count_gain | internal ↔ inventory_loss | Stock count | Variance approval |

Every move stores: id, variant, from/to, qty, UoM + stock-UoM qty, unit cost, move type, reference document (type/id/line), user, device, timestamp, branch, approval state, reason (if adjustment). Moves without a reference document are rejected by DB constraint.

## 4. Negative stock
- Default: a move that would make an `internal` quant negative is **rejected** (checked under row lock).
- Controlled exceptions (setting per company/branch/category): POS sale allowed to go negative → creates `inv_negative_exception` (variant, location, qty, source) for daily review. Exception resolution: count, late GRN posting, or adjustment.
- Never allowed for serial-tracked items; lot-tracked items allowed only to a generic "unknown lot" bucket flagged for resolution.
- Valuation of negative stock (weighted average): issue at current avg cost; when replenished, difference between receipt cost and issue cost on the negative quantity → COGS adjustment (posted, explained).

## 5. Costing
**Method per company (Decision D2, default Weighted Average perpetual). Locked after first valued move.**

### 5.1 Weighted average (perpetual, company level)
```
On valued receipt:   new_avg = (qty_valued × avg + qty_in × unit_cost_in) / (qty_valued + qty_in)
On issue:            unit_cost = current avg ; value_total -= qty × avg
```
- `inv_product_cost (company_id, variant_id)` row-locked during valuation.
- Internal & inter-branch transfers don't change avg (same company).
- Returns from customers re-enter at original sale cost (affects avg).
- Precision: avg stored at 6 decimals; value_total authoritative to avoid drift; avg = value_total / qty.

### 5.2 FIFO
- Each valued receipt creates a `valuation_layer` with `remaining_qty/remaining_value`.
- Issue consumes oldest layers (`ORDER BY created_at, id FOR UPDATE`); cost = Σ consumed values; consumption recorded in `valuation_layer_consumption` (layer_id, move_id, qty, value) for audit.

### 5.3 Valuation sub-ledger ↔ GL
Every valued move emits `StockValued` (value, accounts keys) → posting engine. Daily reconciliation: Σ valuation by company == Σ GL inventory accounts. Difference blocks period hard lock.

### 5.4 Offline POS sales
Cost determined at **server apply time** (current avg / FIFO layers then). Accepted approximation; documented. Sale's accounting date = sale business date.

## 6. Lots, expiry, serials
- Tracking set at product level (`none|lot|serial`); change only when no stock exists.
- Lot: number, expiry date, production date; FEFO suggested for picking; sale of expired lot blocked (POS shows alert).
- Expiry alerts at configurable days-before (e.g., 30/14/7).
- Serial: one unit per serial; serial unique per variant; status (in_stock, sold, returned, scrapped); POS requires serial scan.

## 7. Stocktaking
1. Create count (full / cycle by category/location/ABC class / blind).
2. **Freeze snapshot**: record expected qty at count start per (location, variant, lot). Sales continue; moves after snapshot are accounted for when computing variance (`expected_at_close = snapshot + moves since snapshot`).
3. Counting: mobile/desktop, multiple counters, offline-capable; recounts for variances > tolerance.
4. Review: variance by qty & value; supervisor approval thresholds.
5. Post: count_gain/count_loss moves + valuation + GL.

## 8. Analytics definitions
| Metric | Definition |
|---|---|
| Inventory value | Σ remaining valuation (company) by branch/location for display |
| Stock aging | Age buckets by FIFO layer date (FIFO) or by last receipt date (avg) |
| ABC | Ranking by 12-month COGS value (A=80%, B=15%, C=5% — configurable) |
| Turnover | COGS(period) / avg inventory value(period) |
| Days of cover | On-hand / avg daily sales (last 28 days) |
| Dead stock | On-hand > 0 and no sale/issue in N days (default 90) |
| Replenishment suggestion | if available + on-order − reserved ≤ reorder_point → order up to max (rounded to supplier MOQ/pack) |

## 9. Authorization
All adjustments, scraps, count postings require: reason code, user with `inventory.adjust` in that warehouse scope, and approval when |value| > threshold (per branch). All are audit-logged with before/after quant values.

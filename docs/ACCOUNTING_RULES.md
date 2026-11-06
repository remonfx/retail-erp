# Accounting Rules

**Version:** 0.1 — Draft · requires review by the Financial Controller and an Egyptian chartered accountant/tax advisor before implementation.

## 1. Invariants (enforced in code AND database)
1. Every posted journal entry: Σ debit = Σ credit > 0 (deferred constraint trigger recomputes from lines).
2. A line has exactly one non-zero side; amounts ≥ 0.
3. Posted entries and lines are immutable. Only allowed transition: `posted → reversed`, performed by creating a linked reversal entry (same amounts, opposite sides) in an **open** period.
4. No posting into a period that is `hard_locked`; `soft_locked` requires the `accounting.post_locked_period` permission + reason.
5. Auto-posted entries carry `source_event_id`, unique in `acc_posting_registry` → re-processing an event never double-posts.
6. Each entry stores `posting_rule_id` + `version` used → historical entries are explainable after rule changes.
7. Postable accounts only (no posting to parent/group accounts).
8. Multi-currency: company-currency `debit/credit` are authoritative for balancing; `amount_currency` + `fx_rate` kept per line.

## 2. Posting Engine
```
Domain event ──► Posting rule lookup (company, event type, conditions)
              ──► Account mapping resolution (by tender, tax rate, category, branch, partner …)
              ──► Build lines + dimensions (branch, cost center, partner, product)
              ──► Validate (balanced, open period, accounts postable)
              ──► Insert entry (state=posted) + registry row — one transaction
On failure ──► event parked in `acc_posting_exception` with reason; visible in Controller dashboard; nothing half-posted.
```
**Account mappings** are configured by keys, most specific wins:
`(company, mapping_key, [branch], [product_category], [tender_type], [tax_rate], [partner_group])` → account.

Example keys: `sales.revenue`, `sales.discount`, `sales.returns`, `tax.vat_output`, `tax.vat_input`, `tax.wht_payable`, `inventory.asset`, `inventory.cogs`, `inventory.shrinkage`, `inventory.damage`, `inventory.count_gain`, `inventory.in_transit`, `purchase.grni`, `purchase.price_variance`, `ap.trade`, `ar.trade`, `pos.cash`, `pos.card_clearing`, `pos.wallet_clearing`, `pos.cash_over_short`, `bank.card_fees`, `payroll.*`.

## 3. Posting Rules (default set)

Notation: Dr / Cr. Amounts: N = net of tax, T = tax, G = gross (N+T), C = cost at valuation. Dimensions: every line gets `branch_id`; revenue/COGS/expenses also `cost_center_id` (branch default unless specified).

### 3.1 POS cash sale (summarized per shift session — Decision D5)
Sub-ledger keeps each receipt; GL entry generated at session close (or nightly for sessions open > 24h), grouped by account/tax rate/dimension.
| Dr / Cr | Account | Amount |
|---|---|---|
| Dr | POS Cash (session) | G collected in cash |
| Dr | Sales Discounts (contra revenue) | discounts (if D6 = gross method) |
| Cr | Sales Revenue | N before discount |
| Cr | VAT Output Payable | T |
| Dr | COGS | C |
| Cr | Inventory | C |

### 3.2 Card / wallet / installment-provider sale
Same as 3.1 but debit **Card Clearing – <acquirer>** (or Wallet/BNPL Clearing – <provider>).
Settlement (from bank/settlement file):
| Dr Bank | net settled | Dr Card Fees Expense | fee | Cr Card Clearing | gross |
Unmatched clearing balances older than N days → reconciliation exception.

### 3.3 Split payment
One debit line per tender type, total = G. No difference allowed; change given is netted from cash.

### 3.4 Sales return (refund)
| Dr Sales Returns (contra revenue) | N | Dr VAT Output Payable | T | Cr Cash / Clearing / Store Credit Liability | G |
| Dr Inventory (or Quarantine Inventory) | C original | Cr COGS | C original |
Cost of the return = **original sale cost** (from the original sale's move), not current average. Damaged returns go to quarantine location; later scrap → §3.12.

### 3.5 Exchange
Posted as return + new sale in the same session; net tender difference collected/refunded.

### 3.6 Cash over/short at session close
Counted cash − expected cash: shortage → Dr Cash Over/Short Expense / Cr POS Cash; overage → reverse. Transfer to safe/bank: Dr Cash in Transit or Bank / Cr POS Cash.

### 3.7 Goods receipt (GRN) — perpetual inventory
| Dr Inventory | qty × PO unit cost (net of recoverable VAT) | Cr Goods Received Not Invoiced (GRNI) | same |
Consignment receipts (owner = supplier): **no journal** (stock not owned).

### 3.8 Supplier invoice
| Dr GRNI | qty invoiced × PO price | Dr VAT Input Recoverable | T | Cr Accounts Payable – supplier | G |
Price difference (invoice price ≠ PO price, within tolerance & approved):
- Weighted average: if the received qty is still on hand → Dr/Cr Inventory (re-averages); portion already consumed → Dr/Cr COGS (or Purchase Price Variance, configurable).
- FIFO: adjust remaining value of the related layer; consumed portion → COGS/PPV.
Non-recoverable VAT → capitalized into inventory cost.
Landed costs (customs, freight): Dr Inventory (allocated) / Cr AP – forwarder/customs.

### 3.9 Purchase return
| Dr Accounts Payable (or Supplier Debit Note Receivable) | G | Cr Inventory | C (cost layer of returned goods) | Cr VAT Input | T |
Difference between returned value at invoice price and C → Purchase Price Variance.

### 3.10 Supplier payment
| Dr Accounts Payable | gross liability settled | Cr Bank/Cash | paid | Cr WHT Payable | withheld (if applicable — D9) |

### 3.11 Customer receipt (B2B AR)
| Dr Bank/Cash | Cr Accounts Receivable – customer |  (WHT certificates received → Dr WHT Receivable).

### 3.12 Stock adjustments
| Event | Dr | Cr |
|---|---|---|
| Count loss / shrinkage | Inventory Shrinkage Expense | Inventory |
| Count gain | Inventory | Inventory Count Gain (or credit Shrinkage — configurable) |
| Damage / scrap | Damaged Goods Expense | Inventory |
| Expired goods | Expired Goods Expense | Inventory |
| Supplier-recoverable damage | Supplier Claims Receivable | Inventory |
Valued at current cost (avg) or consumed FIFO layers. Reason code → account mapping.

### 3.13 Inter-branch transfer (same company)
Step 1 dispatch: Dr Inventory In-Transit (branch dim = destination or company) / Cr Inventory (branch A) at C.
Step 2 receipt: Dr Inventory (branch B) / Cr Inventory In-Transit.
Short receipt: difference → Transit Loss Expense (after approval) or Claim against carrier.
*No revenue, no tax.* (Single valuation per company ⇒ cost unchanged.)

### 3.14 Inter-company transfer (different legal entities) — D16
Seller company: sale at transfer price (AR Intercompany, Revenue IC, VAT if applicable, COGS). Buyer company: purchase (Inventory, VAT input, AP Intercompany). Flagged `intercompany` for elimination in consolidation. **Tax treatment to be confirmed.**

### 3.15 Operating expenses
| Dr Expense (cost center) | N | Dr VAT Input (if recoverable) | T | Cr AP / Cash / Employee Advance | G (− WHT) | Cr WHT Payable | WHT |
Petty cash: imprest model per branch.

### 3.16 Payroll (v1: import of computed payroll — A6)
| Dr Salaries & Wages Expense (cost center) | gross | Dr Employer Social Insurance Expense | employer share |
| Cr Salaries Payable | net | Cr Social Insurance Payable | employee + employer share | Cr Payroll Income Tax Payable | tax | Cr Employee Loans/Advances | deductions |
Payment: Dr Salaries Payable / Cr Bank.

### 3.17 Gift cards / vouchers / store credit
Issue: Dr Cash / Cr Gift Card Liability (no VAT at issue — **confirm with tax advisor**). Redemption: Dr Gift Card Liability (tender) in sale. Breakage policy: configurable, posted at expiry.

### 3.18 Rounding
POS cash rounding (if enabled) → Dr/Cr Rounding Difference account. Tax rounding method configurable (per line vs per document) — must match ETA rules.

## 4. Period & Closing Procedures
Periods: `open → soft_locked → hard_locked`. Year: `open → closing → closed`.

Month-end checklist (system-tracked, each item a check with owner & evidence):
1. All POS sessions closed & synced; quarantine queue empty or accepted.
2. Posting exceptions queue empty.
3. GRNI review (received not invoiced aging).
4. Card/wallet clearing reconciled to settlements.
5. Bank reconciliation completed.
6. Inventory sub-ledger value = Inventory GL (auto-check; difference blocks hard lock).
7. Accruals & prepayments posted.
8. Cost allocations (HQ → branches) posted.
9. FX revaluation of open foreign-currency AP/AR (if any).
10. VAT return report generated & reviewed.
11. Soft lock → review → hard lock (Controller; 4-eyes).

Year-end: income & expense accounts closed to Retained Earnings via closing entry; opening balances generated for balance sheet accounts.

## 5. Corrections
- Posted entry wrong → **Reverse & Replace** wizard: creates reversal (dated in open period or original date if open) + new corrected draft linked to it; both require permission `accounting.reverse`.
- Source-document corrections (e.g., wrong supplier invoice) go through document credit notes, not raw journal edits, so sub-ledgers stay consistent.

## 6. Reports derived from GL only
Trial balance, P&L, balance sheet, cash-flow (indirect: net income + non-cash adjustments + working-capital deltas by account subtype mapping), general ledger, partner ledgers, tax reports. Operational dashboards (sales, margin) come from read-models and are labelled "operational — not audited".

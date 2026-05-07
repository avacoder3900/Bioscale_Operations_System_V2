# ERP Integration Master Plan BIMS Financial Layer Build

Status: SYNTHESIS & READY TO COMMIT (2026-05-07)

## TL;DR

BIMS has 85 Mongoose models (MES/QMS/manufacturing, zero financial layer). The deep-dive docs (docs/erpnext-deep-dive/, 13 chapters, April 2026) remain authoritative. This plan:

1. Reconciles research with post-Ask-BIMS reality (85 models, 4 Vercel crons, 24 Ask BIMS tools)
2. Commits 10-phase buildout: Foundations → Stock Ledger + GL → Buying + Selling → Manufacturing → Cutover
3. Maps 13 open business questions to stakeholder calls
4. Lists model deltas, routes, migrations, acceptance criteria per phase
5. Outlines 5–10 new Ask BIMS financial tools unlocked post-GL

## Key Reconciliation

- **Models:** 84 claimed → 85 actual (added AskBimsCostLog, BimsAnomaly post-audit). Both Tier-3 immutable; plan absorbs.
- **Crons:** 2 claimed → 4 actual (mocreo, heartbeat, daily-digest, cartridge-cleanup). Vercel pattern prod-ready.
- **Ask BIMS:** 23 tools → 24 tools; cost caps + daily spend tracking live. Phase 6+ unlocks 5–10 financial tools.
- **Deep-dive research:** Still authoritative. Zero design drift.

## 13 Open Business Questions (Prioritized)

Blocking Phase 1–3: Q1 (opening cost basis), Q2 (perpetual vs. periodic), Q3 (WIP warehouse structure).
Blocking Phase 4–5: Q4 (credit limits), Q5 (tax nexus), Q6 (landed cost).
Blocking Phase 6+: Q7 (labor costing), Q8 (scrap recovery), Q9 (assay in invoicing), Q10–Q12.
Non-blocking: Q13 (FX revaluation, Phase 9).

Engagement: 1× 15-min call per phase start with Bioscale ops lead. Document decision as DECISION.md in phase dir.

## 10-Phase Buildout

| Phase | Goal | Models | Effort | Crons | Ask BIMS Tools |
|-------|------|--------|--------|-------|----------------|
| 1 | Foundations (Company, COA, Warehouses) | 9 (Account, CostCenter, Warehouse, etc.) | M (4–5d) | — | — |
| 2 | Item Shim + Sync | 1 (Item) | S (2–3d) | 1 (item-sync) | — |
| 3 | Stock Ledger + GL (dual-shadow, 30–60d validation) | 6 (SLE, GL, Bin, StockReconciliation, ShadowDriftLog) | L (7–10d) | 2 (repost, shadow-validation) | inventory_valuation, trial_balance, gl_posting_trace |
| 4 | Buying (PO, PR, PI, Supplier) | 5 (Supplier, PurchaseOrder, PurchaseReceipt, etc.) | L (7–10d) | 1 (match-invoices) | supplier_performance, ap_aging |
| 5 | Selling (SO, DN, SI, Customer) | 7 (enhance Customer, SalesOrder, DeliveryNote, etc.) | L (7–10d) | 1 (update-ar-aging) | ar_aging, revenue_by_assay, revenue_by_customer |
| 6 | Manufacturing (BOM, WO, JobCard, SE, PartCostRollup) | 5 (BOM, WorkOrder, JobCard, StockEntry, PartCostRollup) | L (7–10d) | — | cost_per_cartridge, wip_variance |
| 7 | Quality + Scrap | 1 (ScrapDisposal) | M (4–5d) | — | scrap_value_trend |
| 8 | Projects + Time Tracking | — | M (future) | — | — |
| 9 | Multi-Currency + FX | 1 (ExchangeRateRevaluation) | M (4–5d) | 1 (month-end-fx-revaluation) | currency_exposure |
| 10 | Cutover Finalization | 1 (CutoverCertificate) | S (1–2d) | 1 (cutover-final-validation) | — |

## Migration & Cutover Risks

Concurrent writes: Shadow-write pattern (legacy + new GL/SLE both written; on failure, log to ShadowDriftLog).
Backfill: Forward-only opening balance via StockReconciliation at T0 (2026-04-30); CSV import of cost basis.
Backwards compatibility: InventoryTransaction never deleted; Phase 3 adds SLE-based query paths; shim in ask-bims.ts.

## For Leadership

3–4 month buildout (2–3 engineers). Phases 1–3: 4–5 wks (foundations + dual-shadow validation). Phases 4–5: 2–3 wks (buying+selling, AR/AP live). Phases 6–10: 2–3 wks (manufacturing, multi-currency, cutover).

Blockers: 7 business questions; 1 call/phase.
Risk: Shadow-write = zero outage. Rollback = flip flag.
Payoff: Cost-per-cartridge, profitability-by-assay, AR/AP aging, period close. Real-time reporting.

---

See docs/erpnext-deep-dive/ (13 chapters) for full context. Ready to commit. Phase 1 starts post-approval.

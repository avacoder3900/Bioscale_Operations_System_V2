# Process Analytics Enhancement Plan

**Date:** 2026-05-07
**Audience:** Engineering, Quality, Operations Teams

## Executive summary

This plan upgrades BIMS process analytics from a static reporting surface into a decision-support system. Today the codebase has solid pure-statistical primitives (`src/lib/server/analytics/stats.ts` — 14 functions covering Cp/Cpk, IMR, p-chart, Nelson rules, ANOVA, t-test, regression, Pareto, FPY, RTY) and one unified-runs aggregator (`runs-feed.ts`). The analytics page (`/manufacturing/analysis/+page.svelte`, ~1,261 lines, 12 tabs) surfaces them, but the experience is monolithic and lacks real-time alerts, capability trends, confidence intervals, operator scorecards, and material-lot traceability. This plan covers four axes: real-time monitoring, operator daily dashboards, QE weekly workbench, manager monthly KPIs. Hybrid architecture (batch nightly + real-time SPC alerts only). 5-phase rollout over 16 weeks.

---

## 1. Existing analytics architecture audit

### 1.1 Statistical toolkit (`src/lib/server/analytics/stats.ts`)

14 core pure functions, well separated from data fetching:

| Function | Purpose | Current consumers |
|---|---|---|
| `describe()` | mean/median/stdDev/IQR | overview tabs |
| `histogram()` | binned distributions | cycle time + yield histograms |
| `paretoFromCounts()` | rank by frequency, cumulative % | rejection-reason ranking |
| `capability()` | Cp, Cpk, Pp, Ppk, DPMO, sigma | capability dashboard |
| `imrChart()` | individuals + moving range, with Nelson rules | SPC alerts tab |
| `pChart()` | proportion defective | yield trend |
| `nelsonRules()` | 8 Nelson rules | embedded in IMR + p chart |
| `oneWayAnova()` | F-test across groups | operator/robot/shift comparison |
| `tTest()` | two-sample t-test | run-to-run comparison |
| `linearRegression()` | least-squares | trend regression |
| `fpy()` | first-pass yield | KPI |
| `rty()` | rolled throughput yield | multi-stage |

**Strengths:** clean separation, full Nelson 1–8, both Cp/Cpk and Pp/Ppk, DPMO + sigma mapping.

**Gaps:**
- No confidence intervals (yields are point estimates only)
- No time-series forecasting (EWMA, exponential smoothing)
- No multivariate SPC (Hotelling T², PCA)
- No DOE statistical infra
- No capability-over-time (current Cpk only, no Cpk trend)
- Pareto by frequency only — no stratification by assignable cause

### 1.2 Data aggregation (`src/lib/server/analytics/runs-feed.ts`)

`loadUnifiedRuns(filters)` integrates 4 process streams: WI-01 backing, wax filling, reagent filling, plus stubs for laser cut / cut-thermoseal / storage / shipping. Normalizes each to a `UnifiedRun` shape with operator, robot, deck, cycle time, plannedCount, scrapCount, etc.

**Filter support:** date range, process type, operator, robot, shift (inferred), input lot.

**Gaps:**
- No per-deck/per-tray aggregation — can't isolate a single deck's quality
- No per-assay performance — can't compare WI-01 across assay A vs B
- No material-lot traceability — can't link yields to wax/reagent supplier lot
- No real-time stream — all batch query (default 30-day window)

### 1.3 Models supporting analytics

| Model | Purpose | Status |
|---|---|---|
| `SpecLimit` | per-process per-metric tolerances | active, QA-editable |
| `FmeaRecord` | failure mode library + RPN | draft / active |
| `SpcSignal` | flagged out-of-control points | append-only log |
| `CauseEffectDiagram` | fishbone structure | created, no UI editor, no rejection linkage |
| `AnalyticsNote` | free-form incident annotations | created, no notification when added |
| `ProcessAnalyticsEvent` | manual rejection entry with code | created, can link to run |

**Gaps:**
- No standardized rejection code taxonomy — "surface crack", "Surface Crack", "crack surface" coexist as free text
- No NC ↔ FMEA linkage
- No SPC signal → investigation log
- No formal Phase 1 (baseline) vs Phase 2 (monitoring) lifecycle for SPC studies

### 1.4 Current UI surface

`/manufacturing/analysis/+page.svelte` — single page, 12 tabs:
1. Overview, 2. Cycle time, 3. Yield & failures, 4. Material flow (incomplete), 5. Compare, 6. SPC alerts, 7. FMEA, 8. Manual input, 9. Notes, 10. All runs, 11. Reports & export, 12. DOE planner (read-only).

Subpage: `/manufacturing/analysis/demo` — fabricated training data.

**Not surfaced today:** capability trend over time, yield CIs, operator scorecards, equipment reliability, FMEA risk heatmap, audit trails on spec-limit changes.

---

## 2. Gap analysis vs ideal SPC toolkit

| Capability | Current state | Gap |
|---|---|---|
| Real-time SPC monitoring | Manual Nelson detection, reactive | Auto alerts (Slack/email/dashboard) on rule trigger |
| Cpk trend | Single-point, ad-hoc window | 7/14/30-day rolling, regression slope, target line, segmented (operator/robot/shift) |
| Yield CI | Point estimate (fpy = a/n) | Wilson score interval, segmented |
| Pareto stratification | Frequency only | By operator/shift/robot/material lot, vital-few tracking |
| Cause/effect editor | Model exists, no UI | Drag-drop builder + rejection-code linkage |
| FMEA editor | Read-only table | In-page form, RPN heatmap, action tracking, effectiveness |
| Capability per assay/robot | Filter-only | Side-by-side cards, statistical significance test, target per segment |
| Run comparison | 2-run | N-run cohort, statistical summary, variation drivers |
| Operator/shift performance | Filter-only | Scorecards, training correlation, consistency metric |

---

## 3. Ten Ask BIMS analytics tools

These should join the 27 existing tools after Phase 4:

1. **`get_capability_trend(process, metric, days)`** — time-series Cpk with CI, regression slope, threshold flag
2. **`yield_breakdown(process, segmentBy, sinceDays)`** — FPY per operator/shift/robot/assay with Wilson CI
3. **`rejection_root_cause(query, sinceDays)`** — Pareto stratified, timeline, linked runs, FMEA-suggested actions
4. **`equipment_reliability(equipmentType, sinceDays)`** — abort count, rate, top causes, repair history
5. **`cycle_time_variance_driver(process, sinceDays)`** — t-test before/after, segment that shifted
6. **`fmea_risk_query(rpnThreshold, statusFilter)`** — sorted RPN, overdue actions
7. **`material_lot_traceability(lotId)`** — every cart that consumed the lot, QC outcomes, suspect flag
8. **`shift_correlation(metric, sinceDays)`** — day vs night with significance test
9. **`cpk_vs_target(process, metric)`** — current vs target, improvement needed (μ-shift or σ-reduction), suggested actions
10. **`forecast_capability_impact(process, metric, scenario)`** — sensitivity analysis (e.g., "if σ drops 10%, new Cpk?")

---

## 4. Three audience-specific surfaces

### 4.1 Daily operator dashboard (`/manufacturing/daily-status`)

Goal: 2-minute morning check. Mobile-first.

- Status lights (🟢/🟡/🔴) per process
- "My performance today" — cycle time, yield, abort count
- Watch list: SPC alerts, rejections, material shortages
- Quick actions: scan, start run, check inventory

### 4.2 QE weekly workbench (`/analytics/qe-workbench`)

Goal: Friday morning quality review.

Tabs: Capability review (Cpk trends), Yield analysis (Pareto + segments), Corrective actions (FMEA actions due, status), SPC studies (Phase 1 vs 2), Audit trail (spec-limit changes).

### 4.3 Manager monthly dashboard (`/analytics/manager`)

Goal: month-end KPI review.

Cards: overall FPY (target vs actual), OTDR, equipment utilization, quality incident count, CAPA closure rate. Charts: 6-month FPY trend, Cpk trend per process, top failure modes, operator ranking.

---

## 5. Real-time vs batch decision

### Hybrid recommendation

**Phase 1 (now):** Batch nightly aggregation. 11 PM job recomputes Cpk, FPY, SPC rules, capability status. 6 AM email/dashboard summary to QA. Cost: ~$0.

**Phase 5 (later):** Real-time WebSocket overlay for SPC signals only. New run arrives → check Nelson rules → emit WebSocket event + Slack notification if Rule X triggers. Cost: ~$50/mo (Redis Pub/Sub). Skip full real-time dashboards (cost not justified for current volume).

---

## 6. 5-phase rollout

### Phase 1 — Foundation (Weeks 1–4)

Deliverables: spec-limit configuration UI with change control + approval workflow, FMEA editor (in-page form, RPN sliders, action tracker), rejection-code taxonomy migration, data validation report (% completeness on last 100 runs).

### Phase 2 — Monitoring (Weeks 5–8)

Deliverables: daily operator dashboard, capability-trend dashboard (rolling Cpk + regression + target), yield deep-dive (Pareto stratified, Wilson CI), SPC alert investigation log (when Nelson rule triggers, create incident, track resolution).

### Phase 3 — Insights (Weeks 9–12)

Deliverables: cause-and-effect (fishbone) editor with rejection-code linkage, FMEA risk heatmap (Severity×Occurrence grid colored by RPN), operator scorecards, manager monthly dashboard.

### Phase 4 — Optimization (Weeks 13–16)

Deliverables: material-lot traceability page, 10 Ask BIMS analytics tools, DOE planner configuration, audit-trail dashboard (spec-limit + SPC closure history).

### Phase 5 — Automation (Weeks 17+)

WebSocket SPC alerts, predictive yield model (Random Forest on historical data), automated corrective-action suggestions from FMEA.

---

## 7. Schema additions

New collections:
- `spec_limit_changes` — audit trail (old/new value, changed by, timestamp)
- `spc_investigations` — incident record (rule, points, root cause, resolution)
- `rejection_code_taxonomy` — standardized codes (category, code, description)
- `material_lot_traceability` — lot ↔ cart ↔ QC join (denormalized for query speed)

---

## 8. New API endpoints (under `/api/analytics/`)

- `GET /api/analytics/capability-trend?process=wax&days=90`
- `POST /api/analytics/spc-investigation`
- `GET /api/analytics/yield-by-operator?process=wax&sinceDays=14`
- `GET /api/analytics/rejection-codes`
- `GET /api/analytics/material-lot/[lotId]`

---

## 9. Testing strategy

- 20–30 contract tests for new endpoints (Vitest)
- Validate capability calculations against R `qcc` package (reproducibility)
- Load tests: Cpk over 10K runs in <2s
- UAT: QA + 1 operator per phase

---

## 10. Conclusion

This plan transforms BIMS from data logger to decision-support. Real-time monitoring catches problems early, trend dashboards expose drift, FMEA tooling links observations to corrective action, Ask BIMS makes it queryable in plain English. Hybrid batch+stream architecture defers infrastructure complexity to phase 5 when volume justifies it.

# KB2-05 — Flow Metrics: Work Item Age First, SLE/Scatter Later

**Depends on:** KB2-01 (transition service = trustworthy timestamps). Read KB2-00 first.

## Order of construction (deliberate)

1. **Work Item Age** — `now − wipDate` (first `→ wip`) for every unfinished Tier 2 item. The
   leading indicator: cycle time only describes finished work; age shows what is quietly stuck
   NOW. Surface as a color band on every card (thresholds = SLE percentiles per sizeClass from
   policy; until real data: the seeded values) and as the default sort of the Flow view.
2. **Aging / flow-debt alerts** — flag items whose age exceeds their size class's SLE percentile;
   flag the specific pattern where an item ages while items started AFTER it finish (flow debt =
   the measurable signature of cherry-picking). Feed `operations/alerts` + Flow view.
   **This diagnoses the original problem without measuring any person.**
3. **SLE + cycle-time scatterplot** — percentiles per sizeClass from completed items
   (`wipDate → completedDate`), archived included. 85th percentile default. Display
   "insufficient data (n=X)" below a minimum sample size instead of fabricating a number.
   Probabilistic forecast only — no estimation fields for humans to fill.
4. **Discovered-work ratio** — `discovered ÷ all` over committed items, rolling 30d; the
   Replenishment view uses it to suggest filling ready to (100 − ratio)% of cap.
5. **Flow efficiency** — touch time ÷ elapsed, from `waiting`/`blocked` intervals in
   `transitions[]`. Display frames blocked time as a system problem (it is).

## Data source

`transitions[]` (now written by every path) + per-status date stamps, computed on read — never
stored as drift-prone fields. Include archived docs. Legacy fallback: replay `activityLog`
`status_change` entries for pre-KB2 history (existing analytics.ts logic, extracted and kept).

## The hard constraint (query-layer, with the rationale in code)

No API, query, or export returns per-person throughput, per-person cycle time, leaderboards, or
anything that trivially reconstructs them. Enforce in the metrics module (assert/omit at the
aggregation layer), not as a UI convention. Code comment must preserve the why: individual
cycle-time measurement is the documented cause of cherry-picking — the disease this redesign
exists to cure. Per-person WIP counts (limits) are fine.

## Acceptance criteria

- [ ] Age computed live for every unfinished Tier 2 item, shown against SLE thresholds.
- [ ] Flow-debt flag fires on the overtaken-while-aging pattern.
- [ ] SLE shows "insufficient data" under minimum n; no estimation input exists anywhere.
- [ ] Grep of metrics module + endpoints shows no per-person aggregate output.

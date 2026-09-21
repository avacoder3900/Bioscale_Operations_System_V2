# KB2-28 — The roadmap scheduler (backward pass + capacity clamp)

**Status:** approved 2026-08-20. Depends on KB2-27 schema. Consumed by KB2-29 views and
the `kanban_roadmap` MCP tool.

## Intent
Anchor each milestone's hard date, walk the `blocked_by` graph backwards with rough
durations, and give every undated task a *derived* latest-start date — then compare
against a forward pass from today and the team's measured capacity to answer, at any
moment: are we on track, and what must we be working on right now? Dates are OUTPUTS,
never inputs (LiquidPlanner doctrine). Recomputed fresh on every read — no stored
schedule, nothing to go stale.

## Method (research-grounded, session 2026-08-20)
Classic CPM backward/forward pass (MS Project "schedule from finish date" behavior) plus
Goldratt's critical-chain correction: a pure dependency-path calc assumes infinite
parallelism, so the honest projection is
`projectedFinish = max(CPM forward-pass finish, today + remainingWork / measuredVelocity)`.
Milestone health is CCPM buffer burn (one pooled number), not per-task date policing.
Estimate gaps fall through the KB2-27 ladder; actual throughput (which can't be gamed by
editing estimates) backs the clamp.

## Algorithm — `src/lib/server/kanban/schedule.ts`
1. **Milestones** = non-archived tasks with `itemType: 'milestone'`, a `dueDate`, and
   status ≠ done. Milestones have duration 0.
2. **Subgraph per milestone**: reverse BFS over normalized blocking edges
   (`A blocked_by B` ⇒ edge B→A; `B blocks A` ⇒ same). Cycles: detected via Kahn's —
   reported as a data error on the result, never scheduled around.
3. **Effective duration ladder** (working days): `estimateDays` → `SIZE_CLASS_DAYS` →
   median actual cycle (done tasks' `wipDate→completedDate`, business days, last 90d,
   fallback 3). Done tasks contribute 0 remaining.
4. **Backward pass** (reverse topo, business days): milestone `LF = dueDate`;
   `LF(t) = min(LS of successors)`; `LS = LF − duration`.
5. **Forward pass** from today over not-done tasks: `ES = max(today, EF of preds)`;
   done preds contribute their completion date. `slack = LS − ES` (business days).
   Critical chain = the min-slack path.
6. **Capacity clamp**: velocity = MEAN weekly *estimate-days completed* over the last
   8 weeks (each done task valued by its ladder duration). `clampFinish = today +
   remainingDays / velocity` weeks. `projectedFinish = max(EF(milestone), clampFinish)`.
   Zero history ⇒ clamp disabled and flagged (`velocity: null`).
7. **Buffer burn**: `buffer = dueDate − projectedFinish` (negative = infeasible → the
   Motion-style early warning: "cut scope, add capacity, or move the date").
   `chainPct` = done fraction of subgraph (by count and by estimate-days).
8. **Must-start list**: not-done, all blockers done, `LS ≤ today + 7`; `late` when
   `LS < today`. Sorted by slack asc, **Tier 1 rank as tiebreaker** (decision 2026-08-20:
   rank = importance, slack = urgency; the list surfaces disagreements rather than
   silently obeying either).
9. **Calibration**: done tasks with explicit `estimateDays` → median(actual/estimate)
   ratio + n, so the next workshop session starts from truth.

## Outputs
`computeRoadmap()` returns per-milestone: task rows (id, tracking#, title, status, rank,
tags, durationDays + which ladder rung, LS/LF/ES/EF, slack, onCriticalChain, late),
projectedFinish, bufferDays, chainPct, velocity, mustStart[], cycleError?; plus global
calibration and the unscheduled-milestone list (milestone without dueDate = flagged).

## Exposure
- Load functions (KB2-29 pages) call `computeRoadmap()` directly.
- **`kanban_roadmap`** MCP tool → GET `/api/agent/operations/kanban/roadmap` — the whole
  result, so a Claude-app session can read slack/must-start/buffer-burn and write fixes
  (links, estimates, splits) in the same conversation.

## Honesty rules
- Derived dates are never written back to task documents — they exist only in the
  computed result (GitLab fixed-vs-derived lesson: anchors and computations never mix).
- Every number that comes from a fallback says so (`estimateSource: 'explicit' |
  'sizeClass' | 'median'`).
- Business-day arithmetic throughout (weekends excluded); no holiday calendar in v1.

## Out of scope
- Monte Carlo / probabilistic bands (phase 2 — needs more throughput history to be
  meaningful; the deterministic clamp ships first).
- Resource-level modeling beyond the single capacity pipe. Per-person anything is
  forbidden ground per KB2-00 decision #12.

## Validation
- Unit-style seed check: chain A→B→milestone(Dec 11), estimates 3+7 → LS(A) computed
  right, slack shrinks as today advances, clamp kicks in when velocity is low.
- `npm run check` at baseline.

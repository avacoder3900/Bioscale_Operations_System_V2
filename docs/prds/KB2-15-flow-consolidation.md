# KB2-15 — Flow/Analytics Consolidation + Single Kanban Nav

**Status:** Approved by Jacob 2026-08-14 (in-session; per-person design decided explicitly — see
Decisions below).
**Branch:** `master` (direct, per Jacob)
**Depends on:** KB2-05 (flow metrics), KB2-06 (views), KB2-14 (nav shape Queue|Inventory|Flow|Policy)

## The problem

Two pages measure the same thing from different eras:

- `/kanban/flow` (KB2-05/06/14) — the principled KB2 page: board-aware, computed from the
  transition service's uniform stamps, **no per-person aggregates by construction** (decision
  of record #12, KB2-00).
- `/kanban/analytics` (pre-KB2, retrofitted) — richer charts (CFD, per-person WIP timeline,
  cycle scatter, time-in-status, per-project) but: no board filter (mixes ops+software into
  every number), still reads the **retired `user.wipLimit` field** (KB2-04 moved limits to
  `KanbanPolicy.wipPerPerson`), and carries three per-person widgets that violate decision #12
  (per-assignee done-count/load-score table, creator-mix donut, and arguably the WIP timeline).

There are also **two nav rows**: KanbanNav (Queue | Inventory | Flow | Policy) plus a separate
header nav (Analytics | Projects | Archive). Jacob: collapse to one.

## Decisions (Jacob, 2026-08-14)

1. **One page. Name stays `Flow`, route stays `/kanban/flow`.** `/kanban/analytics` becomes a
   redirect stub (same pattern as `/kanban/replenish`).
2. **Per-person boundary — "who is working on what" ≠ "who is productive":**
   - **KEEP the daily WIP timeline** — a present-tense coordination view (who has what on their
     plate, day-browsable). Per-person WIP is a limit, not a score (decision #12 already allows
     it). No totals, counts, or rankings anywhere on it.
   - **DELETE the per-assignee table** (done-in-range + load score = a leaderboard) and the
     **creator-mix donut** (task-creation counts per person reward ticket spam). Components
     removed from the repo, not just unmounted. Person-level review questions are deliberate
     one-off queries, never a standing dashboard.
3. **One throughput chart** (the Chart.js bar, range-aware), replacing Flow's inline weekly bars
   AND the old Analytics one. `flowMetrics()`'s `weeklyDone` stays untouched for MCP consumers.
4. **All ported charts become board-aware** (ops ⟷ software via the existing `?board=` switcher).
   The WIP timeline stays **cross-board deliberately**: one human, one limit, across both boards
   (KB2-04) — a per-board split would misrepresent load.
5. **Single nav row:** KanbanNav gains Projects and Archive; the header nav in
   `/kanban/+layout.svelte` is removed (branding stays). Analytics link gone.

## Page composition (top → bottom)

| Section | Source | Notes |
|---|---|---|
| Header + range selector (7d/30d/90d/all) | Analytics | Range drives the *historical* charts. Flow's signal cards keep their policy-defined windows (30/60d) — those are control-loop numbers, not exploration. |
| KPI cards (5) | Analytics, trimmed | Active, Throughput-in-range, WIP now (across N people — a count, not a score), Waiting (oldest), Aging (critical). Median-cycle card dropped: p50/p85/p95 live on the scatter, SLE on its card. |
| Signal cards: Discovered %, Expedite, Flow efficiency, SLE | Flow | Unchanged. |
| Work Item Age table | Flow | Unchanged. THE leading indicator; stays above historical charts. |
| CFD | Analytics | Board + range aware. |
| Daily WIP timeline | Analytics | Cross-board; day tabs; `wipLimit` lanes now sized from `KanbanPolicy.wipPerPerson` (retires the last read of `user.wipLimit`). Widget's hardcoded `/kanban/analytics` gotos → current pathname. |
| Throughput (bar) + Cycle scatter | Analytics | Board + range aware. |
| Aging chart + Time-in-status | Analytics | Aging chart complements the Age table: it covers Tier-1 staleness (captured/processed) which committed-item age can't see. |
| Source mix (manual vs agent) + Per-project table | Analytics | Person-free. Creator-mix slot deleted. |
| Capacity by class + Replenishment events | Flow (KB2-14) | Unchanged. |

## Server layout

- **NEW `src/lib/server/kanban/flow-history.ts`** — the person-free historical computations
  ported from `analytics.ts`: KPI block, CFD, throughput points, cycle scatter, aging rows,
  time-in-status, per-project, source mix. All take `(board, range)`. Keeps the
  activityLog-replay method: it is the only source that covers pre-KB2 archived history, and
  `transitionTask()` writes the same `status_change` entries, so it stays correct for new data.
  Board filter uses `{$ne:'software'}` for ops so any pre-migration stragglers without `board`
  still count. Header carries the decision-#12 constraint verbatim from flow-metrics.
- **NEW `src/lib/server/kanban/wip-timeline.ts`** — WIP timeline moved from `analytics.ts`,
  `wipLimit` resolved from `KanbanPolicy.wipPerPerson` (not `user.wipLimit`). Header documents
  the coordination-view boundary: per-person presence is allowed, per-person aggregation is not;
  nothing here may ever grow a count/total/ranking.
- **DELETE `src/lib/server/kanban/analytics.ts`** (889 lines). `/api/kanban/wip-timeline`
  re-imports from the new module. `analytics/+page.server.ts` → redirect stub; `+page.svelte`
  deleted.
- **DELETE** `PerAssigneeTable.svelte`, `CreatorMixDonut.svelte`.

## Non-goals

- No changes to `flow-metrics.ts` or the MCP `kanban_flow_metrics` payload.
- No new metrics; this is consolidation, not invention.
- Recomputing seed policy numbers from measured flow (separate task, window opens ~end of Aug).

## Acceptance

- `/kanban/analytics` (with or without params) 302s to `/kanban/flow`.
- One nav row: Queue | Inventory | Flow | Policy | Projects | Archive + board switcher.
- Flow renders both boards correctly; historical charts respond to range; WIP timeline
  day-browses without leaving `/kanban/flow`.
- Zero per-person aggregates anywhere: grep for `PerAssignee|CreatorMix|creatorMix|perAssignee`
  returns nothing under `src/`.
- `npm run check` — no new errors vs the 11-error baseline.

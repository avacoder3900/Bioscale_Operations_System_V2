# PRD — Kanban Analytics: Cumulative Flow Diagram

**Domain:** Kanban / Analytics
**Status:** Draft
**Depends on:** `KANBAN-ANALYTICS-FOUNDATION.md`

---

## Problem

Single most important kanban visualization. A CFD shows the count of tasks in each status over time as a stacked area chart. At a glance it reveals: scope creep (top edge rising), WIP bloat (mid bands widening), throughput trend (done band slope), and bottlenecks (specific band widening relative to neighbors).

## Goal

Render a daily-resolution CFD covering the selected date range (default 30 days), with one stacked band per kanban status, sourced from replaying `activityLog[]` across all tasks.

## Non-Goals

- Sub-daily resolution (no hourly granularity).
- Per-project CFDs — page-level filter; per-project view is a separate ask.
- Forecasting / projection lines.
- Annotations / event markers on the chart.

## Scope

### 1. Data shape

For each day `d` in the range, compute the count of tasks that were in each status at the **end of day `d`** (23:59:59 in the chosen timezone — default browser local).

```typescript
type CfdPoint = {
  date: string;          // ISO date 'YYYY-MM-DD'
  backlog: number;
  ready: number;
  wip: number;
  waiting: number;
  done: number;
};
```

Computation algorithm:
1. For each task, walk `activityLog[]` in chronological order, accumulating `[date, status]` segments.
2. For each day in the range, count tasks whose status at end-of-day === each status value.
3. Archived tasks count as `done` (they're terminal-state; the archive is just storage).

### 2. Visualization

- Stacked area chart, daily x-axis labels, count on y-axis.
- Band order bottom → top: `done` (green), `wip` (orange), `ready` (cyan), `waiting` (red), `backlog` (grey).
  - Rationale: `done` at bottom because it's "in the bank" — work that's accumulating. `backlog` at top because new scope appearing pushes the top edge up.
- Color palette matches the existing column colors from `kanban/+page.svelte`:
  - backlog `#a0a0a0`, ready `#00d4ff`, wip `#ff6600`, waiting `#ff3366`, done `#00ff88`.
- Tooltip on hover: date + each band's exact count.
- Legend: clickable to toggle bands on/off.

### 3. Range handling

- `7d` / `30d` / `90d` ranges: daily points.
- `all` range: weekly points if total span > 180 days, else daily. Keeps the chart legible.

## Decisions

- **End-of-day snapshot** semantics — simplest to compute, most common kanban convention.
- **Archived = done** for accounting purposes.
- **Timezone**: browser local for display, computed in UTC then bucketed by user's offset. (Browser sends offset on first request via a URL param or `Intl.DateTimeFormat().resolvedOptions().timeZone` cookie. For v1 just use server UTC and accept ±1 day fuzziness near midnight.)
- **No real-time updates** — CFDs are inherently trailing; refresh on page reload.

## Acceptance criteria

1. CFD renders with all 5 bands for a non-empty kanban dataset.
2. Top edge of the chart (sum of all bands at any x) equals the count of total non-archived + completed-in-range tasks at that date.
3. Hover tooltip shows the date and per-status counts.
4. Legend toggles work — clicking `backlog` in the legend hides that band, leaving the others visible.
5. Range changes (`7d` → `90d`) update the chart axis and recompute the data.
6. Spot-check: take a snapshot at "today" — counts should match the current board state (count of tasks in each status visible on `/kanban`).
7. `npm run check` clean.

## Files touched

| File | Change |
|------|--------|
| `src/lib/server/kanban/analytics.ts` | Add `cfd: CfdPoint[]` to aggregator output |
| `src/lib/components/kanban/CfdChart.svelte` | New: chart.js-backed stacked area |
| `src/routes/kanban/analytics/+page.svelte` | Embed `<CfdChart>` after KPI row |
| `docs/prds/KANBAN-ANALYTICS-CFD.md` | This doc |

## Risk / rollback

- **Compute cost**: 90-day range × ~2000 tasks × average 4 transitions each = 720k iterations in JS. Sub-second on Vercel. Mitigation: pre-aggregate in Mongo if needed (group-by-day pipeline).
- **Edge cases**: tasks created before the range start need their "initial status" inferred — the first activityLog entry. Tasks with no activityLog (legacy) default to current status for every day they existed.
- **Rollback**: delete `<CfdChart>` line in the page; aggregator field stays unused.

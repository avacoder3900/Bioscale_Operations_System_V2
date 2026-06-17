# PRD — Kanban Analytics: Flow Charts

**Domain:** Kanban / Analytics
**Status:** Draft
**Depends on:** `KANBAN-ANALYTICS-FOUNDATION.md`

---

## Problem

CFD shows the system-level view; KPI cards show the right-now view. We also need finer-grained operational charts: how throughput tracks week to week, how cycle time is distributed, which specific tasks are aging, and where time is spent within the workflow.

## Goal

Four secondary charts in a 2×2 grid below the CFD: **Throughput**, **Cycle Time Scatter**, **Aging WIP**, and **Time-in-Status Breakdown**.

## Non-Goals

- Per-team or per-role flow charts.
- Predictive analytics (forecast next week's throughput).
- Custom percentile overlays (we hard-code 50/85/95).

## Scope

### Chart A — Throughput

- Vertical bar chart. X = week (last 12 weeks or fit-to-range). Y = count of tasks that hit `done` in that week.
- Bars stacked by project color (one segment per project that contributed).
- Hover tooltip: total + per-project breakdown.
- Title shows trailing-4-week average as a horizontal reference line.

### Chart B — Cycle Time Scatter

- Scatter plot. X = completion date. Y = cycle time in days (from first `wip` entry to first `done`).
- One dot per completed task. Dot color = project color. Dot click → `/kanban/task/[taskId]`.
- Horizontal percentile lines overlaid:
  - 50th (median) — solid line
  - 85th — dashed line, kanban convention for "service level"
  - 95th — dotted line, outlier boundary
- Tooltip: title, completed-on date, exact cycle time, click hint.

### Chart C — Aging WIP

- Horizontal bar chart, one bar per **currently-open** task (status ≠ done, not archived).
- X = days in current status.
- Bar color = status (matches CFD palette).
- Sorted descending — stalest at top.
- Bar label = truncated task title (32 chars).
- Click bar → task detail.
- Right-edge marker per row showing the warning threshold for that status (red zone past `critical`, amber past `warning`).
- Limit to top 20 bars to keep chart legible. "Show all (N)" link to expand.

### Chart D — Time-in-Status Breakdown

- Stacked horizontal bars, one bar per task **completed in the date range**.
- Each bar's total width = total cycle time. Segments within = time in each status, colored by status.
- Sorted by total cycle time desc.
- Limit top 20 with "Show all" expansion.
- Reveals: do tasks spend 80% of their cycle in `waiting`? In `backlog`? Drives improvement focus.

## Decisions

- **All four charts respect the page date range** for the completion-based ones (Throughput, Scatter, Time-in-Status). Aging WIP is point-in-time (current).
- **Top-20 limit** on Aging WIP and Time-in-Status — keeps the chart scannable.
- **Project color** is the default visual encoding when needed; falls back to status color when project isn't relevant.

## Acceptance criteria

1. All four charts render in a 2×2 grid below the CFD.
2. **Throughput**: bars sum to total completions in the range; 4-week average line visible.
3. **Cycle Scatter**: dots clickable, percentile lines computed correctly (spot-check median against a manual count).
4. **Aging WIP**: at least the 5 most-stale active tasks are shown; click navigates to detail.
5. **Time-in-Status**: stacked segments correctly identify the dominant stage per task (verifiable by replaying one task's activityLog).
6. Date range changes update all charts that are range-scoped; Aging WIP is unaffected.
7. `npm run check` clean.

## Files touched

| File | Change |
|------|--------|
| `src/lib/server/kanban/analytics.ts` | Add `throughput`, `cycleScatter`, `agingWip`, `timeInStatus` blocks |
| `src/lib/components/kanban/ThroughputChart.svelte` | New |
| `src/lib/components/kanban/CycleScatterChart.svelte` | New |
| `src/lib/components/kanban/AgingWipChart.svelte` | New |
| `src/lib/components/kanban/TimeInStatusChart.svelte` | New |
| `src/routes/kanban/analytics/+page.svelte` | Add 2×2 grid section |
| `docs/prds/KANBAN-ANALYTICS-FLOW-CHARTS.md` | This doc |

## Risk / rollback

- Cycle scatter can get noisy with many outliers — percentile lines should compress visual range. If chart becomes unreadable, log-scale Y axis is a fallback.
- Time-in-Status replay is the heaviest computation here. Bench at v1; cache if needed.
- Rollback: remove individual chart components; the page lays out gracefully with fewer cells.

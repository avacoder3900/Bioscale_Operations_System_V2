# PRD — Kanban Analytics: KPI Cards

**Domain:** Kanban / Analytics
**Status:** Draft
**Depends on:** `KANBAN-ANALYTICS-FOUNDATION.md`

---

## Problem

The analytics page needs at-a-glance numbers — the kind a manager looks at in 5 seconds and knows whether the team is healthy. Charts are powerful but they're slow to read.

## Goal

Render six KPI cards at the top of `/kanban/analytics` that summarize team flow at a glance, computed from the shared aggregation output.

## Non-Goals

- Drill-down on click (cards are read-only).
- Per-card date-range overrides (the page-level range applies to all).
- Trend sparklines inside the cards — that would push us into chart territory; flow charts cover trends.

## Scope

### Card definitions

| # | Card | Number | Subline | Notes |
|---|------|--------|---------|-------|
| 1 | **Active tasks** | count of tasks where `archived=false AND status!='done'` | "+/− X vs last period" | Sub-line is delta vs the prior equal-length window |
| 2 | **Throughput** | count of tasks that hit `done` in the date range | "X this period" | Bigger = better |
| 3 | **Median cycle time** | median of `cycleTime` (first `wip` → first `done`) over tasks completed in range | "85th: X days" | Median + 85th percentile, in days |
| 4 | **WIP right now** | count of tasks where `status='wip'` | "across N people" | The N is distinct assignees |
| 5 | **Stuck in Waiting** | count of `status='waiting'` tasks | "oldest: X days" | Days = current age of oldest waiting task |
| 6 | **Aging tasks** | count of non-done tasks whose `daysInStatus > threshold for that status` | "X critical" | Thresholds match `KanbanTaskCard.svelte`: backlog 14d, ready 5d, wip/waiting 3d. Critical = >2× warning |

Thresholds for "aging" are pulled from a single source — extract to `src/lib/shared/kanban-aging.ts` and import in both `KanbanTaskCard.svelte` and the analytics aggregator so they can't drift.

### Visual

- Six cards in a single horizontal row on desktop, 2×3 grid on tablet, vertical stack on mobile.
- Each card: big number (40px), label below, sub-line in smaller muted text.
- Tron styling — `tron-card`, accent color borders matching the metric (green for throughput, red for aging, etc.).
- No clickable behavior — text-only.

## Decisions

- **Median over mean** for cycle time — kanban convention; less skewed by outliers.
- **85th percentile** as the secondary cycle-time number — also kanban convention (covers ~service-level expectations).
- **Distinct-assignee count** on the WIP card, not raw WIP count — answers "how spread out is the team."

## Acceptance criteria

1. Cards render with real numbers for a non-empty kanban dataset. Empty dataset shows "—" not "0" only where appropriate (e.g., median is "—" when no completed tasks; throughput is "0").
2. Changing the date range re-fetches and the cards update (Throughput, Median cycle time, Aging delta).
3. Active / WIP / Waiting cards are point-in-time (current state) — not affected by range.
4. Throughput, Median, and Aging cards are range-scoped.
5. Aging thresholds verified to match the per-card aging severity in `KanbanTaskCard.svelte`.
6. `npm run check` clean.

## Files touched

| File | Change |
|------|--------|
| `src/routes/kanban/analytics/+page.svelte` | Render `<KpiCard>` row near the top |
| `src/lib/components/kanban/KpiCard.svelte` | New: small reusable card component |
| `src/lib/shared/kanban-aging.ts` | New: aging thresholds (move from `KanbanTaskCard.svelte`) |
| `src/lib/server/kanban/analytics.ts` | Extend `loadAnalyticsData()` to include `kpi` block |
| `src/lib/components/kanban/KanbanTaskCard.svelte` | Import thresholds from shared module |
| `docs/prds/KANBAN-ANALYTICS-KPI-CARDS.md` | This doc |

## Risk / rollback

- Moving aging thresholds shared changes `KanbanTaskCard.svelte` — touches the frozen UI. Mitigation: keep the import-only change minimal, no visual change.
- Rollback: hide the row by removing `<KpiCard>` instances. Aggregator changes are additive — safe to leave.

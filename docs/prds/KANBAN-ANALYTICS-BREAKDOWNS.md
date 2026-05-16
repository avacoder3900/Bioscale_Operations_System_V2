# PRD — Kanban Analytics: Breakdown Tables

**Domain:** Kanban / Analytics
**Status:** Draft
**Depends on:** `KANBAN-ANALYTICS-FOUNDATION.md`

---

## Problem

Charts reveal patterns. Tables reveal specifics. At the bottom of the analytics page we need scannable, sortable tables that answer: *which project is producing the most? who is loaded heaviest? where do tasks come from?*

## Goal

Three breakdowns at the bottom of `/kanban/analytics`: **Per-Project**, **Per-Assignee**, and **Source Mix**.

## Non-Goals

- Pivot / cross-tab analytics (e.g., project × assignee matrix).
- Per-row drill-down (each row links to a filtered view but the table itself is one click).
- CSV export.

## Scope

### Per-Project table

Columns:
| Project | Active | Done (range) | Median Cycle | WIP | Aging |
|---------|--------|--------------|--------------|-----|-------|

- **Project**: name + color dot. Click → `/kanban/list?project=<id>`.
- **Active**: count of non-archived non-done tasks for that project.
- **Done (range)**: count completed in the date range.
- **Median Cycle**: median cycle time for completed-in-range tasks.
- **WIP**: count of tasks with `status='wip'`.
- **Aging**: count of aging tasks (per the shared threshold module).
- Sortable by any column. Default sort: Done (range) desc.

### Per-Assignee table

Columns:
| Person | Active | Done (range) | Load score | WIP | Aging |
|--------|--------|--------------|------------|-----|-------|

- **Person**: username. Click → `/kanban/list?assignee=<id>`.
- **Active**: non-archived non-done count.
- **Done (range)**: completed in range.
- **Load score**: weighted by `taskLength` — `short=1, medium=2, long=4` — summed across active tasks. Caps at the user's `wipLimit * 4` if `wipLimit` is set (per `KANBAN-WIP-LIMIT-ENFORCEMENT.md`).
- **WIP**: status=wip count for tasks assigned to this person.
- **Aging**: aging tasks assigned to this person.
- Unassigned tasks aggregated into a final "— Unassigned —" row.
- Sortable. Default sort: Load score desc.

### Source Mix donut

- Donut chart counting tasks in the date range by `source` field. Likely values: `manual` (or null), `telegram`, `meeting-synthesis`, `agent`, `operations-trigger`.
- Center label: total task count in the period.
- Click slice → `/kanban/list?source=<value>` (requires the list view to accept this filter — small addition to its load function).
- If only one source category (or all unknown), show as a flat "100% manual" bar instead of a donut.

## Decisions

- **Load score weights**: 1/2/4 for short/medium/long. Standard t-shirt sizing.
- **Unassigned aggregation**: separate row, last in sort, neutral color.
- **Source filter on list view**: extend `/kanban/list/+page.server.ts` to accept `source` query param (one-line addition).

## Acceptance criteria

1. Both tables render with all columns populated.
2. Sortable by clicking any column header — asc/desc/clear cycle (matches `/kanban/list` and `/kanban/archived`).
3. Per-Project row count = count of distinct projects with at least one task in scope, plus an "— No project —" row if any tasks have null project.
4. Per-Assignee row count = count of distinct assignees + unassigned row.
5. Source donut slices total to the count in the source-mix center label.
6. Clicking a row navigates to a filtered list view that shows exactly those rows' tasks.
7. `npm run check` clean.

## Files touched

| File | Change |
|------|--------|
| `src/lib/server/kanban/analytics.ts` | Add `perProject`, `perAssignee`, `sourceMix` blocks |
| `src/lib/components/kanban/PerProjectTable.svelte` | New |
| `src/lib/components/kanban/PerAssigneeTable.svelte` | New |
| `src/lib/components/kanban/SourceMixDonut.svelte` | New |
| `src/routes/kanban/analytics/+page.svelte` | Add bottom section with the three breakdowns |
| `src/routes/kanban/list/+page.server.ts` | Accept `source` query param |
| `docs/prds/KANBAN-ANALYTICS-BREAKDOWNS.md` | This doc |

## Risk / rollback

- Load score is a heuristic — easy to argue about weights. Document them in the table header tooltip.
- Adding `source` to list filter is additive; no existing behavior changes.
- Rollback: remove the three components from the page.

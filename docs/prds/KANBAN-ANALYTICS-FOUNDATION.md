# PRD — Kanban Analytics: Foundation

**Domain:** Kanban / Analytics
**Branch:** `feature/kanban-improvement` (or a follow-up branch)
**Author:** Jacob Q
**Status:** Draft
**Related:** `DOMAIN-02-KANBAN.md`, sibling PRDs `KANBAN-ANALYTICS-KPI-CARDS.md`, `-CFD.md`, `-FLOW-CHARTS.md`, `-BREAKDOWNS.md`, `KANBAN-WIP-TIMELINE.md`, `KANBAN-WIP-LIMIT-ENFORCEMENT.md`

---

## Problem

The kanban system has accumulated rich timeline data (`activityLog[]` on every task captures every status transition with timestamps) but exposes none of it. There is no view that answers: *how fast are we shipping, where are tasks getting stuck, who is doing what, and is the team's flow stable?*

## Goal

Stand up the `/kanban/analytics` route + layout + server-side aggregation pipeline so the actual analytics widgets (defined in sibling PRDs) have a place to live and a shared data backend.

## Non-Goals

- Any specific chart or metric — those are in sibling PRDs.
- Per-user analytics preferences / saved views.
- Email / Slack reports of analytics.
- Historical snapshotting (we compute live from `activityLog[]` every request).

## Scope

### 1. Route + permission

- New route `src/routes/kanban/analytics/+page.server.ts` + `+page.svelte`.
- Gate on `kanban:read` (matches the rest of `/kanban/**`).
- Add a `depends('kanban:analytics')` tag for future invalidation.

### 2. Nav link

Add an **Analytics** entry to the existing kanban header nav in `src/routes/kanban/+layout.svelte`, placed after **Archive**. Icon: chart/bar-graph SVG matching the Tron style of the other nav items.

### 3. Date-range URL param

Single query param: `?range=7d|30d|90d|all`. Default `30d`. Drives every widget on the page. Renders as a button-group selector at the top right of the analytics page.

```typescript
// In load function:
const range = url.searchParams.get('range') ?? '30d';
const since = computeSince(range); // Date object, or null for 'all'
```

### 4. Shared server-side aggregation

A single function `loadAnalyticsData({ since })` in `src/lib/server/kanban/analytics.ts` that:
- Pulls all non-archived tasks plus archived tasks whose `archivedAt >= since`.
- Builds a normalized in-memory shape with computed-per-task fields: `cycleTime` (first `wip` entry → first `done` entry), `currentAge` (since `statusChangedAt`), `stageDurations` (array of {status, ms} from replaying activityLog).
- Returns one object consumed by every widget. Sibling PRDs slice from this.

Goal: single Mongo round-trip, single pass through `activityLog[]` per task. Should be sub-second at our scale (estimated <2000 active + archived-in-window tasks).

### 5. Chart library decision

**Recommendation: `chart.js` + `svelte-chartjs`** wrapper.
- Pros: handles 90% of what we need (bars, lines, scatter, stacked area for CFD) out of the box; small bundle (~80KB gzipped); the svelte-chartjs wrapper is Svelte 5 compatible.
- Alternative: `apexcharts` — prettier defaults, larger bundle (~200KB), some quirks with Svelte 5 reactivity.
- For the WIP timeline grid: hand-rolled SVG/HTML, not a chart library. (See `KANBAN-WIP-TIMELINE.md`.)

Install: `npm install chart.js svelte-chartjs`.

### 6. Page layout (skeleton)

```
┌─────────────────────────────────────────────────────────┐
│  Kanban Analytics             [7d] [30d] [90d] [All]    │
├─────────────────────────────────────────────────────────┤
│  [ KPI cards row — 6 cards, PRD KPI-CARDS ]             │
├─────────────────────────────────────────────────────────┤
│  [ Cumulative Flow Diagram — full width, PRD CFD ]      │
├─────────────────────────────────────────────────────────┤
│  [ Daily WIP Timeline — full width, PRD WIP-TIMELINE ]  │
├─────────────────────────────────────────────────────────┤
│  [ Flow charts grid 2×2 — PRD FLOW-CHARTS ]             │
├─────────────────────────────────────────────────────────┤
│  [ Breakdown tables — PRD BREAKDOWNS ]                  │
└─────────────────────────────────────────────────────────┘
```

## Decisions

- **Library**: `chart.js` + `svelte-chartjs`.
- **Default range**: 30 days.
- **All-time view**: bounded by oldest task in DB, no synthetic floor.
- **Route placement**: `/kanban/analytics` (sibling to `list`, `projects`, `archived`).
- **Live updates**: none on the foundation. Individual widgets that need them (WIP timeline) define their own polling.

## Acceptance criteria

1. Navigating to `/kanban/analytics` returns 200 for users with `kanban:read`, 403 for users without.
2. The header nav shows an **Analytics** entry between Archive and the back-to-site spot (after the recent nav cleanup), highlighted active when on `/kanban/analytics`.
3. Page renders with the date-range selector at top right. Default selection `30d`. Clicking a button updates `?range=` and re-fetches.
4. `loadAnalyticsData()` returns the shape documented above (verified by reading the response in the browser devtools network panel).
5. `chart.js` + `svelte-chartjs` installed and a trivial smoke chart (just a placeholder bar) renders without console errors.
6. `npm run check` clean on changed files.

## Files touched

| File | Change |
|------|--------|
| `src/routes/kanban/analytics/+page.server.ts` | New: range parsing, calls aggregator |
| `src/routes/kanban/analytics/+page.svelte` | New: page layout, date-range selector, slots for widgets |
| `src/lib/server/kanban/analytics.ts` | New: `loadAnalyticsData()` aggregation |
| `src/routes/kanban/+layout.svelte` | Add Analytics nav item |
| `package.json` | Add `chart.js`, `svelte-chartjs` |
| `docs/prds/KANBAN-ANALYTICS-FOUNDATION.md` | This doc |

## Risk / rollback

- **Aggregation cost**: if N grows large (>10k tasks), the activityLog replay could get expensive. Mitigation: add a `recordedAt` index on tasks, paginate or stream if it becomes a problem. Not blocking for v1.
- **Chart.js bundle size**: ~80KB gzipped. Acceptable.
- **Rollback**: remove the nav item; route becomes 404 if file deleted. Zero downstream impact.

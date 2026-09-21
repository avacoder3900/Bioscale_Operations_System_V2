# KB2-29 — Roadmap views: chronological timeline, must-start, plans

**Status:** approved 2026-08-20. Consumes KB2-27 schema + KB2-28 scheduler.

## Intent (from Jacob)
"A very good chronological visualization that I can go to to see both Tier 1 and Tier 2
tasks — all the tasks being worked on" — plus the daily-driver answers (countdown,
must-start) and the immortalized-plan pages.

## Design decisions
- **One time axis, split by today's line — past is fact, future is math.**
  Left of today: actual history from real stamps (`wipDate`, `completedDate`) — what
  happened, no estimates involved. Right of today: the KB2-28 derived schedule — in-flight
  Tier 2 work projected to completion, then Tier 1 milestone-chain tasks at their computed
  start/finish. Future bars are visually distinct (dashed/hollow) so a projection is never
  mistaken for a commitment.
- **Lanes = tags** (program areas), NOT people. Matches the roadmap's structure, keeps
  ~10 lanes readable at 100+ tasks, and respects KB2-00 decision #12 — a per-person past
  timeline would visually reconstruct the per-person history aggregates the board
  constitutionally refuses to build. First tag wins (same rule as WIP-timeline coloring);
  untagged tasks share an "untagged" lane.
- **Milestone diamonds** fixed on the axis at their `dueDate`; countdown header per
  milestone: days left, chain % done, buffer days (CCPM burn), red "infeasible" banner
  when buffer < 0.
- **Must-start list** on the roadmap page: red (latest-start passed) / amber (≤7 days),
  slack ascending, rank tiebreak; each row says which milestone drives it and why
  (blocker chain). This is the daily driver; the chart is for the weekly review.
- **No Gantt bar editing, ever.** Dates on the future half are outputs; you change them by
  changing reality (links, estimates, scope) — in the app or via MCP.
- Rendering: hand-rolled SVG (no chart dependency), weekly gridlines, zoom via range
  select. DAG view (Svelte Flow/dagre) is a deliberate fast-follow, not in this PRD.

## Routes
- **`/kanban/roadmap`** — countdown header(s), must-start list, the timeline, calibration
  footnote ("your explicit estimates run ~1.6× optimistic, n=14"). Load =
  `computeRoadmap()` + past-actual spans query.
- **`/kanban/plans`** — PlanningDocuments newest-first: title, version, status, author,
  filed date, spawned-task progress (done/total).
- **`/kanban/plans/[id]`** — the markdown verbatim (monospace, read-only) + live index of
  spawned tasks (`sourceRef: 'plan:<id>'`) with status badges + supersession chain links.
- `KanbanNav` grows **Roadmap** and **Plans** tabs.

## Timeline data contract
Past spans: done tasks (`wipDate→completedDate`) and in-flight (`wipDate→today`) from the
last 8 weeks, lane = first tag. Future spans: KB2-28 rows with ES/EF, critical chain
highlighted, `late` rows flagged. Milestones: diamonds + labels. All serialized plain.

## Permissions
`kanban:read` for all three routes (same as the board). Plan filing is MCP/agent-side
(KB2-27); no plan-editing UI.

## Out of scope
- DAG dependency-graph view (fast-follow), Monte Carlo cones, burn-up charts, drag-to-
  reschedule (never), per-person lanes (never — decision #12).

## Validation
- `npm run check` at baseline; roadmap renders with zero milestones (empty-state points at
  MCP workshop flow), with a milestone lacking dueDate (flagged), and with the full A4M
  import once roadmap-v4 is filed as PlanningDocument #1.

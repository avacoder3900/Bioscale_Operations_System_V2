# KB2-27 — Milestones, estimates, and immortalized plans (schema layer)

**Status:** approved 2026-08-20 (workshopped Jacob ↔ Claude, this session). First of the
roadmap trio: KB2-27 schema → KB2-28 scheduler → KB2-29 views.

## Intent (from Jacob)
We don't have per-task deadlines — we have milestone deadlines (A4M, Dec 11) and we know
the dependency chains that feed them. The system should hold that structure. Estimates get
workshopped in the Claude app and written via MCP, then checked against actuals. And the
strategic plans themselves (e.g. roadmap-v4) should be immortalized in the database with a
timestamp so every task can answer "where did this come from?"

## Decisions (locked 2026-08-20)
- **Milestone = a task**, `itemType: 'milestone'` — NOT a tag, NOT a new collection. It's a
  node in the dependency graph: other tasks point at it with existing `blocked_by` links and
  it is the only kind of node whose `dueDate` is a hard anchor. Tags keep their grouping job.
  Milestones can gate other milestones (recipe-lock blocks A4M).
- **`estimateDays`** (number, working days) on the task. The scheduler's fallback ladder:
  `estimateDays` → `SIZE_CLASS_DAYS[sizeClass]` (short=1, medium=3, long=7) → historical
  median cycle time. The math never stalls on a missing estimate; every workshopped number
  sharpens it. Estimates are checked against actuals (`wipDate → completedDate`) — KB2-28
  computes the calibration.
- **Dependency logic is human-approved, never inferred.** It comes from the Claude-app
  workshop (finalized in chat → written via MCP link tools, cycle-checked) or the task page.
  Nothing auto-creates links.
- **PlanningDocument** — a new collection immortalizing finalized strategy docs:
  the full markdown verbatim, timestamped, versioned, supersession chain. Tasks created
  from a plan carry `source: 'plan'`, `sourceRef: 'plan:<id>'` so provenance is queryable
  both ways ("this task was born from Roadmap v4" / "of the 60 things v4 called for, 31
  are done").

## Schema
### `kanban-status.ts` (shared, client-safe)
- `ITEM_TYPES` += `'milestone'`.
- `SIZE_CLASS_DAYS: Record<KanbanSizeClass, number> = { short: 1, medium: 3, long: 7 }` —
  the canonical mapping, imported by scheduler and UIs alike.

### `KanbanTask`
- `estimateDays: Number` (optional; working days; > 0).

### `PlanningDocument` (new model, collection `planning_documents`)
```
_id           nanoid
title         e.g. "Fall 2026 Roadmap — v4"
version       free string ("v4")
content       full markdown, verbatim
context       one-para blurb: what question the workshop answered
status        'active' | 'superseded'
supersedes    plan _id (chain; superseding sets the old one 'superseded')
authoredBy    username (the human the workshop was on behalf of)
filedVia      'mcp' | 'ui'
timestamps
```
Plans are append-mostly: content is never edited after filing (file a new version instead).

## Behavior changes
- `processTask` / `reshapeTask` accept optional `estimateDays`; the process/reshape agent
  endpoints and the inventory Process modal pass it through. Milestones may skip sizing
  (`sizeClass` optional when itemType is milestone — a milestone is a marker, not work).
- Capture accepts `itemType: 'milestone'` and optional `estimateDays` (plan imports
  create + estimate in one motion).
- `kanban_update_task` PATCH accepts `estimateDays`.

## MCP / agent API additions
- `kanban_file_plan` → POST `/api/agent/operations/kanban/plans` — files the finalized doc
  FIRST, returns the plan id; the session then captures tasks with
  `sourceRef: 'plan:<id>'` so provenance is atomic with the import. Supersession via
  `supersedes`.
- `kanban_list_plans` → GET `/api/agent/operations/kanban/plans`.
- `kanban_get_plan` → GET `/api/agent/operations/kanban/plans/<id>` — doc + live index of
  spawned tasks with statuses.
- Capture/process/update tool schemas grow `estimateDays`; capture item schema grows
  `'milestone'` in itemType.

## Out of scope (later PRDs)
- All computation (KB2-28) and all UI beyond the process-modal estimate field (KB2-29).
- LLM-proposed dependency links (could ride the `proposals` mechanism someday; explicitly
  not now — graph stays human-approved).

## Validation
- `npm run check` at baseline; capture a milestone via MCP, link tasks to it, file a plan,
  re-read it with spawned-task index.

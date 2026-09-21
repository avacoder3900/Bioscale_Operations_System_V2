# KB2-33 — Dependencies panel: see and edit links on the task page

**Status:** approved 2026-08-21 (Jacob). Closes the write-only gap found while reviewing
the roadmap: dependency data is rich (KB2-20 `links[]` with type/note/author/cycle-guard,
`parentTaskId`, `spawnedFrom`) and the scheduler + canvas consume it, but NO UI surface
showed or edited it — links were created only via MCP workshops and drawn as anonymous
canvas edges. On the one page where you'd ask "what is this task waiting on?", nothing.

## Scope
The task detail page (`/kanban/task/[taskId]`) gains a **Dependencies** card in the right
column (above Task Info):

- **Blocked by** — each blocker with a status dot (green = done, amber = still open —
  instantly answers "why can't this start"), tracking# + title linking to the task, the
  note, and who declared it.
- **Blocks** — what this task is holding up, same row shape.
- **Related** — `relates_to` links (previously visible NOWHERE).
- **Structure** — parent (link), subtasks (with status badges), spawned-from provenance.
  Read-only in v1; re-parenting stays MCP (`kanban_update_task parentTaskId`).
- **Add**: type select (blocked by / blocks / related) + target field accepting a
  **TASK-number or raw task id** (lenient: case/whitespace-insensitive, `task-12` →
  `TASK-012` zero-padding attempted on both widths) + optional note. Server resolves,
  then calls the existing `addLink` service — so UI adds get the same validation the
  MCP path has: existence check, self-link rejection, dupe rejection, **blocking-cycle
  guard**, activity-log entry, audit row.
- **Remove**: ✕ per row — only on links this task declares (`direction: 'declared'`);
  derived rows say which task owns them (the service stores links one-way; the owner
  drops them). Uses the existing `removeLink` service (audited).

## Implementation notes
- Zero new service code: `readLinks` / `addLink` / `removeLink` in
  `src/lib/server/kanban/transition.ts` already existed (KB2-20/MCP-IMPROVEMENTS) with
  hydrated far-side rows (trackingNumber/title/status) — the page simply never called
  them. Load adds `links`, `parent`, `subtasks`, `spawnedFromTask`; two new actions
  (`addLink`, `removeLink`) wrap the services.
- Scheduling meaning is stated inline in the panel ("blocked-by edges drive the
  roadmap"), so a hand-added link visibly moves the canvas/timeline on next load.

## Out of scope
- Autocomplete/search picker for the target task (typing a TASK-number covers the real
  workflow; revisit if it chafes). Re-parent UI. Link editing (delete + re-add covers it).

## Validation
- `npm run check` at baseline. Add a `blocked_by` by TASK-number → appears with amber
  dot; roadmap reflects it. Adding a cycle is rejected with the cycle message. Removing
  a declared link works; derived rows offer no ✕. relates_to renders.

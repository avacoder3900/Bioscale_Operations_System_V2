# KB2-38 — Capture modes: quick vs detailed, landing tier, rank placement

**Status:** approved 2026-09-01 (Jacob: "there is often that i want to push tasks straight
to the board, or i want them to be written out and processed… lets simplify the quick add
field to not have the deliverables box under it… a new detail capture mode which brings up
the task detail view and lets me fill out everything… type in the spot on the tier 1 list
that it goes to, defaults to the bottom… the ability for it to originate processed or
committed"). Amends KB2-03 (processing), KB2-06 (inventory view), KB2-11/12 (capture UX),
KB2-14 (commit bar), KB2-18 (MCP capture shape).

## Problem

Capture is one shape only: a one-line box (plus a deliverable field nobody fills at that
moment) that always lands `captured` at the bottom of Tier 1. When the person capturing
already knows the whole item — size, class, deliverable, where it ranks, and that it is
going on the Board today — they have to capture, find the row, Process (modal), then
Commit, then rank-jump. Four motions for one decision. The deliverable field under the
quick box is the worst of both: too much for a quick capture, not enough for a shaped one.

## Design

Two capture modes, one service, the same gates.

### 1. Quick capture (Tier 1 header, unchanged in spirit)

- **Title + tags + optional position.** The deliverable field under the box is gone.
- **Position** is a small number input: "#" placeholder, empty = bottom (today's
  behavior). `1` = top of Tier 1; anything past the end clamps to bottom.
- Always lands `captured`. A "Detailed…" button sits beside Capture and opens mode 2.

### 2. Detailed capture — `/kanban/capture`

A full page shaped like the task detail view (main column + sidebar), because a modal
cannot hold the whole item and Jacob asked for "the task detail view":

- **Main:** title, description, deliverable (DoR), agent handoff brief (DoR for
  `software`-tagged items).
- **Sidebar — Landing:** `Capture` (→ `captured`) · `Process` (→ `processed`) · `Commit`
  (→ `ready`). Commit is only offered to holders of `kanban:replenish` (or admin). The
  submit button reads Capture / Capture & Process / Capture & Commit.
- **Sidebar — Position:** number input; placeholder shows where "bottom" is for the chosen
  landing (`bottom (#N+1)` of Tier 1, or of the ready queue when committing).
- **Sidebar — Shaping:** item type (deliverable/spike/chore/milestone; spike shows
  question + timebox), size class (with the policy definitions and the KB2-12 sizing
  test), class of service, due date, estimate days, effort days, assignee, tags
  (comma-separated with vocabulary suggestions).
- `?landing=committed` pre-selects Commit — the Board header gets a "+ New task" link
  that opens the page that way.
- On success: redirect to Tier 1 (captured/processed) or the Board (committed) so the
  new row is visible in its slot. Errors render inline with the server's reason verbatim.

### 3. One service: `captureTask()` (`src/lib/server/kanban/capture.ts`)

`captureTask(opts)` = `createKanbanItem` → optional `processTask` → optional `replenish`
→ optional placement via `reorder`. Every capture surface (quick box, detailed page,
agent API, MCP) calls it, so a UI item and an agent item are the same shape.

- `landing: 'captured' | 'processed' | 'committed'` (default `captured`).
- `position?: number` — 1-based slot in the landing list (Tier 1 order for
  captured/processed, the ready queue for committed). Omitted = bottom. Clamped.
- `sizeClass` + `classOfService` are required for `processed`/`committed`
  (`processTask` sets them — the KB2-03 rule that the processor sizes the item holds:
  here the capturer *is* the processor, explicitly).
- **Gates are unchanged, only front-loaded.** Before anything is written, `committed`
  runs `requireReplenisher(actor)` and the DoR check (`dorMissingFields` on the would-be
  task) and refuses if the ready queue is at cap — so a refused commit never leaves a
  half-created item. The actual crossing is still `replenish()` (one replenishment event,
  audited, min-order-point recheck). Expedite/allocation rules apply as before.
- Placement reuses `reorder()` (KB2-25/26 bulkWrite path): build the ordered ids of the
  landing scope, splice the new id in, renumber. Ready-queue placement therefore needs
  the replenisher permission — which committing already proved.
- Activity log on the task carries `landing` and `position` in the `created` details.

### 4. Agent API + MCP

- `POST /api/agent/operations/kanban/tasks` accepts `landing`, `position`, `sizeClass`,
  `classOfService`, `commitNote`; routes through `captureTask`. Response echo gains
  `landing`, `position`, and `replenish` (the event summary) when committed.
- `kanban_capture` (MCP 3.4.0) exposes the same fields. `committed` needs an actor
  holding `kanban:replenish` — the human-only commitment rule (KB2-00 #6) is preserved:
  the tool refuses machine-only actors exactly as `kanban_replenish` does.
- `kanban_capture_bulk` / subtasks keep the plain shape (always `captured`) — bulk
  commits stay a deliberate `kanban_replenish` call.

## Non-goals

- Drag-to-position (KB2-00 #4: buttons/typed numbers, not drag).
- Editing an existing task from this page — that is the task detail page.
- Changing the DoR floor, ready cap, or who may commit.
- Templates: `captureFromTemplate` is untouched (still lands processed).

## Acceptance

1. Quick box: title only → `captured` at bottom; with `#3` → rank 3 and the old #3..N
   shift down by one. No deliverable field is rendered.
2. `/kanban/capture` with Landing = Process, size+class set → task is `processed`,
   DoR/estimate stored, sits at the typed position; without size → 400 with the reason.
3. Landing = Commit as a replenisher with a full DoR → task is `ready`, one replenishment
   event recorded, Board shows it at the typed slot; as a non-replenisher the option is
   not offered and the server refuses with `PERMISSION_DENIED`.
4. Commit when the ready queue is at cap → refused before creation; Tier 1 unchanged.
5. `kanban_capture` with `landing:'committed'`, actor holding `kanban:replenish` → same as 3.
6. `npm run check` stays at baseline (11).

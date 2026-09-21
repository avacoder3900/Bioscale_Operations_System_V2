# KB2-14 — Inventory/Commit Merge (the Replenish page retires; the ceremony moves)

**Depends on:** KB2-02 (commitment point), KB2-03 (DoR), KB2-06 (views), KB2-13 (supply loops).
Read KB2-00 first.

**Status:** Approved by Jacob 2026-08-03.

## Why

KB2-06 gave the commitment ceremony its own page (`/kanban/replenish`): candidates on the left,
queue on the right, stage → arrange → Commit. In practice the page is a duplicate of Inventory
with checkboxes — the candidate list IS the Tier 1 inventory, re-rendered with less context
(no project grouping, no rank moves, no processing controls). The real workflow is: look at the
options, process the ones worth committing, commit them — one surface, not a page hop between
"manage the options" and "commit the options."

So the **page** is retired and the **ceremony** moves into Inventory. What does NOT move is the
gate: `replenish()` in `src/lib/server/kanban/replenish.ts` is unchanged — actor resolution to a
real user holding `kanban:replenish` (or admin), DoR completeness, ready cap, expedite cap, chore
ceiling, one batch replenishment event, min-order-point signal. The commitment point is a
server-side invariant, not a page; moving the UI does not weaken it.

The two capacity readouts the old page carried (WIP-by-class vs allocation targets, replenishment
event history) are flow information, not ceremony controls — they move to `/kanban/flow` where
the rest of the flow data already lives.

## Design

### 1. Inventory gains the commit bar (the ceremony)

- Every `captured`/`processed` row gets a **staging checkbox** — but only rows that are
  `processed` AND DoR-complete are checkable. Captured rows are disabled with tooltip
  "Still 'captured' — process it first"; DoR-incomplete processed rows are disabled with a
  tooltip listing the exact missing fields (from `dorMissingFields`).
- Selecting any row shows a **sticky footer bar**: "N selected · Ready x/8", the staged list in
  commit order with ▲▼ reorder (the order is the rank order they'll join the queue in), an
  optional note (recorded on the event), and **Commit** → the existing `replenish()` service
  (one batch event, `actorUsername = locals.user.username`, `via: 'ui'`).
- The result renders inline: promoted items with their new ranks, rejected items with the
  service's exact reasons. `PERMISSION_DENIED` renders as a clear message, not a raw error.
- The whole staging apparatus (checkboxes + bar) is **hidden entirely** for users without
  `kanban:replenish`/admin — for them Inventory looks exactly as before.

### 2. Inventory header: Ready chip

A compact **"Ready x/8"** chip next to the page title — red when the count is below the board's
`minOrderPoint` (the replenish-now signal), so queue depth is visible from the place where the
decision to commit is made.

### 3. Flow gains the capacity + history sections

Moved verbatim from the old page, fed by the same data:

- **Capacity**: WIP by class of service vs `allocationTargetsPct` (from `replenishmentStatus()`),
  next to the discovered-ratio suggestion Flow already shows.
- **Replenishment events**: last 10 batch events from AuditLog
  (`tableName:'kanban_tasks'`, `recordId ^replenishment:` — the tableName filter keeps the regex
  on the compound index) — who, when, promoted/rejected counts, note.

### 4. The route retires; the path survives

- `src/routes/kanban/replenish/` page + actions deleted. The path keeps a `+page.server.ts`
  whose load throws `redirect(302, '/kanban/inventory')`, preserving `?board=software` —
  bookmarks and muscle memory land on the new home of the ceremony.
- KanbanNav drops the tab: **Queue | Inventory | Flow | Policy**.

### 5. Demote stays on Queue

Demote's home is the Queue cards (ready/waiting/blocked, permission-gated) — that is where you
look at committed work and unwind a bad commitment. The old page's duplicate demote dies with
the page; the service (`demote()`) and its Queue/MCP/agent callers are untouched.

### Explicitly unchanged

`replenish()` / `demote()` / `reorder()` / `replenishmentStatus()`, the 4 agent endpoints, the
MCP tools, `kanban:replenish` permission semantics, the min-order-point WorkflowViolation signal,
and the KB2-13 supply-card autopilot (which bypasses this ceremony by design).

## Acceptance criteria

- [ ] `/kanban/replenish` (with or without `?board=software`) 302-redirects to
      `/kanban/inventory` preserving the board param; the nav shows Queue | Inventory | Flow |
      Policy.
- [ ] On Inventory, a holder of `kanban:replenish` (or admin) can check processed+DoR-complete
      rows, reorder the staged list, and Commit → one replenishment event; promoted ranks and
      rejected reasons render inline.
- [ ] Captured and DoR-incomplete rows are uncheckable, with tooltips naming why ("process
      first" / the missing DoR fields).
- [ ] Users without the permission see no checkboxes, no bar — and the server still rejects a
      forged commit (`PERMISSION_DENIED` renders as a clear message).
- [ ] Inventory header shows "Ready x/cap", red below the min order point.
- [ ] Flow shows WIP-by-class vs allocation targets and the last 10 replenishment events.
- [ ] Demote… remains available on Queue cards (ready/waiting/blocked) and nowhere lost.
- [ ] `npm run check` adds zero errors over the 11-error baseline.

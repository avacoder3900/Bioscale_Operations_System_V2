# KB2-06 — Views: Inventory, Queue, Replenishment, Flow

**Depends on:** KB2-02 (+03 for triage controls, +05 for age bands). Read KB2-00 first.
The old per-project board is REPLACED, not kept alongside (decision: keeping both invites the old
habits back). Svelte UI freeze is lifted — build these properly.

## Global UX rules

- **No drag-and-drop anywhere.** Cards carry explicit buttons mapping 1:1 to transition-service
  operations: Pull (ready→wip, only shown on ranks 1–3), Start/Finish, Block… (prompts reason),
  Wait… (prompts dependency + date), Resume, Demote… (prompts reason, permission-gated). Errors
  from the service (WIP limit, pull window) render as toasts with the server's explanation.
- **Rank number badge top-left** of every ranked card, descending. Order IS the layout.
- Board switcher: `ops | software` (KB2-08).
- No priority labels anywhere. No per-person stats anywhere.

## 1. `/kanban` → The Queue (Tier 2) — the default view

One flat, vertically-ordered global queue per board — **no horizontal swim lanes** (~7-person
team = one priority order). Sections top-to-bottom: **WIP** (grouped by assignee for legibility —
grouping, not lanes; age band on every card), **Blocked / Waiting** (with reason/dependency +
date shown), **Ready** (rank-ordered; top 3 visually distinct as the pull window), **Done
(recent)** (last 7 days, pre-archive). Header shows ready count vs cap and the min-order-point
signal when active.

## 2. `/kanban/inventory` → Tier 1 (the management view)

All options grouped by project, ordered by Tier 1 rank. Filters: status (`captured|processed`,
icebox/declined behind toggles), itemType, origin. Controls: process (KB2-03 modal), rank up/down
(reorder), icebox, decline, edit DoR fields. Bulk select → bulk icebox/decline. Capture box at
top (one line → `captured`).

## 3. `/kanban/replenish` → the commitment ceremony (permission `kanban:replenish`)

Left: candidates = `processed` items across projects, DoR-completeness indicator per item
(exact missing fields on hover). Right: current ready queue with cap gauge, class-allocation
shares vs targets, discovered-ratio suggestion (KB2-05), min-order-point warning. Action:
select candidates → arrange order → **Commit** (one replenishment event). Also: demote from here.
Shows history of past replenishment events (who, when, what).

## 4. `/kanban/flow` → metrics (no people on this screen)

Aging chart (age vs SLE band, flow-debt flags), cycle-time scatterplot, weekly throughput,
discovered-work ratio, expedite rate, flow efficiency. All from KB2-05 module.

## Retired

Old board page + KanbanColumn/drag-drop code, `prioritized` badge/filters, per-project ready
lanes, `list` view (inventory + queue filters replace it), project fold state
(`collapsed`/`backlogCollapsed` on KanbanProject — delete fields).

## Acceptance criteria

- [ ] Every mutation from these views goes through the transition service and renders its typed
      errors; zero direct status writes in UI code.
- [ ] Pull button absent on rank ≥ 4 cards (and server still rejects if forced).
- [ ] Replenishment view unreachable/inert without `kanban:replenish`.
- [ ] No drag handlers remain in kanban components; no priority UI anywhere; no per-person
      metrics on any screen.

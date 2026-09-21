# KB2-08 — Software Board + Agent Handoff Brief

**Depends on:** KB2-02. Read KB2-00 first.

## Why

Software tasks ate the old shared board. They need the same two-tier discipline but a distinct
lane, their own queue/cap, and one crucial difference: **commitment = writing the brief that lets
a coding agent execute the item without re-discovery.** Most software execution will be Claude.

## Design (same engine, discriminated)

- `board:'software'` on tasks. Own global ready queue + rank scope, own `readyCap`/
  `minOrderPoint` policy block, own Queue/Inventory/Replenishment views via the board switcher.
- **Statuses**: adds `review` (legal only on this board): `ready → wip → review → done`.
  `review` = PR open. `waiting`/`blocked` behave as on ops.
- **Shared across boards**: person WIP limits (one human, one limit), status vocabulary,
  transition service, metrics engine (Flow view filterable by board), MCP tools (every tool takes
  optional `board`, default `ops`).
- **Crossover**: items can reference each other cross-board via `sourceRef`/links (e.g. an ops
  option "CV inspect station misreads barcode" spawns a software option). No automatic
  cross-board rollups (non-goal for now).

## Software DoR (enforced at replenish)

Everything from KB2-03 PLUS `dor.handoffBrief` — the agent handoff brief, written at commitment:

- outcome + acceptance criteria (testable),
- constraints/invariants that must not break,
- pointers: routes/files/models involved (as known), related PRDs/docs,
- how to verify (commands, pages to check).

Template stored in `KanbanPolicy.dor.software.handoffBriefTemplate`; the Replenishment view and
MCP tool render it. The brief is the contract: an item whose brief a coding agent couldn't
execute from is not ready to commit.

## GitHub linkage (minimal now, hooks later)

- `sourceRef` conventions: `pr:<number>`, `branch:<name>`, `commit:<sha>` — set via UI field or
  MCP `link_software_item`. Rendered as GitHub links.
- Later (separate PRD when wanted): webhook moves `review → done` on merge. Not in scope.

## Acceptance criteria

- [ ] `review` rejected on the ops board, legal on software.
- [ ] Software replenish rejects an empty/missing handoff brief naming the field.
- [ ] Person WIP limit counts wip across both boards.
- [ ] Board switcher on all views; software has independent queue, rank scope, cap, and signals.

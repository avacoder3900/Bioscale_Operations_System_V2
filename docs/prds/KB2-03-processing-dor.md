# KB2-03 — Processing (Triage) + Definition of Ready

**Depends on:** KB2-01. Read `KB2-00-OVERVIEW.md` first.

## Why

`captured` items are raw. Processing is the once-per-item decision that shapes them; the DoR is
what makes the commitment gate objective instead of a judgment call.

## Processing

A `process` operation (server module + agent endpoint + form action; MCP tool in KB2-09):
`captured → processed`, requiring in one call:

- `sizeClass` — set by the person processing, NOT the author or eventual assignee (removes the
  inflation incentive). Definitions per class live in `KanbanPolicy.sizeClassDefinitions`
  (written text, revised from data), surfaced in the UI/tool description.
- `classOfService` — `standard | fixed_date | chore | expedite`; `fixed_date` requires `dueDate`.
- Tier 1 `rank` position among the project's options (default: bottom).
- Optionally fill DoR fields (below) now or later.

Also from processing: `icebox` (park) and `decline` (requires reason; kept for the record). Both
are ordinary Tier 1 transitions through the transition service; `declined` items are excluded
from every processing/inventory default view.

## Definition of Ready (enforced at replenish, KB2-02 hook)

Config-stored checklist in `KanbanPolicy.dor` (per board). An item cannot cross the commitment
point unless:

- `dor.outcome` non-empty — **outcome, not steps** ("what is different in the world when this is
  done"). Step lists go stale in research work; outcomes survive a change of approach and are
  testable for done-ness. Put this guidance in the field's helper text and MCP tool description.
- `dor.acceptanceCriteria` non-empty.
- `sizeClass` and `classOfService` set (i.e., the item was processed).
- `spike` items: `spike.question` + `spike.timebox` (KB2-07).
- software board: `dor.handoffBrief` non-empty (KB2-08).

Replenish rejects with the exact list of missing fields (spec §11 item 2). DoR completeness is
computed by a shared `dorStatus(task, policy)` helper used by replenish, the Replenishment view's
readiness indicators, and the MCP `replenishment_status` tool.

## Acceptance criteria

- [ ] `captured → processed` requires sizeClass + classOfService in the same operation.
- [ ] `fixed_date` without dueDate rejected; `decline` without reason rejected.
- [ ] Replenishing a DoR-incomplete item is rejected naming the missing fields.
- [ ] Size-class definitions render from policy config, not hardcoded text.

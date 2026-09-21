# KB2-11 — Workflow Templates (ultra-defined recurring work, one touch)

**Approved:** Jacob 2026-08-03 (from the sizing-doctrine discussion). **Depends:** KB2-03.

## Why

Core business workflows ("Build & validate an SPU", "Fill 50 cartridges") are ultra-defined:
same outcome shape, same size, same class every time. Making someone re-type the DoR for the
hundredth SPU build is friction that pushes work off the board. A template captures the SOP
shape once; capturing from it lands the item **already processed and DoR-complete** — i.e.
immediately replenishable.

## Model — `KanbanTemplate` (new collection `kanban_templates`)

```
{ _id, name, board: 'ops'|'software', active: true,
  itemType: 'deliverable'|'chore', sizeClass, classOfService,
  titleTemplate: string,            // e.g. "Build & validate SPU {n}"
  dor: { outcome, acceptanceCriteria, handoffBrief? },  // pre-written from the SOP
  tags: [String], defaultProjectId?, notes?, createdBy }
```

## Behavior

- **Capture-from-template** (Inventory template picker + `kanban_capture` gains optional
  `templateId`, + agent tasks POST): creates the item via `createKanbanItem`, applies the
  template's dor/tags/itemType, then immediately `processTask`s it with the template's
  sizeClass/classOfService — status lands `processed`, DoR complete. Title = template title
  (editable at capture). Actor = the human capturing.
- Template CRUD on `/kanban/policy` (same pattern as StandingTarget CRUD) + MCP
  `kanban_list_templates` / `kanban_set_template` (actor, kanban:admin for mutations).
- Standing targets MAY reference a template later (spawned build options use it) — not in
  this PRD's scope.

## Acceptance

- [ ] Capturing from a template yields a `processed`, DoR-complete, replenishable item in one action.
- [ ] Templates editable at runtime (UI + MCP), no deploy.
- [ ] Spikes cannot be templated (itemType limited to deliverable/chore — a templated
      investigation is a contradiction).

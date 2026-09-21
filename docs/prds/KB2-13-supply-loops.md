# KB2-13 — Supply Loops (autopilot supply cards straight to ready)

**Depends on:** KB2-02 (commitment point), KB2-04 (policy engine), KB2-10 (standing targets).
Read KB2-00 first.

**Status:** Approved by Jacob 2026-08-03.

## Why

KB2-10 made supply needs *visible* (live target-vs-actual, below-reorder-point spawns one
captured option). But a captured option still needs a human to process it, then a human to
replenish it — two ceremonies between "the shelf is empty" and "someone can build stock."
Supply work is not like other work: the decision to do it was made once, when the target was
set. Re-deciding it every week at replenishment is ritual, not control. A stock dip should
produce a pullable card by itself; the human decisions live in the target configuration
(what to keep on hand, how much, at what trigger), not in per-card ceremonies.

Same story for parts: `PartDefinition` already carries `minimumOrderQty` and a live
`inventoryCount`. When stock is at/below minimum, "Order more" is not a judgment call —
it is a chore that should already be on the board.

## Decisions of record (Jacob, 2026-08-03)

1. **Supply/reorder autopilot BYPASSES the commitment point** — auto-spawned supply cards
   land directly in `ready` (auto-committed). This is a deliberate exception to the KB2-02
   human-only-replenishment rule, scoped ONLY to system-spawned supply work; human-created
   work still goes through replenishment.
2. **Supply cards are EXEMPT from the ready cap and chore allocation ceiling** (like
   expedite is from WIP limits) — a stock dip must never be blocked by queue policy. They
   join the BOTTOM of the ready rank order. They are also **EXEMPT from the pull window**:
   anyone may pull a supply card regardless of rank — supply work is always legitimate to
   pull. (Personal WIP limits still apply on pull; the exemptions are queue-entry and
   queue-consumption policy only.)
3. **Standing inventory applies to:** wax-filled carts (`cartridge_phase_count`), parts
   (`part_stock`), and FUTURE chemistry inventory — the metric registry is designed
   extensibly; a reagent metric is wired only against a real model (see `reagent_stock`
   below), otherwise it stays a documented extension point.
4. **Parts reordering needs NO per-part targets:** a reorder sweep reads
   `PartDefinition.minimumOrderQty` + `inventoryCount` directly and spawns one
   "Order {part}" chore card per below-min part, idempotent (sourceRef
   `part-reorder:<partId>`, no new card while one is open/not-done).

## Design

### Auto-shaped, auto-committed spawn (standing targets)

When a standing target is below its reorder point and no open card exists for it,
`standingStatus({spawn:true})` spawns the card as before (`createKanbanItem`, source
`standing-target`, sourceRef `standing:<targetId>`), then:

- **Shape is auto-filled** so the card is DoR-complete without a processing ceremony:
  - `sizeClass` from target config (`spawnSizeClass`, default `'short'`),
  - `classOfService` per target (`'chore'` when `spawnItemType` is chore, else `'standard'`),
  - `dor.deliverable` auto-written:
    `"{target.name} at or above {target.target} (currently {actual}); verify: recount"`.
  - **Optional `templateId`** on the target: when set, the linked `KanbanTemplate` supplies
    the shape instead (itemType, sizeClass, classOfService, dor, tags) — the SOP wins over
    the auto-generated shape.
- **Auto-commit** (unless the target opts out with `autoCommit:false`): `transitionTask`
  to `'ready'` with `allowTierCrossing:true` and actor `{username:'system:supply',
  via:'system'}`, then ranked at the **bottom** of the global ready order + `renumberReady`.
  No ready-cap check, no chore-allocation check (decision 2). A `replenishment` stamp is
  written (`promotedBy:'system:supply'`) so the commitment is attributable in the record.
- Targets with `autoCommit:false` behave exactly as KB2-10: the card stays `captured` and
  flows through the human commitment point.

### Parts reorder sweep (`partsReorderSweep`)

Runs inside `standingStatus({spawn:true})` (panel load + daily cron both cover it) and on
inventory-decrement events (below):

- Scope: active parts with `minimumOrderQty > 0 && inventoryCount <= minimumOrderQty`.
- Spawns `"Order {minimumOrderQty} × {partNumber} {name}"` — `itemType:'chore'`,
  `classOfService:'chore'`, `sizeClass:'short'`, source `part-reorder`, sourceRef
  `part-reorder:<partId>`, auto-written `dor.deliverable`, batch = `minimumOrderQty`.
- Auto-committed to ready exactly like standing spawns (always — parts reorders have no
  per-part config to opt out with; that's the point of decision 4).
- Idempotent: no new card while a not-done, not-archived card with the same sourceRef exists.

### Event-driven trigger

`recordTransaction()` (inventory-transaction service), after recording any transaction that
*decreases* a part's count, fires a **fire-and-forget** `checkSupplyForPart(partId)`
(lazy dynamic import; failures are logged, never thrown into the recording path). That
check runs the part-reorder rule for THAT part plus any active `part_stock` standing
targets pointing at it. The daily cron and panel load remain the sweep-everything paths;
the event trigger closes the gap between a consumption and the next sweep.

### Pull-window exemption

`transitionTask` skips the pull-window check when `task.source === 'standing-target'` or
`'part-reorder'` (decision 2). Everything else about the transition service is unchanged —
supply cards still respect personal WIP limits, blocked-needs-reason, etc.

### Metric registry (extensibility, decision 3)

`computeActual()` in `standing.ts` is the single metric registry. Kinds:

| kind | source | params |
|---|---|---|
| `cartridge_phase_count` | `CartridgeRecord` | `{ statuses:[...], skus?:[...] }` |
| `part_stock` | `PartDefinition.inventoryCount` | `{ partId }` |
| `reagent_stock` | `ReagentInventory` (research-v2 shared collection) | `{ catalogId?, variantKey?, type?, statuses?:['active'], measure?:'count'\|'volume' }` |
| `manual` | human-entered | `{ value }` |

`reagent_stock` counts physical reagent items (or sums `volume` with `measure:'volume'`)
whose `status` is in `statuses` (default `['active']`), filtered by catalogId/variantKey/
type. This is the chemistry wiring available TODAY; a dedicated BIMS chemical-inventory
system does not yet exist — when it does, add a new kind here (one switch case) and to the
StandingTarget enum + MCP schema. That is the whole extension contract.

### Model changes

`StandingTarget` gains:
- `autoCommit: { type: Boolean, default: true }` — opt-out per target (decision 1).
- `templateId: String` — optional `KanbanTemplate` link; template shape wins when set.
- `spawnSizeClass: { enum: ['short','medium','long'], default: 'short' }`.
- `metric.kind` enum gains `'reagent_stock'`.

No `KanbanTask` schema change — `source`/`sourceRef` already exist.

### Surfaces

- **Supply panel** (Queue view): standing rows as before + a parts-reorder section listing
  below-min parts with links to their open order cards; badge counts both. Panel load now
  runs the spawn path (`spawn:true`) — the panel is a supply actuator, not just a mirror.
- **Agent endpoint** `/api/agent/operations/kanban/standing`: GET returns
  `{ targets, partsReorder }`; POST accepts the new fields.
- **MCP**: `kanban_standing_status` / `kanban_set_standing_target` updated (new fields,
  parts-reorder rows, reagent_stock kind). Server version → **2.13.0**.
- **Policy page**: target CRUD form gains metric kind `reagent_stock`, spawn size class,
  auto-commit checkbox, and a template picker.

## Acceptance criteria

- [ ] A standing target dropping below its reorder point yields exactly ONE card, already
      in `ready` at the bottom of the rank order, DoR-complete, with
      `replenishment.promotedBy === 'system:supply'` — no human ceremony involved.
- [ ] Auto-commit ignores the ready cap and chore allocation ceiling; the card never
      blocks on queue policy.
- [ ] Supply cards (source `standing-target`/`part-reorder`) are pullable at ANY rank —
      the pull window does not apply to them. Personal WIP limits still do.
- [ ] `autoCommit:false` on a target restores exact KB2-10 behavior (captured option,
      human commitment point).
- [ ] A part with `inventoryCount <= minimumOrderQty` (and `minimumOrderQty > 0`) gets
      exactly one open "Order …" chore card; no duplicates across repeated sweeps; a new
      card may spawn only after the previous one is done/archived.
- [ ] Recording a consumption/scrap/negative-adjustment that crosses a part below its
      minimum spawns the order card within that request (fire-and-forget) without ever
      failing the inventory transaction itself.
- [ ] `reagent_stock` targets compute live from `reagent_inventory`; zero stored counts.
- [ ] Human-created work is untouched: replenish/demote, caps, allocations, and the pull
      window all behave exactly as KB2-02/04 for everything that is not a supply card.

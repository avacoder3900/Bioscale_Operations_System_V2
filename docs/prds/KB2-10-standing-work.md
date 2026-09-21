# KB2-10 — Standing Work / Supply Panel (the real build queue)

**Depends on:** independent of KB2-01..09 (integrates with capture when it lands).
Read KB2-00 first.

## Why

"Always have cartridge inventory built" is not a flow item — it never finishes, so it should
never sit in a queue pretending it will. The old board's build queue was a supply signal wearing
a task costume. Give it its own small system: a physical-kanban replenishment loop with live
target-vs-actual straight from BIMS data.

## Model — `StandingTarget` (new collection, small)

```ts
{
  _id, name,                        // "Filled cartridges on hand"
  board: 'ops',
  metric: {                         // how to compute actual
    kind: 'cartridge_phase_count' | 'part_stock' | 'manual',
    params: Mixed                   // e.g. { phase: 'wax-filled', skus: [...] } or { partId }
  },
  target: Number, reorderPoint: Number,   // min level that triggers a build signal
  batchSize: Number,                      // suggested build quantity per signal
  active: Boolean, createdBy, notes
}
```

`cartridge_phase_count` computes from `CartridgeRecord` (count by phase/status/sku);
`part_stock` from `PartDefinition` stock; `manual` = human-entered actual. Computed on read —
never stored.

## Behavior

- **Supply panel** on the Queue view (own section, visually distinct from flow items): each
  target shows actual vs target with a level bar; below `reorderPoint` → highlighted.
- **Signal → option**: dropping below `reorderPoint` auto-creates ONE `captured` option
  ("Build {batchSize} × {name}", `itemType:'chore'` or `deliverable` per target config,
  `origin:'planned'`, `sourceRef:'standing:<targetId>'`) — deduped: no new option while an
  un-done one for the same target exists. It then flows through the normal commitment point
  like everything else; the panel just makes the need visible continuously.
- Check runs on panel load + a daily cron tick (piggyback an existing cron), not real-time.
- CRUD UI on the panel (permission `kanban:admin`); MCP tools `list_standing_targets`,
  `set_standing_target`, `standing_status`.

## Acceptance criteria

- [ ] Actuals computed live from BIMS collections; zero stored counts.
- [ ] Below-reorder-point creates exactly one open option per target (idempotent).
- [ ] Panel shows target vs actual for all active targets; signals visible on the Queue view.
- [ ] Standing targets never appear in flow metrics (they are not flow items).

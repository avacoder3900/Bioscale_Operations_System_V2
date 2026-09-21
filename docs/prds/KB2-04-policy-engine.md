# KB2-04 — Policy Engine: WIP Limits, Pull Window, Expedite, Allocations + Tuning UI

**Depends on:** KB2-02. Read `KB2-00-OVERVIEW.md` first.

## The policy document

New model `KanbanPolicy` (singleton, `_id:'default'`, ManufacturingSettings pattern). All limits
are enforced invariants read at runtime — adjustable without deploy. Shape:

```ts
{
  _id: 'default',
  boards: {
    ops:      { readyCap: 8, minOrderPoint: 3 },
    software: { readyCap: 8, minOrderPoint: 3 }
  },
  wipPerPerson: 2,            // across BOTH boards combined
  wipChoreMax: 1,             // of the personal WIP, at most 1 chore
  pullWindow: 3,              // pull only from top-N of global ready order
  expedite: { systemMax: 1, alertPctRolling30d: 5 },
  allocation: { standard: 60, fixed_date: 25, chore: 15 },  // % of Tier 2 WIP; chore is floor AND ceiling
  sizeClassDefinitions: { short: '...', medium: '...', long: '...' },
  dor: { /* per-board required fields, KB2-03 */ },
  sle: { percentile: 85, seeded: true, perSizeClassDays: { short: null, medium: 20, long: null } },
  recalibrateAfter: Date,     // seeds must be recomputed from measured flow — nag when past due
  updatedBy, updatedAt
}
```

## Enforcement (all inside transition service / replenish — single door)

- **WIP per person**: on `→ wip`, count that assignee's `wip` across both boards; reject at limit.
  Replaces `user.wipLimit` (migrate: drop per-user field, one global policy knob).
- **Chore cap**: at most `wipChoreMax` of a person's WIP may be `itemType:'chore'`.
- **Pull window**: KB2-02 §5.
- **Expedite**: `classOfService:'expedite'` bypasses personal WIP limits and the pull window but
  is hard-capped at `systemMax` concurrently, system-wide. Rolling-30-day expedite share > alert
  threshold → `operations/alerts` entry ("rising expedite rate is an upstream-planning signal").
- **Allocation**: advisory at replenish time (the Replenishment view + MCP `replenishment_status`
  show current Tier 2 WIP share per class vs targets; promotion that pushes a class far over its
  share warns but does not block — chore is the exception: promotions beyond the chore ceiling
  are rejected, and a chore share below the floor is surfaced as a signal, because the floor is
  what guarantees small work happens on the board instead of off it).

## Tuning UI

`/kanban/policy` (permission `kanban:admin`): edit every knob with inline explanations of each
rule, show `recalibrateAfter` nag, and an audit trail of policy edits (AuditLog). MCP tools
`get_policy` / `set_policy` (KB2-09) hit the same server module; `set_policy` requires actor with
`kanban:admin`.

## Acceptance criteria

- [ ] Third concurrent `wip` for one person rejected on every path; second concurrent expedite
      rejected system-wide (spec §11 items 6–7).
- [ ] Chore floor/ceiling behave as specified (over-ceiling promotion rejected; under-floor
      surfaced as a signal).
- [ ] Every knob editable at runtime via UI + MCP; edits audited; no policy number hardcoded
      outside the policy document defaults.

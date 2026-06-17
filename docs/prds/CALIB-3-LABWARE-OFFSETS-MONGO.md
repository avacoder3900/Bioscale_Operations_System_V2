# CALIB-3 — Labware offsets in Mongo (revives L3, absorbs & deletes L2)

**Date:** 2026-06-16 · **Owner:** Jacob · **Status:** Approved (workshop 2026-06-16)
**Depends on:** CALIB-0 · **Branch:** `ralph/labware-calibration`

## Goal

Bring back per-robot, per-deck **jog-and-store offsets** as the runtime final-correction layer: if a
deck/rack sits a little off-center on a given robot, jog it back into alignment and store that offset —
never a JSON change. Applied automatically to every wax/reagent run. This **replaces** the hardcoded
`ROBOT_OFFSETS` hostname table (L2), which today is duplicated across protocols and disagrees between
wax and reagent for the same robot.

## The off-deck workaround (Jacob, 2026-06-16)

Opentrons' native labware offsets are **slot-keyed**, so off-deck labware can't carry one — that was
"the shortcoming of the Opentrons software." With our own stack we sidestep it entirely: we already
apply per-robot offsets via `carriage.set_offset(x,y,z)` in the protocol, which works **off-deck**. So
instead of using Opentrons' `labwareOffsets` API, we **store the offset in Mongo and inject it into
`set_offset` at run time** via run-time parameters. Off-deck loading stays as-is; no slot needed.

```
today:  ROBOT_OFFSETS[hostname]  →  carriage.set_offset(x,y,z)   (hardcoded, drifts)
after:  Mongo offset[robot×deck] →  startRun passes param_offset_x/y/z
                                  →  protocol set_offset(offset_x, offset_y, offset_z)  (default 0)
```

## Scope decisions
| # | Decision |
|---|---|
| 1 | Offsets stored in **Mongo**, keyed by **robotId × deckLoadName** (whole-deck placement offset). |
| 2 | Applied via **run-time parameters → `set_offset`**, NOT Opentrons slot-keyed `labwareOffsets`. Off-deck stays. |
| 3 | Captured via the **CALIB-0 jog session** (move to a reference well, jog whole-deck placement, delta = offset). |
| 4 | **Delete `ROBOT_OFFSETS`** from `Wax_Filling_GEN7_Cartridge.py` and `Reagent_Filling_GEN7.py`; seed the new store from the current B07 values so nothing regresses. |

## Codebase anchors
- Hardcoded table to remove: `Wax_Filling_GEN7_Cartridge.py:135-139`, `Reagent_Filling_GEN7.py:180-184`
  (+ `carriage.set_offset()` call sites ~`:334` / `:371-375`).
- Production run create (add offsets here): `wax-filling/+page.server.ts:824-924` (POST /runs ~`:886`),
  `reagent-filling/+page.server.ts:651-746` (POST /runs ~`:710`).
- RTP plumbing (already passes `runTimeParameterValues`): same `startRun` actions.
- Unused per-run field (do NOT reuse — wrong granularity): `opentrons-run-record.ts:20-30`.
- Jog session: CALIB-0 `jog-session.ts`.

## Stories
- **CALIB-3-1 — LabwareOffset model.** New operational model `labware-offset.ts`:
  `{ _id, robotId, robotName, deckLoadName, offset{x,y,z}, capturedBy, capturedAt, supersedesId? }`.
  One active offset per (robotId, deckLoadName); keep history (append + `supersedesId`, or an
  `active` flag). `_id:false` on the vector subdoc.
  - *Acceptance:* upsert per robot×deck round-trips and serializes; only one active row per key.
- **CALIB-3-2 — Protocol RTP migration.** Edit both protocol `.py` files: declare `offset_x/y/z`
  run-time parameters (float, default 0.0), replace the `ROBOT_OFFSETS[hostname]` lookup with the RTP
  values in `set_offset(...)`. Keep z handling identical (wax folds z into `well_z_depth`). Re-upload
  to all three robots (B07/R04/B14) via the existing upload path; py_compile clean, 3.7-safe.
  - *Acceptance:* a run started with offset params 0.15/-0.25/-1.3 reproduces today's B07 wax behavior;
    params 0/0/0 = no shift.
- **CALIB-3-3 — Seed from current values.** One-time seed: write the present B07 wax (0.15/-0.25/-1.3)
  and reagent (0.2/-0.35/-0.35) offsets into `LabwareOffset` so the migration is behavior-preserving;
  B14/R04 seed as 0/0/0 (matching today's uncalibrated state).
  - *Acceptance:* after seeding, B07 has stored offsets equal to the old table values.
- **CALIB-3-4 — startRun applies offsets.** Both `startRun` actions read the active `LabwareOffset`
  for (robot, deckLoadName) and pass `param_offset_x/y/z` into `runTimeParameterValues` on POST /runs.
  Missing offset → 0/0/0.
  - *Acceptance:* a wax run on B07 sends the stored offset as params; removing the stored row sends 0s.
- **CALIB-3-5 — Jog-and-store UI.** Page/section to pick robot + deck, open a CALIB-0 jog session,
  jog the whole-deck placement against a reference well, and save the delta as the active
  `LabwareOffset` (AuditLog + history). Show current stored offset per robot×deck.
  - *Acceptance:* jog B07, save, see it stored and reflected on the next run's params; history retained.

## Relationship to CALIB-1
CALIB-1 edits **L0 (per-hole deck geometry, permanent)**; CALIB-3 edits **L2/L3 (per-robot whole-deck
placement, runtime)**. Same jog primitive (CALIB-0), different storage + apply path. Use CALIB-3 for
"the rack drifted on this robot"; use CALIB-1 for "this hole is physically off on this deck."

## Validation
- `npm run check` zero new errors; `npm run build` green.
- `git grep ROBOT_OFFSETS` in the protocol dir returns nothing after migration.
- Manual on B07: seed → run reproduces prior behavior; jog a new offset → next run reflects it.

## Guardrails
- Behavior-preserving migration: seed before deleting the table; verify B07 unchanged.
- AuditLog on every offset capture/change.
- Re-upload protocols to ALL THREE robots after the RTP edit (memory `project-ot2-bridge-deployment`).
- No `.svelte` edits to frozen components.
</content>

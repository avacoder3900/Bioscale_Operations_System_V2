# CALIB-1 — Deck-JSON hole tuner (edits L0 geometry) ★ priority

**Date:** 2026-06-16 · **Owner:** Jacob · **Status:** Approved (workshop 2026-06-16)
**Depends on:** CALIB-0 · **Branch:** `ralph/labware-calibration`

## Goal

Let an operator jog the robot to any wax/reagent hole, see the tip is a bit off, nudge it,
and **persist that nudge into that well's x/y/z in the deck JSON** — the per-deck, per-hole
hand-tuning the team does today by editing JSON files by hand, but driven from a jog wizard
instead of a text editor. Per Jacob: this is the most important of the three features.

## Scope decisions (Jacob, 2026-06-16)
| # | Decision |
|---|---|
| 1 | A **dedicated tuning mode** (maintenance-run jog session via CALIB-0), NOT inline during a real fill. "Whatever works if we recreate the exact same pattern as a protocol outside of running a protocol." |
| 2 | Tunes **L0 only**: calibrate the nominal hole with `set_offset = 0` and no per-tip probe (additive model — runtime layers stack on top, see CALIB-0). |
| 3 | Operator tunes **only the holes that look off**, not a forced walk of all 576. Pick a hole (or a small set), jog, save. |
| 4 | Edit is **append-with-history**: store the jog delta + before/after coords + who/when, then apply to the live well coords. Deck JSON is treated as a correction-tracked artifact. |

## Data flow for one saved edit
```
operator jogs hole M14 by (+0.12, -0.08, -0.20)
  → DeckCalibrationEdit record written (Mongo): {deckLoadName, well:'M14', delta, before, after, by, at}
  → labware_definitions.<deck>.definition.wells.M14 {x,y,z} += delta   (Mongo)
  → write-back local file ~/Library/Application Support/Opentrons/labware/<deck>.json  (lab Mac path)
  → re-bundle/upload deck definition to the target robot(s) so the next fill uses it
```
The fill protocol already reads per-well coords from the bundled JSON (no protocol change needed —
`proxy.ts:309` bundles `labware_definitions` at upload). The only new write surface is the deck JSON.

## Codebase anchors
- Deck JSON source: `~/Library/Application Support/Opentrons/labware/gen4deck_gen7cartridge_005.json`
  (per-well `{x,y,z,depth,diameter}`; `parameters.format:"irregular"`).
- Mongo model + seed: `src/lib/server/db/models/labware-definition.ts`, `scripts/seed-labware-from-local.ts`.
- Bundle-to-robot: `src/lib/server/opentrons/proxy.ts:309` (`robotUploadProtocol`),
  `maintenance-clone.ts:133` (`registerMaintenanceLabwareDefinition`).
- Jog session: CALIB-0 `src/lib/server/opentrons/jog-session.ts`.

## Stories
- **CALIB-1-1 — DeckCalibrationEdit model + history.** New operational Mongo model
  `deck-calibration-edit.ts` (`_id` nanoid; `deckLoadName`, `deckEquipmentId?`, `wellName`,
  `delta{x,y,z}`, `before{x,y,z}`, `after{x,y,z}`, `robotId` used to tune, `createdBy`, `createdAt`).
  Append-only audit of every hole nudge. `_id:false` on the vector subdocs.
  - *Acceptance:* model loads; a write round-trips and serializes (no ObjectId leak).
- **CALIB-1-2 — Apply-edit service.** `src/lib/server/services/deck-calibration/apply-edit.ts`:
  given `{deckLoadName, wellName, delta, user}` → write `DeckCalibrationEdit`, mutate the well in
  `labware_definitions` (`$inc`/recompute `after`), AND write the updated definition back to the
  local labware JSON file (path from a config/env; the lab-Mac labware dir). Returns the new coords.
  - *Acceptance:* applying (+0.1,0,0) to a well bumps Mongo + the on-disk JSON by exactly 0.1 in x,
    and an `AuditLog` + `DeckCalibrationEdit` row exist.
- **CALIB-1-3 — Re-bundle to robot after edit.** After an edit (or a batch), push the updated deck
  definition to the chosen robot(s) so the next fill picks it up (reuse the upload/bundle path).
  Expose an explicit "sync deck to robot(s)" action; do not silently upload on every keystroke.
  - *Acceptance:* after sync, GET the deck definition off the robot (or via the bundle path) shows
    the new well coords.
- **CALIB-1-4 — Tuner page + flow.** New protected route (e.g. `/manufacturing/cart-mfg/deck-tuner`):
  pick robot → pick deck (resolve loadName) → open CALIB-0 jog session → choose hole (grid picker;
  reuse deck-grid component pattern) → wizard moves to `well.top(well_z_depth)` with set_offset 0 →
  operator jogs → Save (writes via CALIB-1-2) → optionally tune next hole → Sync to robot (CALIB-1-3)
  → close session. Show per-hole edit history. `requirePermission(locals.user, 'manufacturing:write')`
  (confirm exact perm string against `permissions.ts`).
  - *Acceptance:* full loop: pick B07 + GEN7 deck, tune M14, save, see history, sync; the well's coords
    changed in Mongo + JSON and the value persists across reload.

## Open implementation notes
- `well_z_depth` for the tuning move must match the fill's dispense reference (wax `-3.0 + z_offset`,
  but z_offset=0 here). Confirm against `Wax_Filling_GEN7_Cartridge.py` so the operator tunes the same
  plane the fill dispenses at.
- Local-file write path needs the labware dir location as config (it's the lab Mac's
  `~/Library/Application Support/Opentrons/labware/`). In Vercel/prod there is no such dir — the
  write-back is a lab-Mac/LAN-only operation; guard accordingly (Mongo is the source of truth, file
  write is best-effort sync for the desktop Opentrons App).
- 576 holes/deck: the grid picker should make it trivial to jump to a hole; no forced sequential walk.

## Validation
- `npm run check` zero new errors; `npm run build` green.
- Manual on B07: tune one hole, run a short wax fill, confirm the tip lands where expected.

## Guardrails
- No `.svelte` edits to frozen components; new page lives in an allowed route with its own server file.
- AuditLog on every edit; deck JSON edits are correction-tracked (never silent overwrite).
- Mongo is source of truth; on-disk JSON write is best-effort and skipped when the dir is absent.
</content>

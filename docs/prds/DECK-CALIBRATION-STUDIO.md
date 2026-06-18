# PRD: Deck Calibration Studio (graphical deck + jog-to-teach + group apply)

## Goal
One page where an operator can fine-tune the physical position of every wax/reagent
fill hole on a deck — by **jogging the OT-2 pipette to a hole while watching it**
(exactly like the scanner-position teaching flow), capturing the real-world offset,
then **graphically selecting a group of holes** (a hole, all holes on a cartridge,
or several cartridges) and **applying that offset to the whole group**. Corrections
persist in BIMS and flow to the robot. No lab `.py` editing.

## What already exists (reuse, don't rebuild)
- **Deck = one native Opentrons labware def** in Mongo `labware_definitions`
  (`gen4deck_gen7cartridge_001…006`, namespace `cosmas_damian`): 576 wells `A1…X24`
  (24×24 grid = 24 cartridges × 24 holes), each `{x,y,z}`. Both `Wax_Filling_GEN7_Cartridge.py`
  and `Reagent_Filling_GEN7.py` load these — same hole = one source of truth.
- **apply-edit engine** (`src/lib/server/services/deck-calibration/apply-edit.ts`):
  `applyDeckEdit({deckLoadName, wellName, delta, user, robotId?})` writes
  `definition.wells.{well}.{x,y,z}` in Mongo + appends `DeckCalibrationEdit` history +
  `AuditLog` + best-effort local lab-Mac JSON mirror. `deckEditHistory(deckLoadName)`.
- **Maintenance jog flow** (mirror scanner-positions teach page exactly):
  `POST /api/opentrons-lab/robots/[id]/maintenance` → `{runId, pipetteId, mount, pipetteName}`;
  `.../jog` `{pipetteId, axis:'x'|'y'|'leftZ'|'rightZ', distance}`;
  `.../move-to` `{pipetteId,x,y,z}`; `.../position` `{pipetteId}`→`{position:{x,y,z}}`;
  `.../home`; `DELETE .../maintenance/[runId]`. `maintenance.ts` has openMaintenanceRun,
  discoverPipette, loadPipetteInRun, jog, moveTo, getCurrentPosition, home, close.
- **Sync to robot**: `robotUploadProtocol` (`proxy.ts`) re-bundles labware defs to the OT-2.
- **Existing text tuner** `/manufacturing/cart-mfg/deck-tuner` stays as a fallback.

## New page
`/manufacturing/cart-mfg/deck-calibration` — added to the cart-mfg sidebar. Layout:
left = graphical deck canvas + selection; right = jog/maintenance panel (mirrors the
scanner-position teach UI); bottom = captured-offset + apply + history.

---

## Stories (build all)

### S1 — Deck + robot pickers + session safety
- Pick a deck (labware def matching the deck regex) and a robot (OpentronsRobot).
- Load: deck wells (`{name,x,y,z}[]`), per-well edit-history flag (from `DeckCalibrationEdit`),
  robot list, the deck's slot (see S5).
- Stale-run guard: opening the maintenance run auto-clears a stuck protocol/maintenance
  run first (stop+delete), like the OT-2 bridge sweep path, then retries.
- Close the maintenance run on page unmount (onDestroy keepalive DELETE) — same as teach page.

### S2 — Graphical deck canvas
- Render all 576 wells as dots at their real `x/y`, scaled to deck dimensions
  (`definition.dimensions` 454.8×276.4), y-flipped to screen space.
- Cartridge overlay: draw the 24 cartridge blocks (derive each cartridge = its 24-well
  grid region from the 24×24 `ordering`; cartridge n = a contiguous block).
- Per-well color: nominal (dim), has-prior-edit (amber ring), selected (cyan fill),
  current jog target (pulse). Hover tooltip = well name + `{x,y,z}` + last-edit delta.
- Pan + zoom (deck is large); "fit" button.
- Optional toggle: highlight wax holes vs reagent holes (deferred sub-feature; see S9).

### S3 — Selection model
- Click a well: toggle select. Shift/Ctrl-click: add. Click empty: clear.
- **Box/drag select**: drag a rectangle → selects every well inside.
- **Select cartridge**: click a cartridge block header (or double-click a well) → selects
  all 24 wells of that cartridge. Multiple cartridges accumulate.
- Selection summary: N wells across M cartridges; "Clear selection".

### S4 — Maintenance-run jog panel (mirror scanner-positions teach)
- Open / Close maintenance run (reuse the opentrons-lab endpoints + flow verbatim:
  discover pipette, loadPipette, runId+pipetteId).
- Jog pad: X−/X+, Y−/Y+, Z−/Z+ with a **step-size** selector (0.1/1/5/10/25 mm) and a
  **Z-axis** selector (leftZ/rightZ from the mount). Calls `.../jog`.
- Home. Live position readback (`.../position`) shown as x/y/z, "Refresh".

### S5 — Move-to-hole (nominal) — labware-aware
- "Move to selected hole" moves the tip to that well's **nominal** position so the operator
  can see how far off it is. To position by well (relative coords → absolute) without
  hardcoding slot origins, EXTEND the maintenance flow:
  - `maintenance.ts`: add `loadLabwareInRun(robot, runId, namespace/loadName/version, slot)`
    (adds the def to the run + `loadLabware` command → labwareId) and
    `moveToWell(robot, runId, pipetteId, labwareId, wellName, offset?)` (`moveToWell` command).
  - New endpoints: `.../maintenance/[runId]/load-labware`, `.../maintenance/[runId]/move-to-well`.
  - The deck **slot** is needed for loadLabware: resolve from the live protocol's
    `load_labware` slot (or store per-deck; default settable). Confirm against the robot.
- After move-to-well, read position → record `nominal = {x,y,z}` for the active hole.

### S6 — Capture offset from jog
- Flow: select a reference hole → **Move to hole** (records `nominal`) → operator jogs the
  tip onto the true hole center → **Capture offset** reads current position `p`; the
  captured delta = `p − nominal`.
- Show the captured `{dx,dy,dz}` prominently; allow manual tweak/clear.
- Manual mode (no robot): operator can type `{dx,dy,dz}` directly instead of jogging.

### S7 — Apply offset to selection (batch)
- "Apply offset to N selected holes" applies the captured (or typed) delta to every
  selected well.
- New service `applyDeckEditBatch(deckLoadName, wellNames[], delta, user, robotId?)`:
  loops `applyDeckEdit` per well (preserving per-well history + AuditLog), returns
  `{applied, failed[]}`. New page action / API `POST .../deck-calibration?/applyBatch`.
- After apply: refresh canvas (wells now show edited ring), clear selection, keep the
  captured delta available for the next group.

### S8 — Sync to robot
- "Sync deck to robot(s)" re-uploads the wax + reagent protocols via `robotUploadProtocol`
  so the corrected deck def reaches the OT-2. Pick robot(s) + which protocols (wax/reagent/both).
  Show per-robot result + the new analysis status.
- Explicit button (not auto on every save).

### S9 — History, undo, wax/reagent overlay
- History panel: recent `DeckCalibrationEdit` rows for the deck (well, delta, before/after,
  who/when), reused from `deckEditHistory`.
- **Undo last edit** for a well: apply the inverse delta via the same engine (logged as a
  normal edit). Optional: undo a whole batch.
- Optional overlay: tag which wells are wax-fill vs reagent-fill holes (derive from the two
  protocols' targeted wells if discoverable) so the operator can filter. Deferred if the
  well→role mapping isn't readily available; canvas works without it.

### S10 — Permissions + audit + safety
- `requirePermission(manufacturing:write)` on all mutating actions; read for load.
- Every well edit already audits via `applyDeckEdit`. Batch + sync also `AuditLog`.
- Confirm before sync (re-upload affects live runs). Never auto-move without an open run.

---

## Build order (de-risked; ship value early)
- **Layer A (robot-agnostic):** S1 (pickers/load) + S2 (canvas) + S3 (selection) + S7
  (batch apply with typed delta) + S8 (sync) + S9 (history). Fully testable with no robot.
- **Layer B (jog):** S4 (jog panel) + S5 (labware-aware move-to-well) + S6 (capture).
  Needs a live OT-2 on the wire to verify; build behind the same page.

## Validation
- `npm run check` stays at the 11-error baseline (0 new); build green.
- Layer A verifiable in-browser (canvas, select, typed-delta batch apply writes Mongo +
  history; sync re-uploads). Layer B verified against a live robot (B07/R04/B14).

## Out of scope (later)
- CALIB-2 (read-only global-cal surfacing), CALIB-3 (per-robot×deck whole-deck offset in
  Mongo + RTP). This PRD is per-hole (L0) tuning only — the layer that makes the deck "work".

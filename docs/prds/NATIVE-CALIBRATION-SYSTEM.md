# PRD List: BIMS-Native Calibration System

Move ALL OT-2 position correction into BIMS so the whole deck (cartridge deck +
tube racks + tip racks + tip calibrator) is jog-tunable through one system, with
BIMS as the source of truth and the `.py` protocols reduced to runtime targets.

## Background (from the audit, 2026-06-18)
A fill position today is the sum of 3 layers, applied in this order:
```
final = well geometry (labware coords)            ← BIMS owns this already
      + robot offset   (ROBOT_OFFSETS→set_offset) ← hardcoded per host, carriage-only
      + tip adjust     (limit-switch reading − calibrator bend string, over serial) ← runtime, per-tip
```
- **Geometry** is in the labware defs (deck `gen4deck_gen7cartridge_001..006`, tube racks,
  tip racks) — already in the BIMS labware library, bundled to the robot on upload.
- **Robot offset** is hardcoded (`ROBOT_OFFSETS`, B07 wax `0.15,-0.25,-1.3`; reagent
  `0.2,-0.35,-0.35`; R04 & B14 = 0) and currently applied ONLY to the carriage.
- **Tip adjust** = `pick_up_and_calibrate_tip()`: probe the tip against limit switches,
  subtract the calibrator's serial "bend" string → the tip's true zeroed position; added
  to every dispense via `.move(Point(adjust.x, adjust.y, …))`. This is the most accurate
  layer and stays — but geometry must be tuned WITH it active (else double-count).
- Tip calibrator is NOT labware: a fixed limit-switch point (`x125.181,y173.247`,
  z `34.491` wax / `40.8` reagent) relative to the carriage.
- Particle-ID over serial selects which deck def (001..006) is loaded — deck identity, keep.

## Decisions (locked with Jacob)
- BIMS is the source of truth; store the `.py` in Mongo and upload to the robot.
- **Keep the tip calibration** (limit-switch − bend). BIMS must RUN it (trigger the
  robot-side routine) before tuning so captured geometry is tip-zeroed.
- **Robot offset → BIMS**, GLOBAL (applies to ALL labware), per-robot, removed from `.py`.
  Discovered by: tune a deck on the reference robot, move it to robot B, jog to a known
  hole, the delta = robot B's global offset. One robot is the reference (offset 0,0,0).
- Racks (confirmed, all in BIMS): tube = `cosmas_and_damian_drybath_tuberack` (wax) +
  `custom_2ml_24_tube_rack` (reagent); tip = `cosmasanddamian_96_tiprack_20ul` (wax/p20) +
  `cosmas_and_damian_biotix_96_200ul_tiprack` (reagent/p300).
- Phasing: **Phase 1 = all BIMS-side** (zero production risk; live `.py` untouched).
  **Phase 2 = the `.py` cutover** (per-robot, validated). PRDs 1-5 are Phase 1; PRD 6 is Phase 2.

---

## PRD 1 — Protocols become BIMS-native (source of truth in Mongo)
Import both production protocols (`Wax_Filling_GEN7_Cartridge.py`, `Reagent_Filling_GEN7.py`)
into BIMS (`OpentronProtocol.fileContent`, processType wax/reagent). BIMS becomes the
single source; "Re-upload to robot" uploads the stored `.py` + bundles the (jog-tuned)
labware defs + passes RTPs. No more dependence on the lab-Mac Opentrons folder.
- Import action/admin to load the current `.py` into BIMS (one-time, with a hash).
- Make the deck-calibration Sync + the wax/reagent Start-Run uploads use the stored source.
- Acceptance: re-upload works from BIMS alone; the bundled deck reflects jog edits.

## PRD 2 — Calibration data model
New Mongo models:
- **RobotDeckOffset**: `{ robotId, offset{x,y,z}, isReference, capturedBy, capturedAt, note }`
  — one global offset per robot; exactly one `isReference` (offset 0,0,0).
- **TipCalibratorFixture**: `{ robotId|global, position{x,y,z}, zCalWax, zCalReagent,
  capturedBy, capturedAt }` — the calibrator point, jog-tunable.
- (Deck + tube/tip-rack geometry stays in `labware_definitions`; DeckCalibrationEdit history
  already covers per-well edits — extend to cover rack defs too.)
- AuditLog on every write.

## PRD 3 — Multi-slot graphical calibration UI
Expand the Deck Calibration Studio from the cartridge deck to the FULL OT-2 deck:
- Render slots 1-9 = cartridge deck (current), slot 10 = tube rack, slot 11 = tip rack,
  plus the tip-calibrator as a tunable point — each at its real deck position.
- Dropdowns to choose the tube rack (2 options) and tip rack (2 options); their wells load
  + render + are jog-tunable through the SAME apply-edit engine (per-well coords in their defs).
- Selection / box-select / role-filter / deselect work per-labware; the calibrator is a
  single draggable/joggable point saved to TipCalibratorFixture.
- Reuse load-labware/move-to-well per labware (each loaded at its slot).

## PRD 4 — Robot-side tip calibration that BIMS triggers
Replicate `pick_up_and_calibrate_tip()` as an on-demand routine BIMS can run before tuning,
so captured geometry is tip-zeroed.
- Add a **`calibrate_tip` command** to the ot2-bridge daemon (it runs on the robot, has
  serial + can drive a maintenance run): pick up tip → move to calibrator → limit-switch
  probe → read the serial bend string → return the zeroed `adjust{x,y}` to BIMS.
- BIMS jog tool: "Calibrate tip" button → runs it → stores `adjust` for the session →
  applies `adjust` to every subsequent move-to so tuning happens against a zeroed tip.
- Needs the serial device + a robot on the wire to validate; design the daemon command +
  the maintenance-move sequence to mirror the `.py` math exactly (z_cal per tip type).

## PRD 5 — Per-robot global offset capture
- Workflow: tune deck geometry on the reference robot → physically move the deck to robot B
  → in BIMS, jog to a known reference hole on B → the delta = robot B's global offset →
  save to RobotDeckOffset. Repeat per robot.
- UI: per-robot offset card (current value, capture, reset, mark-reference) on the studio.
- The offset is GLOBAL — at fill time it shifts all labware (deck + tube + tip rack).

## PRD 6 — Protocol cutover (Phase 2, per-robot, validated)
Edit both protocols (now in BIMS) to be fully BIMS-native, then re-upload + validate:
- Remove hardcoded `ROBOT_OFFSETS`; read `offset_x/y/z` as RTPs and apply to **all** labware
  (deck + tube rack + tip rack), not just the carriage.
- Read the tip-calibrator position (+ z_cal) as RTPs instead of hardcoding.
- KEEP the limit-switch + bend tip calibration (now positioned via the RTP calibrator).
- Geometry comes from the BIMS-bundled labware defs.
- Start-Run passes the BIMS RobotDeckOffset + TipCalibratorFixture as `runTimeParameterValues`.
- Cut over ONE robot first, run a real fill, verify, then roll to the other two.

---

## Open implementation risks to resolve during build
- **Robot-side calibration (PRD 4):** the serial limit-switch probe must move + read serial
  on the robot — confirm the daemon can drive a maintenance run AND the serial port at once,
  and that the math matches the `.py` (per-tip z_cal: 34.491 wax / 40.8 reagent).
- **Aspiration Z** for tube racks is a volume-lookup in the `.py`, not pure well-coord —
  tuning a tube rack's Z shifts its origin, not the per-volume depth (handle separately).
- **Slot origins** for move-to on non-carriage labware (tube rack slot 10, tip rack slot 11)
  — verify the loadLabware+moveToWell path positions them correctly on the live robot.
- **Phase-2 cutover is the only production-risk step** — gated behind per-robot validation.

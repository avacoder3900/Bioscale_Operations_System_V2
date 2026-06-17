# CALIB — Next Steps / Handoff

**Updated:** 2026-06-16 · **Branch:** `ralph/labware-calibration`
**Worktree:** `/Users/brevitest/github/Bioscale_Worktrees/labware-calibration`
(master checkout is untouched — Jacob has unrelated WIP there.)

Pick up here if the thread is lost. Read order: this file → `CALIBRATION-SYSTEM-WORKSHOP.md`
(the audit) → the individual `CALIB-0/1/2/3` PRDs. Memory `project-calibration-layers` has the
six-layer map; memory `project-ot2-stuck-run-blocks-maintenance` is a gotcha for jog sessions.

## Status
- ✅ Audit of all six position-correction layers — done (`CALIBRATION-SYSTEM-WORKSHOP.md`).
- ✅ Design decisions locked with Jacob (2026-06-16) — see "Decisions" below.
- ✅ Four PRDs written + committed (`49e760c`).
- ⬜ Implementation — **not started.**

## Decisions (locked)
1. **Feature 1 (deck-JSON hole tuner)** = a dedicated maintenance-run jog wizard that recreates the
   fill's move-to-hole geometry *without* running a real fill. Saves the jog delta into the deck JSON
   well x/y/z. **This is the priority feature.**
2. **Feature 2 (global cal)** = surface/track only. Do NOT rebuild Opentrons' pipette/tip-length/deck
   wizard — global cal is created in the Opentrons App and stored on the robot Pi; our L0+L4 already
   beat its accuracy. Just read it, show it, warn when stale.
3. **Feature 3 (labware offsets)** = store per-robot×deck offsets in Mongo, apply via `set_offset`
   run-time params, and DELETE the hardcoded `ROBOT_OFFSETS` hostname table (seed from current B07
   values first so nothing regresses). Off-deck loading stays — we sidestep Opentrons' slot-keyed limit.
4. **Features 1 & 3 share one jog primitive** = CALIB-0; they differ only in where the delta is stored.
5. Build all four, then test. Jacob: "feature 1 is the most important but lets write prds for all of
   them and then ship them all and test them."

## Build sequence (recommended)
1. **CALIB-0** — jog-capture foundation (`jog-session.ts` + jog UI primitive). Pure server/UI; robot-independent until LAN test.
2. **CALIB-1** ★ — deck-JSON hole tuner (DeckCalibrationEdit model → apply-edit service → re-bundle → tuner page).
3. **CALIB-3** — Mongo labware offsets (LabwareOffset model → protocol RTP migration → seed → startRun applies → jog-and-store UI).
4. **CALIB-2** — global-cal surface/track (staleness model → robot view → optional snapshot history).

## Needs the lab (cannot finish/verify autonomously from here)
- LAN access to **B07 `hidden-leaf.local`** (and R04/B14) for any jog session or fill test — see memory
  `project-ot2-bridge-deployment` for IPs/SSH key/.env location.
- **CALIB-3 protocol `.py` edits** (`Wax_Filling_GEN7_Cartridge.py`, `Reagent_Filling_GEN7.py` under
  `~/Library/Application Support/Opentrons/protocols/<uuid>/src/`) must be re-uploaded to **all three
  robots** after editing.
- **CALIB-1 on-disk JSON write-back** only works on the lab Mac (the labware dir
  `~/Library/Application Support/Opentrons/labware/`). Mongo is source of truth; file write is best-effort.
- Before any jog/maintenance session: **clear stale current runs** on the robot or maintenance-run
  creation fails (memory `project-ot2-stuck-run-blocks-maintenance`).

## Open question (where we paused)
Start building **CALIB-0-1 (jog session service)** now — pure server code, safe to write before any
LAN test — or review/adjust the PRDs first? Awaiting Jacob.

## Files (all on this branch)
```
docs/prds/CALIBRATION-SYSTEM-WORKSHOP.md     audit + proposed model
docs/prds/CALIB-0-JOG-CAPTURE-FOUNDATION.md  shared jog primitive (blocks 1 & 3)
docs/prds/CALIB-1-DECK-JSON-HOLE-TUNER.md    ★ priority
docs/prds/CALIB-2-ROBOT-GLOBAL-CAL-SURFACE.md
docs/prds/CALIB-3-LABWARE-OFFSETS-MONGO.md
docs/prds/CALIB-NEXT-STEPS.md                this file
```
</content>

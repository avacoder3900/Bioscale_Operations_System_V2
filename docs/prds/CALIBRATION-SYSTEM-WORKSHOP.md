# Labware Calibration System — Workshop & Audit (DRAFT)

> Status: **workshop draft**, not a locked PRD. Branch `ralph/labware-calibration`.
> Author: design session 2026-06-16 with Jacob.

## 0. Why this doc

Jacob wants a calibration feature for the hand-made precision decks. Before designing it,
we audited *every* place a position/offset correction currently lives. The headline:
the correction logic is spread across **six** mechanisms in **three** different homes
(deck JSON, protocol Python, browser sessionStorage), several of which silently disagree.
This doc maps reality, proposes a clean layered model, and sketches the three features
Jacob described.

---

## 1. Audit — the six correction layers that exist TODAY

| # | Layer | Lives in | Scope | Persistent? | Active in prod fills? |
|---|-------|----------|-------|-------------|----------------------|
| L0 | **Deck JSON well x/y/z** | `~/Library/Application Support/Opentrons/labware/gen4deck_gen7cartridge_00N.json` → Mongo `labware_definitions` → bundled to robot | per physical deck, per hole | yes (file + DB) | yes |
| L1 | **Opentrons on-robot global cal** (deck / pipette-offset / tip-length, the X-marks) | on the robot; edited only via Opentrons **desktop App** | per robot | yes (on robot) | yes (implicitly) |
| L2 | **`ROBOT_OFFSETS` hostname table** (`carriage.set_offset`) | hard-coded **in each protocol .py** | per robot, whole-deck shift | yes (in code) | yes |
| L3 | **LPC labware offsets** (jog-and-store, slot-keyed vector) | jog wizard in `opentrons-clone`; offsets in **browser sessionStorage** | per robot × labware × slot | **no (volatile)** | **no** |
| L4 | **Particle tip-calibrator string + per-tip limit-switch probe** | protocol .py + external Particle device over serial | per tip pickup (XY) | no (live each run) | yes |
| L5 | **Aspiration-height lookup tables** (tube geometry, `HEIGHT_ADJUST`) | protocol .py | per tube type (Z into source) | yes (in code) | yes |

### Evidence highlights
- **L0 is genuinely hand-tuned.** `gen4deck_gen7cartridge_005.json` has `parameters.format: "irregular"`,
  37 distinct Z values spanning 8.5–9.1 mm in a smooth fitted tilt (a flat plate would be constant Z),
  and block-irregular XY pitch per cartridge. One JSON per physical deck — the `_001`.._006` suffix
  *is* the per-deck calibration variant. The app never reads these coordinates; it bundles the JSON to
  the robot, whose protocol engine consumes them. (`scripts/seed-labware-from-local.ts`,
  `src/lib/server/opentrons/proxy.ts:309`.)
- **L1 we do NOT own.** No pipette/tip-length/deck-cal wizard anywhere. We only GET it read-only for
  display (`src/routes/api/opentrons-lab/robots/[id]/calibration/+server.ts`, `opentrons-clone/[robotId]`).
  DOMAIN-12 §line 34 explicitly skipped building these ("Keep Opentrons App for these"). The UI even
  tells operators to use the desktop app. (That read is also partly broken in prod via the dynamic-API 404.)
- **L2 is the hidden landmine.** Per-robot offsets are hard-coded *and duplicated* in each protocol, and
  they **disagree** for the same physical robot: wax B07 = `0.15 / -0.25 / -1.3`, reagent B07 =
  `0.2 / -0.35 / -0.35`. B14 and R04 are still all-zeros (uncalibrated) in both. This is really per-robot
  deck calibration masquerading as protocol source, and it drifts.
- **L3 exists but is effectively dead.** A complete jog wizard lives at
  `opentrons-clone/[robotId]/protocols/[protocolId]/lpc/+page.svelte` (moveToWell → savePosition baseline →
  operator jogs X/Y/Z → savePosition → vector = delta). But it stores results in `sessionStorage`
  (`ot_lpc_offsets:<protocolId>`), only applies when launching a run *from the clone page*, and the
  production wax/reagent `startRun` actions **never send `labwareOffsets`**
  (`wax-filling/+page.server.ts:886`, `reagent-filling/+page.server.ts:710`). The model field
  `OpentronsRunRecord.labwareOffsets` is never written.
- **Off-deck defeats L3 structurally.** The fill protocols load labware `location:'offDeck'`. Opentrons
  offsets are keyed by on-deck **slotName**; off-deck labware has no slot to bind an offset to — so even
  if we forwarded `labwareOffsets`, it couldn't apply. Commit `3cd2789` only auto-resumes the off-deck
  "confirm deck loaded" pause; it does nothing for offsets.
- **L4 = the particle tip calibrator.** A colon-delimited `x:y` mm string read once over USB serial
  (cmd `b'C'`, parsed by brittle slicing `[2:]` / `[:-5]`), then a per-tip limit-switch probe (cmd `b'X'`/`b'Y'`)
  jogs into physical switches and adds the string offset in. This is the per-tip *bend* correction Jacob
  described — higher precision than Opentrons' model assumes. XY only. Magic constants differ wax vs reagent
  (`-150.536/-177.0` vs `-149.906/-176.8`), `z_cal` 34.491 vs 40.8. Nothing in the web app touches it.
- **L5 = the "other calibration in reagent_filling.py" Jacob suspected.** An empirical volume→liquid-height
  lookup table + `tube_bottom_height` + a `HEIGHT_ADJUST` master knob + a hardcoded 9-well
  `calibration_check_wells` visual-check grid. This is *source-tube* calibration, not deck-hole calibration.

---

## 2. Jacob's mental model vs reality

| Jacob said | Reality |
|------------|---------|
| (1) labware JSON | = **L0**. Correct. The per-deck hand-tuned truth. |
| (2) OT-2 calibration data | = **L1**. We don't own it — it's on-robot, edited via Opentrons App, read-only to us. |
| (3) particle tip calibrator string | = **L4**. Lives only in protocol .py + serial device; web app blind to it. |
| "maybe other cal in reagent_filling.py" | = **L5** (aspiration model + 9-well check grid) **and L2** (the ROBOT_OFFSETS table). |
| *(not mentioned)* | **L2** the hostname offset table and **L3** the dead LPC layer are the two biggest surprises. |

---

## 3. Proposed clean model (the simplification)

Collapse six tangled mechanisms into a layered stack with **one home per concern**:

```
final tip position =
   L0 deck geometry (per deck, per hole)        ← hand-tuned JSON; Feature 1 edits this
 + L1 robot global cal (per robot)              ← Opentrons X-marks; Feature 2 (maybe)
 + L2 labware placement offset (per robot×deck) ← runtime labwareOffsets; Feature 3 (absorbs old ROBOT_OFFSETS)
 + L4 per-tip bend probe (per pickup)           ← stays in protocol; surface/tune the baseline string
```

Key moves:
- **Kill the `ROBOT_OFFSETS` hostname table.** Its job is exactly L3's job (per-robot whole-deck offset).
  Move it into the persistent labware-offset store so wax & reagent can't drift apart again.
- **Keep L4 in the protocol** (it's real-time physical probing) but optionally surface/store the baseline
  string so it's visible and tunable from BIMS instead of trapped on a serial device.
- **L5 stays** but is tube-calibration, out of scope for the deck-position features.

---

## 4. The three features

### Feature 1 — Dynamic deck-JSON hole tuner (edits L0)
**Goal:** while watching a fill, see a hole's tip is off, jog the robot, and persist that jog into that
well's x/y/z in the deck JSON — for every wax/reagent hole.

Design forks:
- **(A) Dedicated "deck tuning" maintenance mode** (recommended): a maintenance-run jog wizard (same machinery
  as LPC / deck_scan) that walks holes, lets you jog, and writes deltas back to the well coords. Clean,
  interactive, reuses proven code. Decoupled from a real fill.
- **(B) Inline during a production fill:** pause-at-hole, jog, save, resume mid-protocol. Much harder —
  Opentrons protocol runs aren't per-well interactive; would need protocol cooperation (pause hooks per well).
- Write path for an edit: update Mongo `labware_definitions` → re-bundle/upload to robot → write back the
  local `~/Library/.../labware/*.json` (+ audit log + correction history, since the deck JSON is effectively
  a sacred-ish artifact). 576 holes/deck → needs an efficient "jog only the ones that look off" workflow,
  not a forced walk of all 576.

### Feature 2 — Our own OT-2 global calibration (L1)
**Goal:** replicate Opentrons' pipette-offset / tip-length / deck (X-marks) calibration inside BIMS.

Findings: we have **none** of it; it's on-robot via the desktop App. Could be built on the **maintenance-run +
savePosition** machinery we already use for LPC, referencing Opentrons' open-source `robot-server` calibration
flow. **Open question whether we even need it:** the per-tip limit-switch probe (L4) + hand-tuned JSON (L0)
already deliver the sub-mm XY accuracy Jacob cares about, which is *more* than Opentrons global cal targets.
Global cal may be off the critical path — possibly just surface/track the on-robot values rather than rebuild.

### Feature 3 — Revive labware offsets as the final correction layer (L3, absorbing L2)
**Goal:** per-robot, per-labware jog-and-store offsets so a drifted tube/tip rack can be nudged back into
alignment at runtime — never a JSON change.

Work to bring it back:
1. Load wax/reagent labware **on-deck in a fixed slot** (kill the `offDeck` pattern) so offsets can bind.
   The carriage is already placed at slot 1 via `set_offset`; likely loadable directly in slot 1.
2. Persist offsets in Mongo keyed by **robot × labwareUri × slot** (standalone store; the per-run
   `OpentronsRunRecord.labwareOffsets` field is the wrong granularity).
3. wax/reagent `startRun` reads stored offsets and includes `labwareOffsets` on `POST /runs`.
4. This **replaces** the `ROBOT_OFFSETS` hostname table — one source of truth, no wax/reagent drift.

---

## 5. Open workshop questions (for Jacob)
1. **Feature 1 mechanism:** dedicated deck-tuning maintenance mode (A) or inline-during-real-fill (B)?
2. **Feature 2:** actually rebuild Opentrons global cal, or just surface/track on-robot values and lean on L0+L4?
3. **Unify L2 into L3?** (Recommended — kills the wax/reagent B07 drift bug and the all-zeros B14/R04 gap.)
4. **Off-deck:** OK to load the deck on-deck in slot 1 so offsets bind, or is off-deck loading a hard
   operator-workflow requirement?
5. **Sequencing:** suggested order is Feature 3 (wizard mostly exists) → Feature 1 (deck JSON jog) →
   Feature 2 (only if needed). Agree?

---

## 6. Key file references
- Deck JSON: `~/Library/Application Support/Opentrons/labware/gen4deck_gen7cartridge_005.json`
- JSON→robot: `scripts/seed-labware-from-local.ts`, `src/lib/server/opentrons/proxy.ts:309`, `maintenance-clone.ts:133`
- Protocols: `~/Library/Application Support/Opentrons/protocols/105aa22c-.../src/Wax_Filling_GEN7_Cartridge.py`,
  `~/Library/.../f10fac8c-.../src/Reagent_Filling_GEN7.py` (ROBOT_OFFSETS, limit-switch probe, aspiration model)
- LPC wizard: `src/routes/opentrons-clone/[robotId]/protocols/[protocolId]/lpc/{+page.svelte,+page.server.ts}`
- Offset plumbing to copy: `.../protocols/[protocolId]/+page.server.ts:254-352`
- Production run create (add offsets here): `wax-filling/+page.server.ts:824`, `reagent-filling/+page.server.ts:~670`
- Unused model field: `src/lib/server/db/models/opentrons-run-record.ts:20-30`
- Read-only global cal: `src/routes/api/opentrons-lab/robots/[id]/calibration/+server.ts`
- Off-deck auto-resume: `src/lib/components/manufacturing/EmbeddedRunController.svelte:42-71` (commit `3cd2789`)
</content>
</invoke>

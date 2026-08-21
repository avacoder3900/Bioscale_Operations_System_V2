# DECK001 WAX ALIGNMENT TEST — paused, unresolved

**Search keys:** deck001 test · deck001 wax · wax alignment · gen4deck_gen7cartridge_001 ·
R04 wax offset · wax hole misalignment · OT2CEP20210817R04

**Status:** PAUSED 2026-08-19 for production work. Root cause narrowed to the
**labware definition**, not protocol code. Exact correction still unknown — needs one
jog measurement on the robot.

---

## TL;DR

The wax protocol moves the tip to the *nominal JSON position* of wax hole `X2` with
**every offset set to zero**. Operator reports the tip lands **~4 mm right and slightly
below** the real hole. So the JSON well coordinates are wrong (or the physical cartridge
differs from them). Nothing in the Python offset math is involved.

---

## Resume checklist (start here)

1. Confirm R04 is idle (no `current` run) — see identifiers below.
2. Open a maintenance run, home, move to nominal `X2`, **jog to the true hole centre**.
3. Read back the position → `dx, dy` = (true − nominal).
4. Apply that shift to **even-numbered columns only** (288 wax wells); leave the 288
   odd-numbered reagent wells untouched.
5. Re-bundle + re-upload the protocol (the def is bundled *into* the protocol upload).
6. Verify with the protocol's built-in 9-hole "Calibration check".

---

## Exact identifiers (read fresh 2026-08-19)

| Thing | Value |
|---|---|
| Robot | `OT2CEP20210817R04` ("Robot 2 R04") |
| Robot IP | `172.16.28.144:31950` |
| Other robots | B14 = `172.16.28.71`, B07 = `172.16.28.101` |
| BIMS equipment id | `CCyX8FjTRGvYOd9vISGvi` |
| Protocol id (on robot) | `b34f9d6d-31c5-4521-a8f1-35c5ad8fbe00` |
| Analysis id | `c590b63d-edb3-42c6-8cbe-0160287c8a69` |
| Investigated run | `c43c8dc2-0ce3-466f-88a0-b21360e4bff8` (was paused; now **stopped**) |
| Labware definitionUri | `cosmas_damian/gen4deck_gen7cartridge_001/1` |
| Repo branch @ time of writing | `feat/tip-calibrator-teach` |
| Repo HEAD | `69e0c7868327022705c65ffd1182dd1f9cabbbfc` |

> Re-read all of these before use — do not trust them from a stale context.

**Live labware def snapshot saved next to this file:**
`docs/deck001-live-labware-def-2026-08-19.json` (extracted from the robot's own analysis —
this is exactly what the robot was using).

---

## What the failing run actually did

From the run's command log:

```
Tip calibration disabled — skipping offset baseline read (x=0.0, y=0.0).
Per-tip calibration DISABLED — nominal wax hole position, no X/Y probe.
Calibration check adjust: x=0.0, y=0.0
moveToWell  well=X2  offset={x:0.0, y:0.0, z:1.0}
PAUSE: Calibration check 1/9: wax hole X2 ... Tip over the WAX hole?
```

Runtime parameters on that run:

| RTP | value |
|---|---|
| `bims_native` | **True** |
| `offset_x / offset_y / offset_z` | **0.0 / 0.0 / 0.0** |
| `cal_x / cal_y / z_cal` | 125.181 / 173.247 / 34.491 (defaults) |
| `row_pattern_0/1/2` | all True |

All three labware offsets on the run were `{x:0, y:0, z:0}`.

**Conclusion: the tip went to the pure JSON position. No correction of any kind was applied.**

---

## Live geometry (cartridge 1, row X)

Odd columns = REAGENT, even columns = WAX. Both live in the same definition.

| well | type | x | y | z | dia |
|---|---|---|---|---|---|
| X1 | REAGENT | 59.655 | 256.420 | 8.20 | 1.8 |
| **X2** | **WAX** | **56.354** | **254.321** | **3.50** | 1.8 |
| X3 | REAGENT | 53.655 | 256.420 | 8.20 | 1.8 |
| X4 | WAX | 50.354 | 254.321 | 3.50 | 1.8 |
| X5 | REAGENT | 47.655 | 256.420 | 8.20 | 1.8 |
| X6 | WAX | 44.354 | 254.321 | 3.50 | 1.8 |
| X7 | REAGENT | 41.655 | 256.420 | 8.20 | 1.8 |
| X8 | WAX | 38.354 | 254.321 | 3.50 | 1.8 |

- Wax `X2` sits **−3.301 mm x, −2.099 mm y** from reagent `X1` — i.e. midway between
  reagent columns, not under one.
- Pitch is 6.000 mm in x, 9.000 mm in y (row to row).
- **Hole diameter 1.8 mm** → more than ~0.9 mm of error misses the hole entirely.
- Live def vs `backups/labware-defs-backup-2026-07-28-pre-waxwell-restore.json`:
  wax wells differ by only **−0.5 mm in x** (someone fine-tuning). Not gross corruption.

### Fill order (answers "does it go left or right first?")

Code order is `X2, X4, X6, X8, W2, W4, ...` — column *numbers* ascend, but x *descends*.

**Within a cartridge the fill runs RIGHT → LEFT.** Deck holds 3 cartridges; the groups
step left → right between them:

| cartridge | columns | x range |
|---|---|---|
| 1 | 2–8 | 38.4 – 56.4 |
| 2 | 10–16 | 186.7 – 204.7 |
| 3 | 18–24 | 334.3 – 352.3 |

So starting on a rightmost hole **is correct by design** — `X2` is the rightmost wax hole
of the leftmost cartridge. That part is not a bug.

---

## The measurement, and why it can't be applied literally

Operator: *"the pipette tip is about 4 mm to the right of the first wax hole and slightly
below it."*

Applying `(dx, dy) = (−4.0, +1.5)` verbatim to the wax wells gives:

```
wax X2 (56.354, 254.321) -> (52.354, 255.821)
   nearest reagent X3 (53.655, 256.420) = 1.43 mm away
```

Both holes are 1.8 mm diameter, so centres 1.43 mm apart would **physically merge**.
The raw eyeball numbers are therefore slightly off (expected — the tip obscures the hole).

### Two candidate corrections — UNRESOLVED

**A. Wax sits under the reagent hole** → `dx = −2.699, dy = 0`
   `X2: 56.354 → 53.655` (matches reagent X3's x, 2.099 mm below it in y).
   Geometrically clean. Matches "not in line with reagent holes" literally.
   Requires the operator's "4 mm" to actually be ~2.7 mm.

**B. Wax is genuinely offset from reagent** → roughly `dx = −4.0, dy = +1.5`
   Matches the eyeball reading but produces the 1.43 mm overlap above.
   Only viable if wax/reagent are different-depth features (wax z=3.50 vs reagent z=8.20;
   cf. `Cartridge wax relief.dxf`, `DRAFT cartridge press bottom seal gen7 channel only.stl`
   in ~/Downloads).

**Do not edit 288 wells until this is settled by a jog measurement.**

---

## Ruled out (don't re-investigate)

- **The dropped `-25.955` / `-11.253` calibration constants.** Real latent bug (see below),
  but *not* the cause here — tip calibration was DISABLED on this run and `adjust` was
  `(0,0)`, so that code never executed. A speculative patch for it was made and then
  **reverted**; `protocols/` is clean.
- **Labware offsets.** All zero on the run.
- **BIMS deck offset.** `bims_native=True` but `offset_x/y/z` all `0.0`.
- **Labware def corruption.** Live vs July backup differs by only −0.5 mm in x.

---

## Separate latent bug (real, but NOT this issue)

`PRD 6` refactor dropped two carriage-frame zero constants from the tip-calibration math
in both protocols. Legacy formula:

```python
xOffset = round(x_pos - shift - 150.536 + offset['x'], 1)   # wax
yOffset = round(y_pos - shift - 177.0   + offset['y'], 1)
```

Current:

```python
xOffset = round(offset['x'] - shift, 1)     # constants gone
yOffset = round(offset['y'] - shift, 1)
```

Missing terms: **wax −25.955 / −11.253**, **reagent −26.125 / −11.053**.
`scripts/ot2-bridge.py` says the removal was deliberate for the BIMS-native path ("the C
string is now the baseline the operator dials in"), but R04's `RobotDeckOffset` is
`0,0,0`, so nothing absorbs it there. **Will bite whenever per-tip calibration is
re-enabled.** Track separately.

---

## Known blockers

1. **The running protocol is not in any local repo.** It contains a "Calibration check"
   routine (9 holes, operator confirms each) that no local copy has:
   `grep -c "Calibration check"` returns 0 across all 7 local copies of
   `Wax_Filling_GEN7_Cartridge.py`. Robot download endpoints 404. **Source must come from
   the lab Mac (`172.16.28.173`) or wherever BIMS builds the bundle.**
2. **The def is bundled into the protocol upload** — `gen4deck_gen7cartridge_001.json`
   appears in the protocol's file list on the robot. Fixing it means re-bundling and
   re-uploading, not just editing Mongo `labware_definitions`.
3. No `MONGODB_URI` in this machine's `.env.local` (only `VERCEL_OIDC_TOKEN`), so the
   read-only diag scripts (`scripts/diag-r04-wax-param-diff.ts`) can't run locally as-is.

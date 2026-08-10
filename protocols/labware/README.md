# Custom labware — robot-arm wax cell

## brevitest_arm_nest_1_gen7cartridge.json

Single-cartridge nest for the SO-ARM101 → OT-2 wax-fill handoff (ARM-WAX-01).
One Gen7 cartridge, presented in a standard OT-2 slot footprint
(127.76 × 85.48 mm).

### Derivation

Geometry was extracted programmatically from the production deck definition
`cosmas_damian/gen4deck_gen7cartridge_001` (backup:
`backups/labware-defs-backup-2026-07-28-pre-waxwell-restore.json`), first
cartridge position = deck rows A–C × cols 1–8:

| feature | value | source |
|---|---|---|
| well diameter / depth / volume | ⌀1.8 mm, 3.75 mm, 18 µL | deck def |
| reagent-well x (odd cols) | 52.83 / 58.83 / 64.83 / 70.83 | deck 001 measured |
| wax-gate x offset (even cols) | +3.26 mm | deck 001 measured |
| channel-row y pitch | 9.0 mm (rows centered in slot) | deck def |
| wax-gate y offset | −0.8 mm | deck 001 row A |
| well-bottom z | 8.2 (reagent) / 3.3 (wax) | deck def, cartridge plane 12.7 |

### Layout

- Rows `A/B/C` = the three channel rows of one cartridge.
- **Even columns are wax gates**: col 2 = Gate 4, col 4 = Gate 3,
  col 6 = Gate 2, col 8 = Gate 1 (same as GEN7 deck column grouping).
- Odd columns are reagent wells — present for completeness, not filled.

### Fixture TODO (before first wet run)

The z values assume the cartridge top plane sits at 12.7 mm above the slot,
exactly like the flat gen4 deck. The physical arm nest will hold the
cartridge higher. When the fixture exists:

1. measure the new cartridge-plane height `H`,
2. bump `version` to 2, add `H − 12.7` to every well `z` and to
   `dimensions.zDimension`,
3. run Labware Position Check / the protocol's dry-run mode (`wax=False`)
   to verify with an empty tip.

### Expansion path (more cartridges)

Add rows `D–F` (cartridge 2), `G–I` (cartridge 3)… at the same 9.0 mm
channel pitch with a 14.3 mm gap between cartridges (measured gap on the
gen4 deck), bump `loadName` to `brevitest_arm_nest_<n>_gen7cartridge`, and
widen `CHANNEL_ROWS` in `Wax_Filling_ARM_Single_Cartridge.py`.

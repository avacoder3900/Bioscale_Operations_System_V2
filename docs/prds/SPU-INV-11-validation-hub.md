# SPU-INV-11 — SPU Validation Hub (Fleet View at /validation)

**Status:** Approved (Jacob, 2026-09-08)
**Branch:** `feat/spu-tweaks`

## Problem

Validation UI is scattered: per-unit data lives on the SPU detail Validation tab; execution lives
on per-instrument pages under /validation/*; and `/validation` itself is just a redirect to the
magnetometer page. There is no fleet view and no page that ties the surfaces together.

## Design (per Jacob's workshop answers)

Each instrument keeps its own execution page. `/validation` stops redirecting and becomes the
**SPU Validation hub** — the unified fleet view:

1. **Metric tiles**: fully-validated units, units in `validating`, units with any failed
   modality, sessions in the last 7 days, open validation runs.
2. **Fleet matrix** (active units only, retired hidden) — one row per unit with the
   *measurements Jacob asked for*, not just pass/fail:
   - **Magnetometer**: badge + Z-range summary; row expands to the full gauss grid —
     all 5 wells × channels A/B/C. Falls back to the latest mag session when the rollup
     is empty (pre-fix failures/poll sessions).
   - **Optics**: average F7/F3 ratio per channel A / B / C (`results.ratioByChannel`).
   - **Thermocouple**: the mode of the temperature plot (`results.stats.mode`).
   - Overall cell + UDI links to the unit's Validation tab.
3. **Launcher cards** to the executors: Magnetometer, Thermocouple, Validation Runs (with open
   count), Optical Confirmation.
4. **Navigation stitching**: hub added to the SPU nav group as "SPU Validation"
   (`/validation` moves out of SPU Manufacturing's sectionPaths so highlighting splits);
   the SPU detail Validation tab gets header links to the hub + each executor.

## Acceptance

- /validation renders the fleet matrix with gauss grids, channel ratios, and mode temps.
- The old tab-strip "Validation" tab now lands on the hub instead of the magnetometer page.
- `npm run check` at or below the 10-error baseline.

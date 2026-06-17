# CALIB-2 — Robot global calibration: surface & track (no wizard rebuild)

**Date:** 2026-06-16 · **Owner:** Jacob · **Status:** Approved (workshop 2026-06-16)
**Depends on:** none · **Branch:** `ralph/labware-calibration`

## Decision (Jacob, 2026-06-16)

We will **not** rebuild Opentrons' pipette-offset / tip-length / deck (X-marks) calibration.

Rationale, confirmed in the workshop:
- Global cal is **created in the Opentrons desktop App** and **stored on the robot's Raspberry Pi**
  (`/data`); the App writes it via the robot-server HTTP API. We only read it.
- Our accuracy comes from L0 (hand-tuned deck JSON) + L4 (per-tip limit-switch probe), which already
  exceed what Opentrons global cal targets. Global cal is **not on the accuracy critical path**, so a
  rebuilt jog wizard would be cost without benefit ("overcomplicating it").

So CALIB-2 is scoped down to **surface + track**: read the on-robot calibration, display it, and warn
when it's stale or missing — keeping the Opentrons App as the tool that actually sets it.

## What exists today
- Read-only GETs of `/calibration/deck`, `/calibration/pipette_offset`, `/calibration/tip_length`:
  `src/routes/api/opentrons-lab/robots/[id]/calibration/+server.ts`,
  `src/routes/opentrons-clone/[robotId]/+page.server.ts:58-79` (load), display panels in
  `opentrons/devices/[robotId]/+page.svelte`.
- Caveat: the `/api/opentrons-lab/robots/[id]/...` dynamic route 404s on Vercel prod
  (memory `project-prod-dynamic-api-404`). The `opentrons-clone` load reads calibration directly in
  its load fn, so that path is unaffected — prefer it / the bridge for prod reads.

## Stories
- **CALIB-2-1 — Calibration staleness model + read.** Normalize the three calibration reads into one
  `{deck, pipetteOffset, tipLength}` shape with `lastModified` timestamps and a computed
  `status: ok | stale | missing` (stale threshold reused from the clone page's `STALE_DAYS`).
  Read via the bridge/clone path (not the prod-404 dynamic API).
  - *Acceptance:* for B07, returns the three blocks with timestamps and a status; missing cal → `missing`.
- **CALIB-2-2 — Surface on the robot/manufacturing view.** Show per-robot calibration status with
  age and a clear "Set/update in the Opentrons desktop App" affordance (link/instructions, not a jog
  wizard). Warn (non-blocking) before a fill if a robot's global cal is `stale`/`missing`.
  - *Acceptance:* a robot with old/absent cal shows a visible warning; a freshly-calibrated robot shows green.
- **CALIB-2-3 — (optional) Snapshot to Mongo for history.** On read, upsert a lightweight per-robot
  calibration snapshot (immutable-log style) so we can see when cal last changed over time. No editing.
  - *Acceptance:* repeated reads append/upsert snapshots; history is queryable per robot.

## Explicitly OUT of scope
- No pipette-offset / tip-length / deck X-marks jog wizard.
- No writing calibration to the robot. The Opentrons App remains the system of record for L1.

## Validation
- `npm run check` zero new errors; `npm run build` green.
- Manual: B07 with current cal shows ok; force-stale shows the warning.

## Guardrails
- Read-only against the robot for calibration; no `/sessions` or `/calibration` POSTs.
- Use the bridge/clone read path in prod (dynamic `[id]` API 404s — do not depend on it).
</content>

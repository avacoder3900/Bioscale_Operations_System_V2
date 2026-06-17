# CALIB-0 — Jog-capture foundation (shared by CALIB-1 & CALIB-3)

**Date:** 2026-06-16 · **Owner:** Jacob · **Status:** Approved (workshop 2026-06-16)
**Depends on:** none · **Blocks:** CALIB-1, CALIB-3
**Branch:** `ralph/labware-calibration`

## Why

Feature 1 (deck-JSON hole tuner) and Feature 3 (per-robot labware offsets) both need the
same primitive: open a maintenance run on a chosen robot, load the deck labware, pick up a
tip, move to a target position **using the exact geometry the fill protocol uses**, let the
operator jog X/Y/Z, and return the delta vector. The `opentrons-clone` LPC wizard already
implements ~90% of this jog mechanism; CALIB-0 generalizes it into a reusable service so
CALIB-1 and CALIB-3 don't fork it twice.

This is "recreate the exact same pattern as a protocol, outside of running a protocol"
(Jacob, 2026-06-16): a maintenance-run jog session, not a real fill.

## Codebase anchors
- Existing jog wizard: `src/routes/opentrons-clone/[robotId]/protocols/[protocolId]/lpc/{+page.svelte,+page.server.ts}`
  — moveToWell → `savePosition` baseline → `moveRelative` jog → `savePosition` → vector = delta.
- Maintenance-run helpers: `src/lib/server/opentrons/maintenance-clone.ts:133`
  (`registerMaintenanceLabwareDefinition`), and the maintenance-run create/loadLabware/pickUpTip path.
- Transport: `src/lib/server/opentrons/proxy.ts` (direct LAN vs Vercel bridge).
- Bridge daemon: `scripts/ot2-bridge.py` (note: maintenance commands route through here in prod).
- Stale-run hazard (MUST handle): a non-terminal protocol run blocks maintenance-run creation
  ("Cannot create maintenance run when a protocol run is active"). Auto-stop+delete the stale
  current run and retry once. See memory `project-ot2-stuck-run-blocks-maintenance`.

## Design — the additive position model (governs everything below)
```
fill tip position = L0 deck JSON well x/y/z
                  + L2/L3 set_offset (per robot×deck)
                  + L4 per-tip limit-switch probe (runtime)
```
A jog session calibrates exactly ONE layer at a time and must **zero the others** so the
captured delta is attributable:
- **CALIB-1 (L0 geometry):** move to `well.top(well_z_depth)` with `set_offset = 0` and **no**
  per-tip probe. Operator jogs to the true nominal hole. Delta → that well's JSON x/y/z.
- **CALIB-3 (L2/L3 placement):** move to a reference well with current JSON geometry, `set_offset = 0`,
  no probe. Operator jogs the whole-deck placement. Delta → Mongo per-robot×deck offset.

## Stories
- **CALIB-0-1 — Jog session service.** Extract a transport-agnostic server module
  `src/lib/server/opentrons/jog-session.ts` exposing: `openJogSession(robot, { labwareUri, slot })`
  (clears any stale current run first, opens maintenance run, loads pipette + labware, picks up a
  tip), `moveToTarget(session, { wellName | coordinates, zDepth, adjust })`, `jog(session, {axis, mm})`,
  `capturePosition(session)`, `closeJogSession(session)` (drop tip, home, delete run). Reuse
  `maintenance-clone.ts` + `proxy.ts`; no new transport.
  - *Acceptance:* a script can open a session on a LAN robot, move to a well, jog +1mm X, capture,
    and the returned delta equals the jog. Stale-run auto-clear verified (open twice in a row succeeds).
- **CALIB-0-2 — Jog UI primitive.** A shared Svelte controller/component pattern for the jog pad
  (X/Y/Z ± step buttons, step-size selector, live position readout, capture/cancel) usable by both
  CALIB-1 and CALIB-3 pages. Reuse the LPC wizard's jog-pad markup; do not modify the existing LPC
  files (UI layer frozen) — lift the reusable logic into a new component under an allowed path.
  - *Acceptance:* component renders, buttons fire `moveRelative`, readout updates from `capturePosition`.

## Validation
- `npm run check` — zero new errors.
- Manual: jog session against B07 (`hidden-leaf.local`) on the lab Mac (LAN path) — see
  memory `project-ot2-bridge-deployment` for IPs/SSH key.

## Guardrails
- Do NOT modify `.svelte` files under the frozen UI tree (`src/lib/components/`, existing routes' `+page.svelte`).
- Every offset/JSON mutation downstream gets an `AuditLog` entry (CALIB-1/3 own that).
- Never open a maintenance run without first clearing a stale current run.
</content>

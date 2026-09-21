# CALIB-4 — Two-field calibrator Z (approach vs probe), editable and actually used

**Date:** 2026-08-18 · **Owner:** Alejandro (via Claude Code) · **Status:** Draft
**Depends on:** CALIB-0, NATIVE-CALIBRATION-SYSTEM · **Branch:** `feat/tip-calibrator-teach`
**Priority:** P1 — the studio's Z field is inert today, and the value it *should* write drives production `z_cal`.

## Goal

Let an operator change the tip-calibrator Z in the Deck Calibration Studio, see it live on the page,
and have the saved value actually drive the robot — without collapsing the two physically different
Z heights into one control.

## 1. Problem statement

`TipCalibratorFixture` carries **two different Z values**, and the studio exposes only the one the
probe never reads.

| Field | Meaning | Written by | Read by |
|---|---|---|---|
| `position.z` | "approach point the tip moves to before the probe" (`tip-calibrator-fixture.ts:51`) | the studio's `calZ` input | the jog move-to only |
| `zCalWax` / `zCalReagent` | the actual p20 / p300 probe depth (34.491 / 40.8) | **nothing in the UI** | `resolveCalibratorPoint` → `calibrate-tip`, and production `z_cal` |

`resolveCalibratorPoint` takes X/Y from `position` but Z from `fixture[spec.zCalKey]`
(`tip-calibrator.ts:142-144`) — never `position.z`. So the operator's edit lands in a field the
probe does not consult.

**It is worse than inert — it is self-resetting.** `saveCalibratorPosition()` posts only
`{robotId, x, y, z}` (`+page.svelte:928`). `saveCalibrator` then recomputes both probe Zs from
`prev ?? CAL_DEFAULTS` (`+page.server.ts:311`) and writes them back in the same `$set`. So no UI path
can move probe Z off its default, and a manual Mongo edit is stomped on the next save.

**Three false confirmations** make this hard to spot: the save succeeds; a reload shows your number
(`+page.svelte:73` reads `calZ = cal.position.z`); and "Go to calibrator" honours it (the move-to
posts `z: calZ`). Only the real probe silently reverts to the default.

**This is not a studio-local setting.** `calibration-rtps.ts:59-61` injects the same fields as the
`z_cal` runtime parameter into production wax/reagent runs. **Save is the door to production.**

## 2. Goals

1. Two separately labelled, operator-editable fields: **Approach Z** and **Probe Z**.
2. Probe Z round-trips: edit → visible immediately → Save → used by the next probe *and* by production `z_cal`.
3. Try-before-commit: probe-test an unsaved Z without writing to the database.
4. Range guards on both fields.
5. Make it visible when a robot is inheriting the shared `global` fixture.

## 3. Non-goals

- Persisting `tipAdjust` across sessions (it is deliberately cleared at `+page.svelte:537`).
- Any change to AuditLog **structure** (see Constraints).
- Deck hole positions, `RobotDeckOffset`, or the `bims_native` gate.
- Re-specifying the mount-inference fix — **already landed as `f8a078468`** (`TIP_PROFILE` replaces
  `TIP_FOR_MOUNT`; `resolveCalibratorPoint` takes an explicit `TipProfile`; `calibrate-tip` fails
  closed on missing `mount`/`tipProfile`; the page has an explicit tip-type selector).

## 4. Shared contract — FIXED UP FRONT so stories build in parallel

Story C must not wait on A or B. These names are the contract; do not rename them.

**4.1 `saveCalibrator` FormData keys** (`+page.server.ts:289`, already implemented server-side):

```
robotId      required  string
x, y, z      required  numeric strings  -> position{x,y,z}   (APPROACH point)
zCalWax      optional  numeric string   -> probe Z for the p20/wax tip
zCalReagent  optional  numeric string   -> probe Z for the p300/reagent tip
source       optional  'manual' | 'probe'
note         optional  free text
```

Blank/absent Z key = "leave it alone"; present-but-junk = 400. The client sends **exactly one** of
`zCalWax` / `zCalReagent`, chosen by the active `tipProfile`.

**4.2 Load payload** — `data.calibrators[]` (`+page.server.ts:198`), one entry per fixture, already
shaped by `toCalEntry` (`:115`):

```
{ robotId, position:{x,y,z}, zCalWax, zCalReagent, capturedBy, capturedAt, history[] }
```

Story B adds one field per entry: `inheritedFromGlobal: boolean`.

**4.3 `POST /api/scanner/calibrate-tip` body:**

```
{ robotId, mount:'left'|'right', tipProfile:'wax'|'reagent', tipWell, runId, pipetteId,
  calibrator?: { x, y, z } }     // <- optional, un-saved override for try-before-commit
```

`calibrator` is already honoured by `applyCalibratorOverride` (`tip-calibrator.ts:160`); the page
simply never sends it today.

**4.4 Z limits** — exported from `tip-calibrator.ts` by Story A, consumed by B and C:

```ts
export const CAL_Z_LIMITS = { min: 5, max: 200 } as const;   // mm, OT-2 envelope
export function plausibleZ(v: unknown): number | undefined;   // finite + in range, else undefined
```

## 5. Design decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Approach Z and Probe Z stay **separate controls**. | They are two heights in one motion. If Probe Z drove the free jog move-to, the pipette would descend to touch-off depth **unprotected by the probe routine**. This is the crash case. |
| 2 | Probe Z is keyed by the explicit `tipProfile`, never the mount. | Pipettes are not fixed to mounts on this fleet (see `f8a078468`). |
| 3 | **Save is the only write path to production.** Jog and probe-test never persist. | Gives try-before-commit for free, on the real motion path rather than a proxy. |
| 4 | Reject implausible Z rather than clamping. | A clamp silently moves the pipette somewhere the operator did not ask for. |
| 5 | Treat a stored `(0,0)` / out-of-range Z as *not taught* and fall back. | `vec` defaults every axis to `0` (`tip-calibrator-fixture.ts:37`), so a partial write materialises as a real 0. |

## 6. Stories

Disjoint files — three agents in parallel.

- **CALIB-4-A — Z limits + not-taught guard.** *File: `src/lib/server/services/deck-calibration/tip-calibrator.ts` only.*
  Export `CAL_Z_LIMITS` and `plausibleZ()` per §4.4. Use `plausibleZ` in `resolveCalibratorPoint`
  (`:144`) so an out-of-range or zero stored probe Z falls back to `spec.defaultZ` instead of being
  commanded. Same treatment for `position.x/y` against `DEFAULT_CALIBRATOR_XY` (`:142-143`), which
  today accept a stored `0` as taught. Do **not** touch `Z_CAL_FOR_PROCESS` semantics — production
  RTP behaviour must be unchanged for in-range values.
  - *AC:* a fixture with `zCalWax: 0` resolves to `34.491`, not `0`; a fixture with `zCalWax: 36.2`
    resolves to `36.2`; `plausibleZ('abc')`, `plausibleZ(0)`, `plausibleZ(400)` all return `undefined`.

- **CALIB-4-B — Persist and surface probe Z.** *File: `src/routes/manufacturing/cart-mfg/deck-calibration/+page.server.ts` only.*
  Range-guard `x/y/z` and both optional Z keys in `saveCalibrator` (`:289`) using `plausibleZ`,
  returning `fail(400, …)` with a message naming the offending field. Add
  `inheritedFromGlobal: boolean` to each `toCalEntry` result (`:115`) — true when no row exists for
  that `robotId` and the `global` row is what would be used. Keep the existing `AuditLog.create`
  call shape; it may carry the Z values it already carries, nothing more.
  - *AC:* saving `zCalWax=36.2` persists and is returned by the next load; saving `zCalWax=400`
    returns 400 and writes nothing; a robot with no own fixture reports `inheritedFromGlobal: true`.

- **CALIB-4-C — Two labelled fields + try-before-commit.** *File: `src/routes/manufacturing/cart-mfg/deck-calibration/+page.svelte` only.*
  Split the single `calZ` (`:835`) into **Approach Z** (`position.z`, keeps driving `goToCalibrator`
  at `:894`) and **Probe Z** (bound to the active profile's `zCalWax`/`zCalReagent`). Seed both from
  the load payload (`:73` currently reads only `position.z`). `saveCalibratorPosition` (`:928`) sends
  the matching Z key per §4.1. `calibrateTip` sends `calibrator: {x, y, z}` per §4.3 using the live
  field values, so an unsaved Z is probe-tested without persisting. Label which process each Probe Z
  feeds, and show a note when `inheritedFromGlobal` — the first Save forks that robot off `global`
  permanently. Inputs get `min`/`max` from `CAL_Z_LIMITS`.
  - *AC:* typing a Probe Z updates the field instantly and is sent on the next Calibrate tip without
    a save; pressing Save then persists it and it survives reload; Approach Z still drives
    "Go to calibrator"; switching tip type swaps the displayed Probe Z.

## 7. Constraints

- **No AuditLog restructuring.** Existing `saveCalibrator` / `revertCalibrator` `AuditLog.create`
  calls may carry additional Z values in `newData`; nothing else changes. Per standing policy,
  audit-surface work is solo, not agent work.
- Revert already carries `zCalWax`/`zCalReagent` through `history` (10 deep) — preserve it. **Known
  wrinkle:** history entries written before this PRD will revert Z to defaults via
  `toCalHistoryEntry` gap-filling.
- Serialization: `.lean()` + `JSON.parse(JSON.stringify())` per repo standard.
- `requirePermission(locals.user, 'manufacturing:write')` — takes the user, not the event.

## 8. Risks / open questions

1. **Production blast radius.** After Save, that robot's `z_cal` in wax/reagent runs is the operator's
   number. Intended, but it is the first time this field has ever diverged from the `.py` default.
2. **`global` fork is silent and permanent.** Story C surfaces it; it is not prevented.
3. **Direction of failure is asymmetric.** Too low = crash into the fixture; too high = no reading.
   The range guard bounds both but does not distinguish them.
4. *Open:* should `CAL_Z_LIMITS` be per-profile (p20 vs p300) rather than one global window? Assumed
   one window for now.

## 9. Test / validation plan

- `npx svelte-check --threshold error` — must stay at the pre-existing 11 errors, none in touched files.
- Vercel preview build on the branch (never a local `vercel deploy`).
- **First real probe on the dev unit, not a fleet robot.** Verify: default Z probes as today; a
  deliberately-changed Probe Z moves the touch-off by the expected delta; an out-of-range value is
  refused at the form, not at the robot.
- Confirm a wax run started after a Save carries the new `z_cal` in its runtime parameters.

## Appendix A — File change map

| Action | Path | Story |
|---|---|---|
| Modify | `src/lib/server/services/deck-calibration/tip-calibrator.ts` | A |
| Modify | `src/routes/manufacturing/cart-mfg/deck-calibration/+page.server.ts` | B |
| Modify | `src/routes/manufacturing/cart-mfg/deck-calibration/+page.svelte` | C |
| None | `src/lib/server/db/models/tip-calibrator-fixture.ts` | — (schema already supports both fields) |
| None | `src/lib/server/opentrons/calibration-rtps.ts` | — (reads the same fields; behaviour preserved) |

## Appendix B — Reference pointers

- `NATIVE-CALIBRATION-SYSTEM.md` — PRD 2 (fixture) and PRD 6 (RTP injection).
- `DECK-CALIBRATION-STUDIO.md` — the page this extends.
- `CALIB-3-LABWARE-OFFSETS-MONGO.md` — the sibling "Mongo value → RTP → protocol" pattern.
- Commit `f8a078468` — mount-inference removal; prerequisite for Probe Z being keyed correctly.

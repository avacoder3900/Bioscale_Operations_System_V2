# CALIB-5 — Per-robot offsets for the tip rack and tube rack (slots 10 and 11)

**Date:** 2026-10-26 · **Status:** Approved by Jacob 2026-10-26 ("yes do it"); building on `feat/ot2-wired-1` · **Parent:** `OT2-WIRED-1-PLAN.md` workstream C · **Supersedes:** CALIB-3 decision 2 for racks (CALIB-3 keyed offsets by robot × deck; racks need robot × labware).

## 1. Problem (2026-10-26, measured)

`labware_definitions` holds ONE document per load name. The Deck Calibration Studio's "Apply offset" for kind=tip / kind=tube writes into that shared document (`applyDeckEditBatch`); `robotId` on the edit is audit-only. `run_start_auto_resync` then pushes the edited geometry to every robot at its next run start.

Today: 16:04:54Z, +2/+5 on `cosmasanddamian_96_tiprack_20ul` with R04 selected → 16:34 auto-resync on B07 → B07 missed the X switch on the first probe after every rack pick-up (E1, F1), tips hand-seated, run stopped 17:10. 19:20–19:27Z, with B07 selected: 20 µL −2/−4, drybath tube rack −3/0/+2 (shared with R04/B14 wax), deck-004 −3/0/+2 applied twice. The 200 µL rack was lowered z −1.0 at 17:12/17:13 and reached R04 (18:12) and B14 (18:21) by auto-resync; both ran reagent fine afterwards.

Racks are the same physical part in a slightly different place on each robot. Cartridge decks escape this because each deck has its own definition.

## 2. Decision

- One offset record per **robot × rack definition × slot**: `robot_labware_offsets` `{ _id, robotId, loadName, definitionUri, slotName, vector{x,y,z}, taughtBy, taughtAt, source: 'studio'|'migration'|'manual', note, history[] }`, unique on `(robotId, definitionUri, slotName)`.
- Applied in **both frames the same way**:
  - **Fill run:** two new run-time parameters per protocol, `tiprack_offset_x/y/z` and `tuberack_offset_x/y/z` (defaults 0, −10..10 mm). The `.py` passes them to `tiprack.set_offset(...)` and `tuberack.set_offset(...)` instead of the global `robot_offsets` (which stays 0 and still feeds the carriage). BIMS injects the values at `startPrepare` next to `calibrationRtpValues`. Rationale: on API 2.18+ a later `set_offset` overrides any `POST /runs` `labwareOffsets`, so the `.py` must be the applier; RTPs are already recorded in run records, compared on resume/adopt, and visible on the robot (`runTimeParameters`).
  - **Studio (maintenance run):** `POST /maintenance_runs/{id}/labware_offsets` `{definitionUri, location:{slotName}, vector}` before `loadLabware` for kind=tip / kind=tube and before the tip-profile rack load in pick-up. Offsets bind at load, so changing one reopens the run (same path as SLOT_OCCUPIED).
- **Studio semantics for racks:** "Apply offset" / "Set position" on kind=tip or kind=tube writes the selected robot's offset row (delta added to the current vector), never the shared definition. The shared definition becomes read-only for racks in the Studio (a visible note says which robots it reaches). kind=tip locks the selected rack to the tip profile.
- **Default = current state.** Every robot starts at vector 0 except the migration below, chosen so that no robot moves from the geometry it is working with right now.
- **Protocol freshness** is unaffected (the check compares bundled wells against `labware_definitions`; offsets are not wells).

## 3. Migration (one script, plan/apply, audited)

| Rack | Shared definition after migration | Per-robot offsets |
|---|---|---|
| `cosmasanddamian_96_tiprack_20ul` (wax, slot 11) | stays as now: A1 (14.38, 75.74, 21.62) = Oct-14 geometry +1 Y; B07 picked up and probed first-time on it at 19:36Z | R04 (+2, +4, 0) — its working state today was Oct-14 +2/+5; B07 0; B14 0 |
| `cosmas_and_damian_drybath_tuberack` (wax, slot 10) | restored to Oct-14 geometry A1 (36.5, 73, 67.25) that all three ran on — B07 completed a full wax run on it at 15:06Z today | all 0. Today's 19:22Z −3/0/+2 edit (B07 selected) never completed a run, so it is recorded as a note on B07's row, not applied; re-teach in the Studio once S4 lands if B07 really needs it |
| `cosmas_and_damian_biotix_96_200ul_tiprack` (reagent, slot 11) | stays as now (z −1.0 from 17:12/17:13Z); R04 and B14 completed reagent runs on it | all 0 |
| `custom_2ml_24_tube_rack` (reagent, slot 10) | unchanged | all 0 |

`gen4deck_gen7cartridge_004` is per-deck and out of scope; its double −3/0/+2 apply (19:25, 19:26Z) needs the operator to confirm or undo one.

## 4. Stories

| # | Story | Acceptance |
|---|---|---|
| S1 | Model `RobotLabwareOffset` + registration + saved queries ("Robot rack offsets") | unique index; `history` capped at 10 like `TipCalibratorFixture` |
| S2 | Protocols: 6 RTPs, rack `set_offset` fed from them; `offset_x/y/z` still carriage-only | simulate both `.py` with non-zero rack RTPs; analysis shows run-level offsets on slots 10/11 |
| S3 | `startPrepare`: `rackOffsetRtpValues(robotId, processType, paramSchema)` merged like `calibrationRtpValues`; values in `createArgs`, compared on resume/adopt; written to `OpentronsRunRecord.labwareOffsets` | run on robot shows `tiprack_offset_*` = the robot's row; a stale pre-cutover `.py` (no such RTP) gets nothing injected |
| S4 | Studio: load-labware and pick-up-tip routes resolve the robot's offset and add it to the maintenance run before load; kind=tip follows tip profile; rack "Apply offset"/"Set position" → `saveRackOffset` (+ `revertRackOffset`) instead of the shared write | Move-to-hole and Pick-up land on the same spot on B07 and R04 with different offsets |
| S5 | Migration script `scripts/migrate-rack-offsets.ts` (plan/apply) per §3, audit rows, Sync of both protocols to all three robots | each robot's next run start auto-resyncs (drybath wells changed) and injects its offsets |
| S6 | Docs: INVARIANTS entry, runbook "rack drift triage", Studio help text | — |

## 5. Rollback

Offsets default to 0 and the shared definitions keep today's geometry, so reverting is: set the robot's vector to 0 (Studio revert or script) and re-sync. The `.py` change is additive (RTP defaults 0 = today's behaviour).

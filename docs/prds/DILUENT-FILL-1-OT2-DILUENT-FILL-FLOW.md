# DILUENT-FILL-1 — Sample diluent fill on the OT-2 as a BIMS process

**Date:** 2026-11-13 · **Owner:** Alejandro · **Status:** Built (S1–S4, S6, S7) on `feat/diluent-fill-prd`,
2026-11-13 — first test run with Alejandro after B14's P1000 pipette-offset calibration and a position check.
S5 (stored labware offsets on manufacturing starts) and S8 (settings sub-tab) are deferred until after that run.
Protocol questions for Jacob (deck orientation, 40 vs 80 tubes per rack, tube brand, default pipette) stay open;
the build assumes the answers in Decisions below.
**Depends on:** OT2-BRIDGE-3 (cloud → robot protocol upload), OT2-TAILNET-5 (run lines), LABWARE-LIBRARY-AUTO-BUNDLE

## Problem

Sample-diluent tubes are aliquoted on an OT-2 with a protocol that lives only in the protocols repo and
the lab iMac's Opentrons App. Nothing about a fill reaches BIMS: not who ran it, not which buffer lot went
into the tubes, not how many tubes came out; the 2 mL tubes (PT-CT-107) and the source buffer are never
decremented. Three divergent copies of the protocol exist (production Oct 2025; a "Mixing Tracer" variant
for tracer, Dec 2025; a May 2026 copy that moved one rack to slot 4 and left a duplicate-slot bug), and
none of them matches the physical deck: the 2 mL rack is 237 mm long and spans two slots, so the
protocol's "three sources in three deck columns" scheme cannot be loaded. The per-tube volume is an
integer parameter (190 default) while the method calls for 104.5 µL.

## Decisions (Alejandro, 2026-11-13)

| # | Topic | Decision |
|---|---|---|
| 1 | What a run leaves behind | A **Diluent Lot** record (lot number, tubes per source, volume per tube, source reagent lots, robot, operator, run id) **plus inventory**: 2 mL tubes consumed FIFO from the oldest accepted PT-CT-107 receiving lot (same pattern as the reagent fill), and the source ReagentLot's `remainingVolume` decremented by what was dispensed. |
| 2 | Where the source diluent comes from | A **BIMS ReagentLot picked from a dropdown**, one per source position (A1 / A2 / A3). Finalized lots only. Gives lineage back to the buffer prep. |
| 3 | Protocol | **`protocols/Sample_Diluent_Fill_v2.py`** (this branch): Falcon 15 mL conicals in the Opentrons 15-tube rack (slot 10, A1–A3); **source N → heat-frame rack in slot 7 / 4 / 1**; 40 tubes per rack; pipette is a run-time choice (P1000 right, 8 tubes per aspirate · P300 left, 1 per aspirate); the loaded volume of each source is a run-time parameter and the run refuses to start if it is short; per-tube volume is a float, default **104.5 µL**. API level stays 2.19 so it analyzes on all three robots. |
| 4 | Pipette | **P1000 on B14** (already mounted on the right, tip-length calibrated for Opentrons 1000 µL tips). The P300 stays selectable for B07/R04 but leaves ~5 mL unreachable in a 15 mL tube. |
| 5 | Delivery | PRD first (this document), build after approval. |
| 6 | Calibration | Pipette-offset calibration is done in the **Opentrons App** (BIMS only displays it). Labware positions are checked in BIMS's clone **Labware Position Check** wizard after the protocol is imported; BIMS's manufacturing run-start must then **pass the robot's stored offsets** (new, see S5) — today it sends none. |

## Physical setup

```
      ┌───────────┬───────────┬───────────┐
back  │ 10 SOURCE │ 11 TIPS   │ 12 TRASH  │  10: opentrons_15_tuberack_falcon_15ml_conical, sources in A1 / A2 / A3
      │ 15 mL ×3  │           │           │  11: opentrons_96_tiprack_1000ul (P1000)  or  cosmas_and_damian_biotix_96_200ul_tiprack (P300)
      ├───────────┴─────┬─────┴───────────┤
      │ 7 ─ RACK 1  ← source A1, ≤40 tubes│ 9 (covered)   rack = 3dprinted_2ml_tuberack_heat_frame: the 80-hole
      ├─────────────────┬─────────────────┤               3D-printed rack in its frame; 40 positions defined
front │ 4 ─ RACK 2  ← source A2, ≤40 tubes│ 6 (covered)   (every other hole, A1..E8); 237 × 85 mm, spans two slots
      │ 1 ─ RACK 3  ← source A3, ≤40 tubes│ 3 (covered)
      └─────────────────┴─────────────────┘
```

Per source, the minimum volume to load is `tubes × 104.5 µL + carry-back + unreachable bottom`:
≈ **5.5 mL for 40 tubes with the P1000** (1.3 mL unreachable), ≈ 10.3 mL with the P300 (5 mL unreachable).
One 15 mL tube per rack; three tubes for a full deck of 120.

Two numbers in the protocol are **placeholders to be measured** before production use (marked in the .py):
the Falcon 15 mL volume→height geometry (cone 21.5 mm / 1.5 mL, body 169 µL/mm) and the maximum tip
descent below the rim (100 mm P1000, 72 mm P300). Validate on the first run by weighing ten tubes
(expect 104.5 ± 2 µL).

## Resulting flow

**Diluent Fill** tab under cart-mfg (next to Reagent Filling) → robot cards (same component as wax/reagent;
a robot busy with wax/reagent is unavailable, and vice versa) →

1. **Setup** — pipette (pre-selected from the robot's instruments: B14 → P1000), and one row per source
   position: reagent lot (dropdown of finalized ReagentLots, newest first, showing lot number + template +
   remaining volume), tubes (0–40), loaded volume (mL, read off the graduation). BIMS shows the computed
   minimum per row and refuses Start below it (the protocol would too).
2. **Load deck** — checklist, no barcodes: tip rack in 11 (type follows the pipette), 15-tube rack in 10 with
   the source tubes in A1–A3, a heat-frame rack with empty 2 mL tubes in the 40 defined positions in each
   used row (7 / 4 / 1). Confirm.
3. **Run** — `ProtocolStartPanel` with the run-time parameters pre-filled and read-only
   (`pipette, src_N_tubes, src_N_ml, diluent_vol, tubes_per_trip`), `EmbeddedRunController` for progress.
   Start goes through the existing `startRunQueue / startRunTwoPhase` machinery with a new kind.
4. **Done** — on the terminal run status BIMS counts the `dispense` commands into heat-frame labware per
   rack (so an aborted run records what was actually filled), creates the Diluent Lot
   (`DL-YYYYMMDD-NNN`), writes the inventory transactions, and shows the lot. Label printing is a follow-up
   (DILUENT-FILL-2; the Zebra surface in `print-barcodes/zebra` is the likely home).

## Data model

- **`DiluentFillRun`** (`diluent_fill_runs`) — the third `FillKind`. Same lifecycle fields the run-lifecycle
  machinery reads on `WaxFillingRun` / `ReagentBatchRecord` (`stage`, `operator`, `robotId/robotName`,
  `opentronsRunId`, `opentronsProtocolId`, `startIntent`, `runtimeParameters`, `status`, timestamps) plus
  `pipette`, `diluentVolumeUl`, `tubesPerTrip`, `sources[3] { well, reagentLotId, reagentLotNumber,
  templateName, tubesPlanned, loadedMl, tubesFilled }`, `diluentLotId`.
- **`DiluentLot`** (`diluent_lots`) — `lotNumber`, `runId`, `robotName`, `operator`, `volumeUl`,
  `sources[] { well, reagentLotId, reagentLotNumber, tubes }`, `tubesTotal`, `status: active | retired`,
  `labelsPrintedAt`, timestamps. Lot numbers follow the `FL-YYYYMMDD-NNN` rule in `fill-lot.ts`.
- Enums widened: `OpentronProtocol.processType` += `'diluent-filling'`; `OpentronsRunRecord.manufacturingRunType`
  += `'diluent-filling'`; `FillKind` += `'diluent'`; robot cards / robot services `activeProcess` += `'diluent'`
  and status `'running_diluent'`.
- Permissions: group **`diluentFilling`** (`:read`, `:write`) in `permissions-registry.ts`, added to the Operator
  legacy list beside `reagentFilling`.
- Settings: `manufacturing_settings.diluentFilling { defaultVolumeUl: 104.5, tubesPerRack: 40 }` (editable on
  a settings sub-tab like the other two flows).

## Protocol in BIMS

- Import `protocols/Sample_Diluent_Fill_v2.py` from the Robots tab; the upload route derives `processType`
  from the filename — add `diluent` → `'diluent-filling'` to that mapping. The heat-frame definition is a BIMS
  custom labware and auto-bundles; the Falcon rack and the Opentrons tip rack are robot built-ins.
- `computeRunParameters(kind='diluent')` builds `runTimeParameterValues` from the run record; the posted form
  is ignored for counts/volumes exactly as the reagent fix (240d62ad) does for `cartridges`.
- `finishConfirm(kind='diluent')` parses the run commands (`parseFilledWells` pattern) into per-rack tube
  counts, then creates the lot and the inventory transactions.

## Calibration and offsets

- **Pipette offset** (robot-global): Opentrons App → B14 → Instruments → Calibrate pipette offset on the P1000
  with the 1000 µL rack. B14's right-mount offset on file (2025-11-21) belongs to the P20 that preceded the
  P1000; the P1000 has none. BIMS shows this on the robot page but has no flow for it — not worth building for
  a once-per-pipette task.
- **Labware position** (per labware/slot): after import, run the clone LPC wizard
  (`/opentrons-clone/[robotId]/protocols/[protocolId]/lpc`) on B14 for the tip rack, the 15-tube rack and the
  three heat-frame racks. Offsets land in the robot's `/labwareOffsets` store.
- **Gap to close (S5):** `runCreate` in `ot2-protocol.ts` posts only `protocolId` + `runTimeParameterValues`,
  so runs started from manufacturing pages ignore stored offsets (wax/reagent compensate by editing the labware
  definitions in the Deck Calibration Studio instead). Add a generic step: before create, look up stored offsets
  for the protocol's labware (`POST /labwareOffsets/searches`, fallback `GET /labwareOffsets`), include them in
  `RunCreate.labwareOffsets`, and record them on `OpentronsRunRecord.labwareOffsets` (field already exists).
  Alternative for the heat-frame rack only: whitelist it in the Studio's `TUBE_RACKS` so its definition can be
  jog-corrected like the other racks.

## Stories

| # | Story | Acceptance |
|---|---|---|
| S1 | Protocol + processType | `Sample_Diluent_Fill_v2.py` imports from the Robots tab, analyzes OK on B14, shows up tagged `diluent-filling` with its parameter schema. Unit test: filename → processType. |
| S2 | Models + permissions | `DiluentFillRun`, `DiluentLot`, enum widenings, `diluentFilling:*` permissions; `npm run check` stays at baseline. |
| S3 | Diluent Fill tab, Setup + Load deck | Robot cards shared with wax/reagent; per-source rows with lot dropdown, tube count, loaded mL; computed minimum shown; Start disabled below it. |
| S4 | Run via run-lifecycle | `FillKind 'diluent'` through `startPrepare/startConfirm/finishConfirm/stop*`; RTPs come from the record; tests mirror the reagent `cartridges` tests. |
| S5 | Stored labware offsets on manufacturing starts | `runCreate` includes the robot's stored offsets for the protocol's labware; recorded on the run record; no-op when the store is empty. Unit test with a fake transport. |
| S6 | Done: lot + inventory | Terminal status → per-rack tube counts from commands → `DiluentLot` + PT-CT-107 FIFO consumption (`lotRemaining/fifoLot`) + `ReagentLot.remainingVolume` decrement, all idempotent on re-entry. |
| S7 | Robot availability | A diluent run blocks wax/reagent on that robot and vice versa (`robot-cards.ts`, both `services/*/robots.ts`). |
| S8 | Settings sub-tab | `defaultVolumeUl`, `tubesPerRack` editable; Setup reads them. |

## Open questions (for Jacob)

1. Deck orientation: is "source 1 rack in the back row (slot 7)" right, or did the May 2026 slot-4 edit mean the
   first rack belongs in the middle row?
2. 40 tubes per rack (heat frame, every other hole) or 80 (bare rack definition, which is not in BIMS)?
3. Falcon vs NEST 15 mL tubes (0.3 mm depth / 0.6 mm diameter difference; LPC absorbs it).
4. P1000 at 104.5 µL is at its 100 µL floor (spec ±2 % / CV 1 %) vs the P300's ~±1.5 % / 0.5 % — acceptable
   for the diluent volume? Decide after the weigh-in on the first run.
5. Should a Diluent Lot be tied to a Fill Lot / assay, or stand alone?
6. Labels: print at Done (Zebra) or later from the lot page?

## Risks

- Analysis does not check labware footprints: a wrong slot choice is only caught by eye. Mitigation: the
  deck map on the Load-deck step and the fixed slot mapping in the protocol.
- A short source tube pipettes air silently on the OT-2 (no liquid sensing). Mitigation: loaded-volume
  parameter + pre-flight refusal in the protocol and in BIMS.
- Offsets: until S5 lands, a BIMS-started run ignores the LPC. Do S5 before the first production run.
- Placeholders: Falcon geometry and tip descent must be measured; a 20-minute job with a graduated tube.

# WAX-FLOW-3 — Wax-filling flow simplification

**Date:** 2026-06-11 · **Owner:** Jacob · **Status:** Approved (conversation 2026-06-11)
**Depends on:** WAX-FLOW-2 (backing-lot scan removal)
> **Amended 2026-08-17 by WAX-SIMPLIFY-1..3:** the run now ends at `wax_filled` (the fridge scan
> at deck removal records location only — no `wax_stored` status); the QC/storage status steps
> are gone (visual pass implicit; rejects via the Wax Reject page).

## Decisions (Jacob, 2026-06-11)

| # | Current step | Decision |
|---|---|---|
| 1 | SetupConfirmation screen (`SetupConfirmation.svelte`) | **Delete.** "Meaningless — people aren't checking that stuff." |
| 2 | Scan 15 ml wax source tube barcode (`WaxPreparation.svelte:223-312`, `/api/wax-batch/validate`) | **Replace with dropdown** of active WaxBatches (few lots ever exist). Show lot number + remaining volume; validate remaining ≥ computed fill volume. |
| 3 | Scan 2 ml tube lot barcode (`WaxPreparation.svelte:351-456`) | **Delete.** Tube consumption auto-recorded FIFO from the oldest accepted 2 ml-tube ReceivingLot (no scan, no lineage prompt). |
| 4 | "Fill tube with 800 µL" (`FILL_VOLUME_UL=800`, 3 files) | **Compute from cartridge count:** `volumeUl = settings.waxFilling.waxPerCartridgeUl × plannedCartridgeCount + settings.waxFilling.waxFillDeadVolumeUl` (new setting, editable on wax-filling settings page; default chosen so 24 carts ≈ current 800). WaxBatch + ReceivingLot decrements use the computed value, not flat 800. |
| 5 | "Is 2 ml of wax placed in A3?" popup (`WaxPreparation.svelte:502-538`) | **Delete.** |
| 6 | Scan backing lot barcode (`scanBackingLot`) | **Delete** — superseded by WAX-FLOW-2 per-cartridge origination. |
| 7 | Run execution countdown timer (`RunExecution.svelte:65-80`, manual `runDurationMin` countdown) | **Implicit from the protocol run.** Remove the countdown; run progress/completion comes from `EmbeddedRunController` polling the OT-2 (`recordRunFinished` already fires on terminal status). Keep the physical "Confirm — Deck Removed" gate (starts cooling clock). |
| 8 | Scan cooling tray barcode (`PostRunCooling.svelte:117-188`) + oven scan | **Delete.** Single "Cartridges placed in cooler" confirm; `confirmCooling` stamps time with no tray/location scan (coolingLocation fields become optional). |

## Resulting flow

Pick robot (WAX-FLOW-1) → **Prep**: select wax lot from dropdown + planned cartridge count +
"fill tube with {computed} µL" confirm → **Load deck**: robot-scanner sweep / per-slot scans of
backed cartridges (validation per WAX-FLOW-2) → **Run**: start protocol, OT-2-driven status →
deck removed confirm → **Cooling**: placed-in-cooler confirm → **QC** → **Storage** (unchanged).

## Implementation notes

- `WaxPreparation.svelte` collapses from 5 substeps to 3 (lot dropdown, count, fill-volume
  confirm). Wax lot list loaded server-side (`WaxBatch.find({ remainingVolumeUl: { $gt: 0 } })`).
- `recordWaxPrep` action: accept `waxBatchId` from dropdown (no barcode validation round-trip),
  drop tube-lot + A3 fields; compute + persist `fillVolumeUl` on the run for the later
  decrement.
- Consumption block (`+page.server.ts:2043-2121`): replace `WAX_FILL_VOLUME_UL` with the run's
  persisted `fillVolumeUl`; same for `opentron-control/wax/[runId]/+page.server.ts:24`.
- 2 ml tube FIFO consumption: at `recordWaxPrep`, find oldest accepted ReceivingLot for the
  2 ml-tube part with quantity > 0, decrement 1, InventoryTransaction as today's pattern.
- `RunExecution.svelte`: drop timer UI; show OT-2 run state from EmbeddedRunController.
  `settings.runDurationMin`/`removeDeckWarningMin` remain for the cooling/lockout logic only.
- `PostRunCooling.svelte`: steps collapse to confirm-cooling; `confirmCooling` action
  (`+page.server.ts:1175-1249`) drops tray resolution.
- New setting `waxFillDeadVolumeUl` added to ManufacturingSettings.waxFilling + settings page.

## Acceptance

- A full wax run completes with: zero barcode scans except cartridges themselves (robot
  scanner or handheld per-slot), one dropdown, one count, three confirms (fill volume, deck
  removed, in cooler).
- Computed volume changes with cartridge count and decrements WaxBatch/ReceivingLot by the
  same number. Settings page exposes the dead-volume knob.
- `npm run check` clean of new errors.

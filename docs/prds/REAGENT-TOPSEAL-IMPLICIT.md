# PRD: Top sealing becomes implicit — retire the post-OT-2 reagent queue

**Status:** implemented on `feat/cartridge-status-flow` (2026-08-19). Supersedes the
`sealed` hop in `REAGENT-INSPECT-AFTER-TOPSEAL.md` and changes the target state in
`QUICK-SEAL-WAXQC-TO-SEALED.md`.

## Intent (from Jacob, 2026-08-19)
Top sealing stops being its own BIMS step. When a reagent run completes, its
cartridges are `reagent_filled` — top sealing happens physically but is implicit;
the next BIMS touch is the Reagent Inspect photo. All top-seal UI goes away. The
only reason it was a separate step was to deduct top-seal inventory; that now
happens at run completion (slight over-count on split sheets is acceptable —
cut sheets are cheap).

## Decisions (locked 2026-08-19)
- **Photo → `reagent_qc`.** The Reagent Inspect photo takes `reagent_filled →
  reagent_qc` (not → `sealed`). `sealed` is retired as a live state: it is kept in
  the enum so historical rows validate, `/api/cv/capture` still accepts it for
  stragglers, and the migration moves live `sealed` carts to `reagent_filled`.
- **The whole post-OT-2 reagent queue goes, Storage included.** A reagent run
  ends at Running: `completeRunFilling` sets the run `Completed` (+ `finalizedAt`,
  `runEndTime`, `robotReleasedAt`). The Opentron Control reagent page
  (`opentron-control/reagent/[runId]`) and the "Reagent Cartridges Requiring Top
  Sealing & Storage" row on the Reagent Filling layout are deleted. Fridge storage
  is recorded on `/cartridge-admin/storage` as before (it already existed there).
- **PT-CT-113 (top-seal cut sheet) is deducted at `completeRunFilling`**:
  `ceil(cartridges / topSealCutting.cartridgesPerSheet)` (default 12), step
  `top_seal`, no lot linkage (the sheet lot is no longer scanned).
- **Cut Top Seal material cutting is untouched** (`top-seal-cutting`, WI-03,
  PT-CT-103 rolls, `top_seal_roll` consumables). That is the upstream cutting
  step, not the per-cartridge sealing step.

## Lifecycle (new)
```
… wax_filled | wax_ready
   → reagent_filling → reagent_filled          (completeRunFilling; run → Completed)
   → (top seal — physical, implicit, no BIMS write)
   → [Reagent Inspect] photo → reagent_qc       (/api/cv/capture)
   → (scan-gated verdict) → reagent_ready | reagent_rejected
   → stored                                    (/cartridge-admin/storage)
```
Reagent run status: `Setup → Loading → Running → Completed` (or Cancelled/Aborted).
`Inspection`, `Top Sealing`, `Storage` remain in the enum for history only.

## Changes
### Deleted
- `src/routes/manufacturing/cart-mfg/opentron-control/reagent/[runId]/` (page + server)
- `src/lib/components/manufacturing/reagent-filling/{TopSealing,Inspection,CompletionStorage}.svelte`
- reagent-filling server actions (only the deleted page called them):
  `completeInspectionBatch`, `completeInspection`, `createTopSealBatch`,
  `scanCartridgeForSeal`, `completeSealBatch`, `rejectAtSeal`, `transitionToStorage`,
  `recordBatchStorage`, `completeRun`, and the `resolveRunId` post-OT-2 helper.
- Reagent layout: the post-OT-2 queue section, its types, `sealUrgencyColor`,
  `formatFinished`, 'Top Sealing'/'Storage' badge cases; `loadRobotCardsAndQueues`
  is no longer called from the reagent layout.
- `robot-cards.ts`: `reagentQueue` + seal-deadline math (wax queue unchanged).
- `cartridge-admin/filled`: dead 'Top Sealed' filter chip.

### Changed
- `reagent-filling/+page.server.ts` `completeRunFilling`: run → `Completed`
  (idempotent), carts → `reagent_filled` (unchanged), + PT-CT-113 deduction, + deck
  usageLog (moved from old `completeRun`). `toStage` / `validStages` /
  `forceAdvanceStage` only know Setup/Loading/Running. `createRun` and
  `resetToLoading` no longer touch `sealBatches`.
- `reagent-filling/+page.svelte`: button copy "Complete run"; prose.
- `/api/cv/capture`: `reagent_filled | sealed → reagent_qc` (was `sealed` only).
- `/api/cv/reagent-verdict`: hint text. `/cv/induct`: reagent READY_FOR = `reagent_filled`.
- `reagent-inspect`: `ALLOWED_STATUSES = ['reagent_filled','reagent_qc','sealed','linked']`.
- `quick-seal`: target `reagent_filled` (was `sealed`); no `topSeal` stub written.
- `run-statuses.ts` `REAGENT_NON_TERMINAL`: drops Top Sealing / Storage. The
  model's index `partialFilterExpression` keeps them (inert) to avoid an
  index-options conflict with the existing Atlas `tray_active_unique` index.
- Dashboards (`cart-mfg`, `cart-mfg-dev`, `api/manufacturing/dashboard`): the
  "Available — Reagent queued" branch is gone. `force-reset`, `qa-qc`, `opentrons`
  page: 'Top Sealing' removed from their status lists.
- Models: comments only (`CartridgeRecord.topSeal` marked deprecated; enums kept).

### Migration
`scripts/migrate-retire-top-sealing.ts` (dry-run default, `--apply` to write):
1. reagent runs in Inspection/Top Sealing/Storage → `Completed`
2. carts at `sealed` → `reagent_filled` (`priorStatus: 'sealed'`)
3. audit rows, action `migrate_retire_top_sealing`
Run it after this branch is deployed to production.

## Out of scope / follow-ups
- Removing `sealed` / 'Top Sealing' from the enums and `ReagentBatchRecord.sealBatches`
  / `CartridgeRecord.topSeal` schema fields — history reads (DHR, traceability,
  `cartridge-timings` "seal time") still use them.
- `ManufacturingSettings.reagentFilling.maxTimeBeforeSealMin` stays (DHR timing
  threshold) even though nothing enforces a seal deadline any more.
- Legacy "Top Seal Batches" panel on `opentrons/history` — historical display, left.
- `ask-bims-tier1` flow prose updated; `ask-bims.ts` status enum string untouched.

## Validation
- `npm run check`: 11 errors / 434 warnings — exact baseline, zero in touched files.
- Manual: finish a reagent run → Complete → run is `Completed`, carts `reagent_filled`,
  one PT-CT-113 consumption row (qty = ceil(n/12)), robot Available, no queue row on
  the Reagent Filling layout. Scan a `reagent_filled` cart on Reagent Inspect →
  photo → `reagent_qc` → verdict works. Quick Seal moves wax carts to `reagent_filled`.

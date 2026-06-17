# PRD: Reagent-fill inspection moves after Cut Top Seal (+ reagent Run-again)

## Intent (from Jacob)
Reagent post-run inspection does NOT belong on the reagent-filling run page.
Remove it. Add a dedicated **Reagent Inspect** step that runs AFTER **Cut Top
Seal**, mirroring **Wax Inspect** exactly (photo → physical QR scan → verdict).
Once inspection is off the run page, the Running stage becomes the last step of
reagent fill, so add a **Run again** button there just like wax filling.

## Decisions (locked)
- Status flow mirrors wax exactly. New cartridge statuses: `reagent_qc`,
  `reagent_ready`, `reagent_rejected` (parallel to `wax_qc`/`wax_ready`/`wax_rejected`).
- A cartridge becomes `sealed` after Cut Top Seal; taking a photo on the new
  Reagent Inspect page → `reagent_qc`; a scan-gated human verdict → `reagent_ready`
  or `reagent_rejected`.
- `reagent_rejected` is a terminal state FOR NOW — no scrap gate, no special
  meaning yet. No downstream (curing/storage) gating in this work. Reaching
  `reagent_ready` / `reagent_rejected` is the finish line.
- Verdict requires a physical QR scan (same as wax).

## Lifecycle (new)
```
… reagent_filling → reagent_filled
   → [Cut Top Seal] → sealed
   → [Reagent Inspect] (photo) → reagent_qc
   → (scan-gated verdict) → reagent_ready | reagent_rejected
```
The old `reagent_filled → inspected` hop (driven by the reagent run page) is
removed. `inspected` stays in the enum (don't break historical data) but the
reagent run page no longer sets it. Cut Top Seal now accepts `reagent_filled`
as its input (was `inspected`).

## Changes

### 1. Remove inspection from reagent-filling run page
- `reagent-filling/+page.svelte`: delete the `displayStage === 'Inspection'`
  branches (Inspection component + tray-scan sub-step) and the buffered
  `pendingRejected`/tray flow. Running is now the terminal reagent-fill stage.
- `reagent-filling/+page.server.ts`: `completeRunFilling` no longer advances to
  `Inspection`; the run finishes at Running (robot released at run-finish).
  Drop the `inspected` cartridge-status write. Remove/retire the inspection
  actions (`abortRun` recovery aside) that set `inspected`.
- Timeline: drop the `Inspect` bubble — `Reagent Fill Setup → Barcode Scanning
  → Reagent Prep → Run`.

### 2. Reagent Run-again (mirror wax)
- `reagent-filling/RunExecution.svelte` is timer-based; add the OT-2-completion
  gate via the page's `runFinished` (EmbeddedRunController.onComplete +
  `data.runState.opentronsRunFinalStatus`). Add a **Run again** button shown when
  finished: release the run, create a new run reusing the same assay + params,
  jump to barcode scanning (same pattern as wax `handleRunAgain`).
- Reuse-params: keep the captured ProtocolStartPanel FormData in a
  `runAgainParamsFd` the per-run reset doesn't clear; reapply on the new run.

### 3. New status values
- `cartridge-record.ts` enum: add `reagent_qc`, `reagent_ready`,
  `reagent_rejected` after `reagent_filled` (keep `inspected` for legacy).
- `reagent-batch-record.ts`: add `opentronsRunFinalStatus` (done) for Run-again
  gating parity.

### 4. New Reagent Inspect page  `/manufacturing/cart-mfg/reagent-inspect`
- Mirror `wax-inspect/+page.svelte`: capture station / photo, then a scan-gated
  verdict. ALLOWED_STATUSES = `['sealed','reagent_qc']`; after capture, if the
  cartridge is `sealed` set `reagent_qc`; show ✓ Reagent Ready / ✗ Reject when
  `reagent_qc`.
- New API `/api/cv/reagent-verdict/+server.ts` mirroring `/api/cv/wax-verdict`:
  POST `{cartridgeId, verdict:'ready'|'rejected', reason?, source}`; requires
  `status === 'reagent_qc'`; sets `reagent_ready`/`reagent_rejected`; mirror to a
  `reagentQc` DHR subdoc (Accepted/Rejected); rejected requires a reason.
- `/api/cv/capture/+server.ts`: when the captured cartridge is `sealed`, advance
  to `reagent_qc` (add alongside the existing wax_stored→wax_qc branch). Add a
  phase/projection for the reagent inspect context.

### 5. Cut Top Seal input
- `top-seal-cutting/+page.server.ts`: accept `reagent_filled` (was `inspected`)
  as the consumable input status that it advances to `sealed`.

### 6. Surfaces (status order + colors), mirror FU2
- Add `reagent_qc` (amber), `reagent_ready` (green), `reagent_rejected` (red) to:
  cartridge-admin STAGES/stageColors, routes/+page phaseColors + phaseOrder,
  cartridge-dashboard phaseOrder, cartridge-admin/statistics phases/phaseOrder,
  services/cartridge-admin/queries LifecycleStage union + LIFECYCLE_STAGES.
- Sidebar nav: add **Reagent Inspect** after **Cut Top Seal**.

## Out of scope (later)
- Curing/storage and what consumes `reagent_ready`.
- CV auto-verdict (endpoint already takes `source:'cv'`).
- `reagent_rejected` scrap disposition.

## Acceptance
- Reagent run page: no inspection stage; Running shows Run-again after the .py
  finishes; clean re-scan auto-starts with reused params.
- After Cut Top Seal (`sealed`), Reagent Inspect: photo → `reagent_qc`; scan
  verdict → `reagent_ready`/`reagent_rejected`.
- `npm run check` no new errors over the 11 baseline; build green.

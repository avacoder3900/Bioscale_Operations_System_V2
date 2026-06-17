# VALIDATION-04: Optical Confirmation — Cartridge/Group Capture (as built) + Master Integration

> Supersedes the capture/criteria portions of [VALIDATION-03](./VALIDATION-03-optical-confirmation-assay.md).
> VALIDATION-03's per-SPU attach/run/criteria design is **deferred** (see Deferred Scope). This PRD
> documents what is actually built and deployed today, and the decision required to merge it to master.

## Overview
Operators register batches of **optical-test cartridges** — each stamped with an **assay ID** and
assigned to a reusable **validation group** — from a single page. The cartridges are a shared pool
any SPU can later draw from. After every write the app **re-reads the documents from MongoDB** and
shows them, so the operator has proof the records changed on the BIMS side.

This started from the brevitest-research cartridge→experiment/arm assignment model
([[reference-brevitest-research-build]]) and has since been simplified per operator feedback.

## Current State (built + deployed on `deploy/optical-confirmation`, Vercel preview)
**One page** at `/spu/validation/optical-confirmation` (nav: Manufacturing → Optical Confirmation):
- **Assay ID** — a free-text field; written directly onto each cartridge (`assay._id`). No dropdown,
  no catalog lookup, no preset-in-settings step.
- **Validation group** — a search bar that finds an existing `CartridgeGroup` or creates a new one
  by name.
- **Barcodes** — a textarea; paste/scan a batch (one per line or comma-separated).
- **Register** → batch-creates the cartridges, then the **"✓ Verified in MongoDB"** panel lists each
  barcode with the *actual stored* assay ID / group / status, read back out of the DB after write.
- A table of existing optical-test cartridges.

**Backend (server, additive):**
- `LabCartridge`: `cartridgeType` enum gains `optical_test`; an `assay {_id,name,skuCode}` subdoc.
- `CartridgeGroup`: reused as the validation group (no new model).
- Endpoints under `/api/validation/optical-confirmation/`: `cartridges` (GET barcode-status + POST
  batch-register with read-back verify), `groups` (search/create). Also present but **unused/dormant**:
  `attach`, `detach`, `result`, `criteria`, `criteria/lock` (kept for the deferred per-SPU flow).
- Each mutation writes an `AuditLog` row (real schema: `tableName/recordId/action/oldData/newData/
  changedBy/changedAt/reason`).

## Data Model (cartridge document gains only two things)
```
LabCartridge {
  _id, barcode,
  cartridgeType: 'optical_test',        // NEW enum value
  status: 'available' | 'in_use' | 'depleted' | 'quarantine' | ...,
  assay: { _id: <assayId>, skuCode: <assayId> },   // NEW — written directly from the capture window
  groupId: <CartridgeGroup._id>,        // the validation group
  usageLog: [{ action, spuId?, validationSessionId?, performedBy, performedAt }],
  createdBy, createdAt
}
CartridgeGroup { _id, name, description?, color?, createdBy }   // the "validation group"
```
No SPU restriction: a cartridge is `available` until consumed; any SPU can use any cartridge from any
group.

## ⚠ Master Integration — the decision this PRD must settle
The feature branched off master at `7e2a237`. Master has since advanced ~12 commits, including:

**`4b575d36` — "refactor(cartridges): remove dead LabCartridge/CartridgeGroup/FirmwareCartridge".**

That commit **deleted the two models this feature is built on** (`LabCartridge`, `CartridgeGroup`) and
removed their exports from `models/index.js`. Consequences for a merge to master:
- A straight merge resurrects `lab-cartridge.ts` / `cartridge-group.ts` as modify/delete conflicts but
  master's `models/index.ts` no longer exports them → every `import { LabCartridge } from
  '$lib/server/db'` fails → **broken production build**.
- Content conflicts in `src/routes/+layout.svelte` (nav restructured on master) and
  `src/routes/spu/[spuId]/+page.svelte`.
- Master is now on **Mongoose 9** (was 8); re-introduced models must be Mongoose-9-clean.

This is an architecture mismatch, not a mechanical conflict: master's team treated these models as
**dead** while this feature depends on them. Options:

| Option | What it means | Trade-off |
|---|---|---|
| **A. New dedicated models** (recommended) | Create `OpticalTestCartridge` + `ValidationGroup` purpose-built models; re-target the 2 endpoints + page onto them. | Cleanest; doesn't resurrect cut code or touch the product `CartridgeRecord`. ~1–2 files of rework. |
| **B. Reintroduce LabCartridge + CartridgeGroup** | Bring both models + exports back as part of this feature. | Least rework, but reverses `4b575d36` — coordinate with whoever removed them, or a future cleanup re-deletes them. |
| **C. Build on `CartridgeRecord`** | Use master's surviving cartridge model + a new group concept. | Aligns with master's consolidation, but mixes optical-test units into the product/shipping pipeline (deliberately avoided). |

**Recommendation: Option A.** It survives master's cleanup intent, keeps optical-test cartridges out
of the product model, and is a contained re-target (rename imports `LabCartridge`→`OpticalTestCartridge`,
`CartridgeGroup`→`ValidationGroup`; add two small models + exports). Merge sequence then:
1. Re-target the feature onto the new models on `deploy/optical-confirmation`.
2. Merge `origin/master` in; resolve the `+layout.svelte` nav + `spu/[spuId]` conflicts (keep both sides).
3. Get a **green Vercel preview build** (proves it compiles on master).
4. Fast-forward `master` → production deploy.

## Deferred Scope (not built / dormant)
- **Pass/fail criteria** (parameter ranges + admin lock) — endpoints exist but the UI was removed; the
  optical readout shape + thresholds are TBD.
- **Per-SPU validation run** — select-SPU / attach / detach / submit-reading / result + the SPU-detail
  status card. `ValidationSession`, `Spu.validation.opticalConfirmation`, and the attach/detach/result
  endpoints are in place for when this is picked back up.

## Open Questions
1. **Model strategy** — confirm Option A (new dedicated models) vs B/C above. *Blocks the merge.*
2. **Assay ID semantics** — is the entered value an `AssayDefinition._id`, a SKU, or a free label?
   (Currently stored verbatim as `assay._id`/`skuCode`; no validation against the assay catalog.)
3. **Production target** — merging to master deploys to the **Production** Vercel env, whose Mongo is
   the shared/prod DB. Confirm that's intended for testing, or stand up a separate preview DB first.
4. **Team coordination** — `4b575d36` was a deliberate cleanup; loop in its author before re-landing
   anything cartridge-model-shaped.

## Deployment Status
- Branch `deploy/optical-confirmation` @ `7e783af5` — full feature, pushed; Vercel **preview** green at
  `bioscale-operations-system-mongodb-git-deploy-5c30f3-brevitest.vercel.app`.
- **Not** merged to master (blocked on the Option A/B/C decision above).
- Main working tree + thermocouple WIP untouched; all work isolated in the `oca-feature` worktree.

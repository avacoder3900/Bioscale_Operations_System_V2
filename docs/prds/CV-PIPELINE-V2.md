# CV-PIPELINE-V2 — Phase-Scoped Capture, Unified Labeling, Versioned Train → Verify → Deploy

**Status:** Draft for review
**Branch:** `feat/cv-pipeline-v2` (off `master` @ `d7bb44eca`)
**Date:** 2026-07-07
**Owner:** Alejandro

---

## 1. Summary

Redesign the CV pipeline into five explicit stages with hard boundaries:

1. **Capture** — phase-scoped: the station's manufacturing step (wax / reagent / post-mortem) decides which deployed model grades the photo.
2. **Label** — approve/reject can be entered at capture time OR later in the image-stream / labeling UI; both write the same field.
3. **Train** — the core of the system. Assembles its training set by parsing labels and checking cartridge status/tags/phase, then produces a **new immutable model version**. This is where pass/fail "magic" is created.
4. **Verify → Deploy** — a trained version must pass a holdout check on a minimum sample size before an explicit **Deploy** button promotes it to stations at a given step. Versions iterate and improve; **new training never erases a previous model**, and every version records exactly which photos it used.
5. **Review** — deployed-model verdicts are human-reviewed in the stream section; reviews become labels for the next training iteration.

This PRD also carries the bug-fix work that currently blocks the pipeline end-to-end on
`master` (verified against the production database on 2026-07-06): Mongoose strict-mode
silently drops most CV writes because the schemas never declared the fields the code uses.

---

## 2. Current state on `master` (verified)

The pixels live once in R2. Metadata lives in `cv_projects`, `cv_images`, `cv_inspections`,
plus a thin `photos[]` pointer list on `cartridge_records`. All schemas default to
`strict: true`, and the CV schemas are missing most of the fields the CV code writes —
strict mode **silently strips** undeclared fields from `create`/`$set`, so the calls report
success and persist nothing. Reads (`.lean()`) bypass the schema, so legacy data from
May/June still renders, masking the breakage.

| # | Write site | Field(s) | Result on master |
|---|-----------|----------|------------------|
| 1 | `updateDeployment` action / `PATCH /api/cv/projects/[id]` | `deployAtPhases`, `activeModelVersion`, `shadowModelVersion` | Entire deployment save dropped → "No model is deployed at the post_mortem phase" |
| 2 | `cv-bridge.ts` `triggerTraining` result | `classifier`, `trainingError` on `cv_projects` | Trained weights never persist; project says "trained" with no model inside |
| 3 | `triggerTraining` embedding cache | `embedding`, `embeddingVersion` on `cv_images` | Cache dropped; every image re-embedded every train |
| 4 | `triggerTraining` label query | reads `label`; labeling UIs write `qcLabel` | Trainer sees 0 labeled images → "Need at least 5 labeled images" |
| 5 | `run-inference.ts` `runOne` | `status: 'running'`/`'completed'` vs schema enum `pending\|processing\|complete\|failed`; `isShadow`, `triggeredBy/At`, `confidenceThreshold`, `anomalyScore`, `errorMessage` undeclared | Inspection create fails validation; even if fixed, run metadata would be dropped |
| 6 | nothing appends `trainedModels[]` | — | Activation dropdown always empty; phase query `activeModelVersion: {$ne: null}` can never match |

A partial fix exists on the `main` branch lineage (`18b5b953f` / `7fc21a92c`, 2026-06-15/16)
— it declares `classifier`, `deployAtPhases`, etc. and fixes the label query — but it never
merged to `master`, and it does not include the versioned `trainedModels[]` model that this
PRD specifies. This PRD supersedes it.

---

## 3. Target design

### Stage 1 — Capture (phase-scoped model check)

**Endpoint:** `POST /api/cv/capture` (`src/routes/api/cv/capture/+server.ts`)

- Capture keeps its current contract (file + cartridgeId + phase; orphan photos rejected;
  atomic `photoSequence`; upload to R2; `CvImage` created; `photos[]` ref pushed).
- **New:** the phase on the incoming photo is the routing key. After the image is saved,
  capture resolves *which deployed model owns this step*:
  `CvProject.find({ deployAtPhases: phase, activeModelVersion: { $ne: null } })`
  — post-mortem photos get graded by the post-mortem model, wax by wax, etc.
  (This is `runPhaseInference`'s existing design — it starts working once the schema fix
  lands and deployments actually persist.)
- The capture response and the inspect pages state explicitly which project/version graded
  the photo, or that no model is deployed at this step (existing yellow banner).
- Station sanity check: when the request comes from a capture station with an
  `assignedPhase`, warn (do not block) if the posted phase disagrees with the station's
  assignment — catches "wrong station selected" operator errors.

### Stage 2 — Label (two entry points, one field)

- **Single source of truth:** `cv_images.qcLabel: 'approved' | 'rejected' | null`
  (+ `qcLabeledBy`, `qcLabeledAt`). The trainer reads **only** this field. The legacy
  `label` field is retired (see migration).
- **Entry point A — at capture:** the capture endpoint accepts an optional
  `verdict: 'approved' | 'rejected'` form field so the operator can label the photo the
  moment they take it (the capture UIs already support failure-label tagging at capture;
  this adds the pass/fail verdict alongside).
- **Entry point B — after the fact:** `/cv/label` and the image-stream review UI keep
  working as today; they already write `qcLabel`.
- Both paths are equivalent; last write wins and is attributed (`qcLabeledBy/At`).

### Stage 3 — Train (the core)

**Service:** `cv-bridge.ts` `triggerTraining` (in-process: sharp embeddings + logistic
regression; embedding = `cv-color-spatial-v1`, 156 features; no worker, no GPU).

**Training-set assembly** replaces the naive `{label: {$ne: null}}` query. The project doc
gains a declared `trainingFilter` and assembly resolves, at train time:

1. All `cv_images` with `qcLabel != null` whose `cartridgeTag.phase` is in the project's
   phases (master-model projects skip the phase filter).
2. Joined against `cartridge_records` to apply `trainingFilter.cartridgeStatuses[]`
   (e.g. exclude voided/scrapped carts) and `trainingFilter.requiredTags[]` /
   `excludeTags[]` (failure labels on `cartridgeTag.labels`).
3. Guardrails: ≥ 5 images minimum, both classes present (existing rules), plus the
   holdout reserve (Stage 4).

**Versioned output — the central change.** Training no longer overwrites project-level
state. Each run **appends** an immutable entry to `trainedModels[]`:

```
trainedModels[]: {
  version:        'v<seq>-lr-cv-color-spatial-v1-<timestamp>',
  status:         'trained',            // -> 'verified' -> 'deployed' -> 'retired'
  classifier:     { weights[156], bias, standardization, calibration,
                    embeddingVersion, embeddingDim },   // weights live INSIDE the version
  confidenceThreshold: number,          // calibrated at train time
  trainedAt, trainedBy,
  trainingSet: {
    imageIds:          string[],        // EXACTLY which photos trained this version
    count, approvedCount, rejectedCount,
    newSincePrevious:  number,          // photos added vs the previous version
    filter:            { phases, cartridgeStatuses, requiredTags, excludeTags }
  },
  verification: null                    // filled by Stage 4
}
```

Consequences this buys us (the explicit requirements):

- **Version control:** every model that ever existed stays in the array with its weights.
  Rollback = point `activeModelVersion` back at an older entry. Nothing is ever erased.
- **"What photos were used, so we don't repeat":** `trainingSet.imageIds` is the exact,
  auditable manifest per version; `newSincePrevious` shows what each iteration added.
  The train UI shows "N labeled images available, M new since &lt;current version&gt;" before
  you press Train — retraining with zero new images gets a warning.
- **"More photos improve the model but don't erase it":** training is cumulative — each
  new version trains on *all* eligible labeled images at that moment — while every prior
  version remains intact and re-deployable.

Project-level `modelStatus` / `modelVersion` remain as a convenience mirror of the latest
entry, nothing more.

### Stage 4 — Verify → Deploy (the gate)

**Verify (automatic at train time + on-demand):**

- Assembly holds out a stratified sample (default 20%, minimum 5 per class) that the fit
  never sees. After fitting, the candidate is scored on the holdout and the result is
  written into the version entry:

```
verification: {
  holdoutImageIds: string[], holdoutCount,
  accuracy, balancedAccuracy, passRecall, failRecall,
  gate:    { minHoldoutCount, minBalancedAccuracy },   // per-project, defaulted
  passed:  boolean,
  verifiedAt, verifiedBy
}
```

- **Gate:** only a version whose holdout meets the sample-size and accuracy minimums
  flips to `status: 'verified'`. Defaults: `minHoldoutCount: 10`,
  `minBalancedAccuracy: 0.80` (per-project overrides declared on the project doc).
  A "quick check" panel on the project page also lets you re-verify any version against
  the current labeled pool on demand.

**Deploy (explicit button):**

- The Deployment tab's **Deploy** button is enabled only for `verified` versions.
  Deploying sets `activeModelVersion` to that version and `deployAtPhases` to the chosen
  station steps (`wax_filled` / `reagent_filled` / `post_mortem` / ...), flips the version
  to `status: 'deployed'`, and retires (status only — weights kept) the previously
  deployed version.
- `shadowModelVersion` stays: any other version can run silently alongside the deployed
  one for A/B comparison before promoting it.
- Every deploy is audit-logged (who, when, version, phases).

### Stage 5 — Review (close the loop)

- Deployed-model verdicts land in `cv_inspections` as today (one doc per
  image x project x version run — the verdict *log*).
- The stream/review section shows each verdict with its model version; a human review
  writes `humanLabel` + `reviewedBy/At` on the inspection and mirrors the effective
  verdict onto the image's `qcLabel`, which feeds Stage 3's next iteration.
- **Needs-review lives in the image stream.** (Revised 2026-07-08: a dedicated
  `/cv/review` route + nav badge was built, then removed — the image stream already has
  Needs-review / Reviewed tabs and is the operators' daily touchpoint.) Reviewing an
  image in the stream writes `qcLabel` (approved/rejected), which is both the human
  truth for the scorecard and the training signal for the next iteration. The
  per-version scorecard therefore compares each inspection's verdict against its
  image's `qcLabel` (approved→pass, rejected→fail) rather than a separate
  `humanLabel` field.
- Per-version scorecard on the project page: model verdict vs. human review agreement
  per deployed version — this is the "reviewed again in another section" view and tells
  you when it's time for the next training iteration.
- (Follow-on, per DHR discussion: mirror a compact verdict summary
  `{verdict, inspectionId, modelVersion}` onto the matching `cartridge_records.photos[]`
  entry so cartridge pages show verdicts without extra queries. Summary only — labels,
  embeddings and history never move onto the cartridge doc.)

### View split — top vs. bottom (added 2026-07-08)

Cartridges are photographed from the top and the bottom; the two views look completely
different, so a model must train on and grade exactly one view.

- `cv_images.view: 'top' | 'bottom' | null` — set at capture via a **sticky** Top/Bottom
  selector on /capture (sticky because operators shoot batches per view; the Pass/Fail
  verdict toggle, by contrast, resets per shot). `null` = untagged legacy photo.
- `cv_projects.view: 'top' | 'bottom' | null` — set at create or in Training setup.
  `null` = "any view" (backward compatible; existing projects unchanged).
- **Routing rule:** at capture, a photo is graded only by deployed projects whose view
  matches — a view-less project grades everything at its phase; a view-scoped project
  never sees the other view (or untagged photos).
- **Training rule:** a view-scoped project trains only on images with that exact view;
  untagged photos are excluded (mixing unknown views is what this prevents). The view is
  recorded in each version's `trainingSet.filter`.
- Typical setup: two projects per phase — "Post-mortem Top" (view: top) and
  "Post-mortem Bottom" (view: bottom) — each with its own versions, gate, and deploy.

---

## 4. Schema changes (the unblock)

All of these are *declarations* of fields the code already uses — plus the new versioned
structures. No collection renames, no data moves.

**`cv-project.ts`** — declare: `purpose`, `members[]`, `composedOf[]`, `isLiveComposition`,
`isMasterModel`, `deployAtPhases[]` (indexed), `activeModelVersion`, `shadowModelVersion`,
`trainingError`, `trainingFilter { phases[], cartridgeStatuses[], requiredTags[], excludeTags[] }`,
`verifyGate { minHoldoutCount, minBalancedAccuracy }`, and
`trainedModels[]` per the Stage-3/4 spec (subdocs with `_id: false`; `classifier` and
`verification` as `Schema.Types.Mixed` — opaque blobs, never queried by sub-field).
Project-level `classifier` is deprecated in favor of per-version weights (kept declared
for the migration window).

**`cv-image.ts`** — declare: `embedding[]` (Number), `embeddingVersion`, `sampleId`,
`projectId` (project-scoped uploads without a cartridge — demo/R&D sets — remain
supported; `cartridgeTag` becomes required only for phase captures). Retire `label` in
favor of `qcLabel`.

**`cv-inspection.ts`** — fix the status enum to what the code writes
(`queued | running | completed | failed`), declare `isShadow`, `triggeredBy`,
`triggeredAt`, `confidenceThreshold`, `anomalyScore`, `errorMessage`, `completedAt`.

**Migration script** (`scripts/migrate-cv-pipeline-v2.ts`):
1. `label` → `qcLabel` where `qcLabel` is null (preserve `labeledBy/At` when present).
2. Wrap any legacy project-level `classifier` into a `trainedModels[]` v1 entry
   (status `deployed` if the project has legacy `activeModelVersion`, else `trained`;
   `trainingSet.imageIds: []` marked `legacy: true`).
3. Normalize legacy inspection `status` values to the new enum.
4. Report-only mode first (`--dry-run`), then apply.

---

## 5. Implementation plan (PR-sized)

| PR | Scope | Unblocks |
|----|-------|----------|
| **1. Schema + label unification** | All §4 declarations, enum fix, trainer reads `qcLabel`, migration script | Everything — smallest possible diff, ship first |
| **2. Versioned training** | `triggerTraining` appends `trainedModels[]` entries with manifest + holdout verification; train UI shows available/new image counts | Stage 3 + automatic verify |
| **3. Verify gate + Deploy button** | Gate enforcement, Deploy/rollback/shadow UX on the Deployment tab, audit logging | Stage 4 |
| **4. Review loop + capture verdict** | Capture-time approve/reject, review via the image stream's Needs-review tab (qcLabel), per-version scorecard (verdict vs. image qcLabel), `photos[]` verdict summary mirror, station phase sanity warning | Stages 1, 2, 5 polish |

Each PR: `npm run check` against baseline, preview deploy via GitHub push (never local
`vercel deploy`), entry in `progress.txt` with branch/commit/URL.

**Acceptance (end-to-end):** on a preview deploy — label ≥ 15 post-mortem photos → train
→ version appears with manifest + holdout score → passes gate → Deploy to `post_mortem`
→ capture a new photo at the post-mortem station → verdict appears on the inspect page
→ the photo shows up in the **image stream's Needs-review tab** with its verdict →
approving/rejecting it there sets `qcLabel` → next train shows it as a new training
image.
Then: retrain with more photos → v2 appears alongside v1 → roll back to v1 → verify the
station uses v1 again.

---

## 6. Open questions

1. **Gate defaults** — are `minHoldoutCount: 10` / `minBalancedAccuracy: 0.80` right for
   current volumes? (cvdemo-scale projects may need lower to get started.)
2. **Master model** — does the cross-phase master model participate in Verify→Deploy the
   same way, or is it advisory-only?
3. **Auto-shadow** — when a new version passes verification, auto-run it as shadow at the
   deployed phases for N captures before allowing Deploy? (Nice safety rail; adds a step.)
4. **Doc size** — weights are ~2 KB per version (156 floats + calibration); at 50+
   versions per project we should cap retained `trainedModels[]` entries or archive
   retired weights to R2. Not urgent.

# PRD: CV Verdict Calibration, Disposition & Gating

**Author:** Alejandro Valdez (decisions) + Claude (audit + draft)
**Date:** 2026-06-12
**Status:** Draft — awaiting Alejandro review
**Priority:** P1 — pass/fail verdicts are currently statistically meaningless and carry no consequences
**Branch:** `dev`
**Depends on:** [PRD 3 — Project as Model](./CV-REFACTOR-3-PROJECT-AS-MODEL.md), [CV-MODEL-TRAINING-SERVERLESS](./CV-MODEL-TRAINING-SERVERLESS.md), [CV-CARTRIDGE-PHASE-TRACKING](./CV-CARTRIDGE-PHASE-TRACKING.md)

---

## 1. Problem

Full audit of the verdict path (2026-06-12, see progress.txt) found the plumbing
works — capture → R2 → fire-and-forget `runPhaseInference()` → cv-worker →
`CvInspection` — but the *decision itself* is broken in three ways:

1. **The threshold is uncalibrated.** The worker compares a PaDiM anomaly score
   against `confidenceThreshold` (default 0.5). PaDiM scores are unbounded
   Mahalanobis-distance values, not probabilities. `main.py:310-311` sigmoid-squashes
   the score *only when it falls outside [0,1]*, so a raw 3.0 becomes 0.95 while a
   raw 0.7 passes through untouched. Nobody has ever computed what threshold
   actually separates the labeled good images from the bad ones. Pass/fail results
   therefore don't track reality — this is the root cause of bad verdicts.

2. **Verdicts have no consequences and no human loop.** `CvInspection.result` is
   display-only (DHR page, project pages). Nothing gates cartridge flow on it — a
   cartridge with a `fail` can reach `released`/`shipped`. There is no way to
   disposition or override a verdict; `CvImage.qcLabel` is training-data labeling,
   unrelated to inspections.

3. **The loop is fragile.** No timeout/retry in `cv-bridge.ts` (a hung worker
   leaves inspections in `running` forever); worker response is stored verbatim
   with zero validation (`runInference` returns `any`); the worker has **no auth**
   on any endpoint; `defects` is a hardcoded placeholder
   (`{type:'anomaly', location:'global', severity:'high'}` on every fail); the
   in-memory ONNX session cache grows unboundedly; training data accumulates in
   `/tmp`; model cache filenames (`model_path.replace('/', '_')`) can collide;
   shadow inspections are stored but never filtered out of queries.

Corrections vs. an earlier draft of the audit: `cv_inspections` **does** index
`imageId`, `cartridgeRecordId`, and `projectId` (schema `index: true`) — no index
work needed. And the inference path sends no API key at all (`cv-bridge.ts` has no
auth header; the `CV_API_KEY`/`cv-api.ts` machinery is a separate, unused module).

## 2. Goals

- A threshold that is **computed from labeled data at training time**, per model
  version, instead of an arbitrary 0.5 against a distorted score.
- A **human disposition loop**: every `fail` (and any contested `pass`) can be
  accepted/rejected by an operator, with reason + audit trail — QMS-compatible.
- A **gate** that gives verdicts consequences, rolled out advisory → soft → hard,
  per project, meshing with the manual QC sections that already exist on
  `CartridgeRecord` (`waxQc`, `reagentInspection`, `qaqcRelease`).
- A **reliable loop**: timeouts, validation, worker auth, cache hygiene.

## 3. Non-goals (future PRDs)

- Anomaly **heatmap / defect localization** (replacing the synthetic `defects`
  array with real locations). Requires exporting PaDiM's pixel-level map.
- **Drift dashboards** comparing shadow vs. active model agreement over time
  (this PRD only makes shadow data queryable and clean).
- Auto-promotion of models. Promotion stays manual per PRD 3.
- Multi-class / per-criterion defect models. PaDiM single-score stays for v1.

## 4. How this meshes with existing CV infrastructure

| Existing piece | How this PRD uses it (no rework) |
|---|---|
| `CvProject.trainedModels[]` append-only registry (PRD 3) | Calibration data is **new fields on each entry** — `calibratedThreshold`, `scoreStats`, val metrics into the already-existing `metrics: Mixed` field. Old entries keep working via fallback. |
| `trainedModels[].confidenceThreshold` | Becomes the **operator override**; effective threshold = `confidenceThreshold ?? calibratedThreshold ?? 0.5`. No UI change required to keep tuning. |
| `train-complete` callback + `TRAIN_CALLBACK_SECRET` (serverless training PRD) | GitHub Actions trainer posts calibration results through the **same callback**, same secret. Worker `/train` path computes the same numbers inline. The shared-secret pattern is also reused for worker auth (`CV_WORKER_SECRET`). |
| `runPhaseInference()` fire-and-forget on capture (PRD 3 decision #10) | **Unchanged.** Trigger model, project fan-out by `deployAtPhases`, shadow runs — all stay. Only the inside of `runOne()` gains validation + timeout. |
| `CvInspection` pre-insert (`running`) → update pattern | **Unchanged**; disposition is additive fields on the same doc. Existing indexes on `imageId`/`cartridgeRecordId`/`projectId` already cover the gate query. |
| Phase pipeline `wax_filled → reagent_filled → inspected → sealed → oven_cured → qaqc_released` (phase-tracking PRD) | Gate lookups key on `(cartridgeRecordId, phase)` using these exact values, same as `photos[].phase` and `deployAtPhases`. |
| Manual QC sections on `CartridgeRecord` | CV gate surfaces *into* the human decisions that already exist: `wax_filled` ↔ `waxQc`, `reagent_filled`/`inspected` ↔ `reagentInspection`, `qaqc_released` ↔ `qaqcRelease.testResult`. CV never writes these sections — it informs/blocks the operator action that does. |
| AuditLog pattern (CLAUDE.md) | Disposition and gate-override mutations write AuditLog entries like every other mutation. |
| `.svelte` freeze | All logic is server-side. Two small UI surfaces (disposition button, advisory banner) are flagged in §10 for escalation per the freeze-exception process. |

## 5. Workflow

### 5a. Capture → verdict (today's flow, hardened)

```
Operator / Pi station
  └─ POST /api/cv/capture (or /capture-ingest)
       ├─ image → R2, CvImage created, photos[] $push on CartridgeRecord
       └─ fire-and-forget runPhaseInference({imageId, phase, cartridgeRecordId})
            └─ for each CvProject where deployAtPhases ∋ phase && activeModelVersion:
                 ├─ CvInspection created (status: running)        [unchanged]
                 ├─ cv-bridge POST /infer                          [+ 30s timeout, 1 retry,
                 │    {image_url, model_path, threshold}             + X-CV-Secret header]
                 ├─ worker: ONNX → raw_score → normalized_score    [calibrated, §6]
                 │    result = normalized >= effectiveThreshold ? fail : pass
                 ├─ response validated (zod) before persist        [new]
                 └─ CvInspection updated: result, rawScore,
                    normalizedScore, threshold, completedAt
            (shadow model: same, isShadow: true — excluded from gate + default queries)
```

### 5b. Training → calibration (new step inside both existing trainers)

```
POST /api/cv/train  ──► GitHub Actions trainer (train_cli.py)  ──┐
                    └─► worker /train (long-lived path)        ──┤  same logic, shared module
                                                                 ▼
   1. train PaDiM on labeled-good images (unchanged)
   2. NEW — score EVERY labeled image (good + bad) with the trained model
   3. NEW — record rawMin/rawMax over the validation scores → min-max
      normalization params (replaces the conditional sigmoid)
   4. NEW — sweep thresholds over normalized scores; pick the one that
      maximizes F1 (report falsePassRate / falseFailRate at that point)
   5. upload ONNX (unchanged) + POST /api/cv/train-complete with
      {calibratedThreshold, scoreStats, valMetrics}   [same callback, same secret]
   6. trainedModels[] entry updated: status ready + calibration fields
```

A project with zero labeled-bad images trains fine but gets
`calibratedThreshold: null` + a `calibrationWarning` — the UI shows the model as
uncalibrated and the effective threshold falls back as before.

### 5c. Fail → disposition → gate (the new loop)

```
CvInspection.result = 'fail' (production, isShadow: false)
  │
  ├─ DHR / project page shows verdict + scores            [exists today]
  │
  ├─ Operator dispositions it:                            [NEW]
  │    POST /api/cv/inspections/:id/disposition
  │    { decision: 'accept' | 'reject', reason }
  │    → disposition{} set on CvInspection + AuditLog
  │    → effective verdict = disposition.decision ?? result
  │
  └─ Gate check at the NEXT manual QC action for that phase:   [NEW]
       getCvGateStatus(cartridgeRecordId, phase) →
         'pass'        every production inspection passed (or accepted on appeal)
         'fail'        ≥1 un-dispositioned fail or a rejected disposition
         'pending'     inspection still queued/running
         'no-coverage' no project deploys at this phase / inference errored
       enforcement per project (CvProject.enforcementMode):
         advisory  → status shown to operator, action proceeds        (rollout A)
         soft      → 'fail' blocks the QC "Accept" until dispositioned (rollout B)
         hard      → 'fail' + rejected disposition blocks phase action (rollout C)
```

## 6. Schema changes

### `CvProject.trainedModels[]` — additive

```typescript
calibratedThreshold: { type: Number, default: null },   // F1-optimal, from validation sweep
scoreStats: {                                            // min-max normalization params
    _id: false,
    rawMin: Number, rawMax: Number,
    goodMean: Number, badMean: Number                    // sanity/debug
},
calibrationWarning: String,                              // e.g. 'no labeled-bad images'
// valMetrics go into the EXISTING `metrics: Schema.Types.Mixed` field:
// { f1, threshold, falsePassRate, falseFailRate, nGood, nBad }
```

### `CvProject` — additive

```typescript
enforcementMode: { type: String, enum: ['advisory', 'soft', 'hard'], default: 'advisory' }
```

### `CvInspection` — additive

```typescript
rawScore: Number,            // unnormalized model output (anomalyScore keeps normalized for back-compat)
disposition: {
    _id: false,
    decision: { type: String, enum: ['accept', 'reject'] },
    reason: { type: String, required: true },
    by: { _id: String, username: String },
    at: Date
}
```

No changes to `CartridgeRecord` — the gate reads `cv_inspections`, it does not
write cartridge state.

## 7. Worker changes (`services/cv-worker/main.py` + `train_cli.py`)

1. **Calibration step** (§5b) in a shared module used by both training paths —
   ends the FastAPI-vs-CLI logic drift noted in the audit.
2. **`/infer` scoring**: drop the conditional sigmoid (`main.py:310-311`).
   Accept optional `score_stats` in the request; return both `raw_score` and
   `normalized_score` (min-max clamped 0–1). Decision compares normalized score
   to the effective threshold sent by the app.
3. **Auth**: FastAPI dependency requiring `X-CV-Secret == CV_WORKER_SECRET` on
   `/train`, `/infer`, `/process-image`, `/status` (`/health` stays open for
   Fly checks). `cv-bridge.ts` sends the header. Same shared-secret pattern as
   `TRAIN_CALLBACK_SECRET`.
4. **Hygiene**: LRU-cap `_model_cache` (e.g. 8 sessions); SHA-1-hash the model
   cache filename (fixes the `replace('/', '_')` collision at `main.py:286`);
   `shutil.rmtree` the project training dir after successful ONNX upload.

## 8. App changes (all server-side)

1. **`cv-bridge.ts`**: 30 s `AbortSignal` timeout + one retry on network
   error/5xx; send `X-CV-Secret`.
2. **`run-inference.ts`**: zod-validate the worker response before persisting
   (`result ∈ {pass, fail}`, numeric scores); invalid → `status: 'failed'` with
   `errorMessage`, never garbage in the enum. Pass `score_stats` + effective
   threshold from the trained-model entry.
3. **Stale sweep**: mark inspections stuck in `running` > 10 min as `failed`
   (`errorMessage: 'timed out'`). Runs in the existing cron route alongside the
   daily-reminder job.
4. **`POST /api/cv/inspections/:id/disposition`** (new): permission-guarded,
   writes `disposition{}` + AuditLog. One disposition per inspection; changing
   it appends a correction-style AuditLog entry.
5. **`getCvGateStatus(cartridgeRecordId, phase)`** in `src/lib/server/cv/` —
   queries production (`isShadow: false`) inspections for that cartridge+phase,
   folds in dispositions, returns the four-state verdict of §5c. Called by the
   `waxQc` / `reagentInspection` / `qaqcRelease` form actions according to the
   owning project's `enforcementMode`.
6. **`/api/cv/inspections`**: default filter `isShadow: false`; explicit
   `?includeShadow=true` to see shadow runs. Promotion endpoint refuses versions
   whose `status !== 'ready'`.

## 9. Rollout

| Stage | What ships | Exit criteria |
|---|---|---|
| **A — Calibrate + harden** | §6 schema, §7 worker, §8.1–3, 8.6. Retrain active projects to mint calibrated entries. Everything advisory. | Calibrated verdicts visibly track operator judgment on ~50 captures; zero stuck-`running` inspections. |
| **B — Disposition + soft gate** | §8.4–5; `enforcementMode: 'soft'` on one pilot project (suggest wax_filled ↔ `waxQc`). | Operators disposition fails within the shift; false-fail rate acceptable per valMetrics. |
| **C — Hard gate (opt-in)** | Flip `enforcementMode: 'hard'` per project as confidence warrants. | QA sign-off per phase. |

## 10. `.svelte` freeze escalations (not implemented in this PRD)

Two small UI surfaces need eventual escalation per the freeze-exception process;
the server APIs above work without them (curl / existing pages):

- Disposition button + reason field on the DHR inspection rows.
- Gate-status banner on the wax-QC / reagent-inspection / QA-QC forms.

## 11. Acceptance criteria

1. Retraining a project with ≥5 good and ≥3 bad labeled images produces a
   `trainedModels[]` entry with `calibratedThreshold`, `scoreStats`, and
   `metrics.f1` populated via the train-complete callback.
2. `/infer` responses contain `raw_score` and `normalized_score`; the stored
   inspection reproduces the worker's decision from its own persisted fields
   (score + threshold → result).
3. Requests to `/infer` without `X-CV-Secret` return 401.
4. Killing the worker mid-inference leaves no inspection in `running` after the
   sweep interval; it shows `failed` with a timeout message.
5. Dispositioning a fail as `accept` flips `getCvGateStatus` to `pass` for that
   cartridge+phase and writes an AuditLog entry.
6. With `enforcementMode: 'soft'`, the wax-QC Accept action returns
   `fail(400, ...)` while an un-dispositioned CV fail exists for that cartridge
   at `wax_filled`, and succeeds after disposition.
7. `/api/cv/inspections?projectId=X` no longer returns shadow rows by default.

## 12. Risks

- **Calibration garbage-in**: mislabeled training images produce a confident but
  wrong threshold. Mitigation: valMetrics surfaced on the model entry; advisory
  stage A before any gating.
- **Old model entries** lack `scoreStats` — inference falls back to legacy
  behavior (current squash + 0.5). Mitigation: retrain during stage A; UI marks
  entries uncalibrated.
- **Gate deadlock** if a project deploys at a phase but the worker is down:
  `pending`/`no-coverage` states never block, only `fail` does, and only in
  soft/hard mode.
- **OneDrive dev clone**: file watching/locks can interfere with long worker
  runs locally; worker deploys run on Fly, unaffected.

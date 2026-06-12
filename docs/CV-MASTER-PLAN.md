# CV Master Plan — From Refactor to Trustworthy Verdicts

**Author:** Alejandro Valdez (decisions) + Claude (drafted)
**Date:** 2026-06-12
**Status:** Active — supersedes the standalone reading of its two sources
**Merges:** [CV-REFACTOR-HANDOFF](./CV-REFACTOR-HANDOFF.md) (operate the machine)
× [CV-VERDICT-CALIBRATION-AND-GATING PRD](./prds/CV-VERDICT-CALIBRATION-AND-GATING.md) (fix its judgment)
**Branches:** work lands on `dev`, publishes to `main` (Vercel production)

---

## 1. Where we are

The cartridge-first CV refactor is live: images belong to cartridges, projects
are composable training sets that own **versioned, append-only models**
(`trainedModels[]`, active + shadow). Capture (`/capture`), the image stream
(`/cv/stream`), labeling (`/cv/label`), and project management (`/cv/projects`)
all work in production. Making and storing multiple CV models is **supported by
design** — every training run mints a new version, nothing is overwritten, and
each project can deploy at any manufacturing phase.

The 2026-06-12 audit found the part that *judges* cartridges is broken in three
ways:

1. **Uncalibrated threshold** — pass/fail compares a raw PaDiM anomaly score
   (an unbounded distance, inconsistently sigmoid-squashed) against a default
   0.5 nobody ever derived from data. Verdicts don't track reality.
2. **No consequences, no human loop** — a `fail` is display-only; a failed
   cartridge can ship. No disposition/override exists.
3. **Fragile loop** — no timeout/retry (inspections stick in `running`
   forever), no validation of worker responses, **no auth on the worker**,
   placeholder `defects`, unbounded model cache, `/tmp` accumulation.

If training has ever *felt* broken ("can't create models"), the audit's
suspects are: worker training state is in-memory (lost on Fly restart, so runs
look stuck), and a version only flips to `ready` via the train-complete
callback — if that fails, the entry sits in `training` limbo. Phase 0 below
settles this empirically.

## 2. The goal

Operators train and store **multiple calibrated model versions per phase**,
compare them by scorecard, promote deliberately, and trust that a `fail` means
something — first as advice, then as a gate into the manual QC decisions that
already exist on the cartridge record (`waxQc`, `reagentInspection`,
`qaqcRelease`).

---

## 3. Phase 0 — Validate the stack (handoff checklist, do FIRST)

Prerequisite for everything: prove the training round-trip works on the real
deployment. From the handoff's Monday checklist, still the right order:

| # | Check | How | Exit |
|---|---|---|---|
| 0.1 | Worker reachable from Vercel | `GET ${CV_WORKER_URL}/health` from the deployed app's env; verify the Vercel env var points at the Fly worker | 200 |
| 0.2 | Capture end-to-end | `/capture` with USB scanner: scan registered cartridge → green banner → photo in <2s, `_00N` increments | CvImage + `photos[]` entry exist |
| 0.3 | Label flow | `/cv/label` → approve ~10 / reject ~3 wax_filled images | `qcLabel` persists on refresh |
| 0.4 | **Training round-trip** | Create "Wax Fill QC" project → add labeled members → deploy at `wax_filled` → `POST /api/cv/train` → poll until `trainedModels[]` entry is `ready` → set active | New version `ready` with ONNX in R2 |
| 0.5 | Inference round-trip | Capture a new wax_filled photo → CvInspection row appears in project History | result + scores populated |
| 0.6 | Second version + shadow | Train again → v2; set v1 active, v2 shadow → captures produce two inspection rows | both rows present, `isShadow` correct |

**If 0.4 fails**, debug before anything else — likely the in-memory training
state or the train-complete callback (see §1). Fixing that is part of Phase 1
anyway; Phase 0 just tells us how urgent it is.

## 4. Phase 1 — Calibrate + harden (PRD Stage A)

Make every stored model version trustworthy and the loop reliable.

**Training gets a final exam** (shared module used by both the worker `/train`
path and the GitHub Actions `train_cli.py` path):
1. Train PaDiM on labeled-good images (unchanged).
2. Score **every** labeled image (good + bad) with the trained model.
3. Record `scoreStats` (rawMin/rawMax → min-max normalization; replaces the
   conditional sigmoid).
4. Sweep thresholds; store the F1-optimal one as `calibratedThreshold`, plus a
   scorecard (`metrics`: f1, falsePassRate, falseFailRate, nGood, nBad) via the
   existing train-complete callback.
5. No labeled-bad images → train fine, `calibratedThreshold: null` +
   `calibrationWarning`; falls back to today's behavior.

Effective threshold = `confidenceThreshold` (operator override) ??
`calibratedThreshold` ?? 0.5.

**Loop hardening:**
- `cv-bridge.ts`: 30s timeout + 1 retry; send `X-CV-Secret`.
- Worker: require `X-CV-Secret` on `/train` `/infer` `/process-image`
  `/status` (`/health` open); persist training status (Mongo) so restarts
  don't orphan runs; LRU-cap the ONNX session cache; hash cache filenames;
  clean `/tmp` after upload.
- `run-inference.ts`: zod-validate worker responses; store `rawScore` +
  normalized score; invalid → `failed`, never garbage.
- Stale sweep: `running` > 10 min → `failed` (existing cron route).
- Promotion endpoint refuses versions with `status !== 'ready'`.
- `/api/cv/inspections` defaults to `isShadow: false`.

**Exit:** retrain active projects → calibrated entries with scorecards; verdicts
visibly track operator judgment over ~50 captures; zero stuck inspections;
unauthenticated `/infer` returns 401.

## 5. Phase 2 — Disposition + soft gate (PRD Stage B)

- `POST /api/cv/inspections/:id/disposition` — operator accepts/rejects a
  verdict with reason; AuditLog entry; effective verdict =
  disposition ?? model result.
- `getCvGateStatus(cartridgeRecordId, phase)` → `pass | fail | pending |
  no-coverage`, production rows only, dispositions folded in.
- `CvProject.enforcementMode: 'advisory' | 'soft' | 'hard'` (default advisory).
- Pilot **soft** mode on one project (wax_filled ↔ `waxQc`): the QC "Accept"
  action returns `fail(400)` while an un-dispositioned CV fail exists;
  succeeds after disposition. `pending`/`no-coverage` never block.

**Exit:** operators disposition fails within the shift; false-fail rate
acceptable per scorecard.

## 6. Phase 3 — Hard gate, opt-in per project (PRD Stage C)

Flip `enforcementMode: 'hard'` per project as confidence warrants: a fail with
a rejected disposition blocks the phase action. QA sign-off per phase. The
phase map: `wax_filled` ↔ `waxQc`, `reagent_filled`/`inspected` ↔
`reagentInspection`, `qaqc_released` ↔ `qaqcRelease.testResult`.

## 7. Carry-over gotchas to close en route (from the handoff)

| Gotcha | Close in |
|---|---|
| `CaptureButton` not wired into wax-fill / reagent-fill / top-seal pages | Phase 0/1 (one-liner per page; operator value immediately) — `.svelte` touch, follows the freeze-exception precedent |
| Lenient permissions (CV endpoints check `locals.user` only) | Phase 2, alongside the disposition permission |
| No CV contract tests | Each phase adds tests for its new endpoints |
| Phase enum is an open string | Phase 2 — validate against the known pipeline when gating starts caring |
| Silent composition-cycle skip (`cycleSkipped` never surfaced) | Phase 1 — log + surface in train response |
| Project hard-delete orphans inspections | Phase 2 — archive flag instead of delete |

## 8. UI surfaces requiring freeze escalation

Server APIs work without them; escalate per the `.svelte` freeze-exception
process when ready: disposition button on DHR inspection rows; gate-status
banner on the wax-QC / reagent-inspection / QA-QC forms; "uncalibrated" badge
on model versions in the project Deployment tab.

## 9. Key files (merged map)

- **Schemas:** `cv-project.ts` (trainedModels[] + new calibration fields,
  enforcementMode), `cv-inspection.ts` (+ rawScore, disposition),
  `cv-image.ts`, `cartridge-record.ts` (untouched — gate reads, never writes)
- **Loop:** `src/lib/server/cv/run-inference.ts`,
  `src/lib/server/services/cv-bridge.ts`, `src/routes/api/cv/{train,
  train-complete,infer,inspections}/`
- **Worker:** `services/cv-worker/main.py`, `train_cli.py` (+ new shared
  calibration module)
- **New:** `src/lib/server/cv/gate-status.ts`,
  `src/routes/api/cv/inspections/[id]/disposition/+server.ts`

## 10. Definition of done

A cartridge photographed at any deployed phase gets judged by a model whose
threshold was measured from labeled data; the verdict, scores, threshold, and
model version are replayable from the inspection record forever; a human can
overrule it with a logged reason; and a `fail` cannot be silently ignored at
the QC step for that phase once its project is in soft/hard mode. Multiple
model versions per project remain permanently stored, compared by scorecard,
and promoted deliberately.

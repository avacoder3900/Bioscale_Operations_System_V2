# CV Subsystem — What the Trunk Consolidation Did (for Alejandro)

**Date:** 2026-06-10
**Branch built:** `jq/consolidate-trunk` (folds every live branch into one trunk → master)
**Who/why:** Jacob asked to consolidate all divergent work onto `master` (Vercel production). This file documents **only the CV-related decisions** so you can verify nothing of yours was lost and recover anything you need.

## TL;DR

- **Your deployed CV system (main, capture stations, 06-09) is preserved 100% unchanged.** Nothing in main's CV was overwritten.
- **`feat/cv-train-infer-split` (06-04) was NOT folded in.** It's a *divergent refactor* of the CV subsystem, not a mechanically-mergeable branch — it conflicts structurally with main's capture-station CV. Folding it half-and-half broke the type-check, so I backed it out and kept main's CV coherent.
- **Your branch `feat/cv-train-infer-split` is untouched on `origin`.** Nothing was deleted from it. The serverless-training direction it represents (which dev's PRD `docs/...serverless CV training...` describes) should land as its **own follow-up refactor PR**, not a fold.

## Exactly what I did, file by file

### 1. `spu-assembly-revamp` (your 05-15 branch) — CV files → kept MAIN's
When folding `spu-assembly-revamp`, these conflicted with main. main was newer (05-16…05-27 vs 05-15), so I took **main's** version:
- `src/lib/server/db/models/cv-image.ts`
- `src/lib/server/db/models/cv-inspection.ts`
- `src/lib/server/db/models/cv-project.ts`
- `src/routes/api/cv/infer/+server.ts`
- `src/routes/api/cv/train/+server.ts`
- `src/routes/cv/projects/[id]/+page.svelte`

→ **Effect on you:** spu-assembly-revamp's CV workspace / in-process classifier code was *not* merged into the trunk. It remains on the `spu-assembly-revamp` branch. If any of that classifier work is still wanted, cherry-pick it deliberately — it was superseded by main's newer CV at the time.

### 2. `feat/cv-train-infer-split` (your 06-04 branch) — backed out of the trunk
I first took *your* versions of these, then **reverted them to main's** because mixing the two CV systems broke `npm run check` (e.g. `run-inference.ts` expected `anomaly_score` from an `InferenceResult` shape your `infer` route changed; `cv/training` page expected `data.projects` that main's loader doesn't provide):

**Restored to main's version (your changes NOT applied to trunk):**
- `src/lib/server/db/models/cv-inspection.ts`
- `src/lib/server/db/models/cv-project.ts`
- `src/routes/cv/+layout.svelte`
- `src/routes/api/cv/infer/+server.ts`
- `src/routes/api/cv/train/+server.ts`

**Removed from the trunk (net-new files from your branch, incoherent without the rest of your refactor):**
- `src/routes/cv/training/+page.svelte` + `+page.server.ts`
- `src/routes/cv/labeling/+page.svelte` + `+page.server.ts`
- `src/routes/api/cv/train-manifest/+server.ts`
- `src/routes/api/cv/train-complete/+server.ts`

**KEPT in the trunk (additive, harmless — not type-checked, useful scaffolding for your future refactor):**
- `.github/workflows/train-cv-model.yml`
- `api/ml/infer.py`
- `services/cv-worker/train_cli.py`, `services/cv-worker/requirements-train.txt`
- `services/cv-worker/fly.toml` (came via `dev`)

### 3. robot-arm files touched by cv-train → kept arm-protocols' (newer)
- `src/lib/server/db/models/robot-arm-run.ts` and `src/routes/api/robot-arm/webhook/+server.ts` → kept **ours** (`feature/arm-protocols` 05-27 is newer than cv-train's 05-12 robot-arm commit).

### 4. `.env.example` → UNION
Kept both your CV-training/inference env vars (`CV_INFER_URL`, `ML_INFER_SECRET`, `GITHUB_DISPATCH_TOKEN`, `TRAIN_CALLBACK_SECRET`, `R2_WORKER_URL`, `R2_UPLOAD_SECRET`) **and** the robot-arm Tailscale block. Nothing dropped here.

## How to land your CV-training refactor properly (recommended)

Your `feat/cv-train-infer-split` is the *intended future direction* (serverless GitHub-Actions training + Vercel ONNX inference, replacing the always-on cv-worker — per the dev PRD). It just needs to be reconciled against main's current capture-station CV as a focused effort, not a blind merge:

1. Rebase `feat/cv-train-infer-split` onto the new consolidated `master` (after this lands).
2. Reconcile the model-shape changes (`cv-inspection`, `cv-project`, `InferenceResult.anomaly_score`) against main's capture-station fields.
3. Re-wire `cv/training` + `cv/labeling` pages to main's project/loader data shape.
4. Open it as its own PR so the CV diff is reviewable in isolation.

Everything you need is still on `origin/feat/cv-train-infer-split` — **nothing was force-pushed or deleted from your branches.** This consolidation only *added* merge commits to a new trunk.

## If something of yours looks broken after this ships
- Diff your branch against the new master: `git diff origin/feat/cv-train-infer-split origin/master -- src/routes/cv src/lib/server/cv`
- The full per-branch decision log is in `docs/TRUNK-CONSOLIDATION-LOG-2026-06-10.md`.
- Ping Jacob — the old `master` tip (`213b8f5`) is preserved, so any decision is reversible.

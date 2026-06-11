# PRD: Serverless CV Model Training & Inference (no always-on host)

**Status:** Proposed · **Author:** session 2026-06-10 · **Branch target:** `dev` → `main`

## 1. Problem Statement

The CV "Train" button (`/cv/projects/[id]`) is wired and shipped to production, but
**there is no backend to train on.** The current design (`cv-bridge.ts`) calls an
always-on FastAPI service (`services/cv-worker`) via `CV_WORKER_URL`. Nothing hosts
that service, so production fails with:

```
CV worker unreachable at http://localhost:8000/train (ECONNREFUSED).
```

Hosting that always-on PyTorch service (Fly/Render/etc.) means a **new paid account
and a server to babysit** — in-memory training state and `/tmp` scratch make it
fragile (a restart mid-train loses progress). Constraints from the product owner:

- **No new paid accounts.** Use what we already pay for / what's free.
- **Easy and reliable.** Minimal DevOps; nothing to keep alive.
- **OK to split training from inference** (they have opposite shapes — see §3).

## 2. Decision

**Do not add a hosting platform. Split the workload across infrastructure we already
have, both of which scale to zero:**

| Concern | Shape | Run it on | Why |
|---|---|---|---|
| **Training** | occasional, heavy (PyTorch/PaDiM, minutes, ~GBs RAM) | **GitHub Actions** ephemeral runner | Free on public repos / 2,000 min/mo free on private; 6 h job ceiling (we cap at 30 min); ~7 GB / 2-core runner is plenty for PaDiM on CPU; nothing to host. |
| **Inference** | frequent, light (one ONNX forward pass per capture) | **Vercel Python function** (`api/ml/infer.py`) | Already on Vercel; Python functions allow large deps + a 500 MB `/tmp`; Fluid compute (default since Apr 2025) shares instances to cut cold starts. |
| **Artifacts** | model + images | **Cloudflare R2** (existing) | Already holds every capture; training reads image URLs, writes `model.onnx`. |

This is exactly the architecture already prototyped on branch
`feat/cv-train-infer-split` (`.github/workflows/train-cv-model.yml`,
`services/cv-worker/train_cli.py`, `api/ml/infer.py`, `github-dispatch.ts`,
`train-manifest`/`train-complete` endpoints). **This PRD ports that pattern onto the
current `main` CV data model** rather than merging the branch wholesale (the branch
uses a divergent, older schema — see §6).

### Best-practice validation (research, June 2026)
- GitHub Actions is a recommended pattern for on-demand ML training; store creds as
  encrypted secrets, least-privilege tokens, cache pip. ([GitHub Actions limits](https://docs.github.com/en/actions/reference/limits), [GitHub MLOps blog](https://github.blog/enterprise-software/ci-cd/streamlining-your-mlops-pipeline-with-github-actions-and-arm64-runners/))
- Vercel Python functions comfortably host `onnxruntime` (CPU wheel ~tens of MB) +
  a small PaDiM ONNX; model is fetched to `/tmp` at runtime, not bundled; Fluid
  compute mitigates cold starts. ([Vercel Functions limits](https://vercel.com/docs/functions/limitations), [Fluid compute](https://vercel.com/docs/fluid-compute))
- Trigger Actions from the web app with `repository_dispatch` + a **fine-grained PAT**
  (Contents: write, Metadata: read), stored as a Vercel env secret. ([fine-grained PAT dispatch](https://www.eliostruyf.com/dispatch-github-action-fine-grained-personal-access-token/), [REST: dispatch](https://docs.github.com/en/rest/actions/workflows))

## 3. What exists today

- **UI + orchestration (main, shipped):** `/cv/projects` (create), `/cv/label`
  (filter → approve/reject → add to project), `/cv/projects/[id]` (Train +
  Deployment tabs). Train POSTs `/api/cv/train`. Deployment sets
  `activeModelVersion` + `deployAtPhases`. Capture auto-runs inference via
  `runPhaseInference` (`run-inference.ts`).
- **The blocker:** `/api/cv/train` and `run-inference.ts` both go through
  `cv-bridge.ts` → `CV_WORKER_URL` (the unhosted always-on service).
- **Reusable assets** on `feat/cv-train-infer-split`: the Actions workflow, the
  training CLI, the Vercel inference function, the dispatch helper, and the
  manifest/callback endpoints. We adapt, not copy.

## 4. Target architecture

### Train (button → model in R2)
```
Operator clicks Train (/cv/projects/[id])
  → POST /api/cv/train            (validate ≥5 labeled members; mint version)
  → dispatchWorkflow('train-cv-model', { projectId, version, callbackToken })
  → GitHub repository_dispatch
  → Actions runner: train-cv-model.yml (≤30 min, ubuntu-latest, py3.11)
       1. GET /api/cv/train-manifest?projectId&token   → { imageUrls, labels, uploadUrl }
       2. python train_cli.py  → download imgs, PaDiM fit, export model.onnx
       3. PUT model.onnx to uploadUrl (R2 presigned)   ← runner holds NO R2 creds
       4. POST /api/cv/train-complete { projectId, version, token, metrics }
  → train-complete appends to CvProject.trainedModels[]  (NO auto-promote)
UI polls GET /api/cv/train?projectId → trainedModels / status
```

### Infer (capture → PASS/FAIL)
```
/api/cv/capture saves photo
  → runPhaseInference (fire-and-forget) for any project with this phase in deployAtPhases
  → POST {Vercel}/api/ml/infer { imageUrl, modelKey: trainedModels[activeVersion].modelPath, threshold }
       infer.py: fetch model.onnx (R2) → /tmp cache, preprocess image, onnxruntime run
       → { result: pass|fail, anomaly_score, confidence }
  → write CvInspection (UI shows badge on /capture + /cv/projects history)
```

## 5. Components & changes

| # | Item | Action |
|---|---|---|
| 5.1 | `src/lib/server/services/github-dispatch.ts` | **Port** from branch. `dispatchWorkflow(type, payload)` → POST `repos/{repo}/dispatches`. Env: `GITHUB_DISPATCH_TOKEN`, `GITHUB_REPO`. |
| 5.2 | `.github/workflows/train-cv-model.yml` | **Port + retune.** `repository_dispatch: [train-cv-model]` + `workflow_dispatch`; 30-min timeout; pip cache; concurrency per `projectId`. Secrets: `BIMS_URL`, `TRAIN_CALLBACK_SECRET`. |
| 5.3 | `services/cv-worker/train_cli.py` + `requirements-train.txt` | **Port + adapt** to consume the manifest shape from 5.5; PaDiM fit (good=approved, bad=rejected); export ONNX; PUT to presigned `uploadUrl`; POST callback. |
| 5.4 | `src/routes/api/cv/train/+server.ts` | **Rewrite** the existing endpoint: keep current model (members[] + `qcLabel`), mint a version into `trainedModels[]`, then `dispatchWorkflow` instead of calling `cv-bridge`. |
| 5.5 | `src/routes/api/cv/train-manifest/+server.ts` | **New.** Authed by `TRAIN_CALLBACK_SECRET`. Resolves project members (`resolveProjectMembers`), filters `qcLabel != null`, returns `{ imageUrls, labels(url→approved/rejected), uploadUrl(presigned R2 PUT for modelPath) }`. |
| 5.6 | `src/routes/api/cv/train-complete/+server.ts` | **New.** Authed callback. Marks the `trainedModels[]` entry ready + records metrics. Does **not** auto-promote. |
| 5.7 | `api/ml/infer.py` + `requirements.txt` | **Port.** Vercel Python function: onnxruntime CPU inference; fetch model from R2 to `/tmp`; ImageNet-norm 256×256 (match `cv-worker/main.py`). |
| 5.8 | `src/lib/server/cv/run-inference.ts` + `cv-bridge.ts` | **Repoint** inference from `CV_WORKER_URL` to the internal `api/ml/infer.py` function. Retire `CV_WORKER_URL` once cut over. |
| 5.9 | `services/cv-worker/main.py` (always-on service) | **Deprecate** (keep for local dev only). Remove the Fly path / this PRD supersedes the Fly approach. |

## 6. Data-model fit (keep current `main` schema)

No schema migration required — reuse what's there:
- **Labels:** `CvImage.qcLabel ∈ {approved, rejected, null}` → train maps
  `approved→normal/good`, `rejected→abnormal/bad` (PaDiM trains on the *good* set;
  rejected tunes the threshold).
- **Membership:** `CvProject.members[]` (+ `composedOf`/`isLiveComposition` via
  `resolveProjectMembers`). Manifest pulls labeled members only.
- **Model registry:** reuse append-only `CvProject.trainedModels[]`
  (`version`, `modelPath`, `sampleCount`, …) + `activeModelVersion` (promotion stays
  manual on the Deployment tab). *Optional add:* `trainedModels[].status`
  (`training|ready|failed`) + `metrics` for nicer History UI — additive, non-breaking.
- ⚠️ **Do NOT merge `feat/cv-train-infer-split` wholesale** — it uses `CvImage.label`
  + `CvImage.projectId` and `CvProject.modelStatus/modelVersion`, which conflict with
  the current model. Port the four assets (5.1–5.3, 5.7) and rewrite the endpoints.

## 7. Config & secrets

| Where | Key | Purpose |
|---|---|---|
| Vercel (prod) | `GITHUB_DISPATCH_TOKEN` | fine-grained PAT, Contents: write + Metadata: read on the BIMS repo |
| Vercel (prod) | `GITHUB_REPO` | `avacoder3900/Bioscale_Operations_System_V2` (default) |
| Vercel (prod) | `TRAIN_CALLBACK_SECRET` | shared secret authing manifest + callback |
| GitHub repo secrets | `BIMS_URL`, `TRAIN_CALLBACK_SECRET` | runner → BIMS manifest/callback |
| (existing) | `R2_*` | image hosting + model storage; **runner needs none** (uses presigned URLs) |
| **Retire** | `CV_WORKER_URL` | no longer used after cutover |

## 8. Security
- **Least-privilege PAT** (fine-grained, two scopes) stored only in Vercel.
- **Runner holds no R2 credentials** — BIMS hands it public image URLs to read and a
  short-lived presigned PUT to write the model. Smaller blast radius.
- **Manifest + callback authed** by `TRAIN_CALLBACK_SECRET` (constant-time compare);
  callback validates `projectId`/`version` belong to a dispatched run.
- Concurrency guard (`cancel-in-progress`) so a re-click can't double-train.

## 9. Risks & limits
- **GitHub minutes:** free + unlimited on **public** repos; **2,000 min/mo** free on
  private. PaDiM trains in minutes, so private is fine for normal use — but if the
  repo is private and training is frequent, watch the quota. (Decision needed — §11.)
- **Vercel function size:** `onnxruntime` + `numpy` + `pillow` ≈ tens of MB, well
  under the limit; the model loads from R2 to `/tmp` at runtime (not bundled).
- **Cold start** on first inference after idle (Fluid compute reduces this); capture
  inference is already fire-and-forget, so latency is non-blocking.
- **PaDiM RAM** on a 7 GB runner is fine for the dataset sizes here; revisit if image
  counts grow large.

## 10. Rollout
1. Land `github-dispatch.ts`, the workflow, `train_cli.py`, manifest + callback
   endpoints; rewrite `/api/cv/train` (behind the same button).
2. Set the three Vercel env vars + two GitHub secrets + create the PAT.
3. Land `api/ml/infer.py`; repoint `run-inference.ts`; retire `CV_WORKER_URL`.
4. End-to-end test on `dev` preview: label → Train → runner → model in R2 →
   promote → capture shows PASS/FAIL. Then merge to `main`.

## 11. Open questions
1. **Repo visibility** — is `Bioscale_Operations_System_V2` public or private? Drives
   whether Actions minutes are unlimited or capped at 2,000/mo. (If private + heavy
   use, consider a dedicated public training repo holding only the workflow.)
2. **Who owns the PAT?** Recommend a machine/service account over a personal one.
3. **Model upload** — presigned R2 PUT (preferred) vs runner POSTs bytes to
   `train-complete` (simpler, but larger callback payload). Confirm during 5.3.
4. Keep `services/cv-worker/main.py` for local dev, or delete entirely?

## Appendix — sources
- GitHub Actions limits / billing — https://docs.github.com/en/actions/reference/limits
- GitHub MLOps pipeline guidance — https://github.blog/enterprise-software/ci-cd/streamlining-your-mlops-pipeline-with-github-actions-and-arm64-runners/
- Vercel Functions limits — https://vercel.com/docs/functions/limitations
- Vercel Fluid compute — https://vercel.com/docs/fluid-compute
- Fine-grained PAT dispatch — https://www.eliostruyf.com/dispatch-github-action-fine-grained-personal-access-token/
- REST: workflow/repository dispatch — https://docs.github.com/en/rest/actions/workflows

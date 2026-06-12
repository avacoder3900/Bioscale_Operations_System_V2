# PROD-API-NAMESPACE-FIX — Reclaim `/api/*` from Vercel's root-`api/` collision

**Date:** 2026-06-12 · **Owner:** Jacob · **Status:** Approved (conversation 2026-06-12)
**Depends on:** none · **Unblocks:** OT2-BRIDGE-1/2 callbacks, wax one-button Start Run

## Problem

Every dynamic `[param]` API endpoint (a `+server.ts` nested under a bracket dir)
returns a framework-level **404 at the Vercel edge** in production
(`x-vercel-error: NOT_FOUND`, `x-vercel-id: cle1::` only — the request never
reaches a serverless function). Static `/api` routes and dynamic *page* routes
work normally (`cle1::pdx1::`). This silently breaks the OT-2 bridge: the daemon
drives the robot fine, but its result/progress callbacks
(`/api/agent/ot2/commands/[id]/result`, `/progress`) 404, so BIMS never records
command outcomes — and the wax-filling Start Run (deck-scan + sweep `[id]`
round-trips) cannot complete.

**Root cause (confirmed):** the repo has a **root-level `api/` directory**
(`api/ml/infer.py` — a legacy Vercel Python ONNX inference function — and
`api/requirements.txt`), declared in `vercel.json` `functions`. When a project
has a root `api/` dir with serverless functions, Vercel **reserves the entire
`/api/*` URL namespace** and applies legacy literal-path routing: it matches
`/api/.../<value>` against the literal `[id]` folder, fails, and 404s instead of
falling through to SvelteKit's "match any segment" regex routes. Static `/api`
routes survive (exact path match); dynamic pages survive (not under `/api`).

This is why the bug is invisible locally: `npm run build` runs only the SvelteKit
adapter and produces a correct routing table; Vercel additionally builds the root
Python function and merges it, hijacking `/api/*`. Confirmed by a preview deploy
(`test/remove-root-api`, 4fcd67c) that deletes the root `api/` dir — on that
preview every dynamic endpoint flipped 404 → 401, including ones never touched by
the earlier `split:true` workaround.

## Design

### 1. Remove the root `api/` directory and its vercel.json declaration

- Delete `api/ml/infer.py` and `api/requirements.txt` (the whole root `api/`
  dir). This is the single change that makes Vercel stop reserving `/api/*`.
- Remove the `"functions": { "api/ml/infer.py": {...} }` block from
  `vercel.json`. Keep the `crons` block unchanged (those are SvelteKit routes
  under `/api/cron/*` and are unaffected).

The Python function is safe to delete: CV inference moved **in-process** months
ago (`cv-bridge.ts`: "now runs entirely in-process via cv-classifier, no outside
service required"). The active capture→inference path never calls it. The only
code reference is the `/api/cv/infer` route, rewired below.

### 2. Revert the `split:true` workaround

Commit `6ef0a73` added `export const config = { split: true }` to 5 endpoints as
an attempted (failed) workaround. With the namespace collision gone it is
unnecessary and would only add cold-starts. Restore each file:

- `api/agent/ot2/commands/[id]/result/+server.ts` — remove the config export
- `api/agent/ot2/commands/[id]/progress/+server.ts` — remove the config export
- `api/scanner-position-sets/[id]/deck-position/+server.ts` — remove the config export
- `api/traceability/cartridge/[cartridgeId]/+server.ts` — remove the config export
- `api/scanner/sweep/[id]/+server.ts` — restore to `export const config = { maxDuration: 60 }`

### 3. Rewire `/api/cv/infer` to in-process inference

`src/routes/api/cv/infer/+server.ts` currently POSTs to the (now-deleted) Python
function at `env.CV_INFER_URL || \`${url.origin}/api/ml/infer\``. Rewire it to
call the in-process `runInference(imageUrl, projectId, threshold)` from
`cv-bridge.ts` (the same function the auto-capture path uses), mapping its result
onto the `CvInspection` record. Drops the dead HTTP dependency
(`CV_INFER_URL` / `ML_INFER_SECRET` no longer needed by this route) while keeping
the manual one-off inference capability.

## Out of scope

- The `run-inference.ts` `modelPath` vs `projectId` auto-inference bug — covered
  by the companion PRD **CV-INFERENCE-PROJECTID-FIX**.
- Relocating ONNX inference to a separate Vercel project — not needed; inference
  is in-process. If a Python inference service is ever wanted again, it must live
  in its OWN Vercel project (own domain) and be wired via `CV_INFER_URL`, never
  back in this project's root `/api`.
- The remaining 61 dynamic endpoints need no per-file change — removing the root
  `api/` fixes the whole class at once.

## Acceptance

- After deploy, dynamic `/api/.../<value>` endpoints return their real status
  (401/405/400, `cle1::pdx1::`) instead of 404 — verified by curl probe of
  `/api/scanner/sweep/<x>`, `/api/agent/ot2/commands/<x>/result|progress`,
  `/api/traceability/cartridge/<x>`, `/api/box/files/<x>`,
  `/api/opentrons-lab/robots/<x>/health`.
- OT-2 bridge daemon journal shows result/progress POSTs returning 200.
- Static `/api` routes, dynamic pages, and crons still work.
- `npm run check` clean vs baseline; `npm run build` succeeds.

# CV-INFERENCE-PROJECTID-FIX — Pass projectId (not modelPath) to in-process inference

**Date:** 2026-06-12 · **Owner:** Jacob · **Status:** Approved (conversation 2026-06-12)
**Depends on:** none (independent of PROD-API-NAMESPACE-FIX)

## Problem

Capture-triggered CV inference always fails. `src/lib/server/cv/run-inference.ts`
calls the in-process inference helper with the wrong argument:

```ts
// run-inference.ts (runOne)
const result = await runInference(ctx.imageUrl, modelPath, confidenceThreshold);
```

but `cv-bridge.ts` `runInference` expects a **project id**, which it uses to load
the trained classifier:

```ts
// cv-bridge.ts — JSDoc: "the param is the project id"
export async function runInference(imageUrl: string, projectId: string, confidenceThreshold?: number) {
  const project = await CvProject.findById(projectId)...
  if (!project) throw new Error(`Project ${projectId} not found`);
  ...
}
```

`modelPath` (e.g. `cv/<projectId>/models/model.onnx`) is not a project id, so
`findById` returns null, `runInference` throws "Project not found", and the
`CvInspection` is marked `failed`. Inference is fire-and-forget (errors caught
and logged), so the failure is silent — no auto-inspection ever completes.

This is a pre-existing bug, surfaced during the PROD-API-NAMESPACE-FIX impact
analysis. It is independent of the Vercel routing fix.

## Design

In `runOne` (`src/lib/server/cv/run-inference.ts`), pass the project id, not the
model path:

```ts
const result = await runInference(ctx.imageUrl, project._id, confidenceThreshold);
```

`project` is already in scope (passed into `runOne`). `modelPath` / `version`
remain used for the `CvInspection` record's `modelPath` / `modelVersion` fields —
only the `runInference` argument changes. `runInference` re-fetches the project by
id and loads `classifier.weights` itself, so no other plumbing changes.

## Out of scope

- The `/api/cv/infer` route rewire (handled in PROD-API-NAMESPACE-FIX).
- Any change to the embedding/classifier maths in `cv-classifier.ts`.
- Reconciling the `anomaly_score` field (the in-process `InferenceResult` has no
  `anomaly_score`; `run-inference.ts` assigning `result.anomaly_score` simply
  yields `undefined`, which the schema tolerates — left as-is).

## Acceptance

- A captured image at a phase with a deployed, trained project produces a
  `CvInspection` with `status: 'completed'` and a real `confidenceScore`/`result`
  (instead of `status: 'failed'`, "Project not found").
- `npm run check` clean vs baseline.

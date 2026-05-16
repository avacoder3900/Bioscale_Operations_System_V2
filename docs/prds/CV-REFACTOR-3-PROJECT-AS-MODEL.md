# PRD: CV Refactor — Project as Trainable + Deployable Model

**Author:** Jacob Quick (decisions) + Claude (drafted)
**Date:** 2026-05-16
**Status:** Draft → ready to implement
**Priority:** P1 — Required for the inference loop to actually deploy
**Branch:** `feature/cv-followups`
**Depends on:** [PRD 1 — Image Model](./CV-REFACTOR-1-IMAGE-MODEL.md), [PRD 2 — Capture Pipeline](./CV-REFACTOR-2-CAPTURE-PIPELINE.md)

---

## 1. Problem

Today a CvProject is an image container. After PRD 1's schema change it's a training set with no deployment story. We need:

- **Training**: pick a set of labeled images, train a PaDiM model, store the ONNX artifact.
- **Deployment**: declare "this model runs at phase X." When a capture lands at phase X, auto-run inference.
- **Versioning**: every retrain produces a new model artifact; old artifacts are never overwritten. Every inspection records which model version made the decision.
- **A/B / shadow**: a project can have an `activeModelVersion` (production) and a `shadowModelVersion` (parallel inference for evaluation only). Operator promotes shadow → active when ready.
- **Composability**: training-set membership can be drawn from other projects, snapshot or live.

## 2. Decisions

| # | Decision |
|---|---|
| 1 | **CvProject owns members + composition + deployment.** Self-contained unit. |
| 2 | **Members are explicit imageIds.** Snapshot mode: `members[]` is the frozen list. |
| 3 | **Live composition via `composedOf: [projectIds]` + `isLiveComposition: true`.** At training time, members are flattened as `union(members, ...composedOf.map(p => p.members))`. |
| 4 | **PaDiM only for v1.** `projectType` field collapsed; only anomaly detection. Pickable architectures (PatchCore, EfficientAD) can come later. |
| 5 | **`trainedModels: []` is append-only.** Every training run produces a new entry. ONNX written to R2 with a versioned key. |
| 6 | **`activeModelVersion` designates the production model.** Inference reads this. |
| 7 | **`shadowModelVersion` is optional; if set, runs in parallel.** Both decisions stored on each CvInspection. |
| 8 | **`deployAtPhases: [String]` declares deployment.** When a capture lands at phase X, every project with `deployAtPhases` including X runs inference. |
| 9 | **Multiple projects can deploy at the same phase.** That's fine — each produces its own CvInspection record. |
| 10 | **Inference is fire-and-forget on capture.** Capture endpoint returns immediately; inference happens async; results land on CvInspection later, polled by UI if needed. |

## 3. Schema additions (over what PRD 1 already specs)

PRD 1 already added `members[]`, `composedOf[]`, `isLiveComposition`, `deployAtPhases`, `trainedModels[]`, `activeModelVersion`, `shadowModelVersion` to CvProject.

`CvInspection` (`cv_inspections`) — already exists but unused (0 docs). Schema additions:

```typescript
{
  _id: nanoid,
  imageId: { type: String, required: true, index: true },
  cartridgeRecordId: { type: String, required: true, index: true },
  phase: { type: String, required: true },

  projectId: { type: String, required: true, index: true },        // which project's model decided
  modelVersion: { type: String, required: true },                  // NEW: which trainedModels[] version
  modelPath: { type: String, required: true },                     // NEW: R2 key of the ONNX used
  isShadow: { type: Boolean, default: false },                     // NEW: was this a shadow run, not the production decision

  result: { type: String, enum: ['pass', 'fail'], required: true },
  confidenceScore: Number,
  anomalyScore: Number,
  confidenceThreshold: Number,
  defects: [{ /* unchanged */ }],

  status: { type: String, enum: ['queued', 'running', 'completed', 'failed'], default: 'queued' },
  processingTimeMs: Number,
  errorMessage: String,

  triggeredBy: { type: String, enum: ['auto-on-capture', 'manual', 'batch'], default: 'auto-on-capture' },
  triggeredAt: { type: Date, default: Date.now },
  completedAt: Date,
}
```

## 4. Composition resolution

A helper `resolveProjectMembers(projectId)` does:

```typescript
async function resolveProjectMembers(projectId: string): Promise<string[]> {
  const project = await CvProject.findById(projectId).lean();
  if (!project) throw new Error('Project not found');

  const direct = new Set(project.members ?? []);

  if (project.isLiveComposition && project.composedOf?.length) {
    for (const childId of project.composedOf) {
      const childMembers = await resolveProjectMembers(childId); // recursive — depth limit needed
      for (const id of childMembers) direct.add(id);
    }
  }

  return [...direct];
}
```

**Guardrails:**
- Recursion depth limit of 5 (prevents cycles).
- Cycle detection via visited-set passed down the recursion.
- Snapshot projects (`isLiveComposition: false`) don't recurse — `composedOf` is ignored at read time; was only used at project-creation time to seed `members[]`.

## 5. API

### `POST /api/cv/projects/:id/train` (UPDATED)

- Resolves members via `resolveProjectMembers`.
- Pulls full `CvImage` docs for those IDs, filters for `qcLabel != null` (only labeled images train).
- Builds payload for Python cv-worker: `{ project_id, imageUrls, labels, modelOutputKey }`.
- `modelOutputKey` is versioned: `models/{projectId}/{timestamp}-{shortHash}.onnx`.
- Records `trainedModels[]` entry with `sampleSnapshot: [labeledImageIds]` for replay.
- Sets project's `modelStatus` derived state (in-progress, then completed/failed via cv-worker polling).
- Does NOT touch `activeModelVersion` — that's a separate "promote" action.

### `POST /api/cv/projects/:id/promote` (NEW)

```json
{ "version": "2026-05-16T14-30_a3f8" }
```

Sets `activeModelVersion` to the given version. Validates it exists in `trainedModels[]`. Clears `shadowModelVersion` if it matches. AuditLog entry.

### `POST /api/cv/projects/:id/set-shadow` (NEW)

```json
{ "version": "2026-05-16T14-30_a3f8" }
```

Sets `shadowModelVersion`. From now until cleared, every inference for this project also runs the shadow model in parallel, storing both decisions on CvInspection (with `isShadow: true` flag on the shadow one).

### `POST /api/cv/phase-inference` (NEW — called by `/api/cv/capture`)

Internal endpoint, fired async after capture lands. Body: `{ imageId, cartridgeRecordId, phase }`.

Behavior:
1. Find all projects where `deployAtPhases` includes `phase` AND `activeModelVersion != null`.
2. For each project:
   - Fetch active model `modelPath` from `trainedModels`.
   - POST to cv-worker `/infer` with `{ image_url, model_path }`.
   - Insert CvInspection doc with `isShadow: false`, status `queued` → `running` → `completed`.
3. If project also has `shadowModelVersion`:
   - Same as above with `isShadow: true`.
4. All async; capture response doesn't wait.

### `POST /api/cv/infer` (KEEP — manual one-off inference)

Still exists for ad-hoc "rerun this image against this project's model." Behavior:
- Takes `imageId` + `projectId`, optional `version` (defaults to `activeModelVersion`).
- Same flow as `/api/cv/phase-inference` but for one image, optionally synchronous.

## 6. Files

| File | Action |
|---|---|
| `src/lib/server/db/models/cv-project.ts` | UPDATE — already done in PRD 1 |
| `src/lib/server/db/models/cv-inspection.ts` | UPDATE — add modelVersion, modelPath, isShadow, triggeredBy |
| `src/lib/server/cv/resolve-project-members.ts` | NEW — composition resolver |
| `src/routes/api/cv/projects/[id]/train/+server.ts` | UPDATE — use resolver, version the model |
| `src/routes/api/cv/projects/[id]/promote/+server.ts` | NEW |
| `src/routes/api/cv/projects/[id]/set-shadow/+server.ts` | NEW |
| `src/routes/api/cv/phase-inference/+server.ts` | NEW — internal trigger |
| `src/routes/api/cv/capture/+server.ts` | UPDATE — fire phase-inference async |
| `src/routes/api/cv/infer/+server.ts` | UPDATE — optional version param |
| `src/lib/server/cv/run-inference.ts` | NEW — shared helper (used by phase-inference + infer) |

## 7. Implementation phases

1. **Phase 1: Composition resolver.** Pure function, write + test in isolation.
2. **Phase 2: Versioned training.** Update `/api/cv/projects/[id]/train` to version the model key, append to `trainedModels[]`. Don't touch activeModelVersion.
3. **Phase 3: Promote/set-shadow endpoints.** Simple writes.
4. **Phase 4: Auto-inference on capture.** Wire `/api/cv/phase-inference` and fire it from `/api/cv/capture`.
5. **Phase 5: Shadow mode.** Add shadow run alongside active in `phase-inference`.

## 8. Acceptance

- [ ] Training a project produces a versioned `trainedModels[]` entry; old versions never overwritten.
- [ ] `sampleSnapshot` on each trained model lists the exact imageIds used.
- [ ] Promoting a version flips `activeModelVersion`; production inference uses the promoted version immediately.
- [ ] Setting a shadow version causes a second inference per capture, stored with `isShadow: true`.
- [ ] A capture at phase X triggers inference for every project with `deployAtPhases` including X.
- [ ] Composed projects (live) flatten their members at training time, including children's children up to depth 5.
- [ ] Cycle in `composedOf` is detected and rejected with a clear error.
- [ ] CvInspection records the modelVersion + modelPath for every decision — DHR / audit can replay any historical decision.

## 9. Out of scope

- Pickable model architecture (PaDiM vs PatchCore vs EfficientAD) — future
- GPU inference — future
- Multi-class classification, object detection — future
- Re-labeling images within a project context (per-project labels) — future
- Automatic retraining on schedule — future

# CV Clean Data Path — Architecture & Field Mapping

**Branch:** `feat/cv-clean-datapath` · **Date:** 2026-07-06
**Principle:** `cartridge_records` owns photos and human QC truth. `cv_*` collections organize models and machine outputs only. No duplicated truth anywhere.

## The dedicated pathway

```
CAPTURE            /api/cv/capture → R2 upload → cartridge_records.photos[] entry (truth)
                                              → cv_images row (technical/derived only)
LABEL              /api/cv/images/[id]/label + /tags + /highlight
                   → targeted $set on photos.$[p] (qcLabel / labels / notes / annotations)
TRAIN              /api/cv/train → cv-bridge.triggerTraining:
                   photos[] where phase ∈ project.phases and qcLabel ≠ null
                   → embeddings via cv_images cache → LR fit + stratified holdout
                   → CvProject.trainedModels[] push + activeModelVersion
INFER              runPhaseInference on capture → active (+ shadow) model
                   → cv_inspections (machine verdict only)
REVIEW             join cv_inspections × photos[].qcLabel by imageId
```

## Collections after the rework

| Collection | Role | Key fields |
|---|---|---|
| `cartridge_records.photos[]` | **Photo record of truth** | imageId, phase, capturedAt, capturedBy, r2Key, r2Url, cartridgeImageNumber, **qcLabel** (approved/rejected/null), qcLabeledBy/At, **labels[]** (from failure_labels vocab), **notes**, **annotations[]** {x,y,w,h,tag,color,savedBy,savedAt} |
| `cv_projects` | Model organizer | name, description, projectType, **phases[]** (training + deployment scope, ONE field), modelStatus, trainingError, **trainedModels[]** {version, trainedAt, trainedBy, classifier{weights,bias,featureMeans,featureStds,calibrationMin/Max,embeddingDim,embeddingVersion}, samplesUsed, approvedCount, rejectedCount, trainingAccuracy, trainingLogLoss, holdoutAccuracy, holdoutF1, holdoutSamples, confidenceThreshold}, activeModelVersion, shadowModelVersion, confidenceThreshold, captureSettings |
| `cv_inspections` | Machine verdicts ONLY | imageId, cartridgeRecordId, phase, projectId, modelVersion, isShadow, status (**running/completed/failed** — one vocabulary), errorMessage, result (pass/fail), passProbability, confidenceScore, threshold, triggeredBy, triggeredAt, processingTimeMs, completedAt |
| `cv_images` | Derived/technical cache (1:1 with photos[].imageId) | cartridgeRecordId, phase, filename, width, height, fileSizeBytes, cameraIndex, metadata, processingMode/Params/processedAt, **embedding[]**, embeddingVersion, embeddedAt |
| `failure_labels` | THE defect-tag vocabulary | text (unique, case-insensitive) |

**Deleted:** `cv_samples` (+ routes), `/api/cv/process-image`, GH Actions trainer (`train-cv-model.yml`, `services/cv-worker`, `github-dispatch.ts`).

## Old field → new source (for rewiring consumers)

| Old (read/written) | New source of truth |
|---|---|
| `CvImage.qcLabel` / `qcLabeledBy` / `qcLabeledAt` | `photos[].qcLabel` / `.qcLabeledBy` / `.qcLabeledAt` |
| `CvImage.cartridgeTag.labels` | `photos[].labels` |
| `CvImage.cartridgeTag.notes` | `photos[].notes` |
| `CvImage.cartridgeTag.cartridgeRecordId` | `photos[]` is ON the cartridge; CvImage keeps `cartridgeRecordId` (top-level) for reverse lookup |
| `CvImage.cartridgeTag.phase` | `photos[].phase` (CvImage keeps top-level `phase` copy for cache queries) |
| `CvImage.imageUrl` / `filePath` | `photos[].r2Url` / `.r2Key` |
| `CvImage.thumbnailPath` / `processedPath` | dropped — display uses `photos[].r2Url` |
| `CvImage.capturedAt` / `capturedBy` / `cartridgeImageNumber` | `photos[].capturedAt` / `.capturedBy` / `.cartridgeImageNumber` |
| `CvImage.metadata.highlight.boxes` | `photos[].annotations` |
| `CvImage.label` / `projectId` / `sampleId` (legacy, undeclared) | dead — remove the code |
| `CvInspection.humanLabel` / `reviewedBy` / `reviewedAt` | `photos[].qcLabel` (join by imageId; pass≈approved, fail≈rejected) |
| `CvInspection.defects[]` / `anomalyScore` / `modelPath` / `sampleId` / `inspectionType` | dropped |
| `CvInspection.status` 'pending'/'processing'/'complete' | `'running'` / `'completed'` |
| `CvProject.deployAtPhases` | `phases` |
| `CvProject.classifier` (single) / `modelVersion` | `trainedModels[]` entry + `activeModelVersion` |
| `CvProject.members[]` / `composedOf[]` / `isLiveComposition` / `purpose` | dropped — training set is derived from phases + qcLabel, not curated membership |
| `CvProject.labels[]` / `tags[]` | dropped — vocabulary is `failure_labels` |
| `CvProject.imageCount` / `annotatedCount` | dropped — aggregate `photos[]` when needed |

## Query recipes

Training set / labeled photos for phases P:
```js
CartridgeRecord.aggregate([
  { $match: { 'photos.qcLabel': { $in: ['approved','rejected'] } } },
  { $unwind: '$photos' },
  { $match: { 'photos.phase': { $in: P }, 'photos.qcLabel': { $in: ['approved','rejected'] } } }
])
```
Photo by imageId: `CartridgeRecord.findOne({ 'photos.imageId': id })` (indexed). Targeted truth write: `updatePhotoTruth()` in `src/lib/server/cv/photo-truth.ts` — the ONLY sanctioned write path for photo QC fields.

Indexes added on cartridge_records: `photos.imageId`, `photos.qcLabel+photos.phase`, `photos.labels`.

## Sacred-model note
`applySacredMiddleware` only blocks updates when `finalizedAt` is set (currently orphaned — never written) and hard-blocks deletes. Photo-truth writes are targeted `$set` on `photos.$[p].*` subpaths and pass. If cartridge finalization is ever activated, decide then whether QC-label subpaths get an exemption or flow through corrections.

## Migration
`scripts/migrate-cv-labels.ts` (idempotent) copies legacy `cv_images.{qcLabel,qcLabeledBy,qcLabeledAt,cartridgeTag.labels,cartridgeTag.notes,capturedAt,capturedBy,metadata.highlight.boxes}` onto the matching `photos[]` entry by imageId, with `cv_inspections.humanLabel` (pass→approved / fail→rejected) as fallback where no qcLabel exists. Run BEFORE deploying code that reads only the new locations. Legacy fields on cv_images are left in place until verified, then stripped.

# PRD: CV Refactor — Image Model (Cartridge-First)

**Author:** Jacob Quick (decisions) + Claude (drafted)
**Date:** 2026-05-15
**Status:** Draft → ready to implement
**Priority:** P0 — Foundation for all other CV refactor work
**Branch:** `feature/cv-followups`

---

## 1. Problem

The CvImage model is project-first: every image **requires** a `projectId`, capture endpoints 400 without one, and "induction" auto-creates a `CartridgeRecord` if a CV scan sees an unknown QR. This is backwards. An image is **of a cartridge**. Project membership should be a curation act, not a precondition for the image to exist.

The current label enum (`'approved' | 'rejected' | null`) is treated as semantic identity — gallery filters on it, training reads it, the master model is built around it. Labels are useful, but they are not what makes an image meaningful.

## 2. Decisions

| # | Decision |
|---|---|
| 1 | **`CvImage.projectId` removed.** Images do not belong to any project at capture time. |
| 2 | **`cartridgeTag.cartridgeRecordId` becomes required.** Every image is anchored to a manufactured cartridge. |
| 3 | **Induction is dead.** If a capture's QR doesn't match a `CartridgeRecord`, the endpoint rejects with `Cartridge not found`. No auto-creation. |
| 4 | **Labels demoted.** Rename `CvImage.label` → `qcLabel`. Still optional. Image's identity is now `cartridge + phase + capturedAt`, not its label. |
| 5 | **Human-readable image numbers.** New field `cartridgeImageNumber` like `CART-000123_001`. Atomic counter on `CartridgeRecord.photoSequence`. |
| 6 | **`CvProject` becomes a training set + deployment target.** Adds `members[]`, `composedOf[]`, `deployAtPhases[]`, versioned `trainedModels[]`. Drops `isMasterModel`. |
| 7 | **Projects are composable.** A project can `composedOf` other projects; composition is live (default) or snapshot. |
| 8 | **No "Master Model" singleton.** The master concept is replaced by a regular project named "Master" with `composedOf: [every other project]` and `isLiveComposition: true`. |

## 3. Schema diff

### `CvImage` (`cv_images`)

```typescript
{
  _id: { type: String, default: nanoid }, // unchanged

  // Identity — cartridge-first
  cartridgeTag: {
    cartridgeRecordId: { type: String, required: true, index: true }, // CHANGED: required
    phase: { type: String, required: true },                          // CHANGED: required
    labels: [String],   // free-text descriptive tags (unchanged)
    notes: String,      // unchanged
    _id: false
  },
  cartridgeImageNumber: { type: String, index: true }, // NEW: e.g. "CART-000123_001"

  // Where the pixels live
  filename: String,         // unchanged
  filePath: String,         // unchanged (R2 key)
  thumbnailPath: String,    // unchanged
  imageUrl: String,         // unchanged
  width: Number,            // unchanged
  height: Number,           // unchanged
  fileSizeBytes: Number,    // unchanged
  cameraIndex: Number,      // unchanged

  // Processing pipeline
  processedPath: String,           // unchanged
  processingMode: { type: String, enum: ['full', 'raw', null] }, // unchanged
  processingParams: { /* unchanged LIZA params */ },
  processedAt: Date,               // unchanged

  // Capture metadata
  capturedAt: Date,                // unchanged
  capturedBy: { _id: String, username: String }, // NEW: who triggered capture

  // QC label — demoted to side field
  qcLabel: { type: String, enum: ['approved', 'rejected', null], default: null }, // RENAMED from `label`
  qcLabeledBy: { _id: String, username: String, _id: false },                     // NEW
  qcLabeledAt: Date,                                                              // NEW

  // REMOVED FIELDS
  // projectId          — images don't belong to projects
  // sampleId           — unused everywhere, drop it
  // label              — renamed to qcLabel
}
```

### `CvProject` (`cv_projects`)

```typescript
{
  _id: { type: String, default: nanoid },
  name: { type: String, required: true },
  description: String,
  purpose: String,
  tags: [String],

  // Training set composition
  members: [String],          // NEW: explicit imageIds (snapshot mode)
  composedOf: [String],       // NEW: projectIds (live mode unions their members at read time)
  isLiveComposition: { type: Boolean, default: false }, // NEW: live vs snapshot

  // Model deployment config
  deployAtPhases: [String],   // NEW: manufacturing phases where this project's model runs

  // Versioned model registry — append-only
  trainedModels: [{           // NEW
    version: String,            // ISO timestamp + short hash, e.g. "2026-05-15T14-30_a3f8"
    modelPath: String,          // R2 key for the ONNX
    trainedAt: Date,
    trainedBy: { _id: String, username: String, _id: false },
    sampleCount: Number,        // images used at training time
    sampleSnapshot: [String],   // imageIds frozen at training (audit + replay)
    confidenceThreshold: Number,
    _id: false
  }],
  activeModelVersion: { type: String, default: null }, // NEW: version currently used for production inference
  shadowModelVersion: { type: String, default: null }, // NEW: version running in parallel for A/B

  // Capture settings (LIZA params) — unchanged
  captureSettings: { /* unchanged */ },

  // REMOVED FIELDS
  // isMasterModel       — composition replaces singleton flag
  // imageCount          — derive from members.length (+ composedOf flatten)
  // annotatedCount      — derive from members where qcLabel != null
  // phases              — replaced by deployAtPhases
  // labels              — unused after refactor (free-text descriptors moved to image notes)
  // projectType         — only anomaly_detection works; field hardcoded going forward
  // modelStatus         — derive from trainedModels.length + activeModelVersion
  // modelVersion        — replaced by activeModelVersion
  // confidenceThreshold — moved into each trainedModels[] entry (per-model threshold)
}
```

### `CartridgeRecord` (`cartridge_records`) — additive

```typescript
{
  /* all existing fields unchanged */
  photoSequence: { type: Number, default: 0 } // NEW: atomic counter for cartridgeImageNumber generation
}
```

## 4. Migration plan

The destructive wipe has already happened (commit `1073cdb`): all 27 projects deleted, all 1445 images now have `projectId: null`. Ledger preserved at `docs/CV-PROJECT-LEDGER-2026-05-16T02-41-34.md`.

What remains:

1. **Drop the `projectId` field on existing images.** Mongo `$unset`. ~1445 docs.
2. **Rename `label` → `qcLabel`** via `$rename`. Same 1445 docs.
3. **Backfill `cartridgeImageNumber` for images that have a `cartridgeTag.cartridgeRecordId`.** ~581 docs affected. For each, look up the cartridge's current `photoSequence`, atomically increment, format as `{cartridgeId}_{seq:03}`.
4. **Decide on the 864 images with no cartridge tag.** Options:
   - (a) Leave them as-is — they have `qcLabel`, filenames, R2 URLs. They're floating R&D pixels. Searchable in `/cv/stream`, just won't appear in any cartridge timeline.
   - (b) Soft-tag them with a sentinel cartridge `_orphan` so they have a home.
   - (c) Delete them.
   - **Recommend (a)** — they're real data captured for experiments. Don't delete. `/cv/stream` shows them under a "no cartridge" group.
5. **Drop sample-related fields** (`sampleId` from `CvImage`, `cv_samples` collection — it has 0 docs).
6. **Add `photoSequence: 0` to existing `CartridgeRecord` docs** via `$set` with `{ photoSequence: { $exists: false } }` filter. Idempotent.

Script: `scripts/migrate-cv-image-model.ts` (will create).

## 5. API impact

Endpoints that need updates:

| Endpoint | Change |
|---|---|
| `POST /api/cv/images/presign` | `projectId` becomes optional. Still required if caller wants the file to land at a specific project's R2 prefix (legacy). Otherwise routes to `cv/captures/dhr/...` keys. |
| `POST /api/cv/images/record` | `projectId` optional. `cartridgeTag` becomes required. Validates cartridge exists. Atomic increment of `photoSequence` to mint `cartridgeImageNumber`. |
| `POST /api/cv/capture-ingest` (lab Python) | Silently ignores `projectId`. `cartridgeTag` becomes required. Returns `400 Cartridge not found` if QR doesn't match. |
| `POST /api/cv/induct-cartridge` | **DELETED**. Induction is gone. |
| `POST /api/cv/capture` (new) | One-shot capture: file + cartridgeId + phase. No projectId. Replaces presign+record for new flows. |

## 6. Implementation order

1. Write models: `cv-image.ts`, `cv-project.ts`, `cartridge-record.ts` schema updates.
2. Write the migration script `scripts/migrate-cv-image-model.ts`. Dry-run first; verify counts.
3. Run the migration.
4. Update the 4 endpoints above.
5. Delete `/api/cv/induct-cartridge/+server.ts`.
6. Verify with audit that:
   - Every image with `cartridgeTag.cartridgeRecordId` has a `cartridgeImageNumber`.
   - No image has a non-null `projectId`.
   - `qcLabel` field exists (even if null).
7. Run `npm run check`. Should be green or only have pre-existing errors.

## 7. Acceptance

- [ ] CvImage.projectId no longer exists on any document.
- [ ] `cartridgeTag.cartridgeRecordId` is required at the schema level.
- [ ] `cartridgeImageNumber` populated for every image that has a cartridge tag.
- [ ] `CartridgeRecord.photoSequence` exists and is incremented atomically on new captures.
- [ ] `qcLabel` replaces `label`; all 100 labeled images preserve their label value.
- [ ] `/api/cv/induct-cartridge` returns 404 (route deleted).
- [ ] Endpoints reject captures with QR not matching a CartridgeRecord.
- [ ] No existing test or page that touched CvImage breaks (graceful empty-state at minimum).

## 8. Out of scope

- New /capture page UI (PRD 2)
- Project members/composedOf training UI (PRD 3)
- /cv/stream and /cv/label admin pages (PRD 4)
- Phase-X auto-inference wiring (PRD 3)

# PRD: iCast CV → BIMS V2 Migration

**Date:** 2026-03-26  
**Author:** Agent001 (from Alejandro Valdez request)  
**Branch:** `feature/cv-migration` (create from dev)  
**Priority:** High — consolidate CV pipeline into single platform  
**Approach:** Hybrid — BIMS owns UI + data, Python microservice owns ML training/inference

---

## Architecture

```
BIMS V2 (SvelteKit on Vercel)          Python CV Service (Mac mini / Fly.io)
┌─────────────────────────────┐        ┌──────────────────────────┐
│ UI: Projects, Gallery,      │        │ POST /train              │
│      Training, Inspections  │───────►│ POST /infer              │
│ Data: MongoDB (bioscale db) │        │ GET  /status             │
│ Storage: R2 via @aws-sdk    │        │ PaDiM + ONNX runtime     │
│ API: /api/cv/*              │        │ Reads images from R2     │
└─────────────────────────────┘        └──────────────────────────┘
         │                                      │
         └──────────── Cloudflare R2 ───────────┘
                    (brevitest-cv bucket)
```

---

## User Stories — Parallel Execution Plan

### File Ownership Map (prevents agent conflicts)

| Agent | Files Owned (EXCLUSIVE) | Shared (READ ONLY) |
|---|---|---|
| **Agent A — Models** | `src/lib/server/db/models/cv-*.ts`, `src/lib/server/db/models/index.ts` (CV exports only) | — |
| **Agent B — R2 Service** | `src/lib/server/services/r2.ts`, `src/lib/server/services/r2-types.ts`, `.env` (R2 vars only) | Models from Agent A |
| **Agent C — API Routes** | `src/routes/api/cv/**` (all files) | Models (A), R2 (B) |
| **Agent D — Projects UI** | `src/routes/cv/projects/**`, `src/routes/cv/+page.*` (dashboard rewrite) | API routes (C) |
| **Agent E — Gallery + Training UI** | `src/routes/cv/gallery/**`, `src/routes/cv/training/**` | API routes (C), R2 (B) |
| **Agent F — Inspect + History UI** | `src/routes/cv/inspect/**`, `src/routes/cv/history/**`, `src/routes/cv/cartridge/**` | API routes (C) |
| **Agent G — Python Bridge** | `services/cv-worker/**` (new dir at repo root), `src/routes/api/cv/train/**`, `src/routes/api/cv/infer/**` | Models (A), R2 (B) |

### Execution Order

```
Phase 1 (parallel):  A (Models) + B (R2 Service)
                         ↓
Phase 2 (parallel):  C (API Routes) + G (Python Bridge)
                         ↓
Phase 3 (parallel):  D (Projects UI) + E (Gallery/Training UI) + F (Inspect/History UI)
```

Agents in the same phase can run simultaneously. Each phase waits for the prior phase to complete.

---

## Phase 1 — Foundation (No Dependencies)

### S1 — MongoDB Models (Agent A) ⚡ CRITICAL
**Create Mongoose models mirroring iCast's MongoDB collections.**

**New files:**
- `src/lib/server/db/models/cv-project.ts`
- `src/lib/server/db/models/cv-image.ts`
- `src/lib/server/db/models/cv-sample.ts`
- `src/lib/server/db/models/cv-inspection.ts`
- Update `src/lib/server/db/models/index.ts` — add CV exports

**Schema reference (from iCast Python models):**

**CvProject:**
```
_id: String (nanoid)
name: String (required)
description: String
projectType: enum ['classification', 'anomaly_detection', 'object_detection']
tags: [String]
phases: [String]  // BIMS manufacturing phases
labels: [{ name: String, color: String }]
imageCount: Number (default 0)
annotatedCount: Number (default 0)
modelStatus: enum ['untrained', 'training', 'trained', 'failed']
modelVersion: String
timestamps: true
```

**CvImage:**
```
_id: String (nanoid)
sampleId: String
projectId: String
filename: String
filePath: String  // R2 key
thumbnailPath: String
width: Number, height: Number, fileSizeBytes: Number
cameraIndex: Number
metadata: Mixed
capturedAt: Date
imageUrl: String  // R2 public URL
cartridgeTag: { cartridgeRecordId: String, phase: String, labels: [String], notes: String }
label: enum ['approved', 'rejected', null]
timestamps: true
```

**CvSample:**
```
_id: String (nanoid)
name: String (required)
description: String
projectId: String
tags: [String]
metadata: Mixed
timestamps: true
```

**CvInspection:**
```
_id: String (nanoid)
sampleId: String
imageId: String
projectId: String
inspectionType: String
status: enum ['pending', 'processing', 'complete', 'failed']
result: enum ['pass', 'fail', null]
confidenceScore: Number
defects: [{ type: String, location: String, severity: String }]
modelVersion: String
processingTimeMs: Number
cartridgeRecordId: String
phase: String
completedAt: Date
timestamps: true
```

**Acceptance Criteria:**
- All 4 models created with proper indexes
- Exported from `models/index.ts`
- Build passes

---

### S2 — Cloudflare R2 Storage Service (Agent B) ⚡ CRITICAL
**Create an S3-compatible storage service for BIMS to upload/download images to R2.**

**New files:**
- `src/lib/server/services/r2.ts`

**Implementation:**
- Use `@aws-sdk/client-s3` (add to dependencies)
- Functions: `uploadToR2(buffer, key, contentType)`, `downloadFromR2(key)`, `deleteFromR2(key)`, `getR2Url(key)`, `listR2Objects(prefix)`
- Read credentials from env: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL`
- Generate thumbnails (256×256 JPEG) on upload using `sharp`
- Return public URL after upload

**Env vars to add to `.env.example`:**
```
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=brevitest-cv
R2_PUBLIC_URL=https://brevitest-cv.7bd6a45ccebc81a14aeac4cdc97030d5.r2.dev
```

**Acceptance Criteria:**
- Upload returns public URL
- Thumbnail generation works
- Graceful fallback if R2 not configured (log warning, skip upload)
- Build passes

---

## Phase 2 — API Layer (Depends on Phase 1)

### S3 — CV API Routes (Agent C)
**Create all CRUD API endpoints for CV models.**

**New files:**
```
src/routes/api/cv/projects/+server.ts          — GET (list), POST (create)
src/routes/api/cv/projects/[id]/+server.ts     — GET, PATCH, DELETE
src/routes/api/cv/projects/[id]/images/+server.ts — GET (images for project)
src/routes/api/cv/images/+server.ts            — POST (upload image)
src/routes/api/cv/images/[id]/+server.ts       — GET, DELETE
src/routes/api/cv/images/[id]/label/+server.ts — PATCH (set approved/rejected)
src/routes/api/cv/samples/+server.ts           — GET, POST
src/routes/api/cv/samples/[id]/+server.ts      — GET, PATCH, DELETE
src/routes/api/cv/inspections/+server.ts       — GET, POST
src/routes/api/cv/inspections/[id]/+server.ts  — GET
```

**Key behaviors:**
- Image upload: accept multipart, store to R2 via service, create CvImage doc, increment project imageCount
- Label endpoint: set `label` field on CvImage, increment/decrement project annotatedCount
- Project delete: cascade delete images, samples, inspections, R2 files
- All routes require auth (`locals.user`)
- Standard error handling with try/catch

**Acceptance Criteria:**
- All CRUD operations work
- Image upload stores to R2 and creates thumbnail
- Labeling updates project annotated count
- Build passes

---

### S4 — Python CV Bridge API (Agent G)
**Create endpoints that proxy training/inference requests to the Python CV service.**

**New files:**
```
src/routes/api/cv/train/+server.ts         — POST (start training), GET (status)
src/routes/api/cv/infer/+server.ts         — POST (run inference on image)
src/lib/server/services/cv-bridge.ts       — HTTP client for Python service
```

**Also create the Python microservice wrapper:**
```
services/cv-worker/main.py         — FastAPI app with /train, /infer, /status
services/cv-worker/requirements.txt
services/cv-worker/Dockerfile
services/cv-worker/README.md
```

**Implementation:**
- `cv-bridge.ts`: Configurable `CV_WORKER_URL` env var (default `http://localhost:8000`)
- Training: POST project config + R2 image URLs → Python service trains PaDiM model → saves ONNX to R2
- Inference: POST image URL → Python service downloads, runs ONNX inference → returns pass/fail + score
- Status: GET returns training progress/status
- Python service is a stripped-down version of iCast's training_service.py + inference.py

**Acceptance Criteria:**
- BIMS can trigger training and poll for status
- BIMS can request inference on a single image
- Python service runs standalone with `uvicorn`
- Dockerfile provided for deployment
- Build passes (TypeScript side)

---

## Phase 3 — UI Pages (Depends on Phase 2)

### S5 — Projects Dashboard + Detail (Agent D)
**Rewrite the CV dashboard and add project management.**

**Files to modify/create:**
```
src/routes/cv/+page.server.ts       — rewrite: load projects from CvProject
src/routes/cv/+page.svelte          — rewrite: project cards grid
src/routes/cv/projects/+page.svelte            — alias/redirect to /cv
src/routes/cv/projects/[id]/+page.server.ts    — load project + images + stats
src/routes/cv/projects/[id]/+page.svelte       — 6-tab project detail:
    Import, Labels, Train, Test, Review, Integrate
```

**UI spec:**
- Dashboard: Grid of project cards showing name, type, image count, model status badge, created date
- Create project modal: name, description, type dropdown, phases checkboxes
- Project detail — 6 tabs:
  - **Import**: Drag-drop image upload, bulk upload, camera capture button
  - **Labels**: Grid of images, click to toggle approved/rejected, bulk label tools
  - **Train**: Show training data stats, "Start Training" button, progress bar, model status
  - **Test**: Upload test image, run inference, show result + confidence + heatmap
  - **Review**: Recent inspections table with pass/fail, confidence, image preview
  - **Integrate**: API endpoint info, webhook config, BIMS manufacturing gate config

**Theme:** TronCard, dark theme, matches rest of BIMS

**Acceptance Criteria:**
- Can create, view, edit, delete projects
- Project detail shows all 6 tabs with functional Import + Labels
- Build passes

---

### S6 — Gallery + Training UI (Agent E)
**Image gallery with filtering/labeling and training management UI.**

**Files to create:**
```
src/routes/cv/gallery/+page.server.ts
src/routes/cv/gallery/+page.svelte
src/routes/cv/training/+page.server.ts
src/routes/cv/training/+page.svelte
```

**Gallery UI:**
- Filterable image grid: by project, by label (approved/rejected/unlabeled), by date range
- Click image → lightbox with full size, metadata, label controls
- Bulk select + bulk label
- Pagination or infinite scroll

**Training UI:**
- Overview: all projects' model status
- Per-project: training data stats (good/defect counts), "Start Training" button
- Training log viewer (polls status endpoint)
- Model download link (ONNX file from R2)

**Acceptance Criteria:**
- Gallery loads and displays images from R2
- Can filter by project and label
- Can label images from gallery
- Training page shows status and can trigger training
- Build passes

---

### S7 — Inspection + History + Cartridge UI (Agent F)
**Inspection runner, history viewer, and per-cartridge CV results.**

**Files to modify/create:**
```
src/routes/cv/inspect/+page.server.ts    — rewrite to use new models
src/routes/cv/inspect/+page.svelte       — rewrite
src/routes/cv/history/+page.server.ts    — rewrite
src/routes/cv/history/+page.svelte       — rewrite
src/routes/cv/cartridge/[id]/+page.server.ts  — rewrite
src/routes/cv/cartridge/[id]/+page.svelte     — rewrite
```

**Inspect UI:**
- Select project → upload or capture image → run inspection
- Shows: result (pass/fail), confidence score, processing time
- Defect overlay on image if applicable
- Link to save result to cartridge record

**History UI:**
- Table: all inspections sorted by date
- Filterable by project, result, date range
- Click row → inspection detail with image

**Cartridge UI:**
- Shows all CV inspections for a specific cartridge
- Timeline view: inspection at each manufacturing phase
- Pass/fail badges per phase

**Acceptance Criteria:**
- Can run an inspection and see results
- History shows all past inspections
- Cartridge page shows per-phase inspection results
- Build passes

---

## Data Migration

### S8 — Migrate Existing iCast Data (Run after all stories)
**One-time script to migrate data from `icast_cv` database to `bioscale` database.**

**Script:** `scripts/cv-migration.ts`

**What to migrate:**
- `icast_cv.projects` → `bioscale.cv_projects`
- `icast_cv.images` → `bioscale.cv_images`
- `icast_cv.samples` → `bioscale.cv_samples`
- `icast_cv.inspections` → `bioscale.cv_inspections`
- R2 images stay as-is (same bucket, same keys)

**Run with:** `npx tsx scripts/cv-migration.ts [--dry-run]`

---

## Agent Execution Summary

| Phase | Agent | Story | Files (Exclusive) | Est. Time |
|---|---|---|---|---|
| 1 | A | S1 — Models | `cv-*.ts`, `index.ts` | 30 min |
| 1 | B | S2 — R2 Service | `r2.ts`, `.env.example` | 45 min |
| 2 | C | S3 — API Routes | `src/routes/api/cv/**` | 2 hrs |
| 2 | G | S4 — Python Bridge | `cv-bridge.ts`, `services/cv-worker/**` | 2 hrs |
| 3 | D | S5 — Projects UI | `src/routes/cv/projects/**`, `cv/+page.*` | 3 hrs |
| 3 | E | S6 — Gallery/Training | `src/routes/cv/gallery/**`, `cv/training/**` | 2 hrs |
| 3 | F | S7 — Inspect/History | `src/routes/cv/inspect/**`, `history/**`, `cartridge/**` | 2 hrs |
| — | — | S8 — Data Migration | `scripts/cv-migration.ts` | 30 min |

**Total estimated: ~11 hours of agent time across 7 parallel agents**
**Wall clock with parallelism: ~5-6 hours**

---

## Out of Scope

- Camera live feed in browser (requires WebRTC or local proxy — defer)
- Real-time inference on video stream
- Object detection (only classification/anomaly for now)
- Multi-model ensemble
- Edge deployment (browser-based ONNX inference)

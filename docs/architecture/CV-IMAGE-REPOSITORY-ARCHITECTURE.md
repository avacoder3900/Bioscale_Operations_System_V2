# CV Image Repository — Database & System Architecture

**Author:** Alejandro Valdez (via Agent001)
**Date:** 2026-03-30
**System:** BIMS (Bioscale Internal Management System)

---

## System Overview

The CV (Computer Vision) Image Repository is a subsystem within BIMS that handles the storage, organization, labeling, and inspection of product images — primarily cartridge inspection photos used for quality control and ML model training.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           BIMS Frontend (SvelteKit)                        │
│                                                                            │
│   /cv              /cv/gallery        /cv/projects/[id]     /cv/inspect    │
│   Dashboard        Image Gallery      Project Detail        Run Inspection │
│                                                                            │
│   /cv/training     /cv/history        /cv/cartridge/[id]                   │
│   Train Models     Inspection Log     Cartridge Images                     │
└────────────────────────────┬───────────────────────────────────────────────┘
                             │
                    SvelteKit API Routes
                    /api/cv/*
                             │
              ┌──────────────┼──────────────────┐
              │              │                  │
              ▼              ▼                  ▼
     ┌────────────┐  ┌──────────────┐  ┌────────────────┐
     │  MongoDB    │  │ Cloudflare   │  │  Python CV     │
     │  Atlas      │  │ R2 Storage   │  │  Worker        │
     │             │  │              │  │  (localhost:    │
     │ cv_images   │  │ brevitest-cv │  │   8000)        │
     │ cv_projects │  │   bucket     │  │                │
     │ cv_samples  │  │              │  │  Training &    │
     │ cv_inspec-  │  │ Stores the   │  │  Inference     │
     │   tions     │  │ actual image │  │  (PyTorch)     │
     │             │  │ files (JPG,  │  │                │
     │ Stores      │  │ PNG, etc.)   │  └────────────────┘
     │ metadata,   │  │              │
     │ references, │  │ Zero egress  │
     │ results     │  │ fees         │
     └────────────┘  └──────────────┘
```

---

## Database Schema (MongoDB Atlas)

### Collection: `cv_projects`

The top-level organizer. Each project represents a specific CV task (e.g., "Cartridge Seal Inspection", "Wax Fill Quality Check").

```
┌─────────────────────────────────────────────────────┐
│                    cv_projects                       │
├─────────────────────────────────────────────────────┤
│ _id              : String (auto-generated)          │
│ name             : String (required)                │
│ description      : String                           │
│ projectType      : Enum                             │
│                    ├── "classification"              │
│                    ├── "anomaly_detection"           │
│                    └── "object_detection"            │
│ tags             : [String]                         │
│ phases           : [String]                         │
│ labels           : [{name: String, color: String}]  │
│ imageCount       : Number (default: 0)              │
│ annotatedCount   : Number (default: 0)              │
│ modelStatus      : Enum                             │
│                    ├── "untrained" (default)         │
│                    ├── "training"                    │
│                    ├── "trained"                     │
│                    └── "failed"                      │
│ modelVersion     : String                           │
│ createdAt        : Date (auto)                      │
│ updatedAt        : Date (auto)                      │
├─────────────────────────────────────────────────────┤
│ Indexes: projectType, modelStatus                   │
└─────────────────────────────────────────────────────┘
```

### Collection: `cv_samples`

Groups of images within a project (e.g., a batch of cartridges captured together).

```
┌─────────────────────────────────────────────────────┐
│                    cv_samples                        │
├─────────────────────────────────────────────────────┤
│ _id              : String (auto-generated)          │
│ name             : String (required)                │
│ description      : String                           │
│ projectId        : String → cv_projects._id         │
│ tags             : [String]                         │
│ metadata         : Mixed (flexible key-value)       │
│ createdAt        : Date (auto)                      │
│ updatedAt        : Date (auto)                      │
├─────────────────────────────────────────────────────┤
│ Indexes: projectId                                  │
└─────────────────────────────────────────────────────┘
```

### Collection: `cv_images`

Individual image records. Stores METADATA only — the actual image file lives in R2.

```
┌─────────────────────────────────────────────────────┐
│                    cv_images                         │
├─────────────────────────────────────────────────────┤
│ _id              : String (auto-generated)          │
│ sampleId         : String → cv_samples._id          │
│ projectId        : String → cv_projects._id         │
│ filename         : String (original filename)       │
│ filePath         : String (R2 key, e.g.             │
│                    "cv/proj123/img456.jpg")          │
│ thumbnailPath    : String (R2 key for thumbnail)    │
│ width            : Number (pixels)                  │
│ height           : Number (pixels)                  │
│ fileSizeBytes    : Number                           │
│ cameraIndex      : Number                           │
│ metadata         : Mixed (EXIF, custom data)        │
│ capturedAt       : Date                             │
│ imageUrl         : String (public R2 URL)           │
│ cartridgeTag     : {                                │
│    cartridgeRecordId : String                       │
│    phase             : String                       │
│    labels            : [String]                     │
│    notes             : String                       │
│ }                                                   │
│ label            : Enum                             │
│                    ├── "approved"                    │
│                    ├── "rejected"                    │
│                    └── null (unlabeled)              │
│ createdAt        : Date (auto)                      │
│ updatedAt        : Date (auto)                      │
├─────────────────────────────────────────────────────┤
│ Indexes: projectId, sampleId, label                 │
└─────────────────────────────────────────────────────┘
```

### Collection: `cv_inspections`

Results of running a trained model against an image.

```
┌─────────────────────────────────────────────────────┐
│                  cv_inspections                      │
├─────────────────────────────────────────────────────┤
│ _id              : String (auto-generated)          │
│ sampleId         : String → cv_samples._id          │
│ imageId          : String → cv_images._id           │
│ projectId        : String → cv_projects._id         │
│ inspectionType   : String                           │
│ status           : Enum                             │
│                    ├── "pending" (default)           │
│                    ├── "processing"                  │
│                    ├── "complete"                    │
│                    └── "failed"                      │
│ result           : Enum                             │
│                    ├── "pass"                        │
│                    ├── "fail"                        │
│                    └── null                          │
│ confidenceScore  : Number (0.0 – 1.0)              │
│ defects          : [{                               │
│    type     : String                                │
│    location : String                                │
│    severity : String                                │
│ }]                                                  │
│ modelVersion     : String                           │
│ processingTimeMs : Number                           │
│ cartridgeRecordId: String                           │
│ phase            : String                           │
│ completedAt      : Date                             │
│ createdAt        : Date (auto)                      │
│ updatedAt        : Date (auto)                      │
├─────────────────────────────────────────────────────┤
│ Indexes: projectId, sampleId, status,               │
│          cartridgeRecordId                           │
└─────────────────────────────────────────────────────┘
```

---

## Entity Relationship Diagram

```
┌──────────────┐       1:N        ┌──────────────┐
│  cv_projects │──────────────────│  cv_samples   │
│              │                  │               │
│  - name      │                  │  - name       │
│  - type      │                  │  - projectId ─┘
│  - model     │                  │  - tags       │
│    Status    │                  └───────┬───────┘
└──────┬───────┘                          │
       │                                  │ 1:N
       │ 1:N                              │
       │                          ┌───────┴───────┐
       │                          │   cv_images    │
       ├──────────────────────────│               │
       │                          │  - sampleId   │
       │                          │  - projectId ─┘
       │                          │  - filePath ──────────▶ R2 Bucket
       │                          │  - imageUrl ──────────▶ (actual file)
       │                          │  - label      │
       │                          │  - cartridge  │
       │                          │    Tag        │
       │                          └───────┬───────┘
       │                                  │
       │                                  │ 1:N
       │                                  │
       │                          ┌───────┴───────┐
       │                          │cv_inspections  │
       └──────────────────────────│               │
                                  │  - imageId    │
                                  │  - projectId ─┘
                                  │  - result     │
                                  │  - confidence │
                                  │  - defects    │
                                  └───────────────┘
```

**Relationships:**
- `cv_projects` → `cv_samples` (1 project has many samples)
- `cv_projects` → `cv_images` (1 project has many images)
- `cv_samples` → `cv_images` (1 sample has many images)
- `cv_images` → `cv_inspections` (1 image has many inspections)
- `cv_images.filePath` → **R2 object key** (links metadata to actual file)

---

## Data Flow: How the Systems Communicate

### Flow 1: Image Upload

```
 User selects image file
         │
         ▼
 ┌─────────────────────┐
 │ SvelteKit Frontend   │
 │ (browser)            │
 │                      │
 │ 1. POST /api/cv/     │
 │    images/presign    │──────────┐
 └─────────────────────┘          │
                                   ▼
                          ┌─────────────────┐
                          │ SvelteKit API    │
                          │ (+server.ts)     │
                          │                  │
                          │ 2. Validates     │
                          │    projectId     │
                          │                  │
                          │ 3. Generates:    │
                          │    - R2 key      │
                          │    - Presigned   │
                          │      upload URL  │
                          │    - Public URL  │
                          └────────┬────────┘
                                   │
                          Returns URLs
                                   │
         ┌─────────────────────────┘
         ▼
 ┌─────────────────────┐
 │ Browser uploads      │
 │ file directly to     │──────────────────▶  ┌──────────────┐
 │ R2 via presigned URL │                     │ Cloudflare   │
 └─────────┬───────────┘                     │ R2 Bucket    │
           │                                  │              │
           │ On success                       │ File stored  │
           ▼                                  │ at key:      │
 ┌─────────────────────┐                     │ cv/{projId}/ │
 │ POST /api/cv/        │                     │ {imgId}.jpg  │
 │ images/record        │                     └──────────────┘
 │                      │
 │ 4. Creates CvImage   │
 │    document in       │──────────────────▶  ┌──────────────┐
 │    MongoDB with:     │                     │ MongoDB      │
 │    - R2 key          │                     │ Atlas        │
 │    - public URL      │                     │              │
 │    - metadata        │                     │ cv_images    │
 │                      │                     │ collection   │
 │ 5. Increments        │                     └──────────────┘
 │    project.imageCount│
 └─────────────────────┘
```

### Flow 2: Image Display

```
 ┌─────────────────────┐
 │ SvelteKit Page       │
 │ (e.g. /cv/gallery)   │
 │                      │
 │ 1. +page.server.ts   │
 │    queries MongoDB   │──────────────────▶  ┌──────────────┐
 │    for CvImage docs  │                     │ MongoDB      │
 │                      │◀──────────────────  │ Returns docs │
 │ 2. Gets imageUrl     │                     │ with imageUrl│
 │    from each doc     │                     └──────────────┘
 │                      │
 │ 3. <img src={        │
 │    imageUrl} />      │──────────────────▶  ┌──────────────┐
 │    loads from R2     │                     │ R2 Public    │
 │                      │                     │ URL serves   │
 └─────────────────────┘                     │ the file     │
                                              └──────────────┘
```

### Flow 3: ML Training & Inspection

```
 ┌─────────────────────┐
 │ User clicks "Train"  │
 │ on /cv/training      │
 │                      │
 │ POST /api/cv/train   │
 └──────────┬──────────┘
            │
            ▼
 ┌─────────────────────┐       HTTP POST        ┌──────────────────┐
 │ SvelteKit API        │ ────────────────────▶  │ Python CV Worker │
 │                      │                        │ (localhost:8000)  │
 │ Sends:               │                        │                  │
 │ - project_id         │                        │ 1. Downloads     │
 │ - image URLs (R2)    │                        │    images from   │
 │ - label map          │                        │    R2 URLs       │
 │ - model output key   │                        │                  │
 └─────────────────────┘                        │ 2. Trains        │
                                                 │    PyTorch model │
            ┌───────────────────────────────────│                  │
            │         Status polling             │ 3. Saves model   │
            ▼                                    │    to R2         │
 ┌─────────────────────┐                        │                  │
 │ GET /api/cv/         │                        │ 4. Returns       │
 │ inspections/[id]/poll│ ◀──────────────────── │    results       │
 │                      │                        └──────────────────┘
 │ Updates:             │
 │ - cv_inspections     │──────────────────▶  ┌──────────────┐
 │   (result, score,    │                     │ MongoDB      │
 │    defects)          │                     │ cv_inspec-   │
 │ - cv_projects        │                     │ tions updated│
 │   (modelStatus)      │                     └──────────────┘
 └─────────────────────┘
```

---

## R2 Storage Structure

```
brevitest-cv/                          ← R2 Bucket
├── cv/
│   ├── {projectId}/                   ← One folder per project
│   │   ├── {imageId}.jpg              ← Full-res original
│   │   ├── {imageId}.png
│   │   └── ...
│   └── models/
│       └── {projectId}/
│           └── {modelVersion}.pt      ← Trained PyTorch model weights
```

**Key format:** `cv/{projectId}/{imageId}.{ext}`
**Public URL format:** `https://brevitest-cv.r2.dev/cv/{projectId}/{imageId}.{ext}`

---

## API Endpoints

| Method | Endpoint | Description | Communicates With |
|--------|----------|-------------|-------------------|
| `POST` | `/api/cv/images/presign` | Generate presigned upload URL | R2 (generates URL), MongoDB (validates project) |
| `POST` | `/api/cv/images/record` | Save image metadata after upload | MongoDB (creates CvImage doc) |
| `GET` | `/api/cv/images` | List images (filter by project/sample) | MongoDB (queries cv_images) |
| `GET` | `/api/cv/images/[id]` | Get single image details | MongoDB |
| `PUT` | `/api/cv/images/[id]/label` | Label image (approved/rejected) | MongoDB (updates label field) |
| `PUT` | `/api/cv/images/[id]/tags` | Add/update image tags | MongoDB |
| `POST` | `/api/cv/projects` | Create new CV project | MongoDB (creates cv_projects doc) |
| `GET` | `/api/cv/projects` | List all projects | MongoDB |
| `GET` | `/api/cv/projects/[id]` | Get project details + stats | MongoDB |
| `GET` | `/api/cv/projects/[id]/images` | Get all images for a project | MongoDB |
| `POST` | `/api/cv/samples` | Create image sample group | MongoDB |
| `GET` | `/api/cv/samples` | List samples | MongoDB |
| `POST` | `/api/cv/capture` | Capture image from camera | Python CV Worker → R2 → MongoDB |
| `POST` | `/api/cv/train` | Start model training | Python CV Worker (reads from R2) |
| `POST` | `/api/cv/infer` | Run inference on image | Python CV Worker |
| `POST` | `/api/cv/inspections` | Create inspection record | MongoDB |
| `GET` | `/api/cv/inspections/[id]` | Get inspection result | MongoDB |
| `GET` | `/api/cv/inspections/[id]/poll` | Poll inspection status | MongoDB |

---

## Frontend Pages

| Route | Purpose | Data Source |
|-------|---------|-------------|
| `/cv` | Dashboard — project overview, stats | MongoDB (cv_projects) |
| `/cv/gallery` | Image gallery — browse, filter, label images | MongoDB (cv_images) → R2 (display) |
| `/cv/projects/[id]` | Project detail — images, model status, labels | MongoDB (cv_projects + cv_images) |
| `/cv/inspect` | Run inspection — select image, run model | MongoDB → Python CV Worker |
| `/cv/training` | Train models — select project, start training | MongoDB → Python CV Worker |
| `/cv/history` | Inspection history — past results, trends | MongoDB (cv_inspections) |
| `/cv/cartridge/[id]` | Cartridge-specific images across phases | MongoDB (cv_images by cartridgeTag) |

---

## Cartridge Phase Tracking

Images can be tagged with a `cartridgeTag` linking them to a specific cartridge at a specific manufacturing phase:

```
Phases (in order):
  backing → wax_filled → reagent_filled → inspected → sealed →
  oven_cured → qaqc_released → shipped → underway → completed
```

Image tag labels:
```
  wax_fill, reagent_fill, top_seal, top_view, side_view,
  defect_crack, defect_bubble, defect_overflow, final_qc, reference
```

This links the CV system back to the main BIMS cartridge production pipeline — every image can be traced to a specific cartridge at a specific manufacturing step.

---

## Service Layer Files (Codebase Reference)

| File | Purpose |
|------|---------|
| `src/lib/server/services/r2.ts` | R2 storage service — presigned URLs, upload, download, delete (pure Node.js crypto, no AWS SDK) |
| `src/lib/server/services/cv-bridge.ts` | Python CV Worker client — training, inference, status polling |
| `src/lib/server/cv-api.ts` | ICast CV API wrapper — external CV service integration |
| `src/lib/server/db/models/cv-image.ts` | Mongoose model for cv_images collection |
| `src/lib/server/db/models/cv-project.ts` | Mongoose model for cv_projects collection |
| `src/lib/server/db/models/cv-sample.ts` | Mongoose model for cv_samples collection |
| `src/lib/server/db/models/cv-inspection.ts` | Mongoose model for cv_inspections collection |
| `src/lib/types/cv.ts` | TypeScript type definitions for all CV entities |

---

## Environment Variables Required

| Variable | Service | Purpose |
|----------|---------|---------|
| `R2_ACCOUNT_ID` | Cloudflare R2 | Account identifier |
| `R2_ACCESS_KEY_ID` | Cloudflare R2 | API key ID for S3 signing |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 | API secret for S3 signing |
| `R2_BUCKET_NAME` | Cloudflare R2 | Bucket name (default: `brevitest-cv`) |
| `R2_PUBLIC_URL` | Cloudflare R2 | Public access URL for serving images |
| `CV_WORKER_URL` | Python Worker | Base URL (default: `http://localhost:8000`) |
| `CV_API_KEY` | CV API | Authentication key for CV service |
| `MONGODB_URI` | MongoDB Atlas | Database connection string |

---

## Summary

| Component | Role | Technology |
|-----------|------|------------|
| **MongoDB Atlas** | Stores all metadata — image records, projects, samples, inspection results, relationships | Mongoose ODM + MongoDB |
| **Cloudflare R2** | Stores actual image files + trained model weights | S3-compatible object storage |
| **SvelteKit API** | Orchestrates communication between frontend, MongoDB, and R2 | TypeScript, server routes |
| **Python CV Worker** | Runs ML training and inference | PyTorch, localhost:8000 |
| **SvelteKit Frontend** | 7 pages for managing images, projects, inspections | Svelte 5, SSR |

**MongoDB holds the "what" and "where." R2 holds the "thing itself." SvelteKit connects them. Python does the ML.**

# Cartridge DHR Photo Traceability — Data Flow Guide

> **Purpose:** Trace every cartridge through manufacturing with photos at each phase, creating a complete Device History Record (DHR) accessible via API.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        DATA SOURCES                                 │
│                                                                     │
│   📷 CV Camera          📱 QR Scanner          🏭 Manufacturing     │
│   (captures photos)     (reads cartridge ID)    (phase progression)  │
└────────┬────────────────────┬──────────────────────┬────────────────┘
         │                    │                      │
         ▼                    ▼                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        STORAGE LAYER                                │
│                                                                     │
│   ☁️  Cloudflare R2              🍃 MongoDB Atlas                   │
│   Bucket: brevitest-cv           Collection: cartridge_records      │
│   Key: dhr/{id}/{phase}/...      Collection: cv_images              │
│                                  Collection: cv_inspections         │
└────────┬────────────────────────────────┬───────────────────────────┘
         │                                │
         ▼                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        API LAYER                                    │
│                                                                     │
│   /api/cartridge-admin/dhr/{id}     Full DHR (timeline + photos)    │
│   /api/cv/cartridge-exists?id=      Quick existence check           │
│   /api/cv/images/{id}/link-cart     Link photo → cartridge          │
│   /api/traceability/cartridge/{id}  Timeline + photos               │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Manufacturing Phase Pipeline

Each cartridge moves through these phases. Photos can be captured at any step.

```
 ┌──────────┐    ┌────────────┐    ┌─────────┐    ┌─────────────┐
 │ BACKING  │───▶│ WAX FILLING│───▶│ WAX QC  │───▶│ WAX STORAGE │
 │          │    │            │    │         │    │             │
 │ 📷       │    │ 📷         │    │ 📷      │    │ 📷          │
 └──────────┘    └────────────┘    └─────────┘    └─────────────┘
                                                        │
       ┌────────────────────────────────────────────────┘
       ▼
 ┌──────────────┐    ┌────────────┐    ┌──────────┐    ┌───────────┐
 │ REAGENT FILL │───▶│ INSPECTION │───▶│ TOP SEAL │───▶│ OVEN CURE │
 │              │    │            │    │          │    │           │
 │ 📷           │    │ 📷 + 🤖 AI │    │ 📷       │    │ 📷        │
 └──────────────┘    └────────────┘    └──────────┘    └───────────┘
                                                            │
       ┌────────────────────────────────────────────────────┘
       ▼
 ┌──────────┐    ┌─────────────┐    ┌──────────┐
 │ STORAGE  │───▶│ QA/QC       │───▶│ SHIPPING │
 │          │    │ RELEASE     │    │          │
 │ 📷       │    │ 📷          │    │ 📷       │
 └──────────┘    └─────────────┘    └──────────┘

 📷  = Photo capture point
 🤖  = CV inspection (pass/fail with confidence score)
```

---

## Data Flow: Capturing a Photo

When the CV camera captures a photo of a cartridge:

```
Step 1: CAPTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  CV Camera ──▶ Image file (JPEG/PNG)
                    │
                    ▼
  POST /api/cv/images/record
                    │
                    ├──▶ Upload to R2
                    │    Key: dhr/CART-000123/wax_filled/2026-04-07T14-30-00-photo.jpg
                    │
                    └──▶ Create CvImage document in MongoDB
                         {
                           _id: "img_abc123",
                           filePath: "dhr/CART-000123/wax_filled/...",
                           cartridgeTag: {
                             cartridgeRecordId: "CART-000123",
                             phase: "wax_filled",
                             labels: [],
                             notes: ""
                           }
                         }


Step 2: LINK TO CARTRIDGE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  PATCH /api/cv/images/img_abc123/link-cartridge
  Body: { cartridgeRecordId: "CART-000123", phase: "wax_filled" }
                    │
                    ├──▶ Update CvImage.cartridgeTag
                    │
                    ├──▶ Push to CartridgeRecord.photos[]
                    │    {
                    │      imageId: "img_abc123",
                    │      r2Key: "dhr/CART-000123/wax_filled/...",
                    │      phase: "wax_filled",
                    │      capturedAt: "2026-04-07T14:30:00Z"
                    │    }
                    │
                    └──▶ Response (INSTANT FEEDBACK):
                         {
                           success: true,
                           cartridgeExists: true,     ◀── green check
                           cartridgeStatus: "wax_filled",
                           photoCount: 3
                         }
```

---

## Data Flow: Quick Status Check (CV Label Feedback)

When the CV labeling UI needs to verify a cartridge exists:

```
  CV Labeling UI
       │
       │  GET /api/cv/cartridge-exists?id=CART-000123
       │
       ▼
  ┌─────────────────────────────────┐
  │  MongoDB: CartridgeRecord       │
  │  findById("CART-000123")        │
  │  .select("_id status photos")   │
  │                                 │
  │  Single query, <50ms            │
  └─────────────────────────────────┘
       │
       ▼
  Response:
  ┌─────────────────────────────────┐
  │                                 │
  │  Found:                         │
  │  ┌───────────────────────────┐  │
  │  │ ✅ exists: true           │  │
  │  │ 📍 status: "reagent_filled│  │
  │  │ 📷 photoCount: 3         │  │
  │  └───────────────────────────┘  │
  │                                 │
  │  Not found:                     │
  │  ┌───────────────────────────┐  │
  │  │ ❌ exists: false          │  │
  │  │    status: null           │  │
  │  │    photoCount: 0          │  │
  │  └───────────────────────────┘  │
  │                                 │
  └─────────────────────────────────┘
```

---

## Data Flow: Full DHR Retrieval

When requesting the complete Device History Record:

```
  GET /api/cartridge-admin/dhr/CART-000123
       │
       ▼
  ┌──────────────────────────────────────────────────────┐
  │                 PARALLEL QUERIES                      │
  │                                                      │
  │  ┌────────────────┐  ┌──────────────┐  ┌──────────┐ │
  │  │ CartridgeRecord│  │ CvImage      │  │CvInspec- │ │
  │  │ .findById()    │  │ .find({      │  │tion      │ │
  │  │                │  │  cartridgeTag│  │.find({   │ │
  │  │ Full document  │  │  .cartridge- │  │ cartridge│ │
  │  │ with all       │  │  RecordId})  │  │ RecordId}│ │
  │  │ phase data     │  │              │  │)         │ │
  │  └───────┬────────┘  └──────┬───────┘  └────┬─────┘ │
  │          │                  │                │       │
  │          │    ┌─────────────┘                │       │
  │          │    │    ┌────────────────────────┘       │
  │          ▼    ▼    ▼                                 │
  │  ┌─────────────────────────────────────────┐         │
  │  │          ASSEMBLY ENGINE                 │         │
  │  │                                         │         │
  │  │  For each phase in timeline:            │         │
  │  │    - Attach matching photos             │         │
  │  │    - Generate signed R2 URLs            │         │
  │  │    - Attach inspection results          │         │
  │  │    - Include operator + timestamp       │         │
  │  └─────────────────────────────────────────┘         │
  └──────────────────────────────────────────────────────┘
       │
       ▼
  RESPONSE STRUCTURE:
  ┌──────────────────────────────────────────────────────┐
  │                                                      │
  │  cartridge: {                                        │
  │    cartridgeId: "CART-000123"                        │
  │    status: "reagent_filled"                          │
  │    photos: [ { imageId, r2Key, phase, capturedAt } ] │
  │  }                                                   │
  │                                                      │
  │  timeline: [                                         │
  │    ┌──────────────────────────────────────────┐      │
  │    │ step: "backing"                          │      │
  │    │ timestamp: "2026-04-01T09:00:00Z"        │      │
  │    │ operator: { username: "jdoe" }           │      │
  │    │ details: { lotId: "LOT-001", ... }       │      │
  │    │ photos: [ { url, thumbnailUrl, label } ] │      │
  │    └──────────────────────────────────────────┘      │
  │    ┌──────────────────────────────────────────┐      │
  │    │ step: "wax_filling"                      │      │
  │    │ timestamp: "2026-04-02T10:30:00Z"        │      │
  │    │ operator: { username: "asmith" }         │      │
  │    │ details: { runId: "RUN-42", ... }        │      │
  │    │ photos: [ { url, label: "approved" } ]   │      │
  │    └──────────────────────────────────────────┘      │
  │    ... (continues for each completed phase)          │
  │  ]                                                   │
  │                                                      │
  │  photos: [                                           │
  │    { imageId, phase, url, thumbnailUrl,              │
  │      label, inspectionResult, confidenceScore }      │
  │  ]                                                   │
  │                                                      │
  │  inspections: [                                      │
  │    { phase, result: "pass", confidenceScore: 0.97,   │
  │      defects: [] }                                   │
  │  ]                                                   │
  │                                                      │
  │  linkedLots: [ { lotId, lotNumber, status, ... } ]   │
  │                                                      │
  └──────────────────────────────────────────────────────┘
```

---

## R2 Storage Structure

Photos are organized in R2 by **project**, then **cartridge ID**, then **phase**:

```
  brevitest-cv/                                    ◀── R2 Bucket
  │
  ├── coc/                                         ◀── COC photos (existing)
  │   └── 2026-04-07/
  │       └── LOT-001.jpg
  │
  └── cv/                                          ◀── Computer Vision root
      │
      ├── proj_abc123/                             ◀── Project folder
      │   ├── img_flat1.jpg                        ◀── Untagged images (existing)
      │   ├── thumbs/
      │   │   └── img_flat1.jpg
      │   │
      │   └── dhr/                                 ◀── DHR photos (NEW)
      │       │
      │       ├── CART-000123/                     ◀── QR code → this folder
      │       │   ├── backing/
      │       │   │   └── 2026-04-01T09-00-00-front.jpg
      │       │   ├── wax_filled/
      │       │   │   ├── 2026-04-02T10-30-00-top.jpg
      │       │   │   └── 2026-04-02T10-31-00-side.jpg
      │       │   │   └── thumbs/
      │       │   │       └── img_xyz.jpg
      │       │   ├── reagent_filled/
      │       │   │   └── 2026-04-03T14-00-00-wells.jpg
      │       │   ├── inspected/
      │       │   │   └── 2026-04-03T15-00-00-qc.jpg
      │       │   └── sealed/
      │       │       └── 2026-04-04T08-00-00-seal.jpg
      │       │
      │       ├── CART-000124/
      │       │   └── ...
      │       │
      │       └── CART-000125/
      │           └── ...
      │
      └── proj_def456/                             ◀── Another project
          └── dhr/
              └── ...

  Key format: cv/{projectId}/dhr/{cartridgeId}/{phase}/{timestamp}-{filename}
  Generated by: buildDhrKey(projectId, cartridgeId, phase, filename)
  Prefix for listing: buildDhrPrefix(projectId, cartridgeId, phase?)
```

### QR Code → Photo Folder Lookup

```
  📱 Scan QR code: "CART-000123"
       │
       ▼
  GET /api/cv/cartridge-photos?id=CART-000123&projectId=proj_abc123
       │
       ├──▶ R2: listFolder("cv/proj_abc123/dhr/CART-000123/")
       │         Returns all files in all phase subfolders
       │
       ├──▶ MongoDB: CvImage.find({ cartridgeTag.cartridgeRecordId: "CART-000123" })
       │         Returns metadata, labels, inspection results
       │
       └──▶ Merges both sources, groups by phase, returns signed URLs
            │
            ▼
  Response:
  {
    cartridgeId: "CART-000123",
    projectId: "proj_abc123",
    totalPhotos: 5,
    phases: [
      {
        phase: "backing",
        photos: [
          { imageId: "img_1", r2Key: "cv/.../backing/...", url: "https://signed...", label: "approved" }
        ]
      },
      {
        phase: "wax_filled",
        photos: [
          { imageId: "img_2", r2Key: "cv/.../wax_filled/...", url: "https://signed...", label: null },
          { imageId: "img_3", r2Key: "cv/.../wax_filled/...", url: "https://signed...", label: "approved" }
        ]
      },
      ...
    ]
  }
```

---

## MongoDB Document Relationships

```
  ┌─────────────────────────────────────────┐
  │          CartridgeRecord                 │
  │          Collection: cartridge_records   │
  │                                         │
  │  _id: "CART-000123"                     │
  │  status: "reagent_filled"               │
  │                                         │
  │  backing: { lotId, operator, ... }      │
  │  waxFilling: { runId, robot, ... }      │
  │  reagentFilling: { assay, ... }         │
  │  ... (all manufacturing phases)         │
  │                                         │
  │  photos: [─────────────────────────┐    │
  │    {                               │    │
  │      imageId: "img_abc" ──────┐    │    │
  │      r2Key: "dhr/CART.../..." │    │    │
  │      phase: "wax_filled"     │    │    │
  │      capturedAt: Date        │    │    │
  │    }                          │    │    │
  │  ]                            │    │    │
  └───────────────────────────────┼────┘────┘
                                  │
              ┌───────────────────┘
              │  References
              ▼
  ┌─────────────────────────────────────────┐
  │          CvImage                         │
  │          Collection: cv_images           │
  │                                         │
  │  _id: "img_abc"                         │
  │  filePath: "dhr/CART-000123/..."        │──▶ R2 Object Key
  │  imageUrl: "https://..."                │
  │  thumbnailPath: "..."                   │
  │  label: "approved" | "rejected" | null  │
  │                                         │
  │  cartridgeTag: {                        │
  │    cartridgeRecordId: "CART-000123" ────┼──▶ Back-reference
  │    phase: "wax_filled"                  │
  │    labels: ["good_fill", "centered"]    │
  │    notes: ""                            │
  │  }                                      │
  └──────────┬──────────────────────────────┘
             │
             │  imageId reference
             ▼
  ┌─────────────────────────────────────────┐
  │          CvInspection                    │
  │          Collection: cv_inspections      │
  │                                         │
  │  _id: "insp_xyz"                        │
  │  imageId: "img_abc"                     │
  │  cartridgeRecordId: "CART-000123"       │
  │  phase: "wax_filled"                    │
  │  result: "pass" | "fail"               │
  │  confidenceScore: 0.97                  │
  │  defects: []                            │
  └─────────────────────────────────────────┘
```

---

## API Quick Reference

### 1. Full DHR
```bash
GET /api/cartridge-admin/dhr/CART-000123

# Auth: Session cookie (requires cartridge admin access)
# Returns: cartridge + timeline (with photos per step) + inspections + lots
```

### 2. Quick Existence Check
```bash
GET /api/cv/cartridge-exists?id=CART-000123

# Auth: Session cookie
# Returns: { exists: true, status: "reagent_filled", photoCount: 3 }
# Speed: <50ms single query
```

### 3. Link Photo to Cartridge
```bash
PATCH /api/cv/images/img_abc123/link-cartridge
Content-Type: application/json

{ "cartridgeRecordId": "CART-000123", "phase": "wax_filled" }

# Auth: Session cookie
# Returns: { success, cartridgeExists, cartridgeStatus, photoCount }
# Side effects: Updates CvImage.cartridgeTag + pushes to CartridgeRecord.photos[]
```

### 4. Traceability Timeline (with photos)
```bash
GET /api/traceability/cartridge/CART-000123

# Auth: Session cookie
# Returns: cartridge + timeline + transactions + linkedLots + photos[]
```

### 5. QR Code → Photo Folder Listing (NEW)
```bash
GET /api/cv/cartridge-photos?id=CART-000123&projectId=proj_abc123

# Auth: Session cookie
# Returns: { cartridgeId, projectId, totalPhotos, phases: [{ phase, photos[] }] }
# Each photo has a signed R2 URL (1hr expiry)
# Optional: &phase=wax_filled to filter to one phase
```

### 6. Presigned Upload (Enhanced)
```bash
POST /api/cv/images/presign
Content-Type: application/json

{ "projectId": "proj_abc", "filename": "photo.jpg", "contentType": "image/jpeg",
  "cartridgeRecordId": "CART-000123", "phase": "wax_filled" }

# If cartridgeRecordId is provided → R2 key: cv/{proj}/dhr/{cart}/{phase}/{ts}-{file}
# If omitted → R2 key: cv/{proj}/{id}_{file} (existing flat behavior)
```

---

## Accessing DHR in the BIMs UI

### How to get there

Navigate to **`/cartridge-admin/dhr`** in your browser. This page is NOT linked from the
existing cartridge-admin tab bar (frozen UI), so access it via direct URL or bookmark.

```
  https://your-app.com/cartridge-admin/dhr
```

### Search Page (`/cartridge-admin/dhr`)

```
  ┌─────────────────────────────────────────────────────────┐
  │  <- Back to Cartridge Admin                              │
  │                                                          │
  │  Device History Record (DHR)                             │
  │  Scan a QR code or search by cartridge ID                │
  │                                                          │
  │  ┌───────────────────────────────────────────┐ ┌──────┐ │
  │  │ 🔍  Enter cartridge ID or scan QR code... │ │Search│ │
  │  └───────────────────────────────────────────┘ └──────┘ │
  │                                                          │
  │  ┌──────────────┬────────┬───────────┬───────┬────────┐ │
  │  │ Cartridge ID │ Status │ Assay     │Photos │        │ │
  │  ├──────────────┼────────┼───────────┼───────┼────────┤ │
  │  │ CART-000123  │ stored │ CRP      │ 📷 5  │View DHR│ │
  │  │ CART-000124  │ sealed │ TNF-a    │ 📷 3  │View DHR│ │
  │  │ CART-000125  │ cured  │ IL-6     │  ---  │View DHR│ │
  │  └──────────────┴────────┴───────────┴───────┴────────┘ │
  └─────────────────────────────────────────────────────────┘
```

### Detail Page (`/cartridge-admin/dhr/CART-000123`)

```
  ┌─────────────────────────────────────────────────────────┐
  │  <- Back to DHR Search                                   │
  │                                                          │
  │  CART-000123                          [  STORED  ]       │
  │  DHR · 5 photos · 2 inspections · Created Apr 1         │
  │                                                          │
  │  ┌───────────────────────────────────────────────────┐   │
  │  │ MANUFACTURING PROGRESS                            │   │
  │  │ [Backing] > [Wax Filling] > [Wax QC] > ...       │   │
  │  │  (cyan = completed)       (gray = pending)        │   │
  │  └───────────────────────────────────────────────────┘   │
  │                                                          │
  │  ┌───────────────────────────────────────────────────┐   │
  │  │ MANUFACTURING TIMELINE                            │   │
  │  │                                                   │   │
  │  │  ● Backing         Apr 1, 9:00 AM                │   │
  │  │  │  Lot: LOT-001                                  │   │
  │  │  │                                                │   │
  │  │  ● Wax Filling     Apr 2, 10:30 AM               │   │
  │  │  │  Run: RUN-42  Robot: OT-2A                     │   │
  │  │  │  ┌────┐ ┌────┐                                │   │
  │  │  │  │ 📷 │ │ 📷 │  <- inline photo thumbnails    │   │
  │  │  │  └────┘ └────┘                                │   │
  │  │  │                                                │   │
  │  │  ● Reagent Filling  Apr 3, 2:00 PM               │   │
  │  │  │  Assay: CRP  Run: RUN-55                       │   │
  │  │  │  ┌────┐                                       │   │
  │  │  │  │ 📷 │  [PASS]  97%                          │   │
  │  │  │  └────┘                                       │   │
  │  │  ...                                              │   │
  │  └───────────────────────────────────────────────────┘   │
  │                                                          │
  │  ┌───────────────────────────────────────────────────┐   │
  │  │ ALL PHOTOS (5)                                    │   │
  │  │ [All (5)] [Wax Filling (2)] [Reagent (1)] ...     │   │
  │  │                                                   │   │
  │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐          │   │
  │  │  │          │ │          │ │          │          │   │
  │  │  │  photo   │ │  photo   │ │  photo   │          │   │
  │  │  │          │ │  [PASS]  │ │          │          │   │
  │  │  ├──────────┤ ├──────────┤ ├──────────┤          │   │
  │  │  │wax fill  │ │reagent   │ │sealed    │          │   │
  │  │  │Apr 2     │ │Apr 3     │ │Apr 4     │          │   │
  │  │  │ ██░░ 85% │ │ ████ 97% │ │          │          │   │
  │  │  └──────────┘ └──────────┘ └──────────┘          │   │
  │  └───────────────────────────────────────────────────┘   │
  │                                                          │
  │  Click any photo to open LIGHTBOX:                       │
  │  ┌───────────────────────────────────────────────────┐   │
  │  │  [X]                                              │   │
  │  │  [<]        Full-size photo            [>]        │   │
  │  │                                                   │   │
  │  │  [Wax Filling]  [PASS]          Apr 2, 10:30 AM   │   │
  │  │  Confidence: 85.2%   Processing: 120ms            │   │
  │  │  Defects: none                                    │   │
  │  │  Labels: [wax_fill] [top_view]                    │   │
  │  └───────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| `r2Key` stored on CartridgeRecord.photos | Direct URL construction without joining CvImage — faster DHR loads |
| `cv/{project}/dhr/{cart}/{phase}/` R2 structure | Nested under project for multi-project support; prefix listing by cartridge or phase |
| `cartridge-photos` endpoint merges R2 + MongoDB | R2 listing catches orphaned uploads; MongoDB provides labels and inspection results |
| Separate `cartridge-exists` endpoint | Single-purpose, <50ms for real-time CV label feedback |
| Photos attached to timeline steps | Each phase in the DHR shows its photos inline — no separate lookup needed |
| Signed R2 URLs in DHR response | Time-limited access (1hr default) — no public bucket exposure |
| Sacred middleware compatible | `finalizedAt` is never set on CartridgeRecord, so photo `$push` always works |
| Upload endpoints auto-tag when cartridge provided | Presign + form upload both accept `cartridgeRecordId` — no separate link step needed |

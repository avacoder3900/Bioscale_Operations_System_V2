# PRD: CV Cartridge Phase Tracking + DHR Photo Linkage

**Author:** Alejandro Valdez (via Agent001)
**Date:** 2026-04-03
**Status:** Draft — awaiting Alejandro review
**Priority:** P1
**Branch:** `feature/cv-bims-integration`

---

## 1. Problem Statement

Four gaps exist in the cartridge CV workflow:

1. **No automatic phase advancement** — When a cartridge QR is scanned on the CV page, the system doesn't check if it's been seen before or what phase it's in. Every scan is treated as a new, unlinked image.

2. **No phase acknowledgment on scan** — The CV scan page doesn't tell the operator "this cartridge was wax-filled, it's now being scanned as reagent-filled." The operator has no context about where this cartridge is in the pipeline.

3. **No photo linkage in cartridge DHR** — When a photo is taken, it's stored in R2 and logged in `cv_images`, but the cartridge record (`cartridge_records`) has no reference to its photos. You can't pull up a cartridge and see all photos taken at each phase.

4. **No photo enlargement on labels page** — The CV gallery/labels page shows photos in a small grid with no way to click and enlarge them for detailed inspection.

## 2. Goals

### 2A: Automatic Phase Advancement
When a cartridge QR is scanned on the CV capture page:
- Look up all previous `cv_images` with this QR code
- Determine the latest phase from the most recent image
- Auto-advance to the next phase in the pipeline
- Display the phase transition to the operator

### 2B: Phase Acknowledgment on Scan
When the QR is recognized:
- Show a banner: "Cartridge [QR] — previously scanned as **wax_filled** → now capturing as **reagent_filled**"
- If it's a brand new QR (no prior images), show: "New cartridge — capturing as **wax_filled**"
- Color-code by phase (e.g., wax = amber, reagent = blue, sealed = green)

### 2C: Photo Linkage in Cartridge DHR
When a CV photo is taken:
- Update the `cartridge_records` document with a reference to the photo
- Store: R2 key, image URL, phase, timestamp, project ID
- The cartridge detail page should show a photo timeline: all photos taken at each phase

### 2D: Photo Enlargement on Labels/Gallery Page
- Clicking a photo thumbnail opens a full-size lightbox/modal
- Shows the full-resolution image from R2
- Navigation arrows to browse through photos
- Close with X or click outside

## 3. Phase Pipeline

```
wax_filled → reagent_filled → inspected → sealed → oven_cured → qaqc_released
```

**Phase advancement rules:**
| Current Phase | Next Phase | Trigger |
|--------------|------------|---------|
| (none — new QR) | `wax_filled` | First scan |
| `wax_filled` | `reagent_filled` | Second scan |
| `reagent_filled` | `inspected` | Third scan |
| `inspected` | `sealed` | Fourth scan |
| `sealed` | `oven_cured` | Fifth scan |
| `oven_cured` | `qaqc_released` | Sixth scan |
| `qaqc_released` | (no change — already complete) | Show "already released" |

The operator can override the auto-detected phase via a dropdown if needed (e.g., re-scanning at the same phase for additional photos).

## 4. Data Architecture

### 4.1 Existing: `cv_images` Collection
Already has `cartridgeTag`:
```typescript
cartridgeTag: {
    cartridgeRecordId: String,    // → cartridge_records._id
    phase: String,                 // wax_filled, reagent_filled, etc.
    labels: [String],
    notes: String
}
```
**No changes needed** — this already supports what we need.

### 4.2 New Field on `cartridge_records`: `photos`
Add an array of photo references:
```typescript
photos: [{
    imageId: String,              // → cv_images._id
    r2Key: String,                // R2 object key for direct URL
    imageUrl: String,             // Public URL
    phase: String,                // Phase when photo was taken
    projectId: String,            // CV project ID
    capturedAt: Date,
    capturedBy: String            // User ID
}]
```

### 4.3 QR Lookup Flow
```
QR scanned on CV page
    ↓
Query cv_images where cartridgeTag.cartridgeRecordId matches QR
    ↓
Sort by capturedAt descending → get latest phase
    ↓
Determine next phase from pipeline
    ↓
Auto-set cartridgeTag.phase on the new image
    ↓
Also update cartridge_records.photos[] with new photo reference
    ↓
Display phase banner to operator
```

## 5. UI Specification

### 5.1 Phase Banner on CV Capture Page (`/cv/inspect` or `/cv/projects/[id]`)

After QR scan, above the camera viewfinder:

**New cartridge:**
```
┌─────────────────────────────────────────────────────────┐
│ 🆕 New Cartridge — QR: ABC123                          │
│ Phase: wax_filled (first scan)                          │
│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ (progress bar 1/6)   │
└─────────────────────────────────────────────────────────┘
```

**Returning cartridge:**
```
┌─────────────────────────────────────────────────────────┐
│ 🔄 Cartridge ABC123 — Phase Update                     │
│ Previous: wax_filled → Now: reagent_filled              │
│ ████████████░░░░░░░░░░░░░░░░░░░ (progress bar 2/6)    │
│                                                         │
│ [Override phase ▼]  ← dropdown to manually select phase │
└─────────────────────────────────────────────────────────┘
```

**Phase colors:**
- `wax_filled` — amber/orange
- `reagent_filled` — blue
- `inspected` — cyan
- `sealed` — purple
- `oven_cured` — red
- `qaqc_released` — green

### 5.2 Cartridge DHR — Photo Timeline (`/cartridges/[id]` or `/cv/cartridge/[id]`)

On the cartridge detail page, add a "Photo History" section:

```
┌─────────────────────────────────────────────────────────┐
│ 📸 Photo History                                        │
│                                                         │
│ wax_filled (Mar 28, 2026)                              │
│ ┌──────┐ ┌──────┐                                      │
│ │ img1 │ │ img2 │  ← click to enlarge                  │
│ └──────┘ └──────┘                                      │
│                                                         │
│ reagent_filled (Apr 3, 2026)                           │
│ ┌──────┐                                               │
│ │ img3 │                                               │
│ └──────┘                                               │
│                                                         │
│ sealed — no photos yet                                  │
└─────────────────────────────────────────────────────────┘
```

### 5.3 Photo Enlargement on Labels/Gallery Page

Clicking any thumbnail in the grid opens a lightbox modal:

```
┌─────────────────────────────────────────────────────────┐
│                         [X]                             │
│                                                         │
│   [◀]        ┌─────────────────────┐          [▶]      │
│              │                     │                    │
│              │   Full-size image   │                    │
│              │   from R2           │                    │
│              │                     │                    │
│              └─────────────────────┘                    │
│                                                         │
│  PT-CT-104 | Phase: wax_filled | Mar 28, 2026 3:15 PM │
│  Captured by: alejandro                                 │
│  Labels: wax_fill, top_view                            │
└─────────────────────────────────────────────────────────┘
```

- Click outside or [X] to close
- Arrow keys or [◀][▶] to navigate between images
- Shows metadata below the image

## 6. Implementation

### 6.1 Backend Changes

#### A. New API endpoint: `POST /api/cv/lookup-cartridge`
Looks up a cartridge by QR code and returns its phase history:
```typescript
// Input: { qrCode: string }
// Output: {
//   cartridgeRecordId: string | null,
//   currentPhase: string | null,
//   nextPhase: string,
//   previousImages: Array<{ id, phase, capturedAt, imageUrl }>,
//   isNew: boolean
// }
```

#### B. Modify `POST /api/cv/images/record`
After creating the `cv_image`, also push a photo reference to `cartridge_records.photos[]`:
```typescript
if (cartridgeTag?.cartridgeRecordId) {
    await CartridgeRecord.updateOne(
        { _id: cartridgeTag.cartridgeRecordId },
        { $push: { photos: {
            imageId: image._id,
            r2Key: key,
            imageUrl: publicUrl,
            phase: cartridgeTag.phase,
            projectId,
            capturedAt: new Date(),
            capturedBy: locals.user._id
        }}}
    );
}
```

#### C. Modify cartridge detail page loader
Load `photos[]` from the cartridge record and group by phase for the timeline view.

### 6.2 Frontend Changes

#### A. CV Capture Page — Phase Banner
After QR scan callback, call `/api/cv/lookup-cartridge` → display phase banner → auto-set the phase on the image being captured.

#### B. CV Gallery/Labels Page — Lightbox Modal
Add a lightbox component that opens on thumbnail click. Full-size image + metadata + prev/next navigation.

#### C. Cartridge Detail Page — Photo Timeline
New section showing photos grouped by phase, with click-to-enlarge.

## 7. Files to Create/Modify

### New Files
| File | Description |
|------|-------------|
| `src/routes/api/cv/lookup-cartridge/+server.ts` | QR lookup endpoint — returns phase history |
| `src/lib/components/cv/PhotoLightbox.svelte` | Reusable lightbox modal for photo enlargement |

### Modified Files
| File | Change |
|------|--------|
| `src/routes/api/cv/images/record/+server.ts` | Push photo reference to cartridge_records |
| `src/routes/cv/inspect/+page.svelte` | Add phase banner after QR scan |
| `src/routes/cv/projects/[id]/+page.svelte` | Add phase banner after QR scan (if capture tab is here) |
| `src/routes/cv/gallery/+page.svelte` | Add lightbox on thumbnail click |
| `src/routes/cv/cartridge/[id]/+page.server.ts` | Load photos from cartridge record |
| `src/routes/cv/cartridge/[id]/+page.svelte` | Render photo timeline grouped by phase |
| `src/lib/server/db/models/cartridge-record.ts` | Add `photos` array to schema (if not already flexible) |

### Files NOT to Touch
- Do NOT modify the R2 upload flow
- Do NOT modify the QR scanner component itself (jsQR)
- Do NOT modify manufacturing pages (wax/reagent filling)
- Surgical edits only — do NOT rewrite files from scratch

## 8. Acceptance Criteria

### Phase Tracking
1. Scanning a new QR on CV page → phase auto-set to `wax_filled`
2. Scanning same QR again → phase auto-advances to `reagent_filled`
3. Phase banner shows previous → current transition
4. Operator can override auto-detected phase via dropdown
5. Phase advancement follows the defined pipeline order

### DHR Photo Linkage
6. After photo capture, `cartridge_records.photos[]` is updated
7. Cartridge detail page shows photo timeline grouped by phase
8. Each phase section shows thumbnails of all photos taken at that phase
9. Clicking a thumbnail in the timeline opens the lightbox

### Photo Enlargement
10. Clicking any thumbnail on the gallery/labels page opens a full-size lightbox
11. Lightbox shows image metadata (phase, date, labels, user)
12. Arrow keys / buttons navigate between images
13. Click outside or X to close

## 9. Notes for AI Agent

- **Stack:** SvelteKit 2 + Svelte 5 (`$props()`, `$state()`, `$derived()`)
- **QR scanner:** Already implemented with jsQR in the capture pages — hook into the existing `onQrDetected` callback
- **Image URLs:** Use the R2 public URL from `cv_images.imageUrl`
- **Phase constants:** Already defined in `src/lib/types/cv.ts` as `CARTRIDGE_PHASES`
- **CartridgeRecord model:** May need `photos` field added to Mongoose schema — check if schema is strict or flexible
- **Only edit** the files listed above
- **Surgical edits only** — do NOT rewrite files from scratch

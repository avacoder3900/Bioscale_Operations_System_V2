# PRD: CV Capture Station — Live Camera, QR Parsing & Auto-Labeling

**Author:** Alejandro Valdez
**Date:** 2026-03-31
**Status:** Draft
**Priority:** P1 — Enables image capture at manufacturing stations without leaving BIMS
**Branch:** `feature/cv-bims-integration`

---

## 1. Problem Statement

BIMS needs a built-in image capture station for the manufacturing floor. Operators currently have no way to:
- Capture photos directly from a USB camera plugged into a workstation
- Automatically identify which cartridge/lot is in frame via QR code
- Auto-label images with the correct manufacturing phase
- Maintain camera settings (exposure, white balance) across capture sessions

The Capture tab (Phase 1, built) proves the camera works in-browser. This PRD covers the remaining features to make it a production-ready capture station.

### Reference: LIZA Diagnostic Camera Scripts

Two Python scripts (`camera_capture.py` and `camera_capture_NO_POST_PROCESSING.py`) define the production camera workflow. All browser-side features must match these capabilities:

**Camera Settings (from LIZA tuning panel):**
```
Resolution:     1920 x 1080
Exposure:       -5 (manual, auto-exposure OFF)
White Balance:  4000K (manual, auto-WB OFF)
Brightness:     128
Contrast:       128
Autofocus:      OFF
Gain:           0
Sharpness:      128 (post-processed) / 0 (raw)
Saturation:     128
Gamma:          100
Buffer size:    1 (minimize latency)
Buffer flush:   20 frames on startup
```

**Post-Processing Pipeline (full version):**
1. Color correction — R: 0.85, G: 0.90, B: 1.0
2. Gaussian denoise (3x3 kernel)
3. CLAHE local contrast enhancement (clip limit 2.0, tile 8x8)
4. Gamma correction (0.85)
5. Unsharp mask sharpen kernel

**QR Code Scanning:**
- Primary: WeChatQRCode (OpenCV contrib, high accuracy)
- Fallback: OpenCV basic QRCodeDetector
- Green bounding box overlay on display only — saved image stays clean
- QR data embedded in filename: `cartridge_capture_{QRDATA}_{001}.png`

**Reliability:**
- 5 connection retries on startup
- Auto-reconnect on disconnect (5 retries, settings restored)
- Frame failure counter (10 fails → reconnect attempt)

---

## 2. What Exists Today (Phase 1 — Complete)

- **Capture tab** on `/cv/projects/[id]` page with live camera feed via `getUserMedia`
- **Camera selector** dropdown for multiple USB cameras
- **Auto-fallback** — skips cameras that return `NotReadableError`
- **Capture + Save** — snapshot to JPEG, upload to R2 via Cloudflare Worker, record in MongoDB
- **Multi-capture** — camera stays live between saves, session counter
- **Resume feed** — live feed restores after save (no black screen)

### Existing Infrastructure
| Component | Location | Status |
|-----------|----------|--------|
| R2 upload worker | `services/r2-upload-worker/` | Deployed |
| Presign endpoint | `src/routes/api/cv/images/presign/+server.ts` | Working |
| Image record endpoint | `src/routes/api/cv/images/record/+server.ts` | Working |
| Image label endpoint | `src/routes/api/cv/images/[id]/label/+server.ts` | Working |
| CvImage model | `src/lib/server/db/models/cv-image.ts` | Has `cameraIndex`, `cartridgeTag`, `label` fields |
| CV types | `src/lib/types/cv.ts` | `CameraInfo`, `ImageResponse`, `IMAGE_TAG_LABELS`, `CARTRIDGE_PHASES` |
| Python CV worker | `services/cv-worker/main.py` | PaDiM training + ONNX inference only |

---

## 3. Phase 2 — QR Code Scanning from Camera Feed

### 3.1 Browser-Side QR Detection

Use the browser's built-in `BarcodeDetector` API (Chrome 83+) to scan QR codes from the live video feed in real-time. Falls back to `jsQR` library if `BarcodeDetector` is unavailable.

**Flow:**
1. Camera is live on the Capture tab
2. A scanning loop runs every 500ms, grabbing a frame from the video
3. Frame is passed to `BarcodeDetector.detect()` or `jsQR()`
4. If a QR code is found, parse the value:
   - **Cartridge barcode** (e.g., `CART-000123`) → look up CartridgeRecord in BIMS
   - **Lot barcode** (e.g., `LOT-20260331-0001`) → look up LotRecord
   - **Part barcode** (e.g., `PART-000456`) → look up PartDefinition
5. Display the parsed info in a panel next to the camera feed
6. Auto-populate the `cartridgeTag` on captured images

**New API Endpoint:**
```
GET /api/cv/lookup-barcode?code=CART-000123
```
Returns the matching record (cartridge, lot, or part) with its current phase and metadata.

### 3.2 Auto-Tag on Capture

When a QR code is detected and the operator captures a photo:
- `cartridgeTag.cartridgeRecordId` is set automatically
- `cartridgeTag.phase` is set to the cartridge's current manufacturing phase
- Operator can override the phase via dropdown if needed

### Files to Create/Modify
| File | Change |
|------|--------|
| `src/routes/cv/projects/[id]/+page.svelte` | Add QR scanning loop, barcode info panel, auto-tag logic |
| `src/routes/api/cv/lookup-barcode/+server.ts` | New — barcode lookup endpoint |
| `package.json` | Add `jsQR` as fallback dependency |

---

## 4. Phase 3 — Camera Parameters & Presets

### 4.1 Camera Settings Panel

Expose `MediaTrackConstraints` settings in the UI:
- **Resolution** — dropdown (640x480, 1280x720, 1920x1080)
- **Exposure** — if camera supports `exposureMode` / `exposureCompensation`
- **White Balance** — auto or manual
- **Focus** — auto or manual (if supported)
- **Zoom** — slider (if supported)

```javascript
// Check what the camera supports
const track = stream.getVideoTracks()[0];
const capabilities = track.getCapabilities();
const settings = track.getSettings();

// Apply constraints
await track.applyConstraints({
  advanced: [{ exposureCompensation: 1.5, whiteBalanceMode: 'manual' }]
});
```

### 4.2 Camera Presets

Save camera configurations per project:
- Store in `CvProject.cameraPresets[]` (new field)
- Presets: name, deviceLabel, resolution, exposure, white balance, zoom
- Auto-apply preset when camera starts and label matches

### 4.3 Schema Addition

```typescript
// Add to CvProject model
cameraPresets: [{
  name: String,           // e.g., "Wax Fill Station"
  deviceLabel: String,    // e.g., "HD USB Camera"
  resolution: { width: Number, height: Number },
  exposure: Number,
  whiteBalance: String,
  zoom: Number,
  _id: false
}]
```

### Files to Create/Modify
| File | Change |
|------|--------|
| `src/routes/cv/projects/[id]/+page.svelte` | Camera settings panel, preset selector |
| `src/routes/cv/projects/[id]/+page.server.ts` | Save/load presets form action |
| `src/lib/server/db/models/cv-project.ts` | Add `cameraPresets` array |

---

## 5. Phase 4 — Auto-Labeling via QR + Phase

### 5.1 Rules Engine

Define labeling rules per project:
- If cartridge is in phase `wax_filled` → auto-tag image with `wax_fill`
- If cartridge is in phase `sealed` → auto-tag with `top_seal`
- Phase-to-tag mapping stored in `CvProject.autoLabelRules[]`

### 5.2 Batch Capture Mode

For high-throughput stations:
1. Operator places cartridge in front of camera
2. QR code is detected → cartridge info appears
3. Operator presses **Capture** (or spacebar shortcut)
4. Image is auto-tagged with phase and cartridge ID
5. Image is auto-labeled as `approved` or left unlabeled (configurable)
6. Counter increments, camera stays live
7. Repeat for next cartridge

### 5.3 Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Capture photo |
| `Enter` | Save captured photo |
| `Escape` | Retake / discard |
| `S` | Start/stop camera |

### Files to Create/Modify
| File | Change |
|------|--------|
| `src/routes/cv/projects/[id]/+page.svelte` | Auto-label logic, keyboard shortcuts, batch mode |
| `src/routes/cv/projects/[id]/+page.server.ts` | Save auto-label rules |
| `src/lib/server/db/models/cv-project.ts` | Add `autoLabelRules` array |

---

## 6. Phase 5 — Python CV Worker Enhancements

### 6.1 QR Code Parsing (Server-Side Fallback)

Add QR/barcode parsing to the Python CV worker for cases where the browser API can't read the code (damaged labels, low contrast).

**New endpoint:** `POST /parse-barcode`

```python
# Add to services/cv-worker/main.py
from pyzbar.pyzbar import decode as decode_barcode
from PIL import Image
from io import BytesIO

class BarcodeRequest(BaseModel):
    image_url: str  # R2 key or URL

@app.post("/parse-barcode")
async def parse_barcode(req: BarcodeRequest):
    # Download image
    key = req.image_url.split("/", 3)[-1] if "/" in req.image_url else req.image_url
    image_data = download_from_r2(key)
    img = Image.open(BytesIO(image_data))

    # Decode all barcodes/QR codes
    barcodes = decode_barcode(img)
    results = []
    for b in barcodes:
        results.append({
            "type": b.type,           # "QRCODE", "CODE128", etc.
            "data": b.data.decode(),  # The barcode content
            "rect": {
                "x": b.rect.left,
                "y": b.rect.top,
                "width": b.rect.width,
                "height": b.rect.height
            }
        })

    return {"barcodes": results, "count": len(results)}
```

**New dependency:** Add `pyzbar` to `requirements.txt`

### 6.2 Image Quality Metrics

Return basic quality metrics with each capture to help operators:

```python
@app.post("/image-quality")
async def image_quality(req: BarcodeRequest):
    image_data = download_from_r2(req.image_url)
    img = Image.open(BytesIO(image_data)).convert("L")  # grayscale
    arr = np.array(img)

    return {
        "brightness": float(arr.mean()),
        "contrast": float(arr.std()),
        "sharpness": float(laplacian_variance(arr)),  # blur detection
        "is_blurry": float(laplacian_variance(arr)) < 100
    }
```

### Files to Create/Modify
| File | Change |
|------|--------|
| `services/cv-worker/main.py` | Add `/parse-barcode` and `/image-quality` endpoints |
| `services/cv-worker/requirements.txt` | Add `pyzbar` |
| `services/cv-worker/Dockerfile` | Add `libzbar0` system dependency |
| `src/routes/api/cv/parse-barcode/+server.ts` | New — proxy to Python worker |

---

## 7. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (Capture Tab)                                          │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────────────┐ │
│  │ Video    │  │ QR Scanner   │  │ Camera Settings           │ │
│  │ Feed     │──│ (Barcode     │  │ (exposure, WB, zoom)      │ │
│  │ (USB)    │  │  Detector)   │  │                           │ │
│  └────┬─────┘  └──────┬───────┘  └───────────────────────────┘ │
│       │ capture        │ barcode found                          │
│       ▼                ▼                                        │
│  ┌──────────┐  ┌──────────────┐                                │
│  │ Canvas   │  │ Lookup API   │──▶ /api/cv/lookup-barcode      │
│  │ → JPEG   │  │ auto-tag     │     → CartridgeRecord          │
│  └────┬─────┘  └──────────────┘     → LotRecord                │
│       │ upload                       → PartDefinition           │
│       ▼                                                         │
│  ┌──────────────────┐                                           │
│  │ R2 Worker Upload │──▶ Cloudflare R2                          │
│  └──────────────────┘                                           │
│       │ record                                                  │
│       ▼                                                         │
│  ┌──────────────────┐                                           │
│  │ /api/cv/images/  │──▶ MongoDB (CvImage + cartridgeTag)      │
│  │ record           │                                           │
│  └──────────────────┘                                           │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Python CV Worker (server-side fallback)                        │
│  POST /parse-barcode  — pyzbar QR/barcode decode                │
│  POST /image-quality  — brightness, contrast, blur detection    │
│  POST /infer          — PaDiM anomaly detection (existing)      │
│  POST /train          — Model training (existing)               │
└─────────────────────────────────────────────────────────────────┘
```

---

## 8. Implementation Order

| Phase | Scope | Effort |
|-------|-------|--------|
| Phase 1 | Live camera + capture + multi-save (DONE) | Complete |
| Phase 2 | Browser QR scanning + barcode lookup + auto-tag | 4-6 hours |
| Phase 3 | Camera settings panel + presets | 3-4 hours |
| Phase 4 | Auto-labeling rules + batch mode + keyboard shortcuts | 3-4 hours |
| Phase 5 | Python QR fallback + image quality metrics | 2-3 hours |

---

## 9. Testing Checklist

### Phase 1 (Complete)
- [x] Camera starts and shows live feed
- [x] Camera selector works with multiple devices
- [x] Auto-fallback on NotReadableError
- [x] Capture freezes frame and shows preview
- [x] Save uploads to R2 and records in MongoDB
- [x] Camera stays live between saves
- [x] Feed resumes after save (no black screen)

### Phase 2
- [ ] QR code detected from live video feed within 2 seconds
- [ ] Barcode lookup returns correct cartridge/lot/part record
- [ ] Auto-tag populates `cartridgeTag` on captured image
- [ ] Falls back to `jsQR` when `BarcodeDetector` unavailable
- [ ] Works with damaged/low-contrast QR codes via Python fallback

### Phase 3
- [ ] Resolution dropdown changes camera output
- [ ] Exposure/white balance sliders work (when camera supports them)
- [ ] Preset saves to project and auto-applies on next session
- [ ] Capabilities are detected and unsupported controls are hidden

### Phase 4
- [ ] Phase-to-tag rules auto-label captured images
- [ ] Keyboard shortcuts (Space, Enter, Escape) work
- [ ] Batch capture counter tracks throughput
- [ ] Works end-to-end: scan QR → capture → auto-tag → save → next

### Phase 5
- [ ] Python `/parse-barcode` decodes QR codes from R2 images
- [ ] `/image-quality` returns brightness, contrast, blur score
- [ ] Blurry images flagged before save

---

## 10. Acceptance Criteria

1. An operator can capture multiple photos from a USB camera without the feed interrupting
2. QR codes on cartridges are automatically detected and linked to the correct record
3. Images are auto-tagged with the manufacturing phase based on the scanned cartridge
4. Camera settings persist between sessions via project presets
5. Keyboard shortcuts enable fast batch capture on the manufacturing floor
6. Server-side QR fallback handles cases the browser can't decode

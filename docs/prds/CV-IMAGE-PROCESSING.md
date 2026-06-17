# PRD: LIZA Image Processing Pipeline for BIMS CV Capture

**Author:** Alejandro Valdez
**Date:** 2026-03-31
**Status:** Draft
**Priority:** P1 — Matches LIZA diagnostic camera quality in BIMS web capture
**Branch:** `feature/cv-bims-integration`
**Reference:** `camera_capture.py`, `camera_capture_NO_POST_PROCESSING.py`

---

## 1. Problem Statement

The LIZA diagnostic camera scripts (`camera_capture.py`) produce consistent, high-quality images for CV inspection by applying:
- Fixed camera parameters (manual exposure, white balance, focus)
- A 5-step post-processing pipeline (color correction, denoise, CLAHE, gamma, sharpen)
- QR code detection with filename embedding

The BIMS Capture tab currently saves raw JPEG frames with no camera parameter control and no post-processing. Images captured in BIMS will be inconsistent compared to LIZA captures, which means CV models trained on LIZA images may perform poorly on BIMS-captured images (and vice versa).

**Goal:** Bring LIZA's image processing pipeline into BIMS so both systems produce equivalent image quality.

---

## 2. LIZA Camera Parameters (Reference)

From `camera_capture.py` tuning panel and `camera_capture_NO_POST_PROCESSING.py`:

### Hardware Settings (applied via OpenCV `cap.set()`)

| Parameter | Full Processing | Raw (No Processing) | OpenCV Constant |
|-----------|----------------|---------------------|-----------------|
| Resolution | 1920 x 1080 | 1920 x 1080 | `CAP_PROP_FRAME_WIDTH/HEIGHT` |
| Auto Exposure | OFF (1) | OFF (1) | `CAP_PROP_AUTO_EXPOSURE` |
| Exposure | -5 | -5 | `CAP_PROP_EXPOSURE` |
| Autofocus | OFF | OFF | `CAP_PROP_AUTOFOCUS` |
| Auto White Balance | OFF | OFF | `CAP_PROP_AUTO_WB` |
| White Balance | 4000K | — | `CAP_PROP_WB_TEMPERATURE` |
| Brightness | 128 | 128 | `CAP_PROP_BRIGHTNESS` |
| Contrast | 128 | 128 | `CAP_PROP_CONTRAST` |
| Gain | 0 | 0 | `CAP_PROP_GAIN` |
| Sharpness | 128 | 0 | `CAP_PROP_SHARPNESS` |
| Saturation | — | 128 | `CAP_PROP_SATURATION` |
| Gamma | — | 100 | `CAP_PROP_GAMMA` |
| Buffer Size | — | 1 | `CAP_PROP_BUFFERSIZE` |
| FPS | — | 30 | `CAP_PROP_FPS` |

### Browser Equivalent (`MediaTrackConstraints`)

```javascript
const track = stream.getVideoTracks()[0];
const capabilities = track.getCapabilities();

// Apply what the camera supports
await track.applyConstraints({
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  advanced: [{
    // These are only applied if the camera reports them in capabilities
    exposureMode: 'manual',
    exposureCompensation: capabilities.exposureCompensation ? -5 : undefined,
    whiteBalanceMode: 'manual',
    colorTemperature: capabilities.colorTemperature ? 4000 : undefined,
    brightness: capabilities.brightness ? 128 : undefined,
    contrast: capabilities.contrast ? 128 : undefined,
    focusMode: 'manual',
  }]
});
```

**Limitation:** Not all USB cameras expose these controls via the browser. The `getCapabilities()` check determines what's available. Unsupported parameters are silently ignored.

---

## 3. LIZA Post-Processing Pipeline

From `camera_capture.py` `process_frame()` function (lines 143-177):

```
Raw Frame
    │
    ▼
Step 1: COLOR CORRECTION
    Split BGR channels
    R × 0.85, G × 0.90, B × 1.0
    Merge back
    │
    ▼
Step 2: DENOISE
    Gaussian blur (3×3 kernel)
    │
    ▼
Step 3: CLAHE (Local Contrast)
    Convert to LAB color space
    Apply CLAHE to L channel (clipLimit=2.0, tileGrid=8×8)
    Convert back to BGR
    │
    ▼
Step 4: GAMMA CORRECTION
    gamma = 0.85
    LUT: pixel = ((pixel/255)^(1/gamma)) × 255
    │
    ▼
Step 5: SHARPEN
    Unsharp mask kernel:
    [[ 0, -1,  0],
     [-1,  5, -1],
     [ 0, -1,  0]]
    │
    ▼
Processed Frame (saved as PNG)
```

---

## 4. Implementation Strategy

Two modes, matching the two Python scripts:

| Mode | Description | When to use |
|------|-------------|-------------|
| **Raw** | No post-processing, camera params only | Training data collection, when Python worker will process later |
| **Processed** | Full 5-step LIZA pipeline | QC inspection, final documentation photos |

### 4.1 Browser-Side (Real-Time Preview)

Apply a lightweight version of the pipeline using Canvas 2D for real-time preview. This runs on every captured frame before display.

```typescript
function processFrame(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data; // RGBA pixel array

  // Step 1: Color correction (R×0.85, G×0.90, B×1.0)
  for (let i = 0; i < data.length; i += 4) {
    data[i]     = Math.min(255, data[i] * 1.0);     // R (note: canvas is RGBA, not BGR)
    data[i + 1] = Math.min(255, data[i + 1] * 0.90); // G
    data[i + 2] = Math.min(255, data[i + 2] * 0.85); // B
  }

  // Step 4: Gamma correction (gamma = 0.85)
  const invGamma = 1.0 / 0.85;
  const gammaLUT = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    gammaLUT[i] = Math.min(255, Math.round(Math.pow(i / 255, invGamma) * 255));
  }
  for (let i = 0; i < data.length; i += 4) {
    data[i]     = gammaLUT[data[i]];
    data[i + 1] = gammaLUT[data[i + 1]];
    data[i + 2] = gammaLUT[data[i + 2]];
  }

  ctx.putImageData(imageData, 0, 0);
}
```

**Note:** Steps 2 (denoise), 3 (CLAHE), and 5 (sharpen) are expensive per-pixel operations not practical for real-time browser rendering. They are applied server-side only.

### 4.2 Server-Side (Python CV Worker — Full Pipeline)

Add a `/process-image` endpoint to `services/cv-worker/main.py` that applies the full LIZA pipeline:

```python
class ProcessRequest(BaseModel):
    image_url: str          # R2 key
    output_key: str         # Where to save processed image in R2
    mode: str = "full"      # "full" (5-step) or "raw" (no processing)
    params: dict = {}       # Override defaults: gamma, clahe_strength, etc.

class ProcessResponse(BaseModel):
    original_key: str
    processed_key: str
    width: int
    height: int
    processing_time_ms: float

@app.post("/process-image")
async def process_image(req: ProcessRequest) -> ProcessResponse:
    start = time.time()

    # Download from R2
    image_data = download_from_r2(req.image_url)
    img = np.frombuffer(image_data, np.uint8)
    frame = cv2.imdecode(img, cv2.IMREAD_COLOR)

    if req.mode == "full":
        frame = liza_process_frame(frame, req.params)

    # Encode and upload
    _, buffer = cv2.imencode('.png', frame)
    upload_to_r2(buffer.tobytes(), req.output_key, 'image/png')

    h, w = frame.shape[:2]
    elapsed = (time.time() - start) * 1000

    return ProcessResponse(
        original_key=req.image_url,
        processed_key=req.output_key,
        width=w, height=h,
        processing_time_ms=round(elapsed, 1)
    )


def liza_process_frame(frame, params=None):
    """Exact replica of camera_capture.py process_frame()"""
    p = {
        'red_correction': 0.85,
        'green_correction': 0.90,
        'blue_correction': 1.0,
        'clahe_strength': 2.0,
        'gamma': 0.85,
        **(params or {})
    }

    # Step 1: Color correction
    b, g, r = cv2.split(frame)
    r = cv2.multiply(r, p['red_correction'])
    g = cv2.multiply(g, p['green_correction'])
    b = cv2.multiply(b, p['blue_correction'])
    frame = cv2.merge([b, g, r])

    # Step 2: Denoise
    frame = cv2.GaussianBlur(frame, (3, 3), 0)

    # Step 3: CLAHE
    lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB)
    l, a, b_ch = cv2.split(lab)
    clahe = cv2.createCLAHE(
        clipLimit=p['clahe_strength'],
        tileGridSize=(8, 8)
    )
    l = clahe.apply(l)
    frame = cv2.cvtColor(cv2.merge([l, a, b_ch]), cv2.COLOR_LAB2BGR)

    # Step 4: Gamma
    inv_gamma = 1.0 / p['gamma']
    table = np.array([
        ((i / 255.0) ** inv_gamma) * 255
        for i in range(256)
    ]).astype('uint8')
    frame = cv2.LUT(frame, table)

    # Step 5: Sharpen
    kernel = np.array([[ 0, -1,  0],
                       [-1,  5, -1],
                       [ 0, -1,  0]])
    frame = cv2.filter2D(frame, -1, kernel)

    return frame
```

### 4.3 SvelteKit Proxy Endpoint

```
POST /api/cv/process-image
Body: { imageKey, outputKey?, mode: "full"|"raw", params?: {} }
```

Proxies to the Python worker's `/process-image` endpoint. Called after upload to process the image server-side.

---

## 5. Capture Flow (Updated)

```
┌─────────────────────────────────────────────────────┐
│  Browser (Capture Tab)                               │
│                                                      │
│  1. Camera live feed (with hardware params applied)  │
│  2. QR detected → barcode lookup                     │
│  3. Space → capture frame to canvas                  │
│  4. Browser-side preview processing                  │
│     (color correction + gamma only)                  │
│  5. Space → save raw JPEG to R2                      │
│  6. Auto-trigger server-side processing              │
│                                                      │
└────────────┬────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────┐
│  Python CV Worker                                    │
│                                                      │
│  POST /process-image                                 │
│    - Downloads raw image from R2                     │
│    - Applies full LIZA 5-step pipeline               │
│    - Uploads processed image to R2                   │
│    - Returns processed_key                           │
│                                                      │
└────────────┬────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────┐
│  MongoDB (CvImage)                                   │
│                                                      │
│  filePath:          "cv/{project}/{id}.jpg"  (raw)   │
│  processedPath:     "cv/{project}/{id}_proc.png"     │
│  processingMode:    "full" | "raw"                   │
│  processingParams:  { gamma, clahe_strength, ... }   │
│                                                      │
└─────────────────────────────────────────────────────┘
```

---

## 6. Schema Changes

### CvImage Model Additions

```typescript
// Add to src/lib/server/db/models/cv-image.ts
processedPath: { type: String },              // R2 key for processed image
processingMode: { type: String, enum: ['full', 'raw', null] },
processingParams: {
  redCorrection: { type: Number, default: 0.85 },
  greenCorrection: { type: Number, default: 0.90 },
  blueCorrection: { type: Number, default: 1.0 },
  claheStrength: { type: Number, default: 2.0 },
  gamma: { type: Number, default: 0.85 },
  _id: false
},
processedAt: { type: Date },
```

### CvProject Model Additions

```typescript
// Camera preset matching LIZA tuning panel
captureSettings: {
  mode: { type: String, enum: ['full', 'raw'], default: 'full' },
  exposure: { type: Number, default: -5 },
  whiteBalance: { type: Number, default: 4000 },
  brightness: { type: Number, default: 128 },
  contrast: { type: Number, default: 128 },
  gain: { type: Number, default: 0 },
  sharpness: { type: Number, default: 128 },
  // Post-processing overrides
  redCorrection: { type: Number, default: 0.85 },
  greenCorrection: { type: Number, default: 0.90 },
  blueCorrection: { type: Number, default: 1.0 },
  claheStrength: { type: Number, default: 2.0 },
  gamma: { type: Number, default: 0.85 },
  _id: false
},
```

---

## 7. Processing Modes

| Mode | Browser Preview | Saved to R2 | Server Processing | Use Case |
|------|----------------|-------------|-------------------|----------|
| **Full** | Color + gamma preview | Raw JPEG | Full 5-step → PNG | QC inspection, documentation |
| **Raw** | No processing | Raw JPEG | None | Training data, when consistency isn't critical |

Toggle in the Capture tab UI: a "Processing: Full / Raw" switch.

---

## 8. Parameter Comparison: LIZA Python vs Browser vs Server

| LIZA Step | Browser (Canvas 2D) | Server (Python/OpenCV) | Notes |
|-----------|--------------------|-----------------------|-------|
| Camera params | `applyConstraints()` | N/A (camera is browser-side) | Depends on camera capabilities |
| Color correction | Per-pixel RGBA loop | `cv2.split/multiply/merge` | Exact match possible |
| Gaussian denoise | Not practical real-time | `cv2.GaussianBlur(3,3)` | Server only |
| CLAHE | Not available in Canvas | `cv2.createCLAHE(2.0, 8x8)` | Server only — key quality step |
| Gamma | LUT per-pixel | `cv2.LUT` | Exact match |
| Sharpen | ConvolutionMatrix possible but slow | `cv2.filter2D` with kernel | Server only for quality |

**Bottom line:** Browser does color + gamma for preview. Server does the full 5-step pipeline for the saved image. Both produce the same output as LIZA when the server pipeline runs.

---

## 9. Files to Create/Modify

### New Files
| File | Description |
|------|-------------|
| `src/routes/api/cv/process-image/+server.ts` | Proxy to Python worker `/process-image` |

### Modified Files
| File | Change |
|------|--------|
| `services/cv-worker/main.py` | Add `/process-image` endpoint with `liza_process_frame()` |
| `services/cv-worker/requirements.txt` | Add `opencv-python-headless` (if not already via anomalib) |
| `src/lib/server/db/models/cv-image.ts` | Add `processedPath`, `processingMode`, `processingParams`, `processedAt` |
| `src/lib/server/db/models/cv-project.ts` | Add `captureSettings` subdocument |
| `src/routes/cv/projects/[id]/+page.svelte` | Add processing mode toggle, browser preview processing, auto-trigger server processing after save |
| `src/routes/cv/projects/[id]/+page.server.ts` | Save/load captureSettings |

---

## 10. Implementation Order

| Step | Scope | Effort |
|------|-------|--------|
| 1 | Add `liza_process_frame()` + `/process-image` to Python worker | 1 hour |
| 2 | Add SvelteKit proxy endpoint | 30 min |
| 3 | Add schema fields to CvImage + CvProject models | 30 min |
| 4 | Browser camera params via `applyConstraints()` | 1 hour |
| 5 | Browser preview processing (color + gamma on canvas) | 1 hour |
| 6 | Auto-trigger server processing after capture save | 1 hour |
| 7 | Processing mode toggle (Full/Raw) in Capture tab | 30 min |
| 8 | Settings panel to override LIZA defaults per project | 1 hour |

---

## 11. Testing Checklist

- [ ] Camera applies manual exposure/WB when supported by USB camera
- [ ] Browser preview shows color correction + gamma adjustment
- [ ] Raw mode saves unprocessed JPEG to R2
- [ ] Full mode saves raw JPEG, then triggers server processing
- [ ] Server `/process-image` produces output matching LIZA `camera_capture.py`
- [ ] Processed image saved to R2 at `{key}_proc.png`
- [ ] CvImage record updated with `processedPath` and `processedAt`
- [ ] Project `captureSettings` persist and auto-apply on next session
- [ ] Processing parameters can be overridden per project
- [ ] Mode toggle (Full/Raw) works in Capture tab

---

## 12. Acceptance Criteria

1. An image captured in BIMS with "Full" processing mode is visually equivalent to one captured by `camera_capture.py`
2. An image captured in BIMS with "Raw" mode is visually equivalent to one captured by `camera_capture_NO_POST_PROCESSING.py`
3. Camera hardware parameters (exposure, WB, focus) are applied when the USB camera supports them
4. Processing parameters default to LIZA values but can be tuned per project
5. Both raw and processed versions of each image are stored in R2 for comparison

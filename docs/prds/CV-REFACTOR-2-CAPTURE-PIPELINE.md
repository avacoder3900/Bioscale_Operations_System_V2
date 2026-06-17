# PRD: CV Refactor — Capture Pipeline

**Author:** Jacob Quick (decisions) + Claude (drafted)
**Date:** 2026-05-15
**Status:** Draft → ready to implement
**Priority:** P0 — Required so operators can actually capture images post-wipe
**Branch:** `feature/cv-followups`
**Depends on:** [PRD 1 — Image Model](./CV-REFACTOR-1-IMAGE-MODEL.md)

---

## 1. Problem

Today's capture flow lives buried inside `/cv/projects/[id]` (now broken — projects don't exist). QR scanning happens in-browser via `jsQR`, which is slow and unreliable. Manufacturing operators on the wax-fill / reagent-fill / top-seal lines have no inline capture — they have to break flow to navigate to the CV section. R&D forensic capture (post-cartridge-run photos for failure analysis) has no dedicated path.

## 2. Decisions

| # | Decision |
|---|---|
| 1 | **Hardware USB barcode scanner replaces browser jsQR.** Scanner runs in HID keyboard-wedge mode. Last-scanned barcode is the **sticky cartridge context**. |
| 2 | **Always-on capture pattern.** Scan once → take as many photos as you want (front, back, side, etc.) — all auto-tagged with the sticky cartridge. Scan next cartridge → context flips. |
| 3 | **One dedicated `/capture` page** for general use. Single screen. Camera live; scanner-input always autofocused. |
| 4 | **Inline capture on manufacturing pages.** "Take photo" button on wax-fill / reagent-fill / top-seal WIs uses the cartridge currently in scope on that page (no scan needed — cartridge context comes from the page state). |
| 5 | **Separate R&D forensic capture flow** at `/cv/forensic-capture`. Tied to a test session/run, not a manufacturing phase. Same backend endpoint, different phase value (`post_run`). |
| 6 | **Orphan scans reject inline.** If the scanned cartridge ID doesn't exist as a CartridgeRecord, capture endpoint returns 400 with `Cartridge not found`. Operator sees a banner, no save. |

## 3. UI

### 3.1 `/capture` (dedicated capture station)

```
┌──────────────────────────────────────────────────────────────┐
│  Capture Station                                              │
│                                                              │
│  Cartridge: 🟢 CART-000123  (scanned 14s ago)                │
│  Phase:     [wax_filled ▾]                                   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │                                                       │    │
│  │              live video feed                          │    │
│  │              (camera selector)                        │    │
│  │                                                       │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  [Take Photo]                          Photos this scan: 3   │
│                                                              │
│  ───── Just captured ─────                                   │
│  📷 CART-000123_001  (1s ago)                                │
│  📷 CART-000123_002  (8s ago)                                │
│  📷 CART-000123_003  (14s ago)                               │
│                                                              │
│  [hidden barcode-wedge input — autofocused]                  │
└──────────────────────────────────────────────────────────────┘
```

**Behavior:**
- Hidden `<input>` element has `autofocus` and refocuses on any blur.
- USB scanner keystrokes type into it; `Enter` triggers `handleScan(qrText)`.
- `handleScan` validates the cartridge via `/api/cv/lookup-cartridge`, on success sets the sticky context state; on failure shows a red banner and resets.
- "Take Photo" button (or `Space` key) snapshots the current `<video>` frame and POSTs to `/api/cv/capture` with `{ cartridgeId, phase, file }`.
- Photo thumbnails stream in below as captures land.
- Phase dropdown defaults to `wax_filled`; operator picks for each cartridge.

**Edge cases:**
- No cartridge scanned yet → "Take Photo" button disabled, status banner: "Scan cartridge to start."
- Cartridge scanned but doesn't exist → "Cartridge CART-X not found in BIMS" toast, sticky context reset.
- Camera not connected → fallback to camera-selector dropdown (re-use existing UX).

### 3.2 Inline manufacturing capture

A small `<CaptureButton cartridgeId={...} phase="wax_filled" />` component embedded on:

- `/manufacturing/wax-filling/+page.svelte` — current cartridge in the active run
- `/manufacturing/reagent-filling/+page.svelte` — same
- `/manufacturing/top-seal/+page.svelte` (or wherever sealing lives) — same

Clicking the button opens a small modal with live camera + "Capture & Save" button. No scanning required — cartridge ID comes from the page's existing state. Phase value is hardcoded per page.

### 3.3 `/cv/forensic-capture` (R&D)

Identical to `/capture` UX, but:
- Phase locked to `post_run`
- Asks for optional `runId` / `sessionId` input to tie to a test run
- Banner explains: "R&D forensic capture — these images are for failure analysis, not manufacturing QC."

## 4. API

### `POST /api/cv/capture` (NEW)

Replaces presign+record for the new cartridge-first flow.

**Request (multipart/form-data):**
- `file`: image blob (JPEG or PNG)
- `cartridgeId`: required
- `phase`: required (any string; common values `wax_filled`, `reagent_filled`, `sealed`, `post_run`)
- `cameraIndex`: optional
- `processingMode`: optional, `'full'` or `'raw'`

**Behavior:**
1. `requirePermission(locals.user, 'cv:capture' OR 'manufacturing:write')`
2. Validate cartridge exists; 400 `Cartridge not found` if not.
3. Atomically `$inc` `CartridgeRecord.photoSequence` to get new sequence number.
4. Build `cartridgeImageNumber` = `{cartridgeId}_{seq:03}`.
5. Build R2 key: `cv/captures/dhr/{cartridgeId}/{phase}/{cartridgeImageNumber}-{timestamp}.jpg`.
6. Upload buffer via Cloudflare Worker proxy.
7. Insert `CvImage` document with `cartridgeTag`, `cartridgeImageNumber`, `capturedBy`, `capturedAt`.
8. Push photo ref to `CartridgeRecord.photos[]`.
9. (Optional Phase-3 enhancement) Look up projects with `deployAtPhases` includes `phase`; if any have an `activeModelVersion`, fire-and-forget inference call.
10. Return `{ imageId, cartridgeImageNumber, imageUrl }`.

**Response (201):**
```json
{
  "imageId": "pK3xV9w...",
  "cartridgeImageNumber": "CART-000123_001",
  "imageUrl": "https://r2.brevitest-cv.com/cv/captures/dhr/CART-000123/wax_filled/...",
  "phase": "wax_filled"
}
```

**Response (400):** `{ "error": "Cartridge CART-000123 not found in BIMS" }`

### `POST /api/cv/capture-ingest` (UPDATED — backwards-compat for lab Python)

Same backwards-compatible contract as today (multipart, agent API key). But:
- `projectId` is silently ignored (it used to be required-or-fallback-to-env).
- `qrCode` field still maps to `cartridgeId`.
- `phase` still required.
- **Now rejects with 400 if cartridge doesn't exist** (per orphan-reject decision).
- Same body shape used internally as `/api/cv/capture`.

This means lab Python scripts keep working — they just need to be capturing images of cartridges that exist in BIMS. The `BIMS_PROJECT_ID` env var in their scripts becomes a no-op.

### `POST /api/cv/induct-cartridge` (DELETED)

Induction is gone. Route removed; UI button removed; references stripped from `/cv/projects/[id]` (which is also being rebuilt).

### `GET /api/cv/lookup-cartridge?id=CART-X` (UPDATED)

Already exists. Behavior simplifies:
- Returns `{ exists: true, status, currentPhase, photoCount }` if found.
- Returns 404 with `{ error: "Cartridge not found" }` if not.
- No "next phase" auto-advancement — phase comes from the operator's selection in the UI.

## 5. Files

| File | Action |
|---|---|
| `src/routes/capture/+page.svelte` | NEW — dedicated capture station |
| `src/routes/capture/+page.server.ts` | NEW — loader |
| `src/routes/api/cv/capture/+server.ts` | NEW — cartridge-first capture endpoint |
| `src/routes/api/cv/capture-ingest/+server.ts` | UPDATE — silently ignore projectId, reject orphans |
| `src/routes/api/cv/induct-cartridge/+server.ts` | DELETE |
| `src/routes/api/cv/lookup-cartridge/+server.ts` | UPDATE — drop induct-mode auto-create |
| `src/lib/components/cv/CaptureButton.svelte` | NEW — reusable inline capture button |
| `src/routes/manufacturing/wax-filling/+page.svelte` | UPDATE — add CaptureButton |
| `src/routes/manufacturing/reagent-filling/+page.svelte` | UPDATE — add CaptureButton |
| `src/routes/manufacturing/top-seal/+page.svelte` (find actual path) | UPDATE — add CaptureButton |
| `src/routes/cv/forensic-capture/+page.svelte` | NEW — R&D forensic flow |
| `src/routes/cv/forensic-capture/+page.server.ts` | NEW |

## 6. Implementation order

1. `/api/cv/capture` endpoint (depends on PRD 1 schema).
2. Update `/api/cv/capture-ingest` and `/api/cv/lookup-cartridge`; delete `/api/cv/induct-cartridge`.
3. `/capture` page UI.
4. `CaptureButton` shared component.
5. Wire CaptureButton into 3 manufacturing pages.
6. `/cv/forensic-capture` page.

## 7. Acceptance

- [ ] Operator at `/capture` can scan a barcode (USB scanner) and the sticky context appears within 100ms.
- [ ] Taking a photo with sticky context works without further input.
- [ ] Photos uploaded show up immediately in the "just captured" list.
- [ ] Scanning a non-existent cartridge shows a clear "not found" banner; no photo is saved.
- [ ] Switching cartridges (scanning a new code) updates context without page reload.
- [ ] Manufacturing pages have an inline button that captures with the right cartridge + phase pre-filled.
- [ ] Python `camera_capture.py` still posts successfully to `/api/cv/capture-ingest` (with any non-existent cartridge now rejected).
- [ ] `/api/cv/induct-cartridge` returns 404.

## 8. Out of scope (handled elsewhere)

- Model inference triggered by capture (PRD 3)
- Browsing captured photos chronologically (PRD 4 — /cv/stream)
- Labeling captured photos (PRD 4 — /cv/label)
- Adding photos to a project's training set (PRD 3 + PRD 4)

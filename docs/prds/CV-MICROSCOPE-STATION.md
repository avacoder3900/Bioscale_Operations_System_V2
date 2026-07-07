# PRD: CV Microscope Station (CV-MICROSCOPE-01)

**Branch:** `cv-microscope` (off `feat/cv-clean-datapath`)
**Date:** 2026-07-07 · **Status:** DRAFT — awaiting approval before implementation

## 1. Problem

We want a CV capture station whose camera is a **microscope** (Celestron Imager HD, a UVC USB camera) mounted on a Raspberry Pi, instead of the standard top-down webcam. The station must keep the existing **Waveshare GW-Barcode wedge scanner** workflow (scan a cartridge → it's identified/locked), and add an **automatic capture sequence**: after a scan, the station takes **15 photos on a timer** without operator interaction, stores them through the normal BIMS photo pathway, and stamps each photo with its **sequence slot (1–15)** so the photos can be **labeled by location later** (slot → physical location mapping is a follow-up, not this PRD).

## 2. What exists today (grounding)

- `services/bims-capture-agent/` — Pi-side Python service (aiohttp + aiortc + evdev):
  - `camera.py`: opens `/dev/video0` hardcoded, MJPG 1280×720, exposes a WebRTC video track + camera tuning props (exposure, focus, WB…).
  - `scanner.py`: Waveshare GW-Barcode (VID 0218/PID 0210) via evdev → scan events over the agent's WebSocket.
  - `agent.py`: `/health` + `/ws` (auth, WebRTC signaling, scan events, LED). Principle to date: *the Pi never writes to the BIMS DB* — the operator's browser grabs frames and POSTs `/api/cv/capture`.
- `POST /api/cv/capture-ingest` — agent-key-authenticated ingest endpoint (exists on the branch): validates cartridge, uploads to R2, creates the `cv_images` technical row, appends the truth entry to `cartridge_records.photos[]`.
- `photos[]` on `cartridge_records` is the single source of photo truth (new datapath): `imageId, phase, capturedAt, capturedBy, r2Key, r2Url, cartridgeImageNumber, qcLabel, labels[], notes, annotations[]`.
- `/capture` page: station mode (WebRTC feed, scan lock, intake-mode toggle), phase select.

## 3. Design

### 3.1 Camera: microscope support on the Pi agent
- **Device selection** becomes configurable: `CAMERA_DEVICE` env — an index (`0`), a device path (`/dev/video2`), or a **name substring match** (`celestron`, resolved via v4l2/`/sys/class/video4linux/*/name` on the Pi and DirectShow name enumeration on Windows dev machines). Today's hardcoded `/dev/video0` becomes the default.
- **Microscope profile**: a named tuning preset (`CAMERA_PROFILE=microscope`) applied on open — fixed focus (autofocus off), manual exposure default, 1920×1080 target (clamped by the sensor), no LIZA color pipeline (microscope optics ≠ cartridge rig lighting). Values remain adjustable live from the `/capture` tuning sliders exactly as today.
- **Dev mode on Windows**: the agent must start without evdev (scanner already optional) so the Celestron + sequence engine can be tested on the desk before the Pi build.

### 3.2 Barcode scanner (unchanged pathway, new trigger)
- Waveshare wedge scanner keeps working exactly as today: scan → WS event → browser locks the cartridge (including the new **intake mode**, so an unknown barcode can be created and assigned to a step first).
- New: when **sequence auto-start** is enabled, a successful scan-lock immediately starts the 15-photo sequence (scan → walk away).

### 3.3 Auto-capture sequence engine (the core new code)
- New agent module `sequence.py`:
  - WS commands: `sequence_start {cartridgeId, phase, count, intervalMs}`, `sequence_abort`.
  - On start: every `intervalMs`, grab a **full-resolution still** directly from the camera (not a WebRTC frame — WebRTC is capped/compressed) until `count` photos are taken.
  - WS progress events after each shot: `sequence_progress {index, count, imageId}` → live progress bar in the browser; `sequence_done` / `sequence_error` at the end.
- **Upload path — recommended: agent POSTs directly to `/api/cv/capture-ingest`** with the fleet `STATION_AGENT_KEY`. Rationale: a 15-shot timed run mediated through the operator's browser tab adds failure modes (tab focus/sleep, WebRTC frame quality) for zero benefit; `capture-ingest` already exists for exactly this kind of scripted ingest and lands photos in the standard pathway (R2 + `photos[]` + auto-inference). This intentionally relaxes the "Pi never writes to BIMS" principle — flagged as **Decision 1** below.
- **Resilience**: each still is saved to a local spool first (`/home/pi/bims-spool/<sequenceId>/NN.jpg`), then uploaded; on upload failure, retry with backoff; spool entries delete on confirmed ingest. Power loss mid-sequence loses at most the not-yet-taken shots.

### 3.4 Storage & labeling of sequence photos — a photo TYPE, not a phase
Microscope photos are **not a manufacturing state**. `phase` values like `wax_filled`/`sealed` describe where the cartridge is in the process; a microscope capture is a different *kind of photo* of the same cartridge. So no new phase is created. Instead the `photos[]` subdocument gains a descriptor + location block (schema addition on this branch):

```
photoType:  'inspection' | 'microscope'        // default 'inspection' — existing photos unchanged
sequenceId: String                             // groups one 15-shot run
sequenceIndex: Number                          // 1…15, order taken
location: { row: String, col: Number }         // named grid position, e.g. row 'A', col 3 → "A3"
```

- **Grid pattern**: 15 shots default to a **3 rows × 5 columns** grid (rows `A–C`, columns `1–5`), row-major scan order. The pattern is config (`GRID_ROWS`/`GRID_COLS`, rows×cols must equal count), and the agent **pre-stamps `location` from `sequenceIndex`** per the pattern (shot 1 → A1, shot 6 → B1, …). The follow-up labeling UI can correct/confirm locations later — but every photo carries a best-guess row/col from day one.
- **Phase on microscope photos**: left `null`. They don't participate in phase-based inference routing (no `runPhaseInference` fires for them) and never pollute a step model's training set. If a microscope model is wanted later, model scoping by `photoType` is a small follow-up on `CvProject`.
- **Findability** (a first-class requirement):
  - Mongo index on `photos.photoType` (+ `photos.location.row/col`).
  - **Image Stream**: new filter `type = microscope` and a location filter (row/col), each photo card badges its `location` (e.g. `A3`) and run.
  - **Cartridge admin / DHR**: cartridges with microscope photos are queryable (`photos.photoType: 'microscope'`); the DHR photo section groups a run by `sequenceId` and shows the row/col grid.
- `capture-ingest` gains acceptance of `photoType`, `sequenceId`, `sequenceIndex`, `location` and passes them into the photo entry. Defaults: `count = 15`, `intervalMs = 2000` (env-overridable and settable per-run from the UI).

### 3.5 `/capture` page UI (station mode)
- A **"Microscope sequence"** panel when the selected station reports the `sequence` capability in `/health`:
  - count (default 15) + interval inputs, **Start sequence** / **Abort** buttons
  - auto-start-on-scan toggle
  - progress bar fed by `sequence_progress` WS events (`7 / 15…`), completion summary with a link to the cartridge's photos in the stream.

## 4. Out of scope
- The location-labeling UI itself (follow-up PRD; data model prepared here).
- Motorized stage / positioning control — "location" here is a post-hoc human label, the microscope does not move by itself.
- CV model changes — sequence photos train/infer through the existing pathway untouched.

## 5. Implementation plan (phased)
| Phase | What | Files |
|---|---|---|
| P1 | Camera device selection by name/index/path + microscope profile + Windows dev mode | `services/bims-capture-agent/camera.py`, `agent.py`, `.env.example`, README |
| P2 | Sequence engine: WS commands, timer stills, local spool, direct ingest w/ retry, progress events | new `services/bims-capture-agent/sequence.py`, `agent.py` |
| P3 | `photos[].photoType/sequenceId/sequenceIndex/location` schema + indexes + `capture-ingest` acceptance | `cartridge-record.ts`, `api/cv/capture-ingest/+server.ts` |
| P4 | `/capture` sequence panel (grid config, start/abort/progress/auto-start) + stream `type`/location filters + DHR run grouping | `capture/+page.svelte`, `cv/stream/+page.server.ts` + `.svelte`, DHR pages |
| P5 | Bench test on Windows with the Celestron; then Pi provisioning notes | RUNBOOK.md |

## 6. Decisions (all RESOLVED 2026-07-07)
1. **Upload path — RESOLVED: `capture-ingest`, which IS the standard BIMS storage path.** `/api/cv/capture-ingest` performs the identical storage sequence as the browser's `/api/cv/capture` (R2 upload → `cv_images` technical row → `cartridge_records.photos[]` truth entry); it differs only in auth (station agent key vs. login session). No parallel pipeline is created.
2. **Interval — RESOLVED: config variable**, not a fixed decision. `SEQUENCE_INTERVAL_MS` env on the agent (initial default 2000) + per-run override from the UI. Tunable when hardware arrives, no code change.
3. **Photo type — RESOLVED:** `photoType: 'microscope'` descriptor, not a phase. `phase` stays null on microscope photos.
4. **Count & grid — RESOLVED: config variables.** `SEQUENCE_COUNT` (default 15) and `GRID_ROWS`/`GRID_COLS`/`GRID_ORDER` (default 3×5, rows A–C × cols 1–5, row-major) as agent env + UI overrides. rows×cols must equal count; the slot→row/col stamping derives from whatever the config says at capture time, so grid shape/order can be finalized during bench testing.

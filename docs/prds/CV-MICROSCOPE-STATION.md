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

### 3.4 Storage & labeling of sequence photos
- **Defaults**: `count = 15`, `intervalMs = 2000` (both env-overridable and settable per-run from the UI).
- **Phase**: new capture phase **`microscope`** (added to the capture page's phase list). Sequence photos are ordinary `photos[]` entries at that phase — visible in Image Stream, DHR, labelable, trainable.
- **Sequence identity for later location-labeling** — add two optional fields to the `photos[]` subdocument (schema addition on this branch):
  - `sequenceId: String` — one id per 15-shot run (groups the set)
  - `sequenceIndex: Number` — 1…15, the slot within the run
- "Label by location later" contract: a follow-up UI will present a run's 15 photos ordered by `sequenceIndex` and let someone assign location names, written into the existing `photos[].labels[]` (vocabulary via `failure_labels` or a new location vocabulary — decided in that follow-up, **not built here**). This PRD only guarantees the data needed for it exists.
- `capture-ingest` gains acceptance of `sequenceId`/`sequenceIndex` and passes them into the photo entry.

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
| P3 | `photos[].sequenceId/sequenceIndex` schema + `capture-ingest` acceptance + `microscope` phase | `cartridge-record.ts`, `api/cv/capture-ingest/+server.ts`, `capture/+page.server.ts` |
| P4 | `/capture` sequence panel (start/abort/progress/auto-start toggle) | `capture/+page.svelte` |
| P5 | Bench test on Windows with the Celestron; then Pi provisioning notes | RUNBOOK.md |

## 6. Decisions needed (defaults applied if unchallenged)
1. **Direct ingest from the Pi** (agent → `capture-ingest` with `STATION_AGENT_KEY`) instead of browser-mediated upload — **recommended yes**.
2. **Interval default 2 s** between the 15 shots (a full run ≈ 30 s) — adjust?
3. **Phase name `microscope`** for these photos — or should sequence photos use the cartridge's inspect-step phase (e.g. `wax_filled`) so existing per-step models score them? Default: `microscope` (its own model scope; a Stage Models assignment can deploy a model there when ready).
4. **15 photos fixed per run** — count is configurable but defaults to 15 per the requirement.

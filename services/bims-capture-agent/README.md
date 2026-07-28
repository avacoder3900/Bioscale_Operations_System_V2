# bims-capture-agent

Pi-side Python service for the BIMS remote capture station. One agent process
per Raspberry Pi exposes the station's USB camera, USB barcode scanner, and
(optional) 365 nm UV LED to the BIMS `/capture` page via HTTP + WebSocket +
WebRTC.

See `docs/prds/PI-CAPTURE-STATION.md` for the full design. This README covers
how to run and install the agent.

## What it does

- `GET /health` — discovery + status endpoint polled by BIMS. Returns
  station identity, agent version, peripheral readiness flags, the active
  `camera_profile`, a `capabilities` list (includes `"sequence"`), and uptime.
- `WS /ws` — single WebSocket per connected operator browser. Carries
  WebRTC signaling (Phase 2), scanner events (Phase 3), LED commands
  (Phase 4), and the microscope **sequence** commands/events (below).
- The operator's browser still grabs live frames via WebRTC and POSTs
  `/api/cv/capture` for manual captures. The **microscope sequence engine**
  is the one exception: the agent grabs full-resolution stills itself and
  POSTs them directly to `/api/cv/capture-ingest` (agent-keyed), so a timed
  15-shot run doesn't depend on browser tab focus or WebRTC frame quality.

## Camera device selection & profile

The camera is no longer hardcoded to `/dev/video0`:

- **`CAMERA_DEVICE`** — an integer index (`0`), a device path (`/dev/video2`),
  or a **case-insensitive name substring** (`celestron`). Name resolution scans
  `/sys/class/video4linux/*/name` on Linux and prefers the lowest `/dev/videoN`
  that actually yields frames (many UVC cams expose a second metadata node).
  **On Windows** name matching is not available through OpenCV — use a numeric
  index (or leave unset for `0`); the agent opens with the DSHOW backend there.
  Unset → index `0` (the historical default).
- **`CAMERA_PROFILE`** — `default` (1280×720, current behavior) or `microscope`
  (targets 1920×1080, disables autofocus + auto-exposure for consistent timed
  stills, applies no color pipeline). Live tuning from the `/capture` sliders
  keeps working in either profile.

### Multiple cameras on one station (CV-CAMERA-02)

A station can have several cameras attached — typically an overview camera plus
the Celestron microscope — described by **`CAMERAS`**, a JSON array:

```json
[{"id":"overview","role":"overview","label":"Overview",
  "device":"/dev/v4l/by-id/usb-HD_USB_Camera_HD_USB_Camera-video-index0",
  "profile":"default"},
 {"id":"scope","role":"microscope","label":"Microscope",
  "device":"celestron","profile":"microscope","sequence":true}]
```

- `device` takes the same spec as `CAMERA_DEVICE`. **Prefer a
  `/dev/v4l/by-id/...` path** — the kernel keys those by USB vendor+product, so
  they survive reboots and re-plugging, while `/dev/videoN` numbering does not.
  Run `ls /dev/v4l/by-id/` on the station to find them. No udev rules needed.
- `role` is `overview` or `microscope`; it decides the `photoType` recorded on
  photos taken through that camera.
- `sequence` defaults to true for microscope-role cameras and false otherwise.
- **`CAMERAS` unset** → a single camera is synthesized from `CAMERA_DEVICE` /
  `CAMERA_PROFILE`, which is exactly the historical behavior. Existing stations
  need no config change.

**Exactly one camera is open at a time.** The device can't be opened twice, and
running two JPEG encoders at once is what browned out station 3's PSU — a switch
is a hand-off, not a second stream. Switch from the `/capture` camera buttons, or
over `/ws`:

- `{cmd:"select_camera", cameraId}` — hand the capture handle to that camera.
  Refused with an `error` event (`sequence_running`) while a sequence run is
  active: swapping optics mid-run would file a split-optics set under one
  `sequenceId` with nothing recording which camera shot which frame.
- `{event:"camera_changed", cameras, activeCameraId, cameraOk}` — **broadcast**
  to every connected client, followed by a fresh `camera_params`, so sibling
  tabs don't keep driving the previous camera's control ranges.

`/health` reports `cameras[]`, `active_camera_id`, and advertises
`camera_switch` in `capabilities` — feature-detect on that, **not** on
`agent_version`, which has read `0.1.0` across every build shipped so far.

`/preview.mjpg` and `/snapshot.jpg` accept an optional `?camera=<id>` that
asserts which optics the caller expects and returns **409** on a mismatch,
rather than silently serving frames from whichever camera happens to be open.

The active camera is in-memory only: a restart returns the station to the first
entry in `CAMERAS`.

## Microscope sequence engine

After a cartridge scan-lock, a run of full-resolution stills is captured on a
timer and uploaded through the standard BIMS photo path. Driven over `/ws`:

- **Commands (browser → agent):**
  - `{cmd:"sequence_start", cartridgeId, count?, intervalMs?}` — start a run.
    Rejected with a `sequence_error` event if a run is already active or
    `cartridgeId` is missing. `count`/`intervalMs` default to the env values.
  - `{cmd:"sequence_abort"}` — stop the current run after the in-flight shot.
- **Events (agent → browser):**
  - `{event:"sequence_started", sequenceId}` — ack (carries the run id).
  - `{event:"sequence_progress", sequenceId, index, count, imageId|null, uploaded, location}`
    — one per shot; `location` is `{row, col}` or `null` (grid mismatch).
  - `{event:"sequence_done", sequenceId, count, uploaded, failed, aborted}`.
  - `{event:"sequence_error", message}` — start rejected or run crashed.
  - `{event:"sequence_aborting", sequenceId}` — ack of an abort command.

Each still is JPEG-encoded (~q92), spooled to `SPOOL_DIR/<sequenceId>/NN.jpg`,
then multipart-uploaded to `${BIMS_URL}/api/cv/capture-ingest` with fields
`file, qrCode, photoType=microscope, sequenceId, sequenceIndex, locationRow,
locationCol`. On success the spool file is deleted; on failure it is retried up
to 3× (1s/3s/9s backoff) and, if still failing, left on disk for recovery while
the run continues.

**Grid stamping:** shots default to a 3×5 grid (rows A–C × cols 1–5), so each
photo carries a best-guess `location` for later labeling. `rows*cols` must equal
`count`; on a mismatch the run still captures but omits `location`.

## Stack

- Python 3.11 (default on Pi OS Bookworm)
- `aiohttp` — HTTP + WebSocket server
- `aiortc` — WebRTC for the camera track (Phase 2)
- `evdev` — barcode scanner input (Phase 3)
- `gpiozero` — LED GPIO control (Phase 4)
- `opencv-python` — camera frame capture

## Dev setup (on a Pi)

```bash
cd services/bims-capture-agent
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env   # then edit STATION_ID, STATION_NAME, STATION_TOKEN
python agent.py
```

The service binds `0.0.0.0:8765` by default. Override with `PORT=...`.

## Env file

In production the env file lives at `/etc/bims/station.env` (mode 0600,
owned by `root:bims`). `setup-station.sh` writes it on first boot. In dev
the agent also reads a local `.env` if present.

Required keys:

| Key | Purpose |
|---|---|
| `STATION_ID` | UUID assigned at provisioning time. Stable for the life of the SD card. |
| `STATION_NAME` | Human-friendly label, e.g. `"Wax Fill Bench 1"`. |
| `STATION_TOKEN` | **Vestigial — the agent never reads it.** `/ws` auth is the per-station HS256 JWT in `STATION_JWT_SECRET`; the `X-Station-Token` header carries that JWT, not this value. Still written by the provisioning scripts. |
| `STATION_JWT_SECRET` | HS256 secret for verifying browser→Pi auth JWTs. Appended by the provisioning scripts after a successful registration. Empty → all `/ws`, `/preview.mjpg`, and `/snapshot.jpg` requests are rejected. |
| `BIMS_URL` | Origin used for self-registration + sequence ingest calls back to BIMS. |
| `PORT` | Optional; defaults to `8765`. |

Optional camera + sequence keys (all have defaults):

| Key | Default | Purpose |
|---|---|---|
| `CAMERAS` | — | JSON array of cameras on this station (see "Multiple cameras" above). Unset → one camera synthesized from `CAMERA_DEVICE`/`CAMERA_PROFILE`. |
| `CAMERA_DEVICE` | `0` | Single-camera selector: index, `/dev/videoN` path, or name substring (Linux only for names). Ignored when `CAMERAS` is set. |
| `CAMERA_PROFILE` | `default` | `default` (1280×720) or `microscope` (1920×1080, AF/AE off). Ignored when `CAMERAS` is set — each entry carries its own `profile`. |
| `SEQUENCE_COUNT` | `15` | Default stills per run (per-run overridable). |
| `SEQUENCE_INTERVAL_MS` | `2000` | Milliseconds between shots (per-run overridable). |
| `GRID_ROWS` | `3` | Grid rows for location stamping; `GRID_ROWS*GRID_COLS` must equal count. |
| `GRID_COLS` | `5` | Grid columns for location stamping. |
| `GRID_ORDER` | `row-major` | `row-major` or `serpentine` scan order. |
| `SPOOL_DIR` | `~/bims-spool` | Local spool root for in-flight sequence stills. |
| `AGENT_API_KEY` | — | Auth for `/api/cv/capture-ingest` (header `x-agent-api-key`). Falls back to `STATION_AGENT_KEY` if unset. See RUNBOOK note — this is a *different* secret from the fleet `STATION_AGENT_KEY`. |

## Production install (systemd)

```bash
sudo cp bims-capture-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bims-capture-agent
sudo journalctl -u bims-capture-agent -f
```

The unit expects the agent installed at `/opt/bims-capture-agent` with the
virtualenv at `/opt/bims-capture-agent/.venv`, and `/etc/bims/station.env`
populated. `setup-station.sh` handles both.

## Layout

```
services/bims-capture-agent/
  agent.py                       main aiohttp entry point
  camera.py                      WebRTC camera bridge (Phase 2)
  scanner.py                     evdev scanner reader (Phase 3)
  led.py                         GPIO/USB LED controller (Phase 4)
  requirements.txt
  bims-capture-agent.service     systemd unit
  setup-station.sh               first-boot configuration
  README.md
```

# CV-CAMERA-02 — Dual-Camera Capture Stations (overview + microscope on one Pi)

**Status:** Draft for review
**Branch:** `feat/dual-camera-stations` (off `NEWDEV` @ `0e8fd30b`)
**Date:** 2026-07-28
**Owner:** Alejandro

---

## 1. Summary

Let one capture station host more than one camera — typically a regular overview camera plus
the Celestron microscope — and let the operator switch between them from `/capture` without
SSH, a config edit, or an agent restart.

**Exactly one camera streams at a time.** This is not tidiness: the V4L2 device can't be
opened twice, MJPEG has no fan-out in this agent (every `<img>` is its own device read *and*
its own JPEG encode), and simultaneous dual encode is what browned out station 3's PSU
(recorded at `src/routes/capture/+page.svelte:42-47`). A switch is a hand-off, never a
second stream.

The work also promotes "is this a microscope?" from a **station** property to a **camera**
property, which is what makes the feature expressible at all.

---

## 2. Current state (verified against the live fleet, 2026-07-28)

"Microscope" is expressed in three unrelated places, all station-scoped:

| # | Where | What it is |
|---|---|---|
| 1 | `services/bims-capture-agent/camera.py:74` | `CAMERA_PROFILE` env var, read **once at import** into a module global |
| 2 | `src/lib/server/db/models/capture-station.ts:47-49` | `capabilities.sequence` boolean — the only thing the UI gates on |
| 3 | `cv-image.ts:72`, `cartridge-record.ts:188` | `photoType: 'inspection' \| 'microscope'` — stamped by *which code path shot it*, not which camera |

The agent holds one `cv2.VideoCapture` behind a lazy singleton (`camera.py:133-136`), and
**there was no runtime teardown path at all**: `CameraTrack.close()` was only ever called on
a failed open, and `_track` was never reset to `None`. Changing cameras meant restarting the
process.

### Latent defect found while designing this

`close()` did not acquire `_read_lock`, while three threads call `self._cap.read()` under
it. Calling `release()` mid-read is a use-after-free on the V4L2 capture object inside
OpenCV — not a Python exception anything can catch. `recv()` additionally checked
`is_open()` *outside* the lock and dereferenced `self._cap` inside it. Both were unreachable
while `close()` only ran on a failed open; a camera switch makes them reachable on every
swap. **Fixed first, independent of the feature.**

### Fleet inventory (read live over Tailscale)

| Host | `STATION_NAME` | Camera | USB ID | Stable `by-id` symlink |
|---|---|---|---|---|
| `alejandrospi-cv-1` (hostname `alejandrospi`) | CV Station test 2 | HD USB Camera | `32e4:9230` | `usb-HD_USB_Camera_HD_USB_Camera-video-index0` |
| `alejandrospi2` | CV Station test 3 | Celestron Imager HD | `058f:1445` | `usb-Celestron_Imager_HD_Celestron_Imager_HD-video-index0` |

Two findings that shaped the design:

- **Camera identification needs no new mechanism.** The two cameras have distinct USB
  VID:PIDs *and* distinct V4L names, and the kernel already publishes stable, role-distinct
  `/dev/v4l/by-id/` symlinks keyed by USB vendor+product. **No udev rules are required** —
  the only rule on either Pi is `99-rpi-keyboard.rules`. `_resolve_device()` already accepts
  `/dev/` paths and case-insensitive name substrings, and `_resolve_device_by_name()` already
  skips the phantom metadata node UVC cameras expose alongside the real one.
- **Station 2 runs a pre-microscope agent build.** Its `/health` returns no `camera_profile`
  and no `capabilities`. Both stations report `agent_version: 0.1.0`, so **version cannot be
  used for feature detection** — the UI must detect on the presence of `cameras[]` /
  `camera_switch`.

---

## 3. Target design

### 3.1 Config — `CAMERAS`, additive and zero-touch

A new optional env var in `/etc/bims/station.env`:

```json
[{"id":"overview","role":"overview","label":"Overview",
  "device":"/dev/v4l/by-id/usb-HD_USB_Camera_HD_USB_Camera-video-index0",
  "profile":"default"},
 {"id":"scope","role":"microscope","label":"Microscope",
  "device":"celestron","profile":"microscope","sequence":true}]
```

`device` takes the existing `CAMERA_DEVICE` spec — index, `/dev` path, or name substring.
Prefer `by-id` paths: `/dev/videoN` numbering is not stable across reboots or re-plugging,
and `by-id` is.

**When `CAMERAS` is unset, a single camera is synthesized from `CAMERA_DEVICE` /
`CAMERA_PROFILE`.** Every station on the fleet keeps working with no config change, and
there is only one code path rather than a legacy fork. The synthesized entry keeps
`sequence: true` regardless of profile, because the agent has always advertised the sequence
capability unconditionally — silently revoking it from a default-profile station that uses
timed runs would be a regression. Per-camera sequence gating applies only once `CAMERAS` is
explicitly set.

Because `python-dotenv` runs with `override=False` and systemd has already injected
`EnvironmentFile`, env changes take effect on service restart. The **active** camera is
therefore in-memory state, and a restart deliberately returns the station to its configured
default.

### 3.2 Agent — `services/bims-capture-agent/`

- `camera.py` — `close()` takes `_read_lock`; `recv()` re-checks inside it; `get_param` /
  `set_param` take it too (with the range lookup hoisted out first, since a cold
  `v4l2-ctl` call takes up to 5 s and must not be held under the read lock).
- `camera.py` — `CameraTrack(source, profile)` is parameterized rather than reading module
  globals, so a switch can build a track for a *different* camera before mutating any state.
- `camera.py` — `list_cameras()`, `active_camera_id()`, `switch_camera(id)`.
  `switch_camera` runs under `_track_lock` and **opens the new camera before closing the
  old one**, so a failed switch leaves the station exactly as it was rather than off the
  air. It resets both `_resolved_source` *and* `_v4l2_ranges_cache` — that cache is
  per-process but the ranges are per-device, and `set_param()` clamps against it, so a stale
  cache would silently squeeze values into the previous camera's range before the driver
  ever saw them.
- `agent.py` — `select_camera` WS command, authed by the connect-time station JWT (same bar
  as `sequence_start`; no admin claim). **Refused while `sequence_mod.manager.is_running()`**
  — a mid-run swap would file a split-optics set under one `sequenceId` with nothing
  recording which camera shot which frame, which is undetectable downstream. Ranges are
  re-warmed off-loop, then `camera_changed` + fresh `camera_params` are **broadcast** so
  sibling tabs resync instead of driving the wrong device's ranges.
- `agent.py` — `/health` gains `cameras[]` + `active_camera_id` and advertises
  `camera_switch` in `capabilities`; the heartbeat body gains `cameras` + `activeCameraId`
  (camelCase, matching its neighbours) so BIMS converges within one interval when a
  station's config changes without re-registration.
- `preview.py` — `/preview.mjpg` and `/snapshot.jpg` accept `?camera=<id>` and **409 on a
  mismatch** rather than switching implicitly. This is the wrong-sensor guard, and it
  doubles as the cache-buster the `<img>` needs (its src is otherwise deterministic in
  `(hostname, token)` and would never re-request).

No systemd change: `SupplementaryGroups=input video` already covers every `/dev/video*` node.

### 3.3 BIMS

- `capture-station.ts` — `cameras[]` subdoc (`_id: false`) + `activeCameraId`. **Mongoose
  strict mode silently drops undeclared fields on write** — this is the same failure mode
  that broke CV in CV-PIPELINE-V2 §2, so the schema change is a hard prerequisite, not a
  tidy-up. Adds `normalizeStationCameras()` and `effectiveCameras()`.
- `stations/register/+server.ts` — `capabilities` was `$set` **unconditionally** from an
  all-false default, so one reboot of an agent that omits it silently stripped a station of
  every capability. Now both `capabilities` and `cameras` are set only when the request
  carried them, and the legacy `capabilities.camera` / `.sequence` booleans are **derived
  from `cameras[]`** so every existing reader keeps working untouched.
- `stations/[id]/heartbeat/+server.ts` — persists `cameras` / `activeCameraId` when present.
  `cameraOk` remains the health of the camera that is **open**, not a roll-up: AND-ing every
  attached camera would let an idle second camera drag a healthy station to `degraded`.
- `api/cv/capture/+server.ts` — the browser capture path had **no `photoType` at all**, so
  every browser capture was filed as `inspection` even when shot down the Celestron. Now
  parses it, and for a microscope shot: `phase` is no longer required, barcode view
  auto-classification is skipped (a close-up never shows the barcode), phase inference is
  skipped, `photoType` is written to `cv_images` **and** to the `cartridge_records.photos[]`
  entry (which previously omitted it, unlike the agent's ingest path), and the wax/reagent
  **manufacturing status auto-advance is suppressed** — a scope close-up is documentation,
  not an inspection.

### 3.4 UI — `src/routes/capture/+page.svelte`

- The Camera control in the context bar previously listed only local `MediaDeviceInfo`
  devices, which is meaningless whenever a Pi station is selected. It now shows the
  station's cameras in station mode and local devices otherwise.
- Rendered as buttons, not a `<select>`: a refused switch must leave the control showing
  what is *actually* live, and a one-way-bound select would sit on the failed choice.
- **The token landmine.** The station JWT is 5 minutes (`token/+server.ts:20`) and the
  browser never refreshes it — only a WS reconnect re-mints. An open MJPEG stream survives
  expiry because the agent authenticates once per HTTP request, but **a camera switch
  re-issues that GET**. Without a re-mint, any operator on the page longer than five minutes
  would 401 → `onerror` → silent, permanent WebRTC fallback. `refreshStationToken()` is
  called immediately before the switch.
- On switch: reset `cameraParams` / `cameraParamsKnown` / `cameraParamRanges`, flush the
  `cameraParamThrottle` timers (an in-flight throttled `set_camera_param` would otherwise
  land on the new camera and be clamped to the wrong range), clear `mjpegError`. **`ws`,
  `lockedStationId`, and the heartbeat are NOT torn down** — the switch is intra-station.
- `activeCameraId` is set only from the agent's `camera_changed` broadcast, never
  optimistically, so every tab converges on what the Pi actually opened.
- The microscope sequence panel now gates on the **active camera's** `sequence` flag, falling
  back to the station capability for single-camera stations and older agents.

---

## 4. Out of scope

`manufacturing/cart-mfg/{wax,reagent,post-mortem}-inspect` each duplicate the
station-connect flow and are **WebRTC-only** — no `mjpegUrl`, no `/snapshot.jpg`. They do
not get the switcher in this change. The agent-side protocol is designed to serve them
later; note that WebRTC peers hold subscriptions bound to the old `MediaRelay` and must
recover with `webrtc_stop` + a fresh offer after a switch.

---

## 5. Verification

1. `npx svelte-check`. No local `npm run build` — it OOMs at ~30 GB on this machine; the
   Vercel branch build is the gate.
2. Deploy the agent to `alejandrospi2` (station 3: current agent + the real Celestron) and
   temporarily attach an HD USB Camera to exercise the dual path.
3. `curl http://127.0.0.1:8765/health` → `cameras[]`, `active_camera_id`, `camera_switch`.
4. **Back-compat first:** a station with no `CAMERAS` still reports exactly one camera and
   streams. This is the path most likely to regress and it covers the whole existing fleet.
5. Switch with an MJPEG stream open: the `<img>` picks up the new camera, slider ranges
   change, and no 401 after sitting on the page more than 5 minutes.
6. Start a sequence, attempt a switch mid-run → clean refusal, run unaffected.
7. Capture from each camera; confirm in Mongo that `cv_images.photoType` **and**
   `cartridge_records.photos[].photoType` match the camera used, and that a microscope shot
   did **not** advance manufacturing status.

---

## 6. Related

- `docs/prds/PI-CAPTURE-STATION.md` — §5.3 frame budget, cited throughout `camera.py`
- `docs/prds/PI-STATION-ADMIN-AND-LIFECYCLE.md` — registration, heartbeat, `deriveStatus`
- `docs/prds/CV-PIPELINE-V2.md` — §2 is the strict-mode failure mode this PRD guards against
- **`CV-MICROSCOPE-01` has no PRD file.** The ID is cited in six source files and in
  `progress.txt`, but `docs/prds/CV-MICROSCOPE-01.md` does not exist on any branch — its
  design rationale lives only in code comments and the agent README. This PRD exists partly
  so that gap is not repeated.

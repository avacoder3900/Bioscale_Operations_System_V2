# PRD: Pi-Hosted Remote Capture Station

**Author:** Alejandro Valdez
**Date:** 2026-05-19
**Status:** Draft
**Priority:** P1 — replaces per-workstation camera attachment with a drop-in network station
**Proposed branch:** `feature/pi-capture-station` (off `feature/cv-followups`)
**Related:** `docs/prds/CV-CAPTURE-STATION.md`, `docs/CV-REFACTOR-HANDOFF.md` (robot-arm-calibration branch)

---

## 1. Problem Statement

The current `/capture` page assumes the operator's workstation has the USB camera and barcode scanner physically attached. That works for one station but doesn't scale and is brittle:

- Only one Windows machine on the floor can act as a capture station — the one with the hardware plugged in.
- Setting up a second capture station means a second full Windows workstation, drivers and all.
- Hardware drift (camera unplugged, wrong device picked from the selector, permission denied) silently breaks captures.
- A 365nm UV LED for fluorescence-based QC imaging isn't part of the loop today — it'd add a third USB peripheral the workstation has to host.

We want a **self-contained capture station**: a Raspberry Pi with the USB camera, USB barcode scanner, and (optionally) the IO Rodeo 365nm Radial LED Board all wired to the Pi. The operator continues to use the existing `/capture` page in BIMS — only now the camera, scanner, and LED are physically located at the station, not the operator's desk. A station drops onto the floor with nothing but a power cable.

---

## 2. What Exists Today

| Component | Status | Location |
|---|---|---|
| `/capture` page (BIMS) | ✅ Live — 2-photo workflow, retake dialog, auto-scan via jsQR | `src/routes/capture/+page.svelte` |
| `/api/cv/capture` endpoint | ✅ Live — accepts multipart photo + cartridgeId + phase | `src/routes/api/cv/capture/+server.ts` |
| `/api/cv/lookup-cartridge` | ✅ Live — UUID → cartridge state lookup | `src/routes/api/cv/lookup-cartridge/+server.ts` |
| Pi precedent — `arm-pi` (Pi 4 2GB) | ✅ Provisioned via `deploy/pi/setup_pi.sh` (robot-arm repo) | External repo `avacoder3900/robot-arm` |
| Waveshare GW-Barcode scanner | ✅ Identified — VID `0218`:PID `0210`, USB HID keyboard, Enter suffix | Already on hand |
| IO Rodeo 365nm Radial LED Board | ❓ Interface TBD — vendor site (https://iorodeo.com/products/365nm-radial-led-board) returned 503 at PRD draft time; assume TTL trigger + external supply pending datasheet review | Planned hardware |

---

## 3. Hardware Bill of Materials (per station)

| Item | Qty | Notes |
|---|---|---|
| Raspberry Pi 4 Model B (2GB or 4GB) | 1 | Pi 5 also works; Pi 4 keeps parity with `arm-pi`. |
| Official USB-C 5V/3A PSU | 1 | |
| 32GB microSD card (Class 10, A2) | 1 | Pre-flashed with the station image. |
| USB camera (same model used at /capture today) | 1 | Confirm Linux UVC compat (most USB cams are). |
| Waveshare GW-Barcode scanner | 1 | Already on hand. |
| IO Rodeo 365nm Radial LED Board | 1 (optional) | Phase 4. Interface verified before order. |
| Powered USB hub (3+ ports, 5V/2A min) | 1 | Distributes USB power to camera + scanner (and LED controller, if USB-driven). |
| Ethernet cable (one-time) | 1 | For initial WiFi config session. |
| Mounting bracket / fixture | 1 | Out of scope for this PRD; operator-built. |

---

## 4. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Operator workstation (Windows + Chrome)                             │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  BIMS  /capture page                                            │  │
│  │   • Station selector (NEW): pick a registered Pi from a list   │  │
│  │   • Live camera feed (NEW): WebRTC stream from the Pi          │  │
│  │   • Wedge-input + 2-photo + retake + auto-scan (unchanged)     │  │
│  │   • LED toggle (NEW): on/off                                    │  │
│  └────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ WebSocket (signaling + scanner events + LED cmds)
                                │ WebRTC peer connection (video)
┌───────────────────────────────┴──────────────────────────────────────┐
│  Pi capture station   e.g. cap-pi-1.local  (manufacturing LAN)       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  bims-capture-agent  (Python systemd service)                   │  │
│  │   • Camera bridge:  v4l2 → aiortc WebRTC track                 │  │
│  │   • Scanner reader: evdev → WebSocket event                    │  │
│  │   • LED controller: gpiozero OR USB serial                     │  │
│  │   • HTTP  /health: BIMS discovery + status                     │  │
│  │   • WebSocket /ws: signaling + events + LED commands           │  │
│  └────────────────────────────────────────────────────────────────┘  │
│   USB camera ─┐                                                       │
│   USB scanner ├─► Pi 4 USB ports (via powered hub)                   │
│   LED board   ─┘ GPIO TTL  OR  USB serial                            │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ HTTPS POST /api/cv/capture (multipart, from BROWSER)
                                │ Pi never touches BIMS DB directly.
┌───────────────────────────────┴──────────────────────────────────────┐
│  BIMS server (Vercel)                                                │
│   • /api/cv/capture       (unchanged)                                │
│   • /api/cv/stations      (NEW) — CRUD for station registry         │
│   • CaptureStation model  (NEW)                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**Why the browser still posts to BIMS (instead of the Pi posting directly):** keeps the existing `/api/cv/capture` flow intact. Pi doesn't need DB credentials — it's a hardware proxy. The browser is the trusted client (already authenticated to BIMS). Also lets the entire 2-photo + retake + cartridge-lookup logic stay exactly where it lives today, with the Pi treated as another camera/scanner source.

---

## 5. Pi-side Software

A single Python service: `bims-capture-agent`.

### 5.1 Stack

- Python 3.11 (default on Pi OS Bookworm)
- `aiohttp` — HTTP + WebSocket server
- `aiortc` — WebRTC for camera streaming
- `evdev` — scanner input
- `opencv-python` + `v4l2` — USB camera capture; `picamera2` if Pi Camera Module is used instead
- `gpiozero` — LED GPIO (if TTL-controlled)
- `systemd` — service management + auto-start

### 5.2 Responsibilities

1. **Camera bridge.** Open `/dev/video0`, downsample to 720p, expose as a WebRTC track. Client connects via WebSocket signaling and receives live video at ~10–15 FPS.
2. **Scanner reader.** Open `/dev/input/eventN` for the Waveshare device (matched by VID `0218`/PID `0210`), assemble scan events terminated by Enter, broadcast `{event:'scan', code:'<uuid>'}` over WebSocket to whichever client is connected.
3. **LED controller.** Respond to `{cmd:'led', state:'on'|'off'}` messages. Phase 4 — verify interface first.
4. **Discovery / health.** `GET /health` returns `{station_id, agent_version, camera_ok, scanner_ok, led_ok, uptime_s}`. BIMS polls this on a registered station list.
5. **One-shot capture (optional fallback).** `POST /capture-now` returns a JPEG frame for cases where WebRTC isn't available — but the default flow uses WebRTC + browser-side canvas grab.

### 5.3 Why WebRTC for the camera

- ~150–300 ms latency, acceptable for visual cartridge alignment.
- Continuous live feed (operator needs to see what they're about to photograph).
- Pi 4 has hardware H264 encoder; CPU stays low at 720p10.
- jsQR (already in BIMS) decodes from the live video frames — auto-scan works against the Pi camera exactly like the local USB camera works today.

### 5.4 Why NOT MJPEG-over-HTTP

Cheaper to implement, but no inter-frame compression — bandwidth-heavy at the same FPS. Reserve as a fallback if WebRTC traversal proves flaky on the LAN.

### 5.5 Photo capture sequence (operator-facing flow is unchanged)

1. Operator scans cartridge — auto via jsQR on the Pi's video stream, OR via the scanner whose events arrive over WebSocket.
2. Operator presses Space.
3. Browser grabs the current frame from the WebRTC video element → canvas → JPEG blob.
4. Browser POSTs to `/api/cv/capture` (multipart) — exactly as today.
5. Cartridge record is updated; image lands in R2 — same as today.

---

## 6. BIMS-side Changes

### 6.1 New schema — `CaptureStation`

```typescript
// src/lib/server/db/models/capture-station.ts
const captureStationSchema = new Schema({
  _id: { type: String, default: () => generateId() },
  name: { type: String, required: true },          // "Wax Fill Bench 1"
  hostname: { type: String, required: true },      // cap-pi-1.<yourdomain> (Cloudflare-Tunnel URL)
  ipAddress: String,                                // last-known LAN IP for debug fallback
  location: String,                                 // free-text floor location
  agentVersion: String,                             // last-seen `bims-capture-agent` version
  lastSeenAt: Date,                                 // bumped by /health poll
  status: { type: String, enum: ['online', 'offline', 'degraded'] },
  capabilities: {
    camera: Boolean,
    scanner: Boolean,
    led: Boolean,
    robotArm: Boolean              // forward-compat (Phase 7+); see §13
  },
  // Mode controls whether the operator can pick the capture phase or the station
  // is locked to one. "free" = operator-selectable; "assigned" = phase is fixed
  // to `assignedPhase` and the dropdown on /capture is read-only while this
  // station is selected.
  mode: { type: String, enum: ['free', 'assigned'], default: 'free' },
  assignedPhase: String,            // required when mode === 'assigned'
  // Current-operator lock: hard limit of one operator per station at a time.
  // One operator may hold sessions on multiple stations simultaneously.
  // Cleared on disconnect or by an explicit release call.
  currentOperator: {
    _id: String,
    username: String,
    since: Date
  },
  createdBy: { _id: String, username: String },
  createdAt: Date
});
```

### 6.2 New endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/cv/stations` | List registered stations + last-known status. |
| POST | `/api/cv/stations` | Register a station (called by the Pi on first boot). |
| GET | `/api/cv/stations/[id]` | One station's detail. |
| PATCH | `/api/cv/stations/[id]` | Update name / location / defaultPhase. |
| DELETE | `/api/cv/stations/[id]` | Unregister. |

### 6.3 `/capture` page changes

- Add a **Station** dropdown to the context bar. Lists stations with `status: 'online'`. Default is `(Local)` — preserves today's behavior.
- Selecting a station:
  - Closes the local `getUserMedia` camera, if any.
  - Opens a WebSocket to `wss://<station-hostname>/ws`.
  - Negotiates WebRTC; attaches the resulting `MediaStream` to the existing `<video>` element. **No other code in the page changes** — jsQR auto-scan, 2-photo workflow, retake dialog all work on the new stream as-is.
  - Routes WebSocket `{event:'scan'}` messages into the existing `handleScan(code, 'auto')` path.
- Selecting `(Local)`: unchanged — uses workstation camera/scanner as today.
- Add an **LED** toggle near the camera selector — sends `{cmd:'led', state:'on'|'off'}` over WebSocket.
- **Mode-driven phase lock.** When a station with `mode === 'assigned'` is selected, the phase dropdown is set to `assignedPhase` and disabled. When `mode === 'free'`, the dropdown stays interactive.
- **Operator lock.** On station-select, the page calls `POST /api/cv/stations/[id]/lock` with the current user. If the station already has a `currentOperator` that isn't this user, the call returns 409 and the page shows a banner: "Station already in use by {username} since {since}." Same operator on a different tab/window: re-uses the existing lock. Lock is released on `beforeunload` or after a 5-minute heartbeat timeout.

### 6.4 New admin page — `/cv/stations`

Plain table: name · hostname · status · agent version · last seen · actions (edit, unregister). Phase 6.

---

## 7. Provisioning & First-Boot

### 7.1 Operator flow (golden path)

1. Flash the pre-built `bims-capture-pi.img` to an SD card.
2. Boot the Pi with Ethernet plugged in (first time only).
3. SSH in (default user `bims`, key-baked into the image), run `setup-station.sh`:
   - Prompts: station name ("Wax Fill Bench 1"), BIMS server URL, manufacturing WiFi SSID + password, Cloudflare Tunnel token (one per station, generated from the Cloudflare dashboard).
   - Writes `/etc/bims/station.env`.
   - Installs and registers `cloudflared` as a systemd service — the station becomes reachable at `https://cap-pi-<name>.<yourdomain>` within ~30s.
   - Enables and starts `bims-capture-agent` systemd service.
   - Agent POSTs to `<BIMS>/api/cv/stations` to register itself, including its Cloudflare hostname.
4. Operator unplugs Ethernet, mounts the station, plugs in power.
5. Station auto-joins WiFi on boot, registers as `online` to BIMS.

Target: under 15 minutes from "factory-fresh Pi" to "registered and streaming."

### 7.2 WiFi configuration modes

| Mode | When | How |
|---|---|---|
| Pre-baked | Bulk provisioning of identical stations | Edit `wpa_supplicant.conf` on the SD card before first boot. |
| Hotspot bootstrap | Field setup, no Ethernet available | First boot opens a `bims-setup` AP; operator joins from a phone; captive-portal page asks for SSID + password. Implementation: `comitup` or `RaspAP`. |
| SSH + Ethernet | Lab / desk setup | Ethernet for the install session, then unplug. |

### 7.3 Self-update

`bims-capture-agent` ships with a systemd timer that runs `git pull` + `systemctl restart bims-capture-agent` daily at 03:00 local time, against a `pi-agent-release` branch. Visible agent version on `/health` so BIMS can show "this station is on an old build."

---

## 8. Security

- Manufacturing LAN is treated as trusted.
- Pi WebSocket requires a shared secret in the `X-Station-Token` header, set in `station.env`. BIMS supplies the token at registration time and stores it in `CaptureStation.token` (hashed).
- BIMS endpoints `/api/cv/stations*` require `cv:write` or `manufacturing:write` (parity with `/api/cv/capture`).
- **TLS via Cloudflare Tunnel.** Each Pi runs the `cloudflared` daemon, which publishes the station at a stable HTTPS URL (e.g. `https://cap-pi-1.<yourdomain>`). TLS termination is handled by Cloudflare; no self-signed cert dance, no mixed-content blocking against the BIMS HTTPS origin, and the tunnel traverses NAT/VLANs — Pi network topology is independent of the operator workstation's network. Trade-off: ~10 ms added latency and dependency on Cloudflare being reachable. Acceptable because BIMS already runs on Cloudflare R2.
- LED commands aren't safety-critical for power damage but ARE relevant for UV exposure — see Section 11.

---

## 9. Phase Breakdown

| Phase | Scope | Effort estimate |
|---|---|---|
| **1** | Pi base image: Pi OS Lite, network, SSH, `bims-capture-agent` skeleton (`/health` + WebSocket scaffolding). Operator can SSH in and see service running. No camera yet. | 1–2 days |
| **2** | Camera bridge: WebRTC track from `/dev/video0`. `/capture` page gets a Station selector that streams the Pi camera into the existing video element. Local camera still works. | 2–3 days |
| **3** | Scanner reader: `evdev` → WebSocket events. Browser wires events into `handleScan(code, 'auto')`. End-to-end 2-photo workflow against the Pi. | 1–2 days |
| **4** | LED control. Verify IO Rodeo board interface; add `/cmd led` handler; UI toggle; safety interlock. | 1–2 days |
| **5** | Provisioning script (`setup-station.sh`), SD card image build pipeline, hotspot bootstrap. | 2–3 days |
| **6** | Station registry UI (`/cv/stations`), health-poll job, station status badges on `/capture`. | 2 days |
| **7** | Polish: self-update, multi-station tested, docs, runbook for adding a new station. | 2 days |

**Total estimate: ~2–3 weeks of focused work,** assuming the LED interface is straightforward and no major surprises. Phases 1–3 are the minimum viable station; Phases 4–7 are improvements.

---

## 10. Files to Create / Modify

### Pi-side — new directory `services/bims-capture-agent/`

| File | Purpose |
|---|---|
| `agent.py` | Main aiohttp service entry point. |
| `camera.py` | aiortc track wrapping v4l2/picamera2. |
| `scanner.py` | evdev poller, scan-event broadcaster. |
| `led.py` | GPIO or USB-serial controller. |
| `requirements.txt` | aiohttp, aiortc, evdev, gpiozero, opencv-python. |
| `bims-capture-agent.service` | systemd unit. |
| `setup-station.sh` | First-boot config script. |
| `build-image.sh` | (Optional) SD-card image builder. |
| `README.md` | Operator + dev docs, troubleshooting. |

### BIMS-side — existing repo

| File | Action |
|---|---|
| `src/lib/server/db/models/capture-station.ts` | NEW — Mongoose model. |
| `src/lib/server/db/models/index.ts` | MODIFY — export. |
| `src/routes/api/cv/stations/+server.ts` | NEW — GET (list), POST (register). |
| `src/routes/api/cv/stations/[id]/+server.ts` | NEW — GET, PATCH, DELETE. |
| `src/routes/capture/+page.svelte` | MODIFY — Station selector, WebRTC client, scanner-event handler, LED toggle. |
| `src/routes/capture/+page.server.ts` | MODIFY — load stations list. |
| `src/routes/cv/stations/+page.svelte` | NEW (Phase 6) — admin UI. |
| `src/routes/cv/stations/+page.server.ts` | NEW (Phase 6). |
| `src/lib/types/capture-station.ts` | NEW — shared types. |

---

## 11. Open Questions & Risks

### Resolved decisions (2026-05-19)

- **Camera model.** Same USB camera used at the operator workstation today. Confirm exact model via `lsusb` on a test Pi before fleet rollout.
- **Network topology.** Pi runs on the manufacturing WiFi in production. Initial config session uses an Ethernet cable from the operator's computer for SSH-only purposes. The Cloudflare Tunnel decision below means Pi network topology is independent of the operator workstation's network anyway, so VLAN boundaries don't matter.
- **TLS strategy.** Cloudflare Tunnel per Pi — see §8.
- **Station modes.** Stations are operator-selectable and interchangeable on `/capture`. Each station has `mode: 'free' | 'assigned'`. Free = operator picks the phase; assigned = phase is locked to `assignedPhase` and the `/capture` dropdown becomes read-only when this station is selected. See §6.1.
- **Multi-tenant.** Hard lock: one operator per station at a time via `CaptureStation.currentOperator`. One operator may hold sessions on multiple stations simultaneously. Second-operator connect attempt is rejected with a banner identifying who currently holds the station.
- **Pi-agent code location.** Inside the BIMS repo at `services/bims-capture-agent/`. Same `feature/cv-followups` family for initial development; merges with the rest of CV refactor.

### Still open

- **Pi 5 onboard WiFi presence.** Spec says Pi 5 ships with dual-band 2.4/5 GHz WiFi + BT 5.0 onboard. Verify on the actual unit before committing the fleet — quick check with `iwconfig` after first boot. If for any reason a unit lacks onboard WiFi, a USB WiFi dongle adds ~$10.
- **LED electrical interface.** IO Rodeo vendor page was 503 at PRD draft. Pull the 365 nm board datasheet before Phase 4 to decide whether the BOM needs a GPIO MOSFET driver, or whether the board takes USB serial / I2C. Affects Phase 4 code structure too.

### Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| WebRTC traversal fails on the LAN | Low | Test early; fall back to MJPEG-over-HTTP if needed. |
| Pi CPU can't sustain 1080p WebRTC + jsQR decode | Medium | Downsample camera to 720p; jsQR already runs on 640px-wide frames per current `/capture` code. |
| UV 365nm LED operating without eye protection | High | UI must show a visible "UV ON" badge with safety reminder; consider a physical-button interlock at the station, not just a remote-click toggle. |
| Pi firmware/agent update breaks a live station mid-shift | Medium | Update timer runs at 03:00 local; visible agent-version badge in BIMS so operators can spot stale builds. |
| Scanner event vs auto-scan race | Low | Same `lastAutoScanCode` debounce as today; both sources funnel into `handleScan(code, source)`. |
| `evdev` access requires `input` group | Low | systemd service runs as a user in `input` group; `setup-station.sh` adds it. |
| Mixed-content blocking (HTTPS BIMS ↔ HTTP Pi) | High | TLS on the Pi from the start; self-signed cert + pinned fingerprint. |

---

## 12. Acceptance Criteria

- [ ] An operator can power on a Pi station and within 60 s see it appear as `online` in the `/capture` Station selector.
- [ ] Selecting a station shows its live camera feed inside the existing `<video>` element on `/capture`.
- [ ] Scanning a barcode at the station auto-locks the cartridge in BIMS within 2 s — same as the local scanner does today.
- [ ] Pressing Space captures the current frame from the Pi camera and creates a `CvImage` the same way the local flow does.
- [ ] The 2-photo + retake + auto-clear workflow works identically against a Pi station as against a local camera.
- [ ] Toggling the LED in BIMS turns the LED on/off at the station.
- [ ] Unplugging the Pi sets its status to `offline` in BIMS within 90 s; reconnecting brings it back without operator intervention.
- [ ] A factory-fresh Pi can be provisioned end-to-end (SD flash → power on → registered) in under 15 minutes.

---

## 13. Forward Compatibility — Robot Arm

Each station's `CaptureStation.capabilities.robotArm: Boolean` is reserved for a future phase that adds a cartridge-handling robot arm at the same Pi. When that phase arrives, the architecture in §4 holds — the Pi can host the arm alongside the camera/scanner/LED without re-platforming:

- The same `bims-capture-agent` process gains an `arm.py` module that drives the arm. The existing `project_robot_arm_workspace` work would inform the controller (likely SO-ARM101 over half-duplex serial via CH343, individual-read mode per the existing `feedback_robot_arm_syncread` memory).
- New WebSocket commands: `{cmd: 'arm', action: 'pickup'|'place'|'home', position: 'A1'|...}`.
- New BIMS endpoint: `POST /api/cv/stations/[id]/arm` that the operator UI on `/capture` calls.
- New UI block on `/capture`, visible only when `capabilities.robotArm === true`: pick-and-place controls + a queue of pending arm operations.

Implementation is **explicitly deferred** until the 2-photo capture flow is stable in production. This PRD does NOT cover arm wiring, kinematics, end-effector selection, safety interlocks for the arm, or BIMS-side queueing of arm operations. Those are a future PRD.

What this PRD DOES do to enable future arm work:

- BOM reserves a free USB port on the powered hub (4-port hub specified when only 3 are needed today).
- BOM reserves CPU headroom: Pi 5 4 GB is specified, with the option to upgrade to 8 GB if arm pathfinding moves on-Pi.
- The agent's HTTP/WebSocket server is structured one-module-per-peripheral (`camera.py`, `scanner.py`, `led.py`) so adding `arm.py` doesn't require rewriting the others.
- `robotArm` is captured as a station capability flag in the schema from day 1, so the UI can conditionally render arm controls without a schema migration later.

---

## 14. Out of Scope (this PRD)

- Multi-camera per station (one camera + one scanner + one optional LED + one future-arm, only).
- Cellular / off-LAN deployment.
- Per-cartridge automated lighting profiles (turn LED on/off at specific phases).
- Pi-side ML inference (BIMS-side cv-worker handles inference today, unchanged).
- Audio capture.
- Operator-facing screen attached to the Pi (it's headless; the browser is the UI).
- Robot arm integration details (see §13 — covered by a future PRD).

# Arm camera streaming — handoff (2026-10-20)

Owner: Alejandro (with Claude), on branch `feat/arm-camera-direct-30fps`. Sam works on the depth / calibration side, not on streaming.
Goal from Alejandro: raise the arm camera to **30 fps**, and decide whether the way video reaches
BIMS should change ("use the same method as the CV stations").

## Result of the 30 fps check (2026-10-20, run on arm-pi)

**The Pi already captures and streams at 30 fps.** `hardware.yaml` → `cameras.external`: 640x480,
`fps: 30`, `quality: 80` (cameras.py defaults are the same). Measured locally on the Pi:
`stream.mjpg` delivered **148 frames / 5 s (~29 fps)**, both before and after a service restart.
Nothing on the Pi was changed (a backup `src/config/hardware.yaml.bak-30fps` exists, identical).
Report saved on the Pi at `~/cam30-report.txt`.

Camera modes over the current USB 2.0 link (YUYV, `/dev/video4`): 424x240 @60/30, **640x480 @30**,
1280x720 @15 max, 1920x1080 @8 max. Depth still works alongside (558 mm test reading).

**So any slowness seen in BIMS is the transport, not the camera:** the proxy path below tops out at
10 fps by design. 30 fps only reaches the browser through direct mode, which needs a public origin.
Answered 2026-10-20: production's panel footer reads "N frames via BIMS · requested 30 fps q80", so
`ROBOT_ARM_PUBLIC_URL` is **not** set and every viewer was on the proxy slideshow.

**Built on `feat/arm-camera-direct-30fps` (2026-10-20, approved by Alejandro):**
- `src/routes/api/robot-arm/cameras/stream-url/+server.ts`: when `ROBOT_ARM_PUBLIC_URL` is unset, publish
  the Cloudflare quick-tunnel origin the Pi registers in `robot_arm_endpoints` ('tunnel'). Only a
  `https://<words>.trycloudflare.com` origin is ever published, rows older than 48 h are ignored, and any
  DB error degrades to `available: false`. The token stays camera-only and short-lived;
  `ROBOT_ARM_API_KEY` / `ROBOT_ARM_BASE_URL` never leave the server. Tests in `stream-url/server.test.ts`.
- `src/lib/components/RobotArmCameraPanel.svelte`: direct mode gets its own fps menu (5/10/15/30, default
  30, remembered per browser) and passes it to the Pi as `stream.mjpg?fps=N`; the Pi's
  `camera_stream(name, fps)` already caps its rate with it. Proxy stays at 1/5/10.

## How footage reaches BIMS today

Camera: Intel RealSense D415 on arm-pi (Raspberry Pi 5). Colour = `/dev/video4` (raw YUYV, up to
1920x1080), depth = `/dev/video0` (Z16, handled by `src/server/depth.py`). Enumerated at USB 2.0 (480M)
until 2026-10-21; **now USB 3.0 (5000M, bus 004)** with the new cable, and `hardware.yaml` is
**1920x1080 @ 30 fps** (see "USB 3 update" below).

The capture/stream code lives **only on the Pi**, not in this repo:
`~/robot-arm/src/server/cameras.py` + `~/robot-arm/src/config/hardware.yaml` (camera picked by
card-name match "RealSense"). The fps/size/quality the Pi requested are visible in BIMS as
`CameraStatus.requested` (see `src/lib/server/robot-arm-client.ts`).

Two transports, chosen in `src/lib/components/RobotArmCameraPanel.svelte`:

1. **Proxy (fallback, always works):** browser polls
   `src/routes/api/robot-arm/cameras/[name]/snapshot/+server.ts`, which fetches one JPEG from the Pi
   per request (Vercel → Funnel/Cloudflare tunnel → Starlink). UI offers 1/5/10 fps; real rate is
   lower. Looks like a slideshow. Exists because Vercel `maxDuration` 30 s can't hold a stream open.
2. **Direct (MJPEG):** if `ROBOT_ARM_PUBLIC_URL` is set in Vercel,
   `src/routes/api/robot-arm/cameras/stream-url/+server.ts` mints a short-lived camera-only token and
   the browser opens `<public origin>/cameras/<name>/stream.mjpg?token=…` directly; the Pi sets the
   frame rate. Any error falls back to proxy.

The Vision tab tracker (`src/lib/components/robot-arm/VisionLiveTracker.svelte`,
`src/lib/robot-arm/frame-grab.ts`) always uses proxy at 1–4 fps.

## CV stations use the same method

`services/bims-capture-agent/preview.py`: MJPEG over `multipart/x-mixed-replace`, tunable
`?fps=1..30&q=30..95`. They also have a WebRTC (VP8/H.264) track, but on a Pi 4 MJPEG benched
**35 ms vs 261 ms** latency, so MJPEG is the live view. The arm's direct mode is already this method.

MJPEG costs ~5–10x the bandwidth of H.264 but has the lowest latency and no negotiation. For the arm
the real limits are:

- **USB 2.0 (resolved 2026-10-21):** raw YUYV 640x480@30 ≈ 18 MB/s fit; 1280x720@30 did not. The USB 3
  cable fixed it: the D415 now offers 1280x720@30 and 1920x1080@30 (YUYV, ~124 MB/s at 1080p@30),
  which is what the AprilTag sheet assumed.
- **Network:** remote viewing goes over Tailscale Funnel / Cloudflare quick tunnel on Starlink;
  Funnel's DERP relay drops regularly (see progress.txt 2026-10-15..19). MJPEG@30 ≈ 1–3 MB/s/viewer.
- **Pi 5 has no hardware H.264 encoder** (Pi 4 did). H.264/WebRTC would be CPU (software) encoded,
  and WebRTC through Starlink's hard NAT would need a TURN relay.

## USB 3 update (2026-10-21)

- `lsusb -t` shows the D415 at 5000M on bus 004. `hardware.yaml` `cameras.external` is now 1920x1080 @
  30 fps q80 (backup `hardware.yaml.bak-720p15`). The v4l2 node negotiates 30 fps.
- **The worker only published 15 fps at 1080p** with `CAP_PROP_BUFFERSIZE = 1`: while the capture thread
  converts YUYV->BGR and JPEG-encodes a frame (~25 ms at 1080p), the driver has no free buffer, so every
  other frame is dropped. `cameras.py` now sets 2 buffers (backup `cameras.py.bak-pre-buffer2`); the
  backlog stays <= 1 frame. Measured rates after that change are in progress.txt (2026-10-21).
- Per-frame costs on the Pi 5 at 1080p: JPEG encode q80 11 ms, decode 15 ms, full-quality still 140 KB.
  Encoding every captured frame put uvicorn at 85-100 % of a core and the SoC at 80-85 C with the
  firmware's soft temperature limit active (passive heatsink only).
- **Lazy encoding (same day):** `cameras.py` now stores the raw YUYV frame (OpenCV's RGB conversion
  switched off, 2 driver buffers) and converts/encodes on first use, cached per frame; `_Frame.encode(q, w)`
  resizes straight from the BGR frame and the Pi's snapshot route uses it (no decode of a full JPEG
  first: `?q=70&w=960` went from 24 ms to 11 ms). Result at 1080p@30: worker 29.8 fps, service ~20-27 %
  of a core with nobody watching, ~30 % with one viewer pulling 960-wide frames at 4-5 fps, SoC ~72 C
  and falling (from 84). The vendored copy is `src/server/cameras.py` in this folder.
- **Thermal route:** `src/server/thermal.py` (GET /health/thermal, installer
  `scripts/install_thermal_router.py`) reports temp, `vcgencmd get_throttled` flags (now / since boot),
  clock, load and the service's CPU. BIMS: `/api/robot-arm/thermal`, chip on the camera card
  (`PiThermalChip.svelte`), episodes in `device_events` as `robot_arm.thermal`.
- AprilTag detection at 1080p (6 live frames, 8 mm tags at ~300 mm = ~35 px): 1x finds the same tags as
  2x (26 ms vs 97 ms detect). `APRILTAG_UPSCALE` stays 2 for tags farther away; drop it to 1.5 or 1 if
  the Pi gets too hot.
- BIMS needed no change: the panel's size menu asks for `?w=` <= 1920 and reads the frame size from
  the Pi's status, and the intrinsics file already had the 1920x1080 entry.

## Recommended plan

1. **30 fps:** done. Pi already at 30; BIMS direct mode now offers 5/10/15/30 (built, see above). Proxy
   stays at ≤10 fps (30 Vercel invocations/s per viewer is slow and costly).
2. **Direct mode without Vercel access:** done via the tunnel fallback above. After it deploys, the
   panel footer should read "direct stream · up to 30 fps". If it still says "via BIMS", the browser's
   probe of `<tunnel>/cameras/external/snapshot.jpg?token=…` failed: check the tunnel answers and that
   the Pi's `require_view_access` accepts `?token=`.
3. **Later, only if bandwidth bites:** add an H.264 path (MediaMTX/go2rtc, software encode) next to
   MJPEG, not instead of it.

## Pi access notes

- `ssh -i ~/.ssh/id_ed25519_armpi brevitest3@100.103.204.105` (Tailscale; works off the office LAN. The `arm-pi` ssh alias points at the old LAN IP). Service:
  `sudo systemctl restart robot-arm`; env file `~/robot-arm/.env`.
- The Pi's `app.py` differs from the copy vendored in this repo; read the Pi's files before editing.
- Public reachability: `https://arm-pi.tailf65a70.ts.net` (Funnel) or the Cloudflare tunnel URL the
  `arm-tunnel` service registers with BIMS. "Funnel on" in status is not proof it works publicly.

## Vision quality update (2026-10-23, branch `feat/arm-vision-raw-frames`) — note for Sam

depth.py on the Pi CHANGED (backup `src/server/depth.py.bak-pre-raw`; the vendored copy in this folder is
now the Pi's file, re-vendored from the Pi first — the old vendored pyrealsense2 version was never what ran):
- Stream mode switch at runtime: `GET/POST /depth/config` with `mode` 480p (848x480, as before) or 720p
  (1280x720) and `fps` 6/15/30; remembered in `calibrations/depth_config.json`, env `DEPTH_MODE`/`DEPTH_FPS`
  as defaults. BIMS Vision tab → "Depth stream" panel. The colour→depth affine (your 848x480 fit) is scaled
  per axis for 720p; probed on the sheet tags it lands on the same surfaces (±1 mm) in both modes.
- `_sample_points` now refuses a window with < 30 % valid returns or a > 20 mm spread (p90−p10) and returns
  null (BIMS falls back to the image z). Reason: at 720p the D415 leaves holes over some tag faces that
  480p's decimation fills; the old median of the few valid pixels read the background (tag 48: 420 mm vs
  its real 381). The sampling radius is given in 848x480 px and scaled with the mode.
- Status (`/depth/status`, `/depth/config`) adds `mode`, `measured_fps`, `frame_bytes`, `child_pid`,
  `child_cpu_pct` (the v4l2-ctl reader). Measured 2026-10-23: both modes hold 15.0 fps; reader CPU 1.0 %
  (480p) vs 1.6 % (720p); depth sd on parked tags ≤ 0.5 mm in both. 720p was not clearly steadier on the
  8 mm tags in this scene.

Also on the Pi (installer `scripts/install_vision_quality.py`, run with `--check` first):
- cameras.py: `_Frame.gray()` (raw YUYV luma), `wait_frame()`, `cameras.current()`, saved UVC controls
  re-applied on every device open.
- apriltags.py: detects on the raw frame (no JPEG round trip), `APRILTAG_REFINE` default `apriltag`,
  `frames` (1..10) averaging with per-tag `jitter_px`/`frames_seen`. Measured on a parked scene at 1080p,
  upscale 2: corner sd 0.10–0.35 px → 0.04–0.07 px; image-z sd 0.25–4.25 mm → 0.06–0.69 mm (→ 0.02–0.31 mm
  with frames=5). Cost: ~580 ms per detect (was 143). Upscale 1.5 / 1 are faster (443 / 256 ms) but miss the
  8 mm tags (#46/47/48/53) in up to half the frames with this refinement, so 2 stays.
- camera_controls.py (new): `GET/POST /cameras/{name}/controls`, device-reported ranges; BIMS Vision tab →
  "Camera settings". Saved set `calibrations/camera_controls.json`.
- `scripts/measure_tag_jitter.py`: the before/after measurement; run it on the Pi before and after any
  camera or detector change.

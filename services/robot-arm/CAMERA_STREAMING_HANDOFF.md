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
1920x1080), depth = `/dev/video0` (Z16, handled by `src/server/depth.py`). **Currently enumerated at
USB 2.0 (480M).**

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

- **USB 2.0:** raw YUYV 640x480@30 ≈ 18 MB/s (fits alongside depth); 1280x720@30 does not fit.
  Fix: blue USB 3 port + USB 3 cable. **Conflict to resolve:** the AprilTag sheet
  (`calibration/apriltag-sheet.html`, progress.txt 2026-10-20) assumes colour at 1920x1080, which is
  ~124 MB/s at 30 fps — impossible on USB 2. Either USB 3, or capture 1080p at low fps for
  calibration stills and stream 640x480@30 for the live view.
- **Network:** remote viewing goes over Tailscale Funnel / Cloudflare quick tunnel on Starlink;
  Funnel's DERP relay drops regularly (see progress.txt 2026-10-15..19). MJPEG@30 ≈ 1–3 MB/s/viewer.
- **Pi 5 has no hardware H.264 encoder** (Pi 4 did). H.264/WebRTC would be CPU (software) encoded,
  and WebRTC through Starlink's hard NAT would need a TURN relay.

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

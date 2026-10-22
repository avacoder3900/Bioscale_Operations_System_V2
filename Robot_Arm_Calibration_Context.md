# Robot Arm Calibration: Context

Condensed working context for the robot arm's camera calibration and home check. Read this before
touching the Vision tab, the arm's vision code in BIMS, or the Pi's camera routes. Full spec:
[docs/prds/ARM-05-apriltag-vision.md](docs/prds/ARM-05-apriltag-vision.md).

_Last updated 2026-10-21 (ARM-05 merged 2026-10-20 as `dcdf9262`, PR #105; on 2026-10-21 encoders via /servos, ≤300-step jogs, then the sequenced, repeating Return to home with the servo-1 freeze; Animate tab ARM-06 added 2026-10-21). The Pi already serves `/cameras/{name}/apriltags` (seen in its OpenAPI on 2026-10-21)._

## 1. Where things stand

| | State |
|---|---|
| BIMS side (ARM-05) | **On master and in production.** The Vision tab works against the new Pi route once it is installed. |
| Pi side (`apriltags.py`) | **Written but never run.** It was written without Pi access and is not installed on arm-pi yet. Until it is, BIMS shows "no AprilTag route installed". |
| Tags | Printed (Giovanni's sheet). No ID has been mapped to a physical spot yet, and none are registered in BIMS. |
| Tolerances | Defaults (5 mm / 5°). Not yet tuned against live jitter. |

**Next steps, in order:** install the Pi route (§5) → register each stuck-on tag (use the photo of where
each ID went) → put at least one tag on something fixed → calibrate with the arm at home → watch the
live view with the arm parked and set tolerances just above the jitter.

## 2. History (why it looks like this)

| Version | Approach | Fate |
|---|---|---|
| ARM-03 (Jacob, 2026-10-19) | Whole-frame greyscale thumbnail compared with the one at home | Replaced: one number for the whole picture, so it can't say which part moved, and people or lighting change it |
| ARM-04 (2026-10-19) | Coloured stickers dragged onto a frozen frame, tracked by colour blob | Replaced 2026-10-20 before it ever ran on the arm: no identity, lighting-sensitive, pixels only |
| **ARM-05** (2026-10-20) | **AprilTag 36h11**: ID plus position in mm and rotation for each tag | Current |

The ARM-03/04 Mongo collections (`robot_arm_home_calibrations`, `robot_arm_markers`,
`robot_arm_vision_calibrations`) are left untouched and are no longer read. Their code is deleted.

## 3. Hardware facts

- **Camera:** Intel RealSense **D415** on arm-pi (Raspberry Pi 5). Colour is `/dev/video4`, depth is `/dev/video0`.
- **Link is USB 3.0 since 2026-10-21** (5000M on bus 004; a USB 3 cable into a blue port). Colour streams at **1920×1080 @ 30 fps** (`hardware.yaml`, backup `.bak-720p15`). History: USB 2.0 capped colour at 640×480@30 / 720p@15 / 1080p@8, and the stream ran 640×480 until 2026-10-20, then 720p@15.
- Focal length ≈ **1366 px at 1920×1080** (factory intrinsics file, `calibrations/realsense_color_intrinsics.json`); 910 px at 1280×720, 615 px at 640×480.
- **Pi 5 has only a passive heatsink.** Encoding every 1080p frame ran one core at 85–100 % and the SoC reached 84 °C with the firmware's soft temperature limit active (2026-10-21). Since then `cameras.py` encodes lazily (the capture thread only copies the raw YUYV frame; colour conversion and JPEG happen on first use, cached per frame), so an unwatched 1080p@30 camera costs ~20–27 % of a core and the SoC sat at ~72 °C. `GET /health/thermal` (`src/server/thermal.py`) reports temperature, throttle flags, clock and service CPU; BIMS shows it as a chip on the camera card of every arm tab and logs hot/critical episodes to `device_events` (eventType `robot_arm.thermal`). The firmware throttles from 80 °C, hard-limits at 85 °C.
- **Tags are at most 1 ft (~300 mm) from the camera** (operator, 2026-10-20).
- **Tag sheet:** `services/robot-arm/calibration/apriltag-sheet.{html,pdf}`, generator `scripts/make_apriltag_sheet.py`.
  - IDs 0–53 in order, nine per size: **0–8: 40 mm, 9–17: 30, 18–26: 20, 27–35: 15, 36–44: 12, 45–53: 8** (edge of the black square).
  - Each ID goes on one spot only. Print at 100 % on matte paper, laser preferred.
- **Smallest reliable tag** ≈ 24 × distance / focal length. At 1 ft and 1920×1080 that is **~5 mm**, so every sheet size reads; the 8 mm tags are ~35 px across at 300 mm. (At 640×480 it was ~12 mm, and the 8 mm tags needed 1280×720.) Use 20–40 mm tags for fixed references; pose precision grows with size. Detection still runs on a 2× enlargement (`APRILTAG_UPSCALE`, ~135 ms per frame at 1080p incl. the grab; 1× found the same tags in ~25 ms on 2026-10-21, kept at 2× for tags farther than 1 ft).
- **Pi camera code:** `services/robot-arm/src/server/cameras.py` is now a vendored copy of the Pi's (lazy-encoding version, 2026-10-21); `src/config/hardware.yaml` lives only on the Pi, and the Pi's `app.py` differs from the repo copy (its snapshot route calls `frame.encode(q, w)`; backup `app.py.bak-lazy`). Read the Pi's files before editing.

## 4. How ARM-05 works

1. **Detection is on the Pi.** `apriltags.py` takes the frame from the service's own `snapshot.jpg` over
   loopback (it never opens the camera), then runs OpenCV aruco with `DICT_APRILTAG_36h11` and sub-pixel corners.
   - For each tag, `solvePnP` (IPPE_SQUARE) gives its position and rotation. The camera intrinsics come from the D415's factory calibration via pyrealsense2; the fallbacks are `APRILTAG_FX/FY/CX/CY` env vars, then a nominal estimate (`source: nominal`).
   - The D415 depth at each tag centre (from depth.py) is attached as a cross-check.
2. **Registry** (`robot_arm_tags`): one row per tag with ID (unique among active tags), size in mm (defaults to the sheet's size for that ID), role and name/group.
   - Role is `arm` or `fixed` (deck, Opentron).
   - Tags are archived, never deleted.
3. **Calibrate**, with the arm parked at home: *Detect tags* outlines every tag in view, and you can register unknown IDs inline. *Save* runs one fresh detection on the server.
   - It stores every registered tag's pose, plus the follower's encoder steps (the Return-to-home target).
   - One `active` calibration per camera (`robot_arm_tag_calibrations`); older ones are kept as `superseded` history.
4. **Check:** each tag now is compared with home in **mm and degrees of spin** (rotation about the tag's own normal). Tilt of the normal is shown but never judged: a square seen nearly head-on has two poses that fit its corners equally (toward / away from the camera), the Pi returns both (`pose.alt`), and BIMS takes the one agreeing with the calibration when their reprojection errors are close (`resolvePose`; a `?` after the live tilt marks such a frame). Angle tolerance 0 means spin isn't checked. A tag without a pose falls back to picture distance (1.5 % of frame width).
5. **Camera bumps are undone, not just flagged.**
   - Each fixed tag proposes a camera motion M = P_now · P_cal⁻¹. The proposal most fixed tags agree with wins, so one knocked fixed tag is outvoted.
   - If that motion is beyond tolerance, it is removed before the arm tags are judged, and the message says "camera shifted ~X mm, recalibrate when convenient".
   - `camera_moved` is the verdict only when **no** fixed tag is in view and three or more tags all moved together.
6. **Editing a tag's registry size after calibration doesn't read as movement:** detections are rescaled to the calibrated size, since translation scales linearly with tag size.
7. **Home verdicts** (`home-calibration.ts`, unchanged since ARM-03/04): `home`, `position_off` (encoders), `markers_off` (tags), `position_off_and_markers_off`, `camera_moved`, `unverified`.
8. **Return to home** (operator spec 2026-10-21) is **one click**: the Vision tab keeps sending attempts until every joint is home **and the claw is closed**, you press Stop, it freezes, or **90 s** pass (no new attempt starts after that; an attempt in progress always finishes). There is **no jog limit**; each request only has a ~20 s move slice (Vercel 30 s) and the next attempt carries on automatically. Each attempt is one server request (Vercel 30 s), in this order:
   1. **Safety gate, servo 1 ("servo A", base rotation):** if it is further than its safe range from home (default **±90°**, editable under *Home settings* on the Vision tab), nothing moves, **torque is turned OFF** so a technician can walk the arm home by hand, and the verdict is `frozen`. A head-mounted camera is planned to handle this case later.
   2. **Open the mouth** (servo 6, positive steps = open; default +300 ≈ 26°, editable, 0 = skip) to release the cartridge. Attempt 1 only.
   3. **Servo 2 ("servo B", shoulder lift) to home** on its own.
   4. **Servos 1–5 to home.**
   5. **Close the claw completely:** −300-step jogs on servo 6 until a jog moves it < 6 steps (the closed stop), then ease off 1 step so it is not left straining. **This is the final step every time Return to home ends** (done, Stop, 90 s, an error): if the attempts ended with the claw still open, the Vision tab calls `?/closeClaw` (`closeClaw()` in robot-arm-vision.ts, torque on, ≤ ~20 s per request, up to 3 requests) and shows "Claw closed" or why not. The one exception is a freeze: torque stays off for the technician.
   **Stop returning** takes effect within one jog: the tab writes its loop's `runId` to the calibration (`?/stopReturn` → `homeStopRunId`), `returnToHome` checks it before every jog and ends the attempt, and the tab then closes the mouth. **Live tags are switched off and locked while Return to home runs**, so their polling never competes with the arm's requests to the Pi.
   Every move is in ≤300-step jogs (the Pi rejects bigger ones with a 400), with a 0.8 s settle, re-read and correction passes, because a jog adds to the *present* position, which lags the goal. The camera check runs only once the encoders say home. Encoder steps come from `GET /servos`; `GET /pose` answers **501** on the current Pi (IK not ported) and is used only, when it answers, to record the Cartesian pose. Home settings live on the calibration (`homing`) and carry forward when you recalibrate.
9. **Cancelling a run** (Control tab Stop → `POST /sessions/stop`) re-enables torque straight after (one retry after 0.6 s), so the arm holds where it is instead of going limp; if that fails the Control tab says so in a warning. The audit row records `torque_on`.

## 5. Pi route and install

```
POST /cameras/{name}/apriltags/detect
  {tag_sizes_mm?: {"<id>": mm}, default_size_mm?, include_frame?, depth?}
  → {available, reason, family, detector, frame:{width,height},
     intrinsics:{fx,fy,cx,cy,dist,source}, tags:[{id, center:[x,y], corners:[[x,y]×4 TL TR BR BL],
     size_mm, pose:{t_mm:[x,y,z], R:[9 row-major], reproj_px}|null, depth_mm, margin}],
     frame_jpeg_b64?, elapsed_ms}
GET  /cameras/{name}/apriltags   → status + intrinsics
```

- Positions are normalised (0..1) to the frame.
- Poses use OpenCV camera axes: x right, y down, z out of the lens.
- Failures come back as `available:false` with a `reason`, never as an HTTP error.

**Install on arm-pi:**
1. Copy `services/robot-arm/src/server/apriltags.py` next to `app.py`.
2. Check OpenCV: `.venv/bin/python -c "import cv2; print(cv2.__version__, cv2.aruco.DICT_APRILTAG_36h11)"`. If that fails, run `uv add opencv-python-headless numpy`.
3. Run `python3 scripts/install_apriltag_router.py`. It is idempotent, backs up `app.py`, and refuses to install without `require_api_key`.
4. Run `sudo systemctl restart robot-arm`.
5. Run `curl -H "x-api-key: $KEY" localhost:8000/cameras/<name>/apriltags`. Expect `available:true` and `intrinsics.source: "realsense"`.

**Unverified assumptions to check on the Pi:**
- OpenCV has aruco (version 4.7 or later, or the legacy API).
- `snapshot.jpg` accepts `x-api-key` over loopback (the key is read from `ROBOT_ARM_API_KEY`).
- cameras.py doesn't rotate or flip frames (if it does, the intrinsics are wrong).
- The service listens on `127.0.0.1:8000` (override with `APRILTAG_SELF_URL`).
- Large angle jumps (28–70°) on small tags were the planar-pose flip; since 2026-10-22 only spin is judged and the flip is settled against the calibration, so the angle tolerance can stay on. The Live Tags table colours the number over tolerance red.

## 6. Code map (BIMS)

| File | Role |
|---|---|
| `src/lib/robot-arm/apriltags.ts` (+15 tests) | Pure logic: sheet sizes, 3-D maths, camera-shift consensus, per-tag assessment, verdict, message |
| `src/lib/robot-arm/home-calibration.ts` (+8 tests) | Pure logic: jog plan, encoder residuals, combined home verdict |
| `src/lib/robot-arm/detect-client.ts` | Browser fetch of detections |
| `src/lib/server/robot-arm-vision.ts` | Registry CRUD, `detectTags`, `saveCalibration`, `checkHome`, `returnToHome`, audit |
| `src/lib/server/robot-arm-client.ts` | `robotArm.detectAprilTags` (a 404 becomes "route not installed") |
| `src/lib/server/db/models/robot-arm-tag{,-calibration}.ts` | `robot_arm_tags`, `robot_arm_tag_calibrations` |
| `src/routes/manufacturing/cart-mfg/robot-arm/vision/` | Vision tab: home check, live view, calibrate, registry |
| `src/lib/components/robot-arm/Vision{Stage,LiveTracker,TagCalibrator,TagRegistry}.svelte` | Tab components |
| `src/routes/api/robot-arm/cameras/[name]/apriltags/+server.ts` | Browser → Pi detection proxy (`manufacturing:read`) |
| `src/routes/api/agent/robot-arm/vision-check/+server.ts` | Agent check, no motion: verdict, per-tag `offMm/offDeg` (spin) `/offTiltDeg/ambiguous/zMm`, `cameraShift` |
| `services/robot-arm/src/server/{apriltags,depth}.py`, `scripts/install_{apriltag,depth}_router.py` | Pi routes and installers |

**Permissions:** viewing needs `manufacturing:read`. Calibrate, check, return to home and the registry need `manufacturing:write`.
Every mutation writes an AuditLog row (`robot_arm.tag.*`, `robot_arm.vision.*`).

## 6b. Animate tab (ARM-06, 2026-10-21)

Not calibration, but it shares the arm and the recording pipeline. Poses captured by hand (torque off → move → *Save pose* → `POST /servos/hold`), move sets (poses + duration/easing/hold per keyframe), sequences (move sets + joins). BIMS renders a 30 Hz joint path (`src/lib/robot-arm/animation.ts`: minimum-jerk easing, Catmull-Rom/Hermite *flow*) and the Pi replays it as recording `animate-preview` with a lead-in from wherever the arm is. **Needs the Pi hold route** (`services/robot-arm/src/server/hold.py`, `scripts/install_hold_router.py`): a bare torque-on after hand-posing drives every servo back to its last goal. Full spec: [docs/prds/ARM-06-animate.md](docs/prds/ARM-06-animate.md).

**Posing with the control arm (2026-10-21, PRD §8).** Hand-posed poses landed off because the unpowered follower sags; the preferred capture is now a Pi **teleop** session: follower torqued and tracking the leader. *Save pose* = `POST /sessions/stop` → settle → `GET /servos` → save → `POST /teleop/start` again; *Done* = stop (follower holds, leader limp). Never read `/servos` while a session runs — the driver is not thread-safe and that route has no bus guard; the Animate page skips its own servo read while any session is active. Runs tagged `manufacturing_step: animate-pose`. No new Pi route.

**Overlay (ARM-07, 2026-10-22, `feat/cleanup-overlay`).** Animated recordings land low (open-loop replay, goal = pose, droop); a pilot's teleop recording of the same motion has the compensation baked into its goals but a rough path. Clean-up tab → *Overlay* (`cleanup/overlay?smooth=&precise=`) lines the two up with subsequence DTW (`src/lib/robot-arm/recording-overlay.ts`), smooths/caps/scales the per-frame offset and adds it to the animated frames; *Save to Pi* writes the dense result, *Open as a clean-up* makes a draft whose frames are the overlay (→ Send to Animate gives poses with the pilot's positions). Spec: [docs/prds/ARM-07-cleanup-overlay.md](docs/prds/ARM-07-cleanup-overlay.md). Untested on the arm.

**Clean-up smoothing (ARM-08, 2026-10-22, `feat/cleanup-smoothing`).** Clean-up by itself only splits into steps, and its Save to Pi plays straight lines. Now a Smoothing card (window and strength sliders, keep stops exact, per-servo ticks, live chart) makes Save to Pi write the smoothed path of the recording or of the steps (`src/lib/robot-arm/recording-smooth.ts`). *Smooth automatically* on the new-clean-up form (default on); overlays opened as clean-ups start smoothed. Settings live on the clean-up, so it can be re-tuned and re-saved later; *Replace it* updates a file this clean-up saved before. Spec: [docs/prds/ARM-08-cleanup-smoothing.md](docs/prds/ARM-08-cleanup-smoothing.md). Untested on the arm.

## 6c. Torque on/off on the camera card (2026-10-21)

`src/lib/components/robot-arm/TorqueControl.svelte`, mounted in `RobotArmCameraPanel.svelte` (the arm layout), so it is on every Robot Arm tab, visible even with the picture collapsed. API `src/routes/api/robot-arm/torque/+server.ts`: GET reads `/servos` torque flags; POST `{enable}` → off = `/torque false`; on = `/servos/hold` (goal := present, then torque on) with a plain `/torque true` fallback that warns the servos drive to their last goal. Refused while a session owns the arm. Audit `robot_arm.torque.on/off`.

## 7. Access and gotchas

- **Reaching the Pi:**
  - Public: `https://arm-pi.tailf65a70.ts.net` (Tailscale Funnel; it drops often) or the Cloudflare quick tunnel registered in `robot_arm_endpoints`.
  - SSH: `ssh -i ~/.ssh/id_ed25519_armpi brevitest3@100.103.204.105` over Tailscale. The key is not on every dev machine.
- **Video to the browser:** 30 fps direct MJPEG goes through the tunnel (Giovanni, `feat/arm-camera-direct-30fps`, merged). Fallback is the BIMS snapshot proxy at ≤10 fps. The Vision tab polls detections at 0.5–2 per second, each carrying its own frame.
- **Vercel function limit is 30 s.** Return to home (≤5 jogs + settle + one detection) fits, as ARM-03/04 did.
- **Deploying:** never deploy from local. Push the branch, let Vercel build it, and log the `-brevitest` URL in `progress.txt`.
- **Related docs:**
  - `docs/prds/ARM-01…ARM-05`
  - `services/robot-arm/CAMERA_STREAMING_HANDOFF.md` (streaming and USB 2.0 limits)
  - `progress.txt` entries dated 2026-10-19 and 2026-10-20

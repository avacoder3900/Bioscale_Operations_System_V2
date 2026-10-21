# Robot Arm Calibration: Context

Condensed working context for the robot arm's camera calibration and home check. Read this before
touching the Vision tab, the arm's vision code in BIMS, or the Pi's camera routes. Full spec:
[docs/prds/ARM-05-apriltag-vision.md](docs/prds/ARM-05-apriltag-vision.md).

_Last updated 2026-10-21 (ARM-05 merged 2026-10-20 as `dcdf9262`, PR #105; encoders via /servos and ≤300-step home jogs 2026-10-21). The Pi already serves `/cameras/{name}/apriltags` (seen in its OpenAPI on 2026-10-21)._

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
- **Link is USB 2.0.** Colour streams at **640×480 @ 30 fps** (720p maxes out at 15 fps, 1080p at 8). Fixing that needs a USB 3 port and cable.
- Focal length at 640×480 ≈ **615 px**.
- **Tags are at most 1 ft (~300 mm) from the camera** (operator, 2026-10-20).
- **Tag sheet:** `services/robot-arm/calibration/apriltag-sheet.{html,pdf}`, generator `scripts/make_apriltag_sheet.py`.
  - IDs 0–53 in order, nine per size: **0–8: 40 mm, 9–17: 30, 18–26: 20, 27–35: 15, 36–44: 12, 45–53: 8** (edge of the black square).
  - Each ID goes on one spot only. Print at 100 % on matte paper, laser preferred.
- **Smallest reliable tag** ≈ 24 × distance / focal length. At 1 ft and 640×480 that is **~12 mm**, so tags 12–40 mm read. The **8 mm tags need 1280×720**. Use 20–40 mm tags for fixed references; pose precision grows with size.
- **Pi camera code is not in this repo.** `~/robot-arm/src/server/cameras.py` and `src/config/hardware.yaml` live only on the Pi, and the Pi's `app.py` differs from the repo copy. Read the Pi's files before editing.

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
4. **Check:** each tag now is compared with home in **mm and degrees**. Angle tolerance 0 means the angle isn't checked. A tag without a pose falls back to picture distance (1.5 % of frame width).
5. **Camera bumps are undone, not just flagged.**
   - Each fixed tag proposes a camera motion M = P_now · P_cal⁻¹. The proposal most fixed tags agree with wins, so one knocked fixed tag is outvoted.
   - If that motion is beyond tolerance, it is removed before the arm tags are judged, and the message says "camera shifted ~X mm, recalibrate when convenient".
   - `camera_moved` is the verdict only when **no** fixed tag is in view and three or more tags all moved together.
6. **Editing a tag's registry size after calibration doesn't read as movement:** detections are rescaled to the calibrated size, since translation scales linearly with tag size.
7. **Home verdicts** (`home-calibration.ts`, unchanged since ARM-03/04): `home`, `position_off` (encoders), `markers_off` (tags), `position_off_and_markers_off`, `camera_moved`, `unverified`.
8. **Return to home:** refuses while a session holds the arm, or when home is more than 20 jogs away. Then torque on and jog servos 1–5 to the calibrated encoder steps in **≤300-step jogs** (the Pi rejects bigger ones with a 400). A jog adds to the *present* position, which lags the goal, so it settles 0.8 s, re-reads and corrects (up to 2 correction passes, 20 jogs total). Home tolerance is 12 steps ≈ 1°. Then the same check. The move goes by the encoders alone.
   Encoder steps are read from `GET /servos` (raw per-servo `position`, no IK). `GET /pose` answers **501** on the current Pi server because inverse kinematics (ikpy + URDF) isn't ported, so it is only used, when it answers, to record the Cartesian pose (fixed 2026-10-21).

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
- If small tags show pose flips (large angle jumps), set the angle tolerance to 0.

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
| `src/routes/api/agent/robot-arm/vision-check/+server.ts` | Agent check, no motion: verdict, per-tag `offMm/offDeg/zMm`, `cameraShift` |
| `services/robot-arm/src/server/{apriltags,depth}.py`, `scripts/install_{apriltag,depth}_router.py` | Pi routes and installers |

**Permissions:** viewing needs `manufacturing:read`. Calibrate, check, return to home and the registry need `manufacturing:write`.
Every mutation writes an AuditLog row (`robot_arm.tag.*`, `robot_arm.vision.*`).

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

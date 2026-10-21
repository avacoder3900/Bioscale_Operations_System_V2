# ARM-05 — AprilTag vision calibration, live view and home check

**Status:** built 2026-10-20 on `feat/arm-apriltag-vision`; Pi side written without Pi access, not yet
run on hardware. **Supersedes ARM-04** (coloured stickers tracked by colour blob).

## 1. Why ARM-04 was replaced

The coloured stickers were never run on the arm, and colour tracking is weak by design: no
identity (two stickers of one colour are told apart only by "nearest blob"), sensitive to lighting,
and only a 2-D picture offset in pixels. The team printed Giovanni's AprilTag 36h11 sheet instead
(`services/robot-arm/calibration/apriltag-sheet.{html,pdf}`, IDs 0–53, nine each at 40/30/20/15/12/8 mm).
A tag carries its own ID and, with its printed size and the camera intrinsics, gives a full pose
(position in mm + rotation) relative to the camera.

## 2. How it works

1. **Detection runs on the Pi** (`services/robot-arm/src/server/apriltags.py`): OpenCV aruco
   `DICT_APRILTAG_36h11`, sub-pixel corners, `solvePnP(IPPE_SQUARE)` per tag with the D415's factory
   colour intrinsics (pyrealsense2), D415 depth at each centre as a cross-check (depth.py). Frames come
   from the service's own `snapshot.jpg` over loopback, so cameras.py is not touched.
2. **Registry** (`robot_arm_tags`): one row per stuck-on tag: ID (unique among active), size mm (sheet
   default by ID, overridable with a measured value), role `arm` or `fixed`, name, group.
3. **Calibrate:** arm parked at home → *Detect tags* shows the frame with every tag outlined; any tag not
   registered can be registered right there by its ID. *Save* runs one fresh detection server-side and
   stores every registered tag's pose, plus the follower's encoder steps (Return-to-home target).
   Unregistered/unseen tags, no fixed tag, no arm tag, and nominal intrinsics are reported as warnings.
4. **Check:** each tag now vs home in **mm and degrees** (defaults 5 mm / 5°, set per calibration; angle 0 =
   not checked). Without a pose on either side, picture offset (1.5 % of width) is the fallback.
5. **Camera bumps are undone, not just reported.** Each fixed tag proposes the camera motion
   M = P_now·P_cal⁻¹; the proposal most fixed tags agree with wins (a single knocked fixed tag is outvoted
   and reported as moved). If that motion exceeds tolerance it is applied to every calibrated pose before
   the arm tags are judged, and the message says the camera shifted and to recalibrate when convenient.
   Only when **no** fixed tag is in view and ≥3 tags all moved together is the verdict `camera_moved`.
6. **Home verdicts are unchanged** (`home_calibration.ts`): `home`, `position_off`, `markers_off`,
   `position_off_and_markers_off`, `camera_moved`, `unverified`. Automation:
   `GET /api/agent/robot-arm/vision-check[?camera=]` (agent key, no motion) now returns per tag `tagId`,
   `role`, `offMm`, `offDeg`, `zMm`, `depthMm`, and `cameraShift`.
7. A registry size edit after calibration does not read as movement: detections are rescaled to the
   calibrated size before comparison (translation is linear in tag size).

## 3. Pi contract

```
POST /cameras/{name}/apriltags/detect
  {tag_sizes_mm?: {"<id>": mm}, default_size_mm?, include_frame?: bool, depth?: bool}
  → {available, reason, family, detector, frame: {width, height},
     intrinsics: {fx, fy, cx, cy, dist, source: realsense|env|nominal},
     tags: [{id, center: [x,y], corners: [[x,y]×4 TL TR BR BL], size_mm,
             pose: {t_mm: [x,y,z], R: [9 row-major], reproj_px} | null, depth_mm, margin}],
     frame_jpeg_b64?, elapsed_ms}
GET  /cameras/{name}/apriltags   → {available, reason, detector, frame, intrinsics, depth}
```

Positions normalised to the frame; pose in the OpenCV camera frame (x right, y down, z out of the lens).
Failures are `available: false` with a reason, never an HTTP error. A Pi without the route answers 404,
which BIMS reports as "no AprilTag route installed".

**Install on arm-pi:** copy `apriltags.py` next to `app.py`;
`.venv/bin/python -c "import cv2; print(cv2.__version__, cv2.aruco.DICT_APRILTAG_36h11)"` (if it fails:
`uv add opencv-python-headless numpy`); `python3 scripts/install_apriltag_router.py`;
`sudo systemctl restart robot-arm`; then
`curl -H "x-api-key: $KEY" localhost:8000/cameras/<name>/apriltags` (expect `intrinsics.source: realsense`) and
`curl -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{"default_size_mm":30}' localhost:8000/cameras/<name>/apriltags/detect`.
Env knobs: `APRILTAG_SELF_URL` (default `http://127.0.0.1:8000`), `APRILTAG_FX/FY/CX/CY`, `APRILTAG_REFINE`.

## 4. Tag size vs distance

The stream is 1920×1080 since 2026-10-21 (USB 3 link; D415 colour f ≈ 1366 px there). It was 640×480
(f ≈ 615) on USB 2.0 until 2026-10-20 and 1280×720 @ 15 fps for one day. A 36h11 black square is 8 cells
and the detector wants ~3 px/cell, so the smallest reliable tag is `24 × distance / f`:

| distance | min tag (640×480) | min tag (1280×720, f≈920) | min tag (1920×1080, f≈1366) |
|---|---|---|---|
| 150 mm | 6 mm | 4 mm | 3 mm |
| 300 mm (1 ft) | 12 mm | 8 mm | 5 mm |

At ≤ 1 ft every sheet size reads at 1080p (the 8 mm tags are ~35 px across at 300 mm; measured
2026-10-21). The Calibrate preview flags any tag that is small for its distance.
Pose precision also grows with tag size: prefer the 20–40 mm tags for the fixed references.

## 5. Files

| File | Role |
|---|---|
| `src/lib/robot-arm/apriltags.ts` (+ `.test.ts`, 15 tests) | pure: sheet sizes, 3-D helpers, camera-shift consensus, per-tag assessment, verdict, message |
| `src/lib/robot-arm/home-calibration.ts` | unchanged logic; now typed against `apriltags` |
| `src/lib/robot-arm/detect-client.ts` | browser: fetch detections from the BIMS proxy |
| `src/lib/server/robot-arm-vision.ts` | registry CRUD, detect, save calibration, check, return to home, audit |
| `src/lib/server/db/models/robot-arm-tag.ts` | `robot_arm_tags` |
| `src/lib/server/db/models/robot-arm-tag-calibration.ts` | `robot_arm_tag_calibrations` — one `active` per camera + history |
| `src/lib/server/robot-arm-client.ts` | `detectAprilTags` (replaces `sampleDepth`) |
| `src/routes/api/robot-arm/cameras/[name]/apriltags/+server.ts` | browser → Pi detection proxy (`manufacturing:read`) |
| `src/lib/components/robot-arm/Vision{Stage,LiveTracker,TagCalibrator,TagRegistry}.svelte` | the Vision tab's parts |
| `services/robot-arm/src/server/apriltags.py`, `scripts/install_apriltag_router.py` | Pi route + installer |

Removed: `markers.ts` (+ tests), `frame-grab.ts`, the depth proxy route, `VisionCalibrationEditor`,
`VisionMarkerRegistry`, models `robot-arm-marker.ts` / `robot-arm-vision-calibration.ts`. Their Mongo
collections (`robot_arm_markers`, `robot_arm_vision_calibrations`) are left untouched and no longer read.
`depth.py` stays on the Pi; apriltags.py uses it.

## 6. Not done / to verify on hardware

- Everything Pi-side: cv2 version/aruco on the Pi, that `snapshot.jpg` accepts `x-api-key` over loopback,
  and that cameras.py does not rotate/flip frames (the intrinsics would then not match).
- Real tolerances: watch the live view with the arm parked and set mm/° above the jitter. Small tags can
  flip pose (planar ambiguity) and show large angle jumps; if that happens set angle tolerance to 0.
- Map each stuck-on ID to its spot (from Giovanni's photo) and register them.
- Vercel budget: Return to home = active check + torque + pose + ≤5 jogs + 1.5 s settle + pose + one
  detection (frame included, ~50–100 kB) — same order as ARM-04.

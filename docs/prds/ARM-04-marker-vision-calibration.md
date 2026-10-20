# ARM-04 — Sticker-marker vision calibration, live tracking and home check

**Status:** SUPERSEDED 2026-10-20 by [ARM-05](ARM-05-apriltag-vision.md) (AprilTags replace the coloured stickers; this code is removed). Was built 2026-10-19 on `feat/arm-marker-calibration`; not yet exercised against the live
arm or a depth camera. **Supersedes ARM-03** (camera-verified HOME via a whole-frame greyscale signature).

## 1. Why ARM-03 was rebuilt

ARM-03 compared a 32×24 greyscale thumbnail of the whole frame with the one taken at home. One
number for the whole picture: it could not say *which* part of the arm was off, a person walking
through the frame or a lighting change moved the score as much as the arm did, and the 0.85
threshold had never been set from real scores. ARM-04 replaces it with points the operator chooses.

## 2. How it works

1. **Markers are the operator's own.** Coloured stickers go on the arm and its surroundings (joints,
   claw, back of the Opentron, deck corners, …). Each one is registered in BIMS with a name, an
   optional group and its colour. No marker or group is built in.
2. **Calibrate = drag markers onto a frozen frame.** With the arm parked at home, the operator freezes
   a camera frame, picks a marker and clicks its sticker (or drags a placed marker), with *snap to
   sticker* centring it on the blob of that colour. Saving stores, per marker: position (normalised
   to the frame), the colour sampled under it on camera, and the depth there; plus the frame, and the
   follower's encoder steps at that moment (the target for Return to home).
3. **Track.** Each frame, every marker is found again by colour near where it was last seen: colour
   mask in a search window → 8-connected blobs → the blob nearest the prior (so two same-coloured
   stickers are never averaged together). Each is compared with its calibrated spot:
   `ok`, `moved` (> position tolerance, default 1.5 % of frame width ≈ 10 px at 640), `depth_off`
   (in place on the picture but nearer/further than the depth tolerance, default 20 mm — what the lidar
   adds: motion along the camera axis is invisible on the picture), or `missing`. If ≥ 3 markers all
   shifted by the same vector the verdict is `camera_moved` — recalibrate, don't drive the arm.
4. **Home check (the fail-state backstop).** *Check without moving* reads the encoders and checks the
   markers in a fresh frame server-side. *Return to home* jogs each joint back to the calibrated
   encoder steps (as ARM-03 did), settles, then runs the same check. Combined verdict: `home`,
   `position_off`, `markers_off`, `position_off_and_markers_off`, `camera_moved`, `unverified`.
   Automation gets the same check at `GET /api/agent/robot-arm/vision-check[?camera=]` (agent API key, no motion).
5. **Recalibrate** whenever the camera moves or anything about the arm or its surroundings changes. Same
   flow as 2: the current markers start where they were and are re-found on the new frame, so only the
   ones that really moved need dragging. The previous calibration is kept as history (`superseded`).

## 3. Files

| File | Role |
|---|---|
| `src/lib/robot-arm/markers.ts` (+ `.test.ts`, 14 tests) | pure: colour matching, patch sampling, blob tracking, assessment, camera-moved heuristic |
| `src/lib/robot-arm/home-calibration.ts` (+ `.test.ts`, 8 tests) | pure: jog plan, encoder residuals, combined home verdict (signature code removed) |
| `src/lib/robot-arm/frame-grab.ts` | browser: snapshot via the same-origin proxy → canvas pixels; depth proxy call |
| `src/lib/server/robot-arm-vision.ts` | registry CRUD, save calibration, server-side check, return to home, audit |
| `src/lib/server/db/models/robot-arm-marker.ts` | `robot_arm_markers` — registry, archived not deleted |
| `src/lib/server/db/models/robot-arm-vision-calibration.ts` | `robot_arm_vision_calibrations` — one `active` per camera + history |
| `src/lib/components/robot-arm/Vision*.svelte` | stage (frame + draggable SVG overlay), live tracker, calibration editor, registry |
| `src/routes/manufacturing/cart-mfg/robot-arm/vision/` | the **Vision** tab |
| `src/routes/api/robot-arm/cameras/[name]/depth/+server.ts` | browser → Pi depth proxy (`manufacturing:read`) |
| `src/routes/api/agent/robot-arm/vision-check/+server.ts` | agent check (no motion) |
| `services/robot-arm/src/server/depth.py`, `scripts/install_depth_router.py` | Pi-side depth route + installer |

Removed: `src/lib/server/robot-arm-home.ts`, model `robot-arm-home-calibration.ts`, the ARM-03 section
and its four actions on the Control page (Control now links to Vision). The old
`robot_arm_home_calibrations` collection is left in Mongo untouched and is no longer read.

## 4. Tracking runs in two places

- **Browser** (live overlay): the snapshot proxy is same-origin, so its JPEG can be decoded to canvas
  pixels. The Pi's direct MJPEG origin cannot be used for this — a cross-origin frame taints the canvas.
- **Server** (home check, agent API): sharp decodes the Pi snapshot to raw RGB; the same `trackAll` /
  `assessMarkers` run on it. Calibration colours are sampled server-side from the exact JPEG the
  operator placed markers on (the browser uploads it).

## 5. Depth (lidar)

The live Pi had **no depth route** on 2026-10-19 (OpenAPI lists only `snapshot.jpg` / `stream.mjpg`
under `/cameras`). ARM-04 defines the contract and ships a Pi router:

```
POST /cameras/{name}/depth/sample  {points: [[x, y], …] normalised to the colour frame, radius_px?}
  → {available, units: "mm", depth_mm: [n | null, …], source, reason}
GET  /cameras/{name}/depth         → {available, source, reason, depth_size, aligned}
```

`depth.py` assumes an Intel RealSense (L515 "LiDAR camera" / D4xx) through `pyrealsense2`, opens only
the depth stream (cameras.py keeps the colour node) and maps colour points onto the depth image with the
device's factory extrinsics (`DEPTH_ALIGN=project`), or by plain scaling (`naive`). Until it is
installed, BIMS gets FastAPI's 404, reports "no depth route installed", and checks on the picture only —
nothing fails. **If the camera is not a RealSense, only the `_RealSense` backend in depth.py changes;
the HTTP contract and everything in BIMS stay.**

Install on arm-pi: copy `depth.py` next to `app.py`, `uv add pyrealsense2 numpy`,
`python3 scripts/install_depth_router.py`, `sudo systemctl restart robot-arm`, then
`curl -H "x-api-key: …" localhost:8000/cameras/<name>/depth`. Set `DEPTH_COLOR_WIDTH/HEIGHT` to the
resolution cameras.py streams.

## 6. Not done / to verify on hardware

- Real tolerances: look at live offsets with the arm parked, then set position/depth tolerance per
  calibration (both are entered on the calibrate form).
- Sticker choice: vivid, distinct hues track best. Grey/white/black stickers fall back to RGB distance
  and are flagged in the UI.
- Fast motion: tracking searches 8 % of frame width around the last position, then retries at the
  calibrated spot. At 1–4 fps a joint moving faster than that between frames is reported `missing`
  until it settles — fine for a home check, not a motion-capture system.
- depth.py has not run on hardware; pyrealsense2 on aarch64 may need building from source.
- Vercel function budget: Return to home = active check + torque + pose + ≤5 jogs + 1.5 s settle +
  pose + snapshot + depth; well inside 30 s normally, same as ARM-03.

# ARM-09 — Verified poses: every step is absolute, every verified step is checked by the camera

**Status:** built 2026-10-22 on `feat/animate-verified-poses` (on top of the ARM-06 redo, PR #130). Not yet run on
the arm. No Pi change: detection, replay and the servo reads it uses all exist on arm-pi already.

## 1. What the operator asked for

> We want to scrap a lot of the workflow for how recordings are played … use the same logic we used to create the
> Home Calibration and verifying with the camera/AprilTags and use that for each step of our animations. First step:
> the servos do their work. Second step: verify that with the camera and AprilTags. … get the follower arm to each
> pose we define, verify it by human sight and capture a picture for its calibration, then use that data for future
> runs. … after a failed AprilTag read: list the ideas, don't implement; for now send out an error and stop the run.
> … manipulate the mm and angle tolerances AFTER the calibration photo is taken, per step as well. … I want this to be
> very similar to the Live Positions in the Calibrate page: a list of these values along a timeline path. I do not
> want those values to be deltas.

Two of those were already true after the redo (ARM-06 §13) and are restated here because they are the premise:

- **A pose is six absolute encoder goals.** A move set is the list of those along the timeline; the Pi plays a
  recording whose every frame is an absolute goal per servo. Nothing is a change from the step before, so an error
  at one step cannot carry into the next. (The "home once, then apply each pose as a delta" behaviour was the old
  Go to pose — relative jogs — and is gone.) The move-set editor now prints each step's six values under its name,
  and the number box beside every slider applies on Enter.
- **The home routine's two halves** — servos to the target, then encoders + AprilTags judged against a stored
  reference — are what ARM-05 built for home. ARM-09 reuses the same pieces (`assessTags`, `residuals`, the Pi's
  `/apriltags/detect`) per pose.

## 2. The flow

1. **Reference per pose** (Animate → pose editor → *Camera reference* card, also under the move-set editor).
   *Go to pose* plays the pose (absolute goals, lead-in from wherever the arm is) and the arm holds it. The operator
   looks: wrong → fix with the sliders, save, Go to pose again. Right → *Capture reference*: servos read, one
   AprilTag detection with the frame, servos read again (refused if a joint moved > 15 steps between the reads — the
   picture and the encoders must describe one pose), stored per pose per camera (`robot_arm_pose_calibrations`):
   every registered tag's picture position and 3-D pose, the encoder steps (servos 1–5), a thumbnail, the full frame
   in R2 (best effort), and the pose's goals at the time. Needs ≥ 1 arm tag in view; warns without a fixed tag.
   The arm must be within 80 steps of the pose's goals on servos 1–5 (the pose editor's own "at pose" rule) or
   capture is refused with "Go to pose first" — the reference must describe what a play lands, not what the sliders
   were nudged to.
2. **Tolerances after the photo.** Each reference carries position mm (default 5), spin ° (5; 0 = not judged) and
   encoder steps (15). *Check now* re-detects without moving and shows the live residuals per joint and per tag, so
   the numbers are set above the real jitter. A move-set step can override any of the three (blank = the pose's).
3. **Which steps are checked.** Each keyframe has *Camera check*: auto (checked when the pose has a reference for the
   camera), on (the run refuses to start without a reference, or with a stale one), off. A reference is **stale**
   once the pose's goals differ from those stored with it; the editor marks it and a run refuses it.
4. **Verified run** (◎ Play verified, on the library rows, the move-set and the sequence pages). The steps are split
   into chunks that end at every verified step (`planChunks`); the last chunk ends at the last step either way.
   Then, per chunk, driven by the browser one request at a time (`VerifiedRun` → `verifiedNext`):
   - **play** — the arm must be idle, torque on, every servo < 65 °C; the chunk is rendered from where the arm is
     (lead-in) and played exactly as Play does (`writeAndPlay`, absolute goals every frame; flow easings keep
     flowing inside a chunk — a verified step is always a stop because the camera needs the arm still).
   - **playing** — the page waits until the path should be over, then asks each second; the Pi idle = chunk over.
   - **verify** — torque back on if an older Pi replay dropped it, 0.8 s settle, encoders read, one detection, both
     judged against the step's reference with the step's tolerances (`assessStep`: pass needs BOTH sides read and
     agreeing; a missing side is `unverified`, never a pass). Camera bumps are measured on the fixed tags in that
     view and undone before the arm tags are judged, as for home.
   - Pass → next chunk, or `passed`. **Fail → the run stops**: status `failed`, the step and its message recorded,
     torque left on so the arm holds the pose it is at, nothing retries. Stop at any time = Pi stop + torque on.
5. **Record.** `robot_arm_verified_runs` keeps the steps, chunks, each chunk's Pi run id, every check (verdict,
   residuals, per-tag mm/°, camera at the check, warnings, time it took) and the failure. Every start / step /
   outcome is audited. A page reload resumes a running run from the server's state.

## 3. After a failed check — ideas, not built (operator: "just send out an error and stop the run")

In rough order of how little they assume (`AFTER_FAILURE_IDEAS` in `verified-poses.ts`):

1. Re-detect once after a short extra settle (the arm may still have been swaying).
2. Re-send the same goals and check again (a servo that stalled briefly often lands on the second try).
3. Back off to the previous verified pose and replay the chunk once.
4. Run the home routine, then resume from the failed step.
5. Pause with the live camera view and let the operator nudge the sliders, then continue.
6. Learn a per-pose trim from the encoder residual (like the droop trim) and retry once.

## 4. Files

| File | Role |
|---|---|
| `src/lib/robot-arm/verified-poses.ts` (+ `.test.ts`, 15 tests) | pure: tolerances (clean / override / effective), `verifyWanted`, `planChunks`, `nearPose`, `assessStep`, `describeStep`, cursor, the ideas list |
| `src/lib/server/robot-arm-verified.ts` | references (capture, check, tolerances, retire, list) and the run (start / next / stop / read), audit |
| `src/lib/server/db/models/robot-arm-pose-calibration.ts` | `robot_arm_pose_calibrations` — one `active` per pose per camera + history |
| `src/lib/server/db/models/robot-arm-verified-run.ts` | `robot_arm_verified_runs` |
| `robot-arm-move-set.ts`, `animation.ts` (`Keyframe.verify`, `.tolerances`, `cleanKeyframes`) | per-step check + override, stored with the move set |
| `robot-arm-animation.ts` | `writeAndPlay` exported with `lastPlay:false` / audit options; `requireIdle`, `torqueBackOn`, `poseSummary` exported |
| `robot-arm-vision.ts` | `readServos`, `thumbnail` exported (reused as is) |
| `robot-arm-animate-actions.ts` | `poseCalibration`, `calibratePose`, `checkPose`, `setPoseTolerances`, `retirePoseCalibration`, `verifiedStart/Next/Stop/Run` — shared by the three Animate pages |
| `src/lib/robot-arm/verified-run.svelte.ts` | browser driver of a run (start / resume / loop / stop) |
| `src/lib/robot-arm/arm-camera.ts` | the chosen camera, shared with the Vision tab (`bims.armVision.camera.v1`) |
| `PoseCameraCard.svelte`, `VerifiedRunPanel.svelte` | the reference card under the pose editor; the run as it happens |
| the three Animate pages | load references + a running run; camera choice; ◎ Play verified; per-step check/tolerances (move-set editor) |

Indexes created with `scripts/ensure-indexes.ts --apply` (2026-10-22; that run also created the five ARM-05/06
indexes that had never been applied).

## 5. Budget (Vercel 30 s per request)

Start: resolve + DB only. Play: active + servos + restore + replay start (~2 s). Verify: active + servos + torque
(maybe) + 1.2 s of settle + servos + one detection with frame (~1–2 s at 1080p) + thumbnail + DB (~5 s). The page
never waits inside a request for the arm to move.

## 6. To verify on the arm

1. Vision tab: tags registered; an arm tag visible at each pose to be verified (a tag on the wrist/claw is in view
   at more poses than one on the base).
2. Animate → a pose → Go to pose → Capture reference: the card shows the picture with the tags outlined, the encoder
   steps, and a VERIFIED POSE badge. Check now with the arm still: expect `ON THE POSE` with encoders within a few
   steps and tags well under 5 mm; set the tolerances just above what several checks show.
3. Move set with two or three referenced poses → ◎ Play verified: the panel shows each chunk moving, then "Checking
   …", then ✓ per step; PASSED at the end. `robot_arm_verified_runs` has the run with one result per verified step.
4. Nudge one pose's goals by 100 steps in the editor and save (the reference goes STALE): ◎ Play verified refuses
   with the step named. Retake the reference → runs again.
5. Put an obstacle so a joint cannot reach: the run stops FAILED at that step with "did not land: joint(s) … steps
   from the reference", torque on, the arm holding. Nothing retries.
6. Move the camera a few mm with a fixed tag in view: checks still pass (shift undone) and warn to recalibrate.

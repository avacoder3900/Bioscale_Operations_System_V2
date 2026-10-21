# ARM-03 — Camera-verified HOME calibration on the Control page

**Status:** SUPERSEDED 2026-10-19 by [ARM-04](ARM-04-marker-vision-calibration.md) (sticker-marker tracking). Built 2026-10-19 on `feat/arm-home-calibration`; its code has been removed.

## 1. Problem

A task or replay can end with the arm somewhere other than its zero/home pose: a stalled
servo, a stopped session, a bump. "Home" on the Pi is whatever the servos were taught,
and the only evidence the arm is physically there is the servos' own report. There was no
way, from BIMS, to (a) define home once in a way that is independent of the servo
teaching, or (b) send the arm back there and *prove* it arrived.

## 2. What was built

An **ARM CALIBRATION — HOME** section at the top of `/manufacturing/cart-mfg/robot-arm/control`.

1. **Calibrate home.** The operator places the arm at its zero (Jog tab, or torque off and
   by hand) and presses the button. BIMS stores the follower's encoder steps for servos 1–5
   (`GET /pose`), and the arm camera's view at that instant: a 32×24 greyscale *signature*
   plus a 240 px thumbnail (both in Mongo) and the full frame in R2 (best-effort).
2. **Return to home.** Torque on, then one bounded jog per joint
   (`POST /servos/{id}/jog`, delta = taught − current, joints already within 12 steps are
   skipped), settle 1.5 s, re-read the encoders, take a fresh frame and score it against the
   signature (Pearson correlation, brightness-invariant). The verdict combines both:
   `home`, `position_off`, `camera_mismatch`, or both. The page shows the reference and the
   current frame side by side with per-joint residuals.
3. **Check without moving.** Same verification, no motion — for "did it come back?" after a
   run.
4. **Recalibrate / Clear.** Recalibration is only needed when the camera or the arm's setup
   is moved; the record is otherwise permanent. Every capture/return/check/clear is audited.

Gates: the arm must be reachable and no session may hold the bus (BIMS holder + Pi
`active`). `manufacturing:write` for every action, as for the rest of the page.

## 3. Files

| File | Role |
|---|---|
| `src/lib/robot-arm/home-calibration.ts` (+ `.test.ts`, 11 tests) | pure: jog plan, residuals, signature, similarity, verdict text |
| `src/lib/server/robot-arm-home.ts` | Pi calls, sharp decode, persistence, audit |
| `src/lib/server/db/models/robot-arm-home-calibration.ts` | one record, `_id: 'default'`, collection `robot_arm_home_calibrations` |
| `control/+page.server.ts` | load `homeCalibration`; actions `calibrateHome`, `returnHome`, `checkHome`, `clearHome` |
| `control/+page.svelte` | the section |

## 4. Pi facts this depends on (live arm-pi OpenAPI, 2026-10-19)

- `GET /pose` returns `joint_steps` keyed by servo id `"1"…"5"` (gripper excluded).
- `POST /servos/{id}/jog` is the **only** motion primitive on the live Pi — there is no
  absolute "move to positions" route (the vendored `services/robot-arm` copy has one; the
  Pi does not run that copy). It 409s while torque is off, hence torque on first.
- `GET /cameras/{name}/snapshot.jpg` serves the worker's latest frame; a camera nobody is
  viewing may have none yet — the capture retries once after 1.5 s and tells the operator to
  open the camera panel.
- The Pi reports `DRY_RUN=false`: Return to home **moves the arm**. The button says so.

## 5. Tunables (`home-calibration.ts`)

`HOME_STEP_TOLERANCE = 12` steps (≈1°), `HOME_MATCH_THRESHOLD = 0.85`, signature 32×24.
If the camera sees mostly static scene with the arm small in frame, lower the threshold
after looking at real scores in `lastCheck`.

## 6. Not done / to verify on hardware

- Whether per-joint sequential jogs are a safe path from every start pose (they move one
  joint at a time in servo order). If a lift-first order is needed, reorder `HOME_SERVO_IDS`.
- Real similarity scores for "at home" vs "a few cm off" with the lab camera; set the
  threshold from those.
- Local `.env` holds a stale `ROBOT_ARM_API_KEY` (the Pi answers 401); production has the
  right one, so this could only be built, not driven, from here.

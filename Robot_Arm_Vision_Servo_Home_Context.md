# Robot Arm: Vision + Servo Home — Context for the next session

Written 2026-10-20 for a future Claude session. Read this, then
[Robot_Arm_Calibration_Context.md](Robot_Arm_Calibration_Context.md) (Sam's ARM-05 context) and
[docs/prds/ARM-05-apriltag-vision.md](docs/prds/ARM-05-apriltag-vision.md), before touching the Vision tab.

## 1. What the operator (Giovanni) wants

> "I mostly want to make this vision calibration work in tandem with the values that the servo outputs,
> the same way we set a home position for them in the Calibrate page. I don't want one or the other, I
> want both."

So: **one home that is defined by both the servo encoder values and the AprilTag poses**, set together,
checked together, and used together. Neither source alone should be "the" home.

**Ask before designing:** "the way we set a home position in the Calibrate page" most likely means the
**sync zero** (§3). The Calibrate tab has no feature literally called "home". Confirm which the operator
means, and whether the vision home and the sync zero should become the *same* pose.

## 2. What already exists on the Vision tab (ARM-05, master)

The Vision calibration **already stores servo values**. What's missing is that they're a second, separate
"home" from the Calibrate tab's.

- **Save calibration** (`saveCalibration`, `src/lib/server/robot-arm-vision.ts` ~L378):
  - Requires the arm to be idle.
  - Runs one detection on the server and stores every registered tag's pose.
  - Calls `readJointSteps()` (~L352), which uses `robotArm.getPose().joint_steps`: raw **follower** encoder steps, **servos 1–5 only** (no gripper).
  - Stores them as `jointSteps` (Mongo `robot_arm_tag_calibrations.jointSteps`, `Map<servoId, steps>`).
  - If the encoder read fails it only warns, and Return to home is then unavailable.
- **Logic** (`src/lib/robot-arm/home-calibration.ts`, pure, tested):
  - `HOME_SERVO_IDS = [1..5]`.
  - `HOME_STEP_TOLERANCE = 12` steps (≈1°).
  - `planJogDeltas()` and `residuals()`.
  - `assessHome()` verdicts: `home | position_off | markers_off | camera_moved | position_off_and_markers_off | unverified`. `camera_moved` wins over everything.
- **Check home** (`checkHome`, ~L591): encoder residuals plus a fresh tag check, combined into one verdict. Writes `lastCheck` and an AuditLog row.
- **Return to home** (`returnToHome`, ~L617):
  - Refuses without `jointSteps` or while a session holds the arm.
  - Then: torque on, one `POST /servos/{id}/jog` per joint toward `jointSteps`, settle `SETTLE_MS = 1500`, re-read, check.
  - **The move is driven by the encoders alone.** Tags only judge the result afterwards.
- **Agent endpoint:** `GET /api/agent/robot-arm/vision-check[?camera=]` (agent key). Read-only. Returns verdict, per-tag `offMm/offDeg/zMm/depthMm`, `cameraShift`, encoder `residuals`.
- **Calibrations keep a name snapshot of each tag on purpose** (model comment). Renames show in checks only after the next calibration.

## 3. What the Calibrate tab does (servo side) — independent of §2

`src/routes/manufacturing/cart-mfg/robot-arm/calibrate/` (`+page.server.ts`, `+page.svelte`). It's about the
**leader→follower teleop mapping**, not a "home":

- **Sync zero:**
  - What it is: a matched reference pose for leader and follower, usually both straight up with the gripper closed. Teleop and record start from it.
  - Actions: `capture` → `POST /calibrate/sync`, `clear` → `DELETE /calibrate/sync`. Load: `GET /calibrate/sync[?live=true]`.
  - Stored **only on the Pi**: `~/robot-arm/calibrations/sync_zero.json`. Shape `SyncZeroRecord` (`robot-arm-client.ts` ~L373):
    `{version, captured_at, captured_by, joint_names[6], leader_positions[6], follower_positions[6], follower_min[6], follower_max[6]}`.
  - Live example (2026-10-15):
    - follower `[2049, 866, 3007, 894, 1472, 2238]`
    - leader `[2017, 853, 3013, 966, 2136, 2040]`
- **Joint map:**
  - What it is: several captured poses fitted to a per-joint scale and offset (gearing 1/345, 1/191, 1/147).
  - Actions: `capturePose`, `deletePose`, `clearMap` → `/calibrate/map/*`.
  - Stored in `~/robot-arm/calibrations/joint_map.json` on the Pi.
  - Fit status values: `ok | no_fit | single_pose | insufficient_range | implausible_scale`.
- **Mongo** gets only AuditLog rows (`tableName: 'robot_arm_calibration'`). No model holds sync zero or the joint map.
- A **third** "zero" exists for Cartesian jog only: `~/.bims-arm/jog-calibration.json` (`joints{1..5:{zero_step, sign}}`), reloaded by the Jog tab's `/jog/reload-calibration`. Unrelated to the other two.
- **The `/calibrate/*` routes exist only in the Pi's `app.py`.** They're not in the repo's vendored `services/robot-arm/src/server/app.py`. Read the Pi's files (`~/robot-arm/src/server/calibration.py`, `app.py` ~L700–810) before changing them.

**Nothing connects §2 and §3.** No code compares or copies `jointSteps` ↔ `sync_zero.follower_positions` ↔ jog
`zero_step`. ARM-03 (`docs/prds/ARM-03-camera-verified-home.md` L8–11) says the encoder home was meant to be
"whatever the servos were taught". There are three separate encoder references today.

## 4. The gap, concretely

1. **Two homes.** The Vision home (`jointSteps`, Mongo, follower only, servos 1–5, captured on Save calibration) and the sync zero (Pi file, leader + follower, 6 joints, captured on Calibrate) are taken at different moments and can disagree.
2. **Setting.** Nothing captures both at once. The operator has to park the arm and press two different buttons on two tabs.
3. **Using.** Return to home trusts the encoders alone. If the encoders are right but a tag says the arm is off (e.g. a slipped horn, or backlash on a lightly loaded joint), nothing corrects it. The verdict is just `markers_off`.
4. **Gripper (servo 6)** is never part of the vision home.
5. **No single view** shows "encoder home vs now" next to "tag home vs now" with both tolerances.

## 5. Design directions to propose (not decided)

- **A. One capture, two records.** Save calibration on Vision also captures (or offers to capture) the sync zero, or reads the current `sync_zero.json` and stores its `follower_positions` alongside `jointSteps`. Show a mismatch warning if they differ by more than `HOME_STEP_TOLERANCE`.
- **B. One home record (preferred, but ask).** A `robot_arm_homes` doc (or extend `robot_arm_tag_calibrations`) holding:
  - encoder steps for servos 1–6 (+ the leader's, if sync zero is folded in);
  - tag poses;
  - tolerances for both.

  The Calibrate tab's sync zero and the Vision calibration both read/write it. Needs a Pi change if sync zero is to come from Mongo instead of `sync_zero.json` (or BIMS pushes it to the Pi on save).
- **C. Closed-loop return.** After the encoder-driven return, if tags disagree but the encoders say home, nudge the joints using the per-tag offsets. That needs a tag→joint sensitivity: which tags sit on which link, plus a small jog-and-observe calibration per joint. Bigger; only if the operator wants the tags to *drive*, not just verify.
- **UI:** a combined "Home" panel on Vision:
  - per joint: home steps / now / Δ, colour-coded like Calibrate's <50 / <200 / ≥200 ticks;
  - per tag: offMm / offDeg;
  - one verdict, plus "Set home (encoders + tags)" and "Return to home" buttons.

## 6. Current Pi / camera state (2026-10-20) that affects this work

- **Leader BusLinker unplugged**, and allowed to be:
  - `DualArm.connect(require_leader=False)` is used for follower jog/torque/replay/preflight.
  - Teleop/record and **sync zero capture still require the leader**: `calibration.py` opens both arms. Sync capture returns 503 "plug in its BusLinker" without it. These are uncommitted diffs in the Pi's own git (`git -C ~/robot-arm diff`).
- **Camera:** D415 at **1280×720 @ 15 fps** (USB 2.0). A USB 3 cable is due 2026-10-21 (then `fps: 30` in `hardware.yaml`). The operator is remounting it on its side; BIMS has a **view-only** ⟲/⟳ rotation (localStorage). Frames, coords and calibration stay in sensor orientation.
- **AprilTag route installed:** `apriltags.py` on the Pi with **2× upscale** (`APRILTAG_UPSCALE`) and factory intrinsics from `~/robot-arm/calibrations/realsense_color_intrinsics.json` (all resolutions; `source: "realsense"`).
  - Pose z agreed with D415 depth within 1 mm at 720p.
  - Most stuck-on tags are the **8 mm** ones (IDs 45–53). Their poses are noisy; recommend 20–40 mm tags for anything used as a reference.
- **Any existing Vision calibration was taken before the camera moved/changed resolution.** Recalibrate first.
- **Tag edit:** clicking a registered tag's cyan name in Calibrate opens the edit form (rename/size/role/group/archive).

## 7. Access, rules, gotchas

- **SSH:**
  - `ssh -i ~/.ssh/id_ed25519_armpi brevitest3@100.103.204.105` (Tailscale). The LAN IP 192.168.1.231 is not in known_hosts.
  - sudo password is in the operator's memory notes; ask if needed.
  - `sudo systemctl restart robot-arm`. Check `curl localhost:8000/sessions/active` first, so a restart doesn't cut off a running session.
- **Pi code is mostly not in this repo** (`cameras.py`, `calibration.py`, `dual_arm.py`, `manual_control.py`, `sessions.py`, the Pi's `app.py`). The repo carries `apriltags.py`, `depth.py`, `gpio.py`, `recordings_admin.py` and the installer scripts.
- **Bus is single-owner:** never run encoder reads while a session is active (`_require_bus_free` on the Pi). The BIMS loads read serially for this reason.
- **Vercel function limit 30 s:** Return to home (≤5 jogs + 1.5 s settle + one detection) fits. Adding gripper + closed-loop nudges must stay inside it, or move the loop to the Pi.
- **Deploy:** commit to a branch, push, merge to master (the operator can't open Vercel previews), and log the deploy in `progress.txt`. Never `vercel` CLI.
- **Every mutation:** `requirePermission(..., 'manufacturing:write')` + AuditLog (`robot_arm.vision.*` / `robot_arm.tag.*` / `tableName 'robot_arm_calibration'`).
- **`npm run check` baseline:** 14 errors on master as of 4d03a5c1, none in arm files.

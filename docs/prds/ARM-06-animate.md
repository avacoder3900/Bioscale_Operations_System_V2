# ARM-06 — Animate: poses by hand, move sets, sequences

**Status:** built 2026-10-21 on `feat/arm-animate`; not yet run on the arm. Needs one new Pi route
(`POST /servos/hold`, §4) before the by-hand capture flow is safe to use.

## 1. What it is

A new **Animate** tab on the Robot Arm page. The operator poses the real arm by hand and saves each
pose; poses are chained into **move sets** (After Effects-style keyframes: per pose, how long the
move into it takes, which easing, and how long to hold it); move sets are chained into **sequences**.
BIMS computes the smoothest path through the poses as a dense 30 Hz joint trajectory and the Pi
plays it as an ordinary recording.

## 2. How it works

1. **Capture.** *Pose by hand* drops torque on the follower (`POST /torque {enable:false}`); the arm
   sags, so the operator supports it. They move it into the pose, keep holding it, name it and press
   *Save pose*: BIMS reads the encoders (`GET /servos`), stores the six positions
   (`robot_arm_poses`), then asks the Pi to **hold** (`POST /servos/hold`: goal := present on every
   servo, then torque on) so the arm stays exactly where it is. *Hold* alone does the same without
   saving. *Save pose from where the arm is* captures without dropping torque (e.g. after *go to*).
2. **Poses** are reusable by id across move sets; *go to* drives the arm to one (≤300-step jogs);
   edit can re-capture a pose from the arm; archived, never deleted.
3. **Move set** (`robot_arm_move_sets`): `[{poseId, durationS, easing, holdS}]`. The editor draws the
   rendered path live (one lane per servo, pose ticks, holds shaded) from the same pure engine the
   server uses, and flags any transition faster than the arm can move.
4. **Sequence** (`robot_arm_sequences`): `[{moveSetId, joinDurationS|null, joinEasing}]`. Between move
   sets BIMS tweens from the previous set's last pose to the next set's first (the *join*), with an
   automatic length from the distance unless set. A set that starts where the last ended just
   extends the hold. The same move set may appear any number of times.
5. **Play.** The server reads where the arm is, renders the path **with a lead-in** from there to the
   first pose, writes it to the Pi as the scratch recording `animate-preview` (delete + restore), and
   starts `POST /replay/start` with preflight on (the path starts at the current position, so the
   ±50-step preflight passes by construction). The page shows elapsed/total and polls until the Pi
   reports no active session. *Stop* = `/sessions/stop` then torque on (one retry), so the arm holds.
6. **Save to Pi** writes a move set or sequence as a named recording (no lead-in; it starts at the
   first pose), replayable from the Control tab and usable in tasks.

## 3. The engine (`src/lib/robot-arm/animation.ts`, 13 tests)

- **Easings** describe the arrival at a pose: `ease` (minimum-jerk quintic — zero velocity *and*
  acceleration at both ends, the default), `in`, `out` (cubic), `linear`, and `flow`.
- **Flow** means "do not stop here": the pose gets a Catmull-Rom tangent (in time) and the segments
  either side are cubic Hermite, so a run of flow poses is one continuous sweep. A pose is a stop
  (zero tangent) if it is held, first/last, or if its own or the next pose's easing is not `flow`.
- **Speed limits:** `MAX_STEPS_PER_S = 2000` (STS3215 no-load ≈ 4000) — a transition that needs more
  is flagged in the editor and refused at play. BIMS's own durations (lead-in, joins) use 600 steps/s.
  Play checks the rendered path frame by frame, so the editor's "at least N s" (`minDurationS`) is
  computed from the easing's **peak** speed, not its average: easy ease peaks at 1.875× the average,
  cubic in/out at 3×, linear at 1× (`peakSpeedFactor`, fixed 2026-10-21 — before this the editor's
  minimum for easy ease was ~half what play would accept).
- **Output** is the Pi's recording JSONL: header (`rate_hz`, `joint_names`, `follower_neutral` =
  first frame), one `{"event":"frame","t","goal":[6]}` per frame, footer. The last frame is exactly
  the last pose. Limits: 200 keyframes, 600 s per path.

## 4. Pi: the hold route

`services/robot-arm/src/server/hold.py` exposes the driver's existing `pause()` semantics:
`POST /servos/hold` → goal := present position for every servo, then torque on → `{held, positions}`.
409 while a session owns the bus. Install: copy `hold.py` next to `app.py`, run
`python3 scripts/install_hold_router.py`, `sudo systemctl restart robot-arm`, then
`curl -X POST -H "x-api-key: $KEY" localhost:8000/servos/hold` with the arm supported — expect no movement.

**Why it is required:** `POST /torque {enable:true}` only writes Torque_Enable; each servo then drives
to its *last goal*, which after hand-posing is wherever the arm was before it went limp — a fast
jump. Until the route is installed, *Save pose* still saves the pose but **leaves torque off** and
says so; BIMS never does a bare torque-on after a by-hand capture. (hold.py reaches into app.py for
`_follower`, `_with_follower` and `state`; the installer warns if those names differ on the Pi.)

## 5. Files

| File | Role |
|---|---|
| `src/lib/robot-arm/animation.ts` (+ `.test.ts`) | pure: easings, durations, keyframe validation, path rendering, sequence flattening, recording JSONL |
| `src/lib/robot-arm/playback.svelte.ts` | browser: Play/Stop/poll state shared by the three pages |
| `src/lib/server/robot-arm-animation.ts` | poses/move sets/sequences CRUD, by-hand capture, go-to, play, stop, save to Pi, audit |
| `src/lib/server/db/models/robot-arm-{pose,move-set,sequence}.ts` | `robot_arm_poses`, `robot_arm_move_sets`, `robot_arm_sequences` |
| `src/lib/server/robot-arm-client.ts` | `holdServos` |
| `src/lib/components/robot-arm/AnimationCurves.svelte` | the path chart |
| `src/routes/manufacturing/cart-mfg/robot-arm/animate/` | the tab: library + capture; `moveset/[id]`, `sequence/[id]` editors |
| `services/robot-arm/src/server/hold.py`, `scripts/install_hold_router.py` | Pi route + installer |
| `src/lib/robot-arm/recording-cleanup.ts` `draftToAnimation`, `src/lib/server/robot-arm-cleanup.ts` `sendToAnimate` | §7: a clean-up's steps as poses + a move set |

Permissions: `manufacturing:read` to view, `manufacturing:write` for everything else. Every mutation
and every play/stop writes an AuditLog row (`robot_arm.animate.*`).

## 6. Not done / to verify on hardware

- Install the hold route; confirm no movement on hold after a by-hand pose.
- Whether the STS3215 holds a hand-posed position well enough at torque-on under load (a sagging
  joint may settle a few steps); the saved pose is the encoder reading at *Save*, not after the hold.
- Real speed ceiling: watch the fastest-servo figure in the editor against what the arm actually
  does; lower `MAX_STEPS_PER_S` if a path stalls (`move-log` on the Pi).
- The scratch `animate-preview` recording is overwritten on every Play; it shows in the Control tab's
  recording list — harmless, but it could be filtered there.
- Gripper (servo 6) is animated like any joint; a closed-on-cartridge pose will squeeze at full torque.

## 7. From the Clean-up tab (`feat/cleanup-to-animate`, 2026-10-21)

The Clean-up tab's own *Save to Pi* plays each step as a straight line and stops dead. **Send to
Animate** on a clean-up hands the same steps to this engine instead, so a recording ends up as a
smooth, adjustable move set:

- `draftToAnimation(draft, {easing})` (pure, `recording-cleanup.ts`, 6 tests): pose 0 is the draft's
  start pose; every step that moves something becomes one pose at its end position for **all six**
  servos (`resolveSteps`, so a servo not in the step holds). Keyframe `durationS` = the step's time,
  raised to `minDurationS` (the 2000 steps/s ceiling) when the recording was faster than the arm can
  go — those steps are reported as *lengthened*; `holdS` = the step's pause. A step whose moves add up
  to nothing becomes hold time on the previous pose (*folded*). Easing is one choice for the whole set
  (default easy ease), changed per pose afterwards in the editor. Limits: 200 keyframes, 60 s per move.
- `sendToAnimate` (server) saves what is on screen first, then inserts the poses (`"<name> · start"`,
  `"<name> · step N <label>"`, suffixed `(2)`… if a live pose already has that name), creates the move
  set with the clean-up's `rateHz` and a note saying where it came from, records the link on the
  clean-up (`moveSets[]`), and audits all three (`robot_arm.animate.pose_save_from_cleanup`,
  `robot_arm.animate.move_set_create`, `robot_arm.cleanup.send_to_animate`). The clean-up draft and
  the source recording are not changed. The page then opens the new move set's editor.
- Nothing here touches the arm; play / save to Pi happen in the Animate tab as for any move set.

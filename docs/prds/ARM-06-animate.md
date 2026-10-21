# ARM-06 — Animate: poses by hand, move sets, sequences

**Status:** built 2026-10-21 on `feat/arm-animate`; not yet run on the arm. The by-hand capture flow needs
one new Pi route (`POST /servos/hold`, §4); posing **with the control arm** (§8, 2026-10-21) needs no new
route and is the recommended way to capture poses.

## 1. What it is

A new **Animate** tab on the Robot Arm page. The operator poses the real arm by hand and saves each
pose; poses are chained into **move sets** (After Effects-style keyframes: per pose, how long the
move into it takes, which easing, and how long to hold it); move sets are chained into **sequences**.
BIMS computes the smoothest path through the poses as a dense 30 Hz joint trajectory and the Pi
plays it as an ordinary recording.

## 2. How it works

1. **Capture.** Two ways. *Pose with the control arm* (§8, preferred): the follower tracks the leader
   under torque, so it is always powered and where the operator put it. *Pose by hand* drops torque on
   the follower (`POST /torque {enable:false}`); the arm sags, so the operator supports it. They move it
   into the pose, keep holding it, name it and press *Save pose*: BIMS reads the encoders
   (`GET /servos`), stores the six positions (`robot_arm_poses`), then asks the Pi to **hold**
   (`POST /servos/hold`: goal := present on every servo, then torque on) so the arm stays exactly where
   it is. *Hold* alone does the same without saving. *Save pose from where the arm is* captures
   without dropping torque (e.g. after *go to*).
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

## 8. Posing with the control arm (`feat/animate-pose-with-leader`, 2026-10-21)

**Problem.** Poses captured by hand were landing in the wrong place: with torque off the follower sags
under its own weight, so the encoders read the sagged position rather than the one the operator meant,
and torque-on afterwards jumps the arm unless the hold route is installed. The servos are never
"active" while the pose is being set.

**Fix.** Pose the follower through the control (leader) arm using the Pi's existing **teleop** session:
on start it snaps the follower's goal to its present position, turns torque ON and then drives it to
the leader's position at 30 Hz, with the leader limp. The follower is therefore powered the whole time
and sits exactly where the operator put the leader; there is no sag and no jump. No new Pi route.

Flow (`src/lib/server/robot-arm-animation.ts`, `animate/+page.server.ts`, capture panel):

1. *Pose with the control arm* → `startLeaderPosing`: refuses while any session owns the arm, then
   `POST /teleop/start {rate_hz: 30, manufacturing_step: "animate-pose"}`. The run shows in the Runs
   tab tagged `animate-pose`; the arm-holder bar shows the operator. The panel turns green.
2. *Save pose* → `savePoseFromLeader`. The Pi's driver is not thread-safe and the teleop thread owns
   the serial bus (the plain `GET /servos` route has **no** bus guard, so reading mid-session would
   corrupt packets). So: name is checked first, then `POST /sessions/stop` (the follower keeps torque
   and its last goal — it holds), 400 ms settle, `GET /servos`, save `robot_arm_poses`
   (audit `robot_arm.animate.pose_save` with `source: "leader"`), then a fresh `POST /teleop/start` so
   the operator carries straight on. If the restart fails the pose is still saved and the follower is
   still holding; the warning says so. Any teleop session counts as "following", whoever started it.
3. *Done* → `stopLeaderPosing`: `POST /sessions/stop`; the follower holds under torque, the leader
   stays limp (same end state as the Control tab's teleop). Go-to / Play / by-hand are disabled while
   following; the page's own servo read is skipped while any session runs, for the same bus reason.

Audit: `robot_arm.animate.leader_posing_start` / `leader_posing_stop` (one row per teleop run, so a
posing session with N saves produces N+1 runs; each is a few seconds to minutes and ends `cancelled`,
which is how the Pi reports a stopped teleop). Posing by hand is kept as the fallback for when the
control arm is not connected (the Pi answers 503 "leader arm not connected", shown as such).

To verify on hardware: the follower moves to the leader on start (confirm the dialog warns about this);
a saved pose matches the follower's position with the leader held still; the follower does not twitch
across the stop → read → restart in *Save pose*; Runs shows the `animate-pose` runs closing.

## 9. Timeline editing and the low claw (`feat/animate-timeline-joints`, 2026-10-21)

**Joints on the timeline.** In the move-set editor every pose has a dot on every servo lane. Drag a
dot up/down (Shift = fine; or focus it and use ↑/↓, Shift = 10 steps) to move that joint at that
pose; drag the ◆ above a pose sideways to change when the arm arrives (the keyframe's `durationS`),
and the ▮ to change its hold. The axis scales hold still while dragging. A selected keyframe also
shows a joint table (pose / here / Δ / droop trim / goal sent) with exact number entry and *reset
joints to the pose*. Joint edits are stored per keyframe as `offsets[6]` (steps added to the pose,
≤ ±1000, omitted when all zero), so they change this move set only — the shared pose is untouched.
`keyframePositions(pose, offsets, trim)` (pure) is the one place a keyframe becomes positions; the
editors use pose + offsets, `resolveKeyframes` (everything sent to the Pi) adds the trim.

**Why the claw ended up lower than the pose.** The Pi plays a path open-loop: each frame's goal is
written and nothing else (`_replay_loop`). The STS3215's position loop is proportional, so a joint
carrying the arm against gravity settles a few to a few tens of steps *short of its goal*
(verified_move.py already allows 20 steps for this). Poses are captured with the arm held in place
(torque off — the hold route is still not installed; every capture on 2026-10-21 logged
`hold_failed`), i.e. at the real joint angles, so playing goal = pose leaves shoulder/elbow/wrist
short on the gravity side and the claw low. *Go to pose* hides it because its jogs are relative to
the present position, which bakes the shortfall in by accident.

**Fix: measured droop trim per pose.** *Go to pose* then *Measure droop* (move-set editor, selected
keyframe): with torque on and the arm within 150 steps of the pose on servos 1–5, BIMS sets each
goal to pose + trim exactly (a jog of goal − present), waits 1.2 s, reads where it settled, adds the
shortfall to the trim (`nextTrim`, pure), and repeats (≤ 4 rounds) until every servo is within 2
steps. The gripper is never trimmed (its shortfall on a part is the grip). Trim is capped at ±50
steps (`MAX_TRIM_STEPS`): more is a stalled/blocked joint, and it keeps a saved recording's first
frame inside Control's ±50-step preflight. Stored on the pose (`trim`, `trimMeasuredAt/By`),
cleared when the pose is re-captured from the arm, audited (`pose_droop_measure` with every round's
goal/settled, `pose_droop_clear`). Play and Save to Pi add it to the goal; the arm ends holding the
pose correctly after a measurement. Recordings already saved to the Pi do not change — save again.

Not verified on the arm. Unmeasured poses play exactly as before. If droop varies a lot with the
path into a pose (backlash: arriving from above vs below), measure after a *Go to* from the same
side the move set arrives from.

**With §8 (control-arm posing) the trim matters as much.** Teleop drives the follower goal to the
leader, so the follower already sits one droop short when *Save pose* reads its encoders; the pose is
where the operator saw the claw. Played back with goal = pose it would land a second droop lower. The
measured trim makes goal = pose + droop, so the claw lands where it was when the pose was saved —
whichever way the pose was captured.

## 10. Droop correction is automatic (`feat/animate-auto-droop`, 2026-10-21)

Replaces §9's *Measure droop* button: nobody has to approve or start the correction. The same settle
pass (`settleAtPose`: goal := target + trim on servos 1–5 via jogs, wait 1.2 s, add the shortfall,
≤ 4 rounds, ±50 cap) now runs by itself whenever the arm is known to be sitting at a pose:

- **End of every Go to pose.** It replaces go-to's old blind correction pass, so the arm ends *on*
  the pose (corrected for gravity) and the pose's trim is learned. Falls back to the plain pass if a
  joint is still > 150 steps away (stalled); the gripper gets its own final jog.
- **End of every Play that finishes on its own** (not after Stop). `writeAndPlay` stores
  `lastPlay.end = {poseId, target}` (last keyframe, pose + offsets, no trim) and `settledAt: null`;
  when the page's playback poll sees the session end it calls `?/settle` (all three Animate pages),
  and `settleAfterPlay` claims the play once (`settledAt`), checks the arm is idle and near the
  target, settles it there and learns that pose's trim. The result shows under the playback line.
- **Poses never visited** play with an *estimated* trim: `estimateTrim` (pure, 4 tests) weights
  every learned pose within 400 steps on the gravity servos 2–4 by inverse distance (falling to zero
  at the radius); nothing near → untrimmed. The editor shows learned vs estimated. The settle pass
  starts from the learned or estimated trim, so a known pose settles in one round.

Each learned trim is re-checked every time the arm stops at that pose, so it tracks load or wear.
Audit: `robot_arm.animate.pose_droop_settle` (reason `go_to` / `play_end`, `startedFrom`, every
round's goal/settled) and `pose_droop_skip`. *Forget correction* (clearPoseDroop) stays.

Limits: mid-play poses are only corrected by the trim learned earlier (the Pi owns the bus during a
replay, so BIMS cannot read or nudge mid-path); recordings replayed from the Control tab are not
settled afterwards; recordings saved to the Pi keep the trims they were saved with. Not run on the arm.

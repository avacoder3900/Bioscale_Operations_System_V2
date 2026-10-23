# ARM-06 — Animate: poses by hand, move sets, sequences

> **2026-10-22 redo — read §13 first.** Poses are now made with live sliders and stored as goals; Go to pose is a one-pose play; posing by hand (§2.1, §4) and the Jog panel (§12) are gone; torque is put back on after every session; servo temperatures gate every motion.

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
written and nothing else (`replay_session` in the Pi's `src/hardware/dual_arm.py`). The STS3215's position loop is proportional, so a joint
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

## 11. Closed-loop replay on the Pi (`feat/animate-replay-settle`, 2026-10-22)

**Why §9/§10 are not enough.** Investigation (2026-10-22): teleop and replay send the *same* servo
commands — both snap goal to present, torque on, then write goals open-loop; neither corrects sag.
Teleop only *looks* sag-free because the operator closes the loop by eye (lifting the leader until
the follower's claw is right) and *record* saves the leader (the command), so replay reproduces the
sag that was already baked in. Animate saves the follower's encoder reading (the result), so replay
lands one droop short. The learned trim (§10) fixes poses the arm has stopped at, but mid-sequence
poses only get an estimate, and BIMS cannot read or nudge the arm mid-path: the Pi owns the serial bus
for the whole replay.

**Fix: the replay loop itself settles.** `services/robot-arm/src/hardware/replay_settle.py` +
`scripts/install_replay_settle.py`. Re-ported 2026-10-22 against the live Pi (the first draft assumed
a session class with `_replay_loop`; the Pi has none): replay is the module-level
`replay_session(arms, source_path, loops, stop_event)` in `src/hardware/dual_arm.py`, run by
`src/server/sessions.py` in a worker thread with the run id on the logging context, over a
`FeetechBus` with per-servo `read(sid, "Present_Position")` / `write(sid, "Goal_Position", v)`.
`replay_session_settling` is a drop-in with the same signature and behaviour (header check,
`replay.start/loop/stop` events, torque off→on, ramp to `follower_neutral`, torque off at the end);
`install()` rebinds the name inside `src.server.sessions`, and the installer adds the two lines to
app.py after refusing on any layout mismatch. Simulated against a sagging fake bus
(`scripts/simulate_replay_settle.py`: plain recordings produce the original's exact writes; flagged
poses converge; stop mid-replay; blocked joint caps the offset; install is idempotent). The loop:

- plays frames exactly as before (goal arrays or the old `positions{}`; header/footer skipped), one
  write per frame at its time;
- at a frame flagged `"settle": true` it writes the goal, waits 0.25 s, reads the follower, adds the
  shortfall (servos 1–5, never the gripper) to a per-servo **offset** (±50 cap), writes goal + offset,
  and repeats until every servo is within 2 steps or the hold window runs out (window = until the
  next frame whose goal differs, −0.12 s, so the next move leaves on time; the last frame gets 2.5 s;
  ≤ 8 rounds);
- carries the offset into the following frames (gravity feed-forward for the move) until the next
  settle point re-learns it;
- logs one `replay.settle` run event at the end (through `arms.logger.log_event`, so the Pi's
  `_forward_to_bims` handler posts it like every session event): per settle point `frame, t, pose,
  target, goal, written, present, residual, rounds, ok, loop`, plus the carried offset. The webhook
  appends it to the `robot_arm_runs` row with the record as `payload`.

Recordings without flags play exactly as before (no reads). Control-tab replays of Animate recordings
saved after this change are settled too, since the flags are in the file.

**BIMS side.** `settleFrames(path)` (pure, 4 tests) flags the arrival frame of every held pose and
the last frame (a stop that is not held has no window); `composeAnimationJsonl` writes `settle`,
`pose` (id) and `target` (pose + offsets, no trim — so the Pi reports droop against the real pose) on
those frames. Markers now carry `poseId`/`target`. `settleAfterPlay` first looks for the run's
`replay.settle` event (waits ≤ 3 s for the webhook), learns each pose's trim from `written − target`
(`trimFromSettle`, audited `pose_droop_from_replay`) and moves nothing; only without the event does
it fall back to §10's own settle. The playback line reports per pose "on target (n rounds)" or
"still k steps off when the hold ran out — give it a longer hold".

**On the Pi:** copy `replay_settle.py` to `src/hardware/`, run `python3 scripts/install_replay_settle.py`
(`--check` first; it refuses on a layout mismatch), then with `/sessions/active` null
`sudo systemctl restart robot-arm` (backup `app.py.bak-replay-settle`). Test: give a pose a 1 s hold,
Play, watch the claw land and stay; the run in Mongo gains a `replay.settle` event.

Installed on arm-pi 2026-10-22 (see progress.txt); not yet played on the arm. Open: `SETTLE_WAIT_S` 0.25 s assumes the servo stops within that; a slow joint
may need 0.4 s. A hold shorter than ~0.5 s gives one round at most.

## 12. Jog: adjust a pose on the real arm, live (`feat/animate-pose-jog`, 2026-10-22)

**Problem.** Fixing a pose that was a little off meant changing numbers (timeline dots, the joint
table) and then playing the move set — a render, a scratch recording on the Pi, a replay — to see
whether the claw now landed right. There was no way to nudge the arm and watch.

**Fix.** A **Jog** panel on the Animate tab. Every pose row has *jog*; the capture bar has *Jog the
arm* (no target pose). The panel shows one row per servo — the pose's value, *Arm now* from the
encoders, the difference, and −/+ buttons for the chosen step (1/5/10/25/50/100 or typed, ≤ 1000) —
and the flow is *Go to pose* → nudge joints, watching the arm and the camera → *Save into pose*
(or *Save as new pose*). The move-set editor's selected keyframe links to it (*jog the pose live*,
`/animate?jog=<poseId>`).

How it moves (`jogArm` in `src/lib/server/robot-arm-animation.ts`; route
`src/routes/api/robot-arm/animate/jog/+server.ts`, session-authenticated, `manufacturing:write`):
each press POSTs `{sid, delta}`; the server refuses while any session owns the arm (409) and sends
the delta to the Pi's existing `POST /servos/{sid}/jog` in ≤ 300-step pieces (`jogChunks`, pure,
tested); the Pi itself refuses with 409 when that servo's torque is off, shown as "press Hold first".
After a 250 ms settle the server reads `GET /servos` and returns all six positions, so the row shows
where the arm really is — not the goal. Presses on one servo queue and add up into one request
(the row moves at once; the encoder read corrects it). `GET` on the same route gives the live read
for the panel's 2 s poll (off while a session runs — the plain servo read has no bus guard — and the
poll is a checkbox). Every jog is audited (`robot_arm.animate.jog`, with the positions read back).
**No new Pi route.**

*Save into pose* (`?/savePoseFromJog` → `recapturePose`) overwrites the pose's positions with the
encoders, keeps name and notes, **clears the droop trim** (measured at the old position; §9) and
audits `pose_recapture` with before/after. Every move set that uses the pose follows, as with any
pose edit; timeline offsets in a move set stay relative to the new pose. *Save as new pose* is the
ordinary `?/savePose` without the hold. Nothing in the move-set editor itself changed.

Not verified on the arm. To check: jog ±10 on the wrist and confirm the arm moves at once and the
row's *Arm now* tracks it; rapid clicks land as their sum; a jog with torque off is refused with the
Hold hint; *Save into pose* updates the pose row and the editor table; the Runs tab shows nothing
(jogs are not sessions).

## 13. Redo: live sliders, absolute moves, torque kept on (`feat/animate-redo`, 2026-10-22)

**What the operator asked for.** (1) Clean up the UI so file names are not everywhere; (2) posing with
the control arm must not turn torque off when a pose is taken; (3) temperature checks on the servos;
(5) instead of the editable line graphs, a clear slider per servo with an axis, and the arm follows the
slider live while a pose is edited, so posing is just jogging; and the question: *when pulling up a
pose the arm often does not end up in the right spot — is it because it does not take into account the
poses before it?*

**Root causes found (production audit rows + code).**

- *Torque off on a control-arm save.* Every pose saved with the control arm before this change logged
  `torqueOnAtCapture: false` (7 of 7 on 2026-10-21/22). The live Pi writes follower torque OFF when a
  teleop session stops, so `savePoseFromLeader`'s stop → 400 ms "settle" → read was really stop →
  400 ms of sagging → read the sagged arm. The live replay loop does the same at the end of every play
  (`replay_settle.py`'s `finally`, mirrored from `dual_arm.replay_session`), so the arm went limp at the
  end of every Play too. The hold route (§4) was never installed (38 `hold_failed` rows).
- *Go to pose landing off.* Go to was a chain of RELATIVE jogs — the Pi's jog sets
  `goal = present + delta` — fired back to back while the arm was still moving. Each jog was measured
  from wherever the arm happened to be at that instant (mid-move, or sagged), so where it stopped
  depended on where it started and how it got there. That is the history dependence the operator saw.
  The answer to the question: poses are absolute positions and should stay that way (relative,
  cumulative moves would add up their errors); what was wrong was that the arm was *sent* there
  relatively.
- *Poses stored readings, not commands.* A pose was the encoder reading; played as a goal the arm sat a
  droop short of it. §9–§11 grew up to compensate.

**Fixes.**

- **Absolute everywhere.** Go to pose is now a one-pose play: the same rendered path (lead-in from the
  arm at 600 steps/s, then a 1 s hold) the Pi replays for a move set, so every servo gets absolute goals
  and the arm ends in the same place whatever it did before. The live sliders use the Pi's existing
  `POST /servos/{id}/move` (absolute goal; `robotArm.moveJoint`), falling back to a jog of
  `goal − present` from a read taken at rest if an older Pi answers 404. No Goal_Speed is ever written
  (the register persists and would slow later replays).
- **Goal poses.** A pose made or saved with the sliders stores the goals the arm was given
  (`pose.basis = 'goal'`). Played back it gets the same goals, so it lands where the operator saw it
  (same goal, same sag) — no droop trim and no Pi settling (`ResolvedKeyframe.settle = false`;
  `settleFrames` skips it). Older poses and control-arm captures are `reading` (the default) and keep
  the §9–§11 trim/settle machinery. Saving a reading pose from the sliders turns it into a goal pose and
  clears its trim.
- **Torque never left off.** After a teleop stop (save or Done) BIMS turns torque straight back on
  (`stopTeleopHolding`): the last goal is still the leader's position, so the follower lifts back onto it
  and the 500 ms settle reads it under torque. After every play / go-to, `afterPlay` (was
  `settleAfterPlay`) turns torque back on first if the replay dropped it. On the Pi,
  `replay_settle.py` now keeps torque ON at the end when the recording header says `hold_at_end: true`
  (every Animate recording does) — finished or stopped; simulated (`simulate_replay_settle.py` §6).
  **Needs copying onto arm-pi** (same install as §11: copy `replay_settle.py` to `src/hardware/`,
  restart with no session active); until then BIMS's torque-on after play covers it with a brief dip.
  *Torque on* (status bar, only when torque is off) uses the hold route if present, else a plain
  torque-on (servos return to their last goal — confirmed in a dialog). Posing by hand (torque off) is
  removed: the sliders replace it and it was the one flow where a plain torque-on could jump.
- **Temperatures.** `readArm` now returns each servo's temperature (already in `GET /servos`). Levels
  (`heatLevel`): warm ≥ 48 °C, hot ≥ 55 °C (the Pi's own arm-health thresholds), stop ≥ 65 °C (the
  STS3215 cuts its own torque near 70). Every motion — play, go-to, follow the control arm, each live
  slider move — reads the arm first and is refused at ≥ 65 °C (`requireCool`); hot servos come back as
  warnings. The status bar shows the hottest servo; the editor shows each servo's temperature, live.
- **The pose editor** (`PoseEditor.svelte`, replaces `PoseJog.svelte` and the move-set editor's
  editable curves): one row per servo — name, temperature, a slider with an axis of round step values
  under it, ▼ the saved value and ● where the arm is, −10/−1/+1/+10, the number, the angle from centre.
  The slider range is the travel the saved poses and the arm actually use, padded ±400 (min 1200 wide)
  — `sliderRange`. *Live* needs the arm within 80 steps of the sliders (Go to pose first, or *start
  from the arm*, which also writes the arm's position as its goal so the two agree). Then every slider
  change is sent, one request at a time, as the servo's absolute goal — the whole distance. (Until
  2026-10-23 it went in ≤ 120-step pieces and the server refused any goal > 600 steps from the arm; the
  operator removed both: "if I want to move the joint to a specific value, it should move to that
  specific value". The only bounds left are 0..4095 and the servo's EEPROM angle limits on the Pi.) The arm
  read is polled every 1.5 s only while nothing is being sent, and a move waits for a read in flight —
  the Pi's `GET /servos` has no bus lock. *Save pose* / *Save as new* save the slider values (goals).
  Per-move requests are not audited; the save that ends an edit is (`pose_edit` with before/after).
- **UI.** The Animate tab is one screen: status (torque, hottest servo), the control-arm strip ("Follow
  the control arm" for rough posing), the editor, and the pose library beside it — names shown through
  `friendlyName` (no `.jsonl`, no recording timestamps; stored names unchanged), poses made together
  ("<group> · <label>", e.g. a clean-up sent here) folded under their group, no raw numbers or notes
  inline (notes are the tooltip), rename/archive behind ⋯. Move sets and sequences are compact lists with
  ▶. The move-set editor is the keyframe list (timing/easing/hold for the selected step) beside the pose
  editor for that step; "Save as new" there swaps the step to the new pose. Old timeline offsets still
  play and can be dropped per step; Save to Pi and archive moved under "More". The sequence page keeps
  its read-only path chart, with friendly names.

**Files.** `src/lib/robot-arm/animation.ts` (+ tests: settle flag, heat, names, sliders),
`src/lib/server/robot-arm-animation.ts` (liveMove, createPose / setPosePositions, goToPose as a play,
stopTeleopHolding, afterPlay, requireCool), `src/lib/server/robot-arm-animate-actions.ts` (actions shared
by the library and move-set pages), `src/routes/api/robot-arm/animate/live/+server.ts` (was `jog`),
`src/lib/components/robot-arm/PoseEditor.svelte`, the three Animate pages, `playback.svelte.ts`,
`robot-arm-pose.ts` (`basis`, `lastPlay`), `robot-arm-client.ts` (`moveJoint`),
`services/robot-arm/src/hardware/replay_settle.py` + simulator.

**To verify on the arm.** (1) Follow the control arm, save a pose: the audit row shows
`torqueOnAtCapture: true` and the arm does not visibly drop. (2) Open a pose, Go to pose twice from two
different starting positions: the arm ends at the same place both times. (3) Live: drag the shoulder
slider; the arm follows within a fraction of a second; ● tracks it. If the Pi answers 404 on `/move`
the note says so (jog fallback). (4) Temperatures show per servo; a play is refused when one reads
≥ 65 °C. (5) After copying `replay_settle.py`: a play ends with torque on and `replay.stop` says
`held: true`.

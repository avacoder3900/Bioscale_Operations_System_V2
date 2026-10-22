# Robot Arm Animate — Droop (the low claw): Context

Condensed working context for the "claw ends up lower than the pose" problem in the Animate tab, the
three layers of fix that exist for it, and the one that still has to be installed and tested on the
Pi. Read this before touching droop/trim code in BIMS or the replay loop on the Pi. Full spec:
[docs/prds/ARM-06-animate.md](docs/prds/ARM-06-animate.md) §9–§11 (numbering caveat in §7 below).
Sibling docs: [Robot_Arm_Calibration_Context.md](Robot_Arm_Calibration_Context.md),
[Robot_Arm_Vision_Servo_Home_Context.md](Robot_Arm_Vision_Servo_Home_Context.md).

_Written 2026-10-22 from the 2026-10-21/22 session. Nothing in §3–§5 has been run on the arm yet._

## 1. Where things stand

| PR | Branch | State | What |
|---|---|---|---|
| #122 | `feat/animate-timeline-joints` | **merged** 2026-10-21 | Drag joints on the timeline (per-keyframe `offsets[6]`); per-pose droop trim with a manual *Measure droop* button |
| #123 | `feat/animate-auto-droop` | open | Droop correction runs by itself (end of Go to pose, end of every Play); unvisited poses get an estimate; *Measure droop* button removed |
| #124 | `feat/animate-replay-settle` | open, **stacked on #123** | Closed-loop replay on the Pi: the replay loop settles the arm ON each held pose; BIMS learns trims from its report |
| #125 | `feat/animate-pose-jog` | merged 2026-10-22 (another session) | Live pose jog panel. Appended PRD §10 — collides with #123's §10 (see §7) |

User merges PRs themselves. The user's decision on 2026-10-22 was **option C** (close the loop on
the Pi), so #124 is the path forward; #123 remains the fallback when the Pi route is not installed.

**Blocked on:** reaching the Pi over SSH to confirm five attribute names and install the route (§5).

## 2. The problem, exactly (what was found)

- The Pi plays a recording **open-loop**: each frame's goal is written and nothing else
  (`_replay_loop`, vendored copy `services/robot-arm/src/arm/leader_follower.py`; the live Pi's is in
  `dual_arm.py`, not in this repo). A loaded STS3215 has a proportional position loop and settles a
  few to a few tens of steps **short of its goal** under gravity (`verified_move.py` already allows
  `ARRIVAL_TOLERANCE = 20`).
- Animate poses store **the follower's encoder reading** — where the joints really were — captured
  by hand (torque off) or from the follower under teleop (#121). Playing goal = that reading lands
  every loaded joint one droop short, on the gravity side: the claw ends low.
- **Teleop has no anti-sag command.** The teleop loop and the replay loop send the same writes
  (snap goal := present, torque on, then goals). Teleop *looks* sag-free because the operator closes
  the loop by eye (lifts the leader until the follower's claw is right) and *record* saves the
  **leader** (the command), so the sag is baked into the recording. Animate saves the result instead.
- *Go to pose* hid the problem: its jogs are relative to the present position, so each jog of
  `target − present` compensates the shortfall by accident.
- Evidence: all 2026-10-21 captures audited `robot_arm.animate.hold_failed` (hold route not
  installed → hand-held poses); audit `robot_arm_move_sets` / `robot_arm_poses` for the day.

## 3. The three layers of fix (what exists in code)

All three keep the same model: a pose has `trim[6]` = steps added to the goal on servos 1–5 (never
the gripper, cap ±50 `MAX_TRIM_STEPS`) so the arm *arrives* at `positions`. One function turns a
keyframe into what is sent: `keyframePositions(pose, offsets, trim)` in `src/lib/robot-arm/animation.ts`.
Editors draw pose + offsets; `resolveKeyframes` (everything sent to the Pi) adds the trim and keeps
the untrimmed `target` on the `ResolvedKeyframe`.

1. **Measured per pose (#122, merged).** `nextTrim(pose, present, trim)` (pure) adds the shortfall;
   the server routine jogs goal := pose + trim, waits 1.2 s, reads, repeats ≤ 4 rounds until within 2
   steps. Stored on `robot_arm_poses.trim`, `trimMeasuredAt/By`; cleared when a pose is re-captured.
2. **Automatic (#123).** The same routine is `settleAtPose(user, pose, target, now, reason)` and runs
   (a) at the end of every `goToPose` (replaces its blind second pass; gripper gets its own final jog)
   and (b) after a Play finishes on its own: `writeAndPlay` stores `lastPlay.end = {poseId, target}` +
   `settledAt: null`; `Playback` (browser, `playback.svelte.ts`) calls `?/settle` when the Pi reports
   no active session; `settleAfterPlay` claims the run once and settles. Unvisited poses play with
   `estimateTrim(positions, samples)` (inverse-distance over learned poses within 400 steps on servos
   2–4). Audit `pose_droop_settle` (reason `go_to`/`play_end`, every round), `pose_droop_skip`.
3. **Closed loop on the Pi (#124).** `services/robot-arm/src/arm/replay_settle.py` is a drop-in
   `_replay_loop`: plays frames as before, but at frames flagged `"settle": true` it writes the goal,
   waits `SETTLE_WAIT_S` 0.25 s, reads, adds the shortfall to a per-servo offset (±50), rewrites,
   repeats until within 2 steps or the hold window ends (next differing frame − 0.12 s; last frame
   2.5 s; ≤ 8 rounds), carries the offset into the following frames, and emits one `replay.settle`
   session event (`settle: [{frame, t, pose, target, goal, written, present, residual, rounds, ok}]`,
   `carry`). BIMS: `settleFrames(path)` flags the arrival at every **held** pose and the last frame;
   `composeAnimationJsonl` writes `settle`, `pose`, `target` on those frames; `settleAfterPlay` first
   looks for the run's `replay.settle` event (waits ≤ 3 s for the webhook), learns each pose's trim
   as `trimFromSettle(written, target)` (audit `pose_droop_from_replay`) and moves nothing; only
   without the event does it fall back to layer 2. Recordings without flags play exactly as before.

Why layer 3 is needed: BIMS cannot read or nudge the arm mid-path — the Pi owns the serial bus for
the whole replay — so layers 1–2 only correct poses the arm has *stopped* at, and the end of a play.

## 4. Tests and checks (how to verify without the arm)

- Unit: `node node_modules/vitest/vitest.mjs run src/lib/robot-arm/` → 99 tests on #124 (`animation.test.ts`
  covers offsets, `nextTrim` convergence with a simulated sagging servo, `estimateTrim`, `settleFrames`,
  `trimFromSettle`). `src/lib/server/` → 369 (`sonic` leave-one-out is flaky; passes alone).
- Types: `node node_modules/@sveltejs/kit/svelte-kit.js sync && node node_modules/svelte-check/bin/svelte-check --threshold error --output machine`
  → baseline **14 errors**, none in robot-arm files. Portable Node lives in
  `%LOCALAPPDATA%\Temp\n22\node-v22.12.0-win-arm64`; there is no `npm` and no Python on the dev PC.
- The Pi module has **never been executed** (no Python here). Read it twice before installing.

## 5. The Pi: what to do next, in order

Facts: hostname `arm-pi`, LAN IP **172.16.202.203** (per the user, 2026-10-22), user `brevitest3`
(password: ask the user; it is not stored in the repo), Funnel `https://arm-pi.tailf65a70.ts.net`
(`/health` → `{"status":"ok","service":"robot-arm","version":"0.1.0"}` — note the live service string
differs from the vendored `app.py`'s `bims-robot-arm`: the Pi's code has diverged from the repo).
Service: `systemctl … robot-arm`; code assumed under `~/robot-arm/src/{arm,server}`.

Reachability: the dev PC on the `linbeck.com` WiFi (`172.16.202.97/23`) **cannot** reach the Pi or the
OT-2s (`.117/.123/.124`) — different VLAN or client isolation. Use the lab Mac, or join the tailnet
(`tailf65a70.ts.net`) and use the Tailscale IP. A password-capable client without `sshpass`/`plink`:
`ssh2` for Node (download the tgz of `ssh2`, `asn1`, `safer-buffer`, `bcrypt-pbkdf`, `tweetnacl` from
the npm registry and untar into a `node_modules`; `npm` is absent on the dev PC).

1. **Read first, change nothing:**
   ```
   ls ~/robot-arm/src/arm ~/robot-arm/src/server; systemctl cat robot-arm | grep -E "ExecStart|WorkingDirectory"
   grep -n "^class \|def _replay_loop\|def _emit\|self\.follower\b\|self\.source\b\|self\.loops\b\|self\._cancel\b" ~/robot-arm/src/arm/dual_arm.py
   grep -n "^from arm\|^import arm\|include_router\|install(" ~/robot-arm/src/server/app.py
   grep -n "def sync_read_positions\|def sync_write_positions" ~/robot-arm/src/arm/driver.py
   ```
   `replay_settle._replay_loop_settling` relies on `self.follower`, `self.source`, `self.loops`,
   `self._cancel` (threading.Event) and `self._emit(suffix, extra)`, and on the driver's
   `sync_read_positions()` / `sync_write_positions(dict)`. If any name differs, edit the five
   references at the top of that function and push the fix to #124 before installing.
2. **Install:** copy `replay_settle.py` into `src/arm/`; `python3 scripts/install_replay_settle.py --check`,
   then without `--check` (it finds the session class by `def _replay_loop`, warns on missing names,
   inserts `from arm import replay_settle as _replay_settle` + `_replay_settle.install(<Class>)` into
   `app.py`, keeps `app.py.bak-replay-settle`); `sudo systemctl restart robot-arm`; confirm `/health`.
3. **Also still pending from 2026-10-21:** the hold route (`src/server/hold.py`,
   `scripts/install_hold_router.py`, PRD §4). Without it, by-hand capture leaves torque off.
4. **Test on the arm (user present, path clear):** in a move set give one pose a **1 s hold** (a stop
   with no hold gives the Pi no window), Play, watch the claw land and stay. Check: the run in
   `robot_arm_runs` gained a `replay.settle` event; the playback line under Play says per pose "on
   target (n rounds)" or "still k steps off when the hold ran out"; `robot_arm_poses.trim` updated;
   audit `pose_droop_from_replay`. If residuals oscillate, raise `SETTLE_WAIT_S` to 0.4.
5. **Re-save** any recording already on the Pi (Save to Pi) — old files keep the trims they had.

## 6. Code map

| File | Role |
|---|---|
| `src/lib/robot-arm/animation.ts` (+`.test.ts`) | pure: `Keyframe.offsets`, `keyframePositions`, `nextTrim`, `estimateTrim`, `settleFrames`, `trimFromSettle`, markers carry `poseId`/`target`, compose writes settle flags |
| `src/lib/server/robot-arm-animation.ts` | `goToPose` (+settle), `settleAtPose`, `settleAfterPlay` (Pi report first, else arm), `learnFromPiSettle`, `clearPoseDroop`, `resolveKeyframes` (trim/estimate), `writeAndPlay` (`lastPlay.end`) |
| `src/lib/robot-arm/playback.svelte.ts` | browser Play/Stop/poll; calls `?/settle` after a finished play; renders the settle line |
| `src/lib/components/robot-arm/AnimationCurves.svelte` | timeline: joint dots (drag/arrow keys), ◆ arrival, ▮ hold handles |
| `animate/+page.server.ts`, `animate/{moveset,sequence}/[id]/+page.server.ts` | `goToPose`, `clearDroop`, `settle` actions |
| models `robot-arm-pose.ts` (`trim`, `trimMeasuredAt/By`), `robot-arm-move-set.ts` (`keyframes.offsets`, `lastPlay.end/settledAt`), `robot-arm-sequence.ts` | |
| `services/robot-arm/src/arm/replay_settle.py`, `scripts/install_replay_settle.py` | the Pi half (#124) |
| `src/routes/api/robot-arm/webhook/+server.ts` | unchanged; `replay.settle` lands there as an ordinary run event |

Audit actions: `robot_arm.animate.pose_droop_measure` (#122), `pose_droop_settle`, `pose_droop_skip`
(#123), `pose_droop_from_replay` (#124), `pose_droop_clear`, `go_to_pose` (now with `trim`).

## 7. Gotchas

- **PRD numbering collision:** master's §10 is now *Jog* (#125); #123 adds its own §10 "Droop
  correction is automatic" and #124 adds §11. When merging #123/#124 into master, renumber theirs to
  §11/§12 and fix the cross-references (`§10`/`§11`) in this file and in `progress.txt` entries.
- `progress.txt` conflicts on every PR (all branches append at the end). Resolve with
  `git merge-file --union`, then **check the `====` header bars**: the union merge drops the bar
  shared by two adjacent entries (seen on #118, #115, #122).
- Source files are CRLF; script-based patches must normalise `\r\n` (the Edit tool is fine).
- The shared checkout `Bioscale_Operations_System_V2` is used by concurrent sessions: work in a git
  worktree (`git worktree add -b <branch> ../Bioscale_V2-wt-<name> origin/master`, then
  `mklink /J node_modules ..\Bioscale_Operations_System_V2\node_modules`), stage explicit paths only.
- Mid-play poses are only corrected by trims learned earlier (Pi owns the bus); a pose only gets
  settled mid-sequence if it is **held** ≥ ~0.5 s. Control-tab replays of recordings saved *after*
  #124 are settled on the Pi too (flags are in the file) but BIMS learns nothing from them.
- Still-open design options the user has not chosen: save the *command* (leader via the live
  `/calibrate/map?live=true` `predicted_follower`) instead of the follower reading for control-arm
  poses; raise the servos' P coefficient (register 21; LeRobot ships SO-100 followers at 16 vs
  default 32) on joints 2–4 — cheapest physical fix, not yet read on the live arm.

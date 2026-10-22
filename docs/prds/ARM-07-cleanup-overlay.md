# ARM-07 — Clean-up overlay: the pilot's positions on an animated recording

**Status:** built 2026-10-22 on `feat/cleanup-overlay`; not yet run against the arm or a live Pi. No new Pi
route — it reads and writes recordings through the routes the Clean-up tab already uses.

## 1. The problem

A move set played from the Animate tab (ARM-06) is smooth and fast, but the claw ends up low: its poses are
the follower's encoder readings, replay is open-loop, and a loaded STS3215 settles short of its goal under
gravity (ARM-06 §9). A pilot on the control arm never has that problem. They watch the follower and push
the leader until the claw is where they want it, so a **teleop recording's goals already carry the right
extra for every joint** — the correction is subconscious and per pose. What the pilot cannot give is a
clean path: hand tremor, uneven speed, pauses in odd places.

The operator wants both: the timing and curves of the animated recording, the positions of the teleop one.

## 2. What it does

**Clean-up tab → Overlay** (`cleanup/overlay?smooth=<animated>&precise=<teleop>`). Pick an animated recording
(timing and smoothness) and a pilot's recording of the same motion (positions). BIMS:

1. **Lines them up in time.** Subsequence dynamic time warping on all six joints, the animated recording as
   the query: it must be matched whole and in order, but may start and end anywhere in the pilot's
   recording, so the pilot may be slower, pause elsewhere, and have lead-in / lead-out motion the animation
   does not. Long recordings are thinned to ≤ 1200 samples for the warping and the match is interpolated
   back to every animated frame.
2. **Takes the offset.** For every animated frame, offset = pilot's goal at the matched moment − animated
   goal, per servo.
3. **Applies it.** The offset is averaged over a window (default 1 s, so tremor and the pilot's detours
   between poses do not get in), capped (default ±150 steps — more is the recordings drifting apart, not
   droop), scaled by a strength (default 100%), rounded and added to the animated frames; servos can be
   left out (e.g. the gripper). The result is the animated recording, frame for frame at its own times,
   with the pilot's positions.

The page shows the alignment (grey = animated, amber = the pilot lined up in time, cyan = result; one lane
per servo), the mean joint distance after alignment (a warning above 150 steps: probably not the same
motion), and a per-servo table: median and range of the raw offset, what was applied, frames capped. The
settings are applied in the browser from the same pure module the server saves with.

Two ways out, both leaving the sources untouched:

- **Save to Pi** — a new recording: the animated recording's header plus `overlay {animated, pilot,
  strength, window_s, servos, max_offset}`, its frames with the offset added, re-based to t = 0, clamped
  to the header's follower limits. Sidecar carries `overlaid_from` / `position_reference` / `overlay`, so the
  picker shows it as *overlay*. Audit `robot_arm.cleanup.overlay_save_to_pi` (table
  `robot_arm_recordings`, record = the file name) with the settings, the fit and the per-servo summary.
- **Open as a clean-up** — a clean-up draft whose `rawT/rawGoal` are the overlay, split into steps like
  any recording (`overlay` on the clean-up row records the pilot recording and settings; the editor's
  header says so). From there: edit, Save to Pi (straight lines, as for any clean-up) or **Send to Animate**
  — the poses then carry the pilot's positions, and the Animate engine renders the curves.

## 3. Files

| File | Role |
|---|---|
| `src/lib/robot-arm/recording-overlay.ts` (+ `.test.ts`, 17 tests) | pure: `seriesFromFrames`, `alignRecordings` (subsequence DTW), `applyOverlay`, `validateOverlayOptions`, `composeOverlayRecording` |
| `src/lib/server/robot-arm-overlay.ts` | read both recordings off the Pi, preview, save to Pi, open as clean-up; `classifyRecording` (animated / teleop / clean-up / overlay from the sidecar) |
| `src/lib/server/robot-arm-cleanup.ts` | `readSourceRecording` / `insertCleanup` split out of `createCleanup`; `overlay` on the clean-up doc |
| `src/lib/server/db/models/robot-arm-recording-cleanup.ts` | `overlay` subdocument (null for a plain clean-up) |
| `src/lib/components/robot-arm/OverlayChart.svelte` | the three-line lanes |
| `src/routes/manufacturing/cart-mfg/robot-arm/cleanup/overlay/` | the page: pickers, settings, table, Save to Pi, Open as a clean-up |
| `src/routes/manufacturing/cart-mfg/robot-arm/cleanup/+page.svelte` | link card on the Clean-up list |

Permissions: `manufacturing:read` to preview, `manufacturing:write` to save. Nothing touches the arm.

## 4. Limits and what to check on hardware

- Both recordings must be the same motion in the same order. The alignment cannot tell a different
  motion from a bad fit; the fit number and the amber-over-grey chart are the operator's check.
- The offset between poses is the pilot's route, not droop; the window averages it. If a move set's
  poses are close together in time (< 1 s), shorten the window so one pose's offset does not bleed into
  the next; if the pilot's path wanders a lot, lengthen it.
- The droop the pilot compensated depends on the load and the direction of approach. An overlay made
  from an empty-claw run will be short when carrying a cartridge.
- Teleop recordings save the **leader's** position as the goal (ARM-06 §11 on `feat/animate-replay-settle`),
  so the pilot's offset includes any leader/follower calibration difference, which is fine — that is
  exactly what replaying the teleop recording would send.
- First hardware test: animate a move set and save it to the Pi; teleop the same motion and record it;
  overlay them; replay the result from Control and check the claw height at each pose against the teleop
  replay. Then try *Open as a clean-up → Send to Animate* and play the move set.

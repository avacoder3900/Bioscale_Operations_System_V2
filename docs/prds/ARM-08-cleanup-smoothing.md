# ARM-08 — Clean-up smoothing: a smooth path, adjustable later with sliders

**Status:** built 2026-10-22 on `feat/cleanup-smoothing`; not yet run against the arm or a live Pi. No new Pi
route: it writes recordings through the restore route the Clean-up tab already uses, and replaces its own files
with the existing delete route.

## 1. The problem

The operator asked whether putting a file through Clean-up does anything. On its own it does not: Clean-up only
splits a recording into steps. The one output that differs is *Save to Pi*, which plays every step as a straight
line between its start and end and stops dead at each. That drops the wobble inside a step but is not smoothing,
and on an animated or overlaid recording it is worse than the source, because the curves become straight segments.

They asked for an option to smooth automatically, and for a smoothed recording to be editable after the fact with
sliders.

## 2. What it does

**Smoothing card** in the clean-up editor, under the timeline. When *Smooth when saving to the Pi* is on, Save to Pi
writes the smoothed path instead of the straight-line steps.

- **Smooth:** *The recording* (its own frames: an overlay keeps its curves) or *Your steps* (the steps as Save to Pi
  renders them, with their corners rounded).
- **Smoothing window** slider, 0–3 s (default 0.6 s), and **Strength** slider, 0–100% (default 100%).
- **Keep stops exact** (default on): every stretch where the smoothed servos stay within ±6 steps for 0.3 s or more is
  a stop, pinned to its median, so smoothing never shortens a reach and the tremor during a hold is gone. Half the
  window at each inner edge of a stop is left free, so moves ease into and out of it.
- **Servos to smooth** ticks (e.g. leave the gripper alone).
- A live chart (grey = source, cyan = smoothed, one lane per servo), stops kept, fastest servo before → after, and the
  largest change per servo.

The same pure function (`smoothSeries`) runs in the browser for the preview and on the server for the save; the
preview uses the recording's display trace (thinned past 6000 frames), the save uses every frame.

**Automatic.** The new-clean-up form has *Smooth automatically* — **unticked by default** (2026-10-22: the operator
prefers smoothing as an opt-in; it was ticked when first built). Ticked, the clean-up is created with smoothing on at
the defaults, so Save to Pi writes a smoothed recording with no step editing. An overlay opened as a clean-up (ARM-07)
also starts with smoothing off; with it off, Save to Pi plays the steps as straight lines, so turn smoothing on *from
the recording* in the Smoothing card to keep the overlay's curves. Clean-ups made before this keep the old behaviour
(smoothing off) until it is turned on.

**After the fact.** The settings are stored on the clean-up (`smoothing`), saved with *Save* and *Save to Pi*, and
restored when the page is opened again. Move the sliders and save again: under a new name, or under a name this
clean-up saved before with **Replace it** ticked (the editor offers *update <last file> instead*). Replace deletes the
old file on the Pi and writes the new one; only names in this clean-up's `savedAs` can be replaced. Each save records
its smoothing settings and whether it replaced a file; the list under Save to Pi shows them.

## 3. Algorithm (`src/lib/robot-arm/recording-smooth.ts`)

1. Stops: maximal runs where every smoothed servo stays inside a 12-step band, lasting ≥ 0.3 s (`findStops`).
2. Anchors: the first and last frame, and the middle of each stop at its median (a stop touching the start or end
   pins that end too).
3. Three passes of a centred moving average, total width = the window (close to a Gaussian, no lag), re-pinning the
   anchors after each pass.
4. Blend with the source by the strength, round, clamp to 0–4095 (and to the header's follower limits when written).

The first and last frame keep the source's position unless they sit in a stop (then the stop's median, a few steps
of tremor away), so a saved recording starts where its source did (Control's ±50-step replay preflight).

## 4. Files

| File | Role |
|---|---|
| `src/lib/robot-arm/recording-smooth.ts` (+ `.test.ts`, 14 tests) | pure: `findStops`, `smoothSeries`, `validateSmoothOptions`, `composeSmoothedRecording` |
| `src/lib/server/robot-arm-cleanup.ts` | `smoothing` on create / save / load; `saveToPi` writes the smoothed path and can replace its own file |
| `src/lib/server/db/models/robot-arm-recording-cleanup.ts` | `smoothing` subdocument; `savedAs[].smoothing`, `savedAs[].replaced` |
| `src/routes/manufacturing/cart-mfg/robot-arm/cleanup/[id]/` | Smoothing card, Save to Pi text, Replace it |
| `src/routes/manufacturing/cart-mfg/robot-arm/cleanup/+page.*` | *Smooth automatically* on the new-clean-up form |
| `src/lib/server/robot-arm-overlay.ts` | overlay → clean-up starts with smoothing on |
| `src/lib/components/robot-arm/OverlayChart.svelte` | pilot line optional, legend labels configurable |

Audit: `robot_arm.cleanup.save` carries the smoothing settings when sent; `robot_arm.cleanup.save_to_pi` carries the
settings, the stops / peak-speed / per-servo change summary and `replaced`. The recording's header and sidecar carry
`smoothed {source, window_s, strength, keep_stops, servos}`.

## 5. Limits and what to check on hardware

- A wide window slows sharp direction changes; the fastest-servo figure shows the effect. Smoothing only lowers peak
  speed, never raises it.
- Stops shorter than 0.3 s are smoothed through, not pinned. A quick tap at a pose will be rounded off; lower the
  window or untick that servo.
- Send to Animate is unchanged: it builds poses from the steps, and the Animate engine does its own easing.
- First hardware test: clean up a teleop recording with *Smooth automatically*, Save to Pi, replay from Control and
  compare against the raw recording: no tremor, the same end positions at each hold.

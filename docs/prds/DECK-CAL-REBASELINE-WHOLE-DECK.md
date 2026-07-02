# PRD: Deck Calibration — one-click "Re-baseline whole deck" (deck-reseat recovery)

## Problem (found in the data, 2026-07-01)
Deck `gen4deck_gen7cartridge_003` drifts by a roughly uniform ~1 mm vector (mostly −Y)
essentially every session — the whole deck is physically off by one offset, not per-hole.
The operator (alejandro) has been correcting this **one cartridge (12 holes) at a time**:
the edit history has **83 uniform bulk-shift batches**, ~12 of them in a single evening
(6/30). Today's 60 re-tuned holes moved by a tight mean of **(0.4, −1.5, 0) mm** (±0.3) —
the signature of a whole-deck placement shift, not random drift. This is hours of manual work
per session for what is a single-vector correction.

Root cause of the drift is separate (either the deck not seating repeatably — a hardware
fix — or a systematic offset in the pre-fix "Move to Hole" math that the operator has been
compensating for by hand; the `master` Studio computes moves differently and should be
re-tested once production is un-stalled). This PRD addresses the **recovery workflow** so a
reseat is a 10-second fix regardless of root cause.

## What already exists
- `applyGlobalShift()` shifts `wells.filter(isActiveRole)` by the captured/typed `dx/dy/dz` —
  i.e. the whole deck ONLY when the role filter is set to "All". Easy to forget the filter and
  shift just wax or just reagent, leaving half the deck off.
- The jog **Capture** flow already yields the offset vector (`dx/dy/dz`) from one reference hole.

## Change (single page, reuse existing engine)
File: `src/routes/manufacturing/cart-mfg/deck-calibration/+page.svelte`

Add **`rebaselineDeck()`** + a prominent **"⇱ Deck moved? Re-baseline ALL 576 holes"** button in
the Offset panel:
- Applies the captured (or typed) `dx/dy/dz` to **every hole on the deck — both wax and reagent
  — ignoring the role filter**. This is the one-click, foolproof deck-reseat correction.
- Confirm dialog states it hits the whole deck and is reversible.
- Routes through the existing `applyDelta → ?/applyBatch` (`applyDeckEditBatch`), so it inherits
  the physical-bounds guard, `DeckCalibrationEdit` history, AuditLog, single-step **Undo**, and
  live-run update. No server/model/API change.

## Workflow it enables
Deck bumped/reseated → jog to ONE reference hole (e.g. a corner) → **Capture** → **Re-baseline** →
all 576 holes translate by that vector at once → fine-tune only the few still off. Replaces
per-cartridge bulk shifting.

## Non-goals
- No server/model/API changes; no change to `applyGlobalShift`, jog/capture, or Sync.
- Does not fix the underlying physical drift (hardware) — it makes recovery trivial.
- A reversible/runtime deck-placement offset layer (so shifts aren't baked into the def each
  time) is a larger follow-up worth considering if the drift can't be fixed physically.

## Acceptance
- With a non-zero captured/typed offset, clicking Re-baseline shifts **all** wells (verified via
  the batch `applied` count = full deck), regardless of the wax/reagent filter; Undo reverts the
  whole thing in one step; out-of-bounds wells report via `failed[]`.
- `npm run check` stays at the 11-error baseline (0 new); build green.

## Deployment note
Reaches operators only once the stale production alias is promoted to current `master` (see the
2026-07-01 stale-prod investigation entry in progress.txt).

# PRD: One-click robot re-scan of failed deck slots

**Status:** In progress (2026-06-17)
**Routes:** `src/routes/api/scanner/sweep/+server.ts`,
`src/lib/components/manufacturing/{wax-filling,reagent-filling}/DeckLoadingGrid.svelte`

## Problem
After a robot sweep, slots that didn't decode show as red tiles with:
> "N slots need manual rescan — click the red tiles below"

The only recovery today is to click each red tile and **manually** scan/type that
cartridge's barcode. That's slow and defeats the hands-off flow — especially now
that the daemon does a focus + grid search per slot, so a second robot pass on
just the failed positions usually succeeds on its own.

## Solution
A **"Retry N failed slots with robot"** button that re-runs the gantry sweep on
ONLY the failed slot positions (reusing the per-slot grid-search recovery). On
success the red tiles clear; anything still failing falls back to the existing
per-tile manual scan.

### Changes
1. **Sweep endpoint** (`/api/scanner/sweep`): accept an optional
   `slotIndices: number[]`. When present, walk exactly those slots (in order)
   instead of `0..maxSlots`. Validates each index has a taught position. Backward
   compatible (absent → current behavior).
2. **Wax `DeckLoadingGrid`**: when `failedSlots` is non-empty, render a
   "Retry N failed slot(s) with robot" button. It posts the sweep with
   `slotIndices = [...failedSlots]`, streams progress through the existing poller
   (which absorbs scans/errors by `slotIndex`), and clears recovered tiles.
   Disabled while a sweep is in flight. Per-tile manual scan stays as fallback.
3. **Reagent `DeckLoadingGrid`**: same affordance (its sweep + failedSlots model
   mirror wax).

## Acceptance
- A sweep that leaves slots 14 & 16 red shows "Retry 2 failed slots with robot";
  clicking re-sweeps just 14 & 16 (with focus/grid search) and clears them on a
  successful decode.
- Still-failing slots remain red and manually scannable.
- `npm run check` no new errors over the 11-baseline; build green.

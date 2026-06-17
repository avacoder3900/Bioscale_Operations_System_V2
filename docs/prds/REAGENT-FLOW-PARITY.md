# PRD: Reagent-filling parity with the polished wax-filling flow

**Status:** Partially done (2026-06-16 overnight). Remaining work flagged for review.

Goal: bring reagent filling to the same hands-off flow as wax — set params, do
barcode scanning, then launch straight into the run with no final Resume click.

## DONE (shipped + deployed this session)
1. **Off-deck auto-resume** — reagent `startRun` enqueues the daemon
   `auto_resume_run` command after play, so the protocol's initial "confirm deck
   loaded" pause is resumed automatically. No final Resume click. (Same daemon
   routine as wax; the `resume`→`play` actions-endpoint fix is shared.)
2. **Robot health badges** — ready/busy/hung/offline dot on the reagent gallery
   cards + tabs, polled from `/api/opentrons-lab/robots/health`, plus the
   "Restart robot server" banner when a robot is hung.
3. **Run counter** — reagent robot cards show cartridge count + elapsed while a
   run is active.

## REMAINING (deferred — needs review/testing, NOT done blind)
Reordering the reagent Loading stage to **params → barcode scanning → auto-start**
like wax. Deferred because the reagent Loading stage is materially different from
wax and a blind reorder risks breaking a working flow:
- Reagent Loading has extra sub-steps wax doesn't: `SetupConfirmation`,
  `ReagentBatchScan`, `ReagentPreparation` (reagent tubes), in addition to
  `DeckLoadingGrid` + `ProtocolStartPanel`.
- Reagent `DeckLoadingGrid` has **no `plannedCartridgeCount`/mismatch** logic and
  no `scanDeckAndCartridges` one-button chain (wax added these). So "clean scan →
  auto-complete (no Confirm Full Load)" has no count to validate against.

### Plan to finish (mirror wax once we can test together)
1. Reagent page (`+page.svelte`): add a `params` sub-step before the deck grid.
   Render `ProtocolStartPanel` with `onSubmitIntercept` to capture the FormData
   (protocol + `param_*`), store it, advance. (Same as wax `handleParamsConfirmed`
   + `paramsReady`/`capturedParamsFd` + per-run reset effect.)
2. Reagent `DeckLoadingGrid`: add `plannedCartridgeCount` + a `scanDeckAndcartridges`
   one-button chain + auto-complete on a clean sweep (`failedSlots` empty &&
   count match) so no "Confirm Full Load" click. Decide where `ReagentBatchScan` /
   `ReagentPreparation` fit relative to params (likely: params → batch scan →
   deck scan → auto-start; confirm with operator).
3. Reagent page: after a clean deck load, replay `capturedParamsFd` to
   `?/startRun` (the run already auto-resumes the off-deck pause). Mirror wax
   `handleDeckLoadComplete` + `startRunWithCapturedParams`.

Reference implementation: wax-filling `+page.svelte` (params substage,
`handleParamsConfirmed`, `startRunWithCapturedParams`) + `DeckLoadingGrid.svelte`
(`scanDeckAndCartridges` auto-complete).

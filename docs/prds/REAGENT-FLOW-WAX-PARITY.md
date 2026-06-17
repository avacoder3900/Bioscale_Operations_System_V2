# PRD: Reagent-filling flow parity with wax-filling

Bring reagent filling in line with the polished wax flow. Four changes.

## Current reagent flow (for reference)
Stages: `Setup → Loading → Running → Inspection` (4 bubbles, 1:1 with stages).
Loading sub-steps (driven by data, not a substage var):
- `cartridges.length === 0` → **DeckLoadingGrid** (scan deck + cartridges) → loadDeck
- `cartridges > 0 && !reagentBatchConfirmed` → **ReagentPreparation** (reagent tubes) → recordReagentPrep
- `cartridges > 0 && reagentBatchConfirmed` → summary + **ProtocolStartPanel** (params + startRun)

## 1. Remove the setup checklist
`SetupConfirmation.svelte` shows a static checklist ("Robot powered on and
calibrated · Deck is clean and ready · 2ml tube rack prepared · Reagent source
tubes available · PPE worn"). Remove it — it's informational noise.

## 2. Protocol params BEFORE barcode scanning (mirror wax)
Move `ProtocolStartPanel` out of the final Loading sub-step. The operator sets the
reagent protocol + params at the **setup step**, the chosen FormData is captured
(`onSubmitIntercept`), and the run auto-starts with it after the deck scan +
reagent prep — not at the end. Pattern is exactly wax's `handleParamsConfirmed` +
`capturedParamsFd` + `startRunWithCapturedParams`, adapted to fire after
`recordReagentPrep` (reagent has the extra reagent-prep step before run start).

## 3. "Scan deck + cartridges with robot" one-button (mirror wax)
The reagent `DeckLoadingGrid` has separate deck-scan + cartridge-sweep buttons.
Add the wax one-button `scanDeckAndCartridges` (deck scan → auto-confirm → sweep)
+ auto-complete on a clean sweep, so the operator clicks once and walks away.
(Reagent grid already has `scanDeckWithRobot`, `autoSweepCartridges`,
`retryFailedSlots`, `confirmDeck` — just chain them like wax.)

## 4. Timeline: rename + add a Barcode Scanning bubble
Bubbles become 5: **Reagent Fill Setup → Barcode Scanning → Load → Run → Inspect**.
- "Setup" → "Reagent Fill Setup".
- New "Barcode Scanning" bubble BETWEEN setup and load = the deck+cartridge scan.
- "Load" = the reagent-prep step (loading the reagents).
Render a TIMELINE array (5 labels) with a `currentBubbleIndex` derived from
stage + Loading sub-step (mirror wax's TIMELINE/currentBubbleIndex):
`Setup→0; Loading & cartridges===0→1; Loading & cartridges>0→2; Running→3; Inspection→4`.

## Affected files
- `src/lib/components/manufacturing/reagent-filling/SetupConfirmation.svelte` (#1, #2 host)
- `src/routes/manufacturing/cart-mfg/reagent-filling/+page.svelte` (#2 capture/replay, #4 bubbles)
- `src/lib/components/manufacturing/reagent-filling/DeckLoadingGrid.svelte` (#3)
- `ProtocolStartPanel.svelte` already supports submitLabel + onSubmitIntercept (from wax).

## Acceptance
- No setup checklist.
- Params are set on the Reagent Fill Setup step; after a clean scan + reagent prep
  the run starts with those params (no end-of-loading param panel).
- One "Scan deck + cartridges with robot" button drives the deck+cart scan; clean
  scan auto-advances.
- 5 bubbles render in order with the right one highlighted per sub-step.
- `npm run check` no new errors over baseline; build green.

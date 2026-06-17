# PRD: Run-completion gating + "Run again" (wax + reagent)

## Context (answered for Jacob)
The OT-2 `.py` ends on its own (status SUCCEEDED). "Confirm — Deck Removed" does
NOT end the run — it advances the BIMS run from Running → Awaiting Removal
(starts cooling, unlocks the robot). Today that button (the `RunExecution`
component) renders for the WHOLE Running stage, even mid-run. Two changes:

## A. Gate "Confirm — Deck Removed" to after the .py completes
- `RunExecution` (wax + reagent): add a `runFinished` prop. Show the
  "Confirm — Deck Removed" button ONLY when `runFinished` is true; while the run
  is still executing, show a "run in progress — confirm removal when it finishes"
  hint instead. Keep **Abort** available during the run (abort needs to work mid-run).
- Parent pages: track `runFinished`, set true when `EmbeddedRunController.onComplete`
  fires (terminal: succeeded/failed/stopped). Also derive it on load from the
  server stamp (wax `opentronsRunFinalStatus` set by recordRunFinished; reagent
  equivalent) so a page reload after completion shows the button immediately.

## B. "Run again" button (wax + reagent)
After a run finishes, a **Run again** button starts the next batch on the same
robot **reusing the same parameters** and jumps straight to **barcode scanning**
(operator has loaded a fresh deck + cartridges). No re-entering setup/params.

- Show it on the run-complete view (next to / after Confirm — Deck Removed) once
  `runFinished`. (Also fine to surface at the end of the flow.)
- On click:
  1. Capture the previous run's setup for reuse — params (the captured
     ProtocolStartPanel FormData, kept in a `lastRunParamsFd` that the per-run
     reset does NOT clear) + wax lot/count (wax) or assay (reagent).
  2. Create a NEW run on the same robot with that setup (wax: recordWaxPrep with
     the prior waxSourceLot + plannedCartridgeCount; reagent: createRun with the
     prior assay) — so a fresh run exists.
  3. Set `paramsReady = true` + `capturedParamsFd = lastRunParamsFd` so the param
     step is skipped, and advance to the barcode-scanning sub-step.
  4. The clean-scan auto-start then runs with the reused params (existing path).
- Robustness: if `lastRunParamsFd` is missing (e.g. reload), Run again still
  creates the run but lands on the param step (operator re-confirms) — never a
  dead end.

## Affected files
- `src/lib/components/manufacturing/wax-filling/RunExecution.svelte` (runFinished prop)
- `src/lib/components/manufacturing/reagent-filling/RunExecution.svelte` (runFinished prop)
- `src/routes/manufacturing/cart-mfg/wax-filling/+page.svelte` (runFinished, Run again)
- `src/routes/manufacturing/cart-mfg/reagent-filling/+page.svelte` (runFinished, Run again)
- server: expose the .py final-status stamp in runState if not already; a Run-again
  may reuse existing createRun/recordWaxPrep actions (no new server action needed
  if the prior setup is replayed from the client).

## Acceptance
- During a run, no "Confirm — Deck Removed" (only progress + Abort); after SUCCEEDED
  it appears.
- "Run again" → new run on the same robot, same params, lands on barcode scanning;
  a clean scan auto-starts with the reused params.
- `npm run check` no new errors over baseline; build green.

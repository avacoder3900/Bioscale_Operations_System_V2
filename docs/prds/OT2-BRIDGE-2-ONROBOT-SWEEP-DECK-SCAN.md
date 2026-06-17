# OT2-BRIDGE-2 — On-robot sweep choreography + robot deck-barcode scan

**Date:** 2026-06-11 · **Owner:** Jacob · **Status:** Approved (conversation 2026-06-11)
**Depends on:** OT2-BRIDGE-1 (command bridge + unified daemon)

## Problem

1. The cartridge sweep is choreographed **from BIMS**, per slot: move command →
   ScannerTrigger doc → daemon serial scan → ScannerEvent doc → BIMS polls for
   the match (`api/scanner/sweep/+server.ts:147-383`). Over the bridge every
   slot would pay multiple queue round-trips; timing-critical choreography
   belongs next to the hardware (Jacob's call: change the choreography).
2. The deck barcode at wax-fill deck loading is scanned by hand. Jacob wants
   the OT-2's gantry scanner to do it.

## Design

### Sweep becomes ONE bridge command, executed on-robot

- `POST /api/scanner/sweep` keeps its public contract (validates, creates the
  `OpentronsScannerSweepRun` doc, returns `sweepRunId` immediately) but instead
  of running the in-process worker it enqueues one `kind:'sweep'` command:
  `payload = { sweepRunId, positions[{slotIndex,x,y,z}], pipetteMount,
  pipetteName?, maxSlots, scanTimeoutS, retryOnce: true }`.
- The daemon executes the whole walk locally: open maintenance run →
  resolve/load pipette (canonical name from live `/pipettes`, as today) →
  home → per slot: moveToCoordinates (forceDirect) + **direct serial scan**
  (it owns the scanner port — no trigger/event docs, no Mongo in the loop) →
  home → close run. Local per-slot time ≈ today's localhost speed (~2-3 s).
- After each slot the daemon POSTs `/api/agent/ot2/commands/[id]/progress`
  with the slot result; BIMS updates the SweepRun doc (scans/errors/log/
  slotsDone/currentSlotIndex) — **the existing live sweep UI keeps working
  unchanged** (it polls `GET /api/scanner/sweep/<id>`). The progress response
  echoes `pauseRequested`/`cancelRequested`; the daemon honors them between
  slots. Cancel also retains today's active close of the maintenance run as a
  fallback for a wedged daemon.
- Final result completes both the command and the SweepRun.
- The old in-process worker loop is **deleted** — sweep always runs via the
  daemon (it owned the scanner serial port anyway, so sweep never worked
  without it; this removes a whole failure mode, not a capability).

### Robot deck-barcode scan (wax + reagent deck loading)

- `OpentronsScannerPositionSet` gains an optional
  `deckBarcodePosition: { x, y, z, testScanBarcode?, testScannedAt? }` —
  taught once per robot on the existing scanner-positions teach page
  (new "Deck barcode" row beneath the slot grid; same jog → save → test-scan
  flow). The deck's barcode label must sit in gantry-scanner view.
- New `kind:'deck_scan'` bridge command (a 1-position sweep):
  `POST /api/scanner/deck-scan { robotId }` → validates a taught
  deckBarcodePosition exists → enqueues → daemon moves, scans, returns the
  barcode in the command result → endpoint responds `{ barcode }` (sync,
  ~10-15 s including maintenance-run open/close; route `maxDuration: 60`).
- `DeckLoadingGrid` (wax + reagent): "Scan Deck with Robot" button calls the
  endpoint, fills the deck field, then runs the existing deck validation.
  Manual input stays as fallback. Disabled with a tooltip when the robot has
  no taught deck position or no recent bridge heartbeat.

## Out of scope

- Removing the legacy trigger/event single-scan path (per-slot rescans +
  teach test-scans still use it; consolidation into `kind:'scan'` commands is
  a later cleanup).
- Reagent-side sweep changes beyond inheriting the new sweep transport
  (both grids already share `/api/scanner/sweep`).

## Acceptance

- From the deployed app: Scan Cartridges runs a full 24-slot sweep with live
  per-slot progress, pause/cancel work, results land in the grid exactly as
  today on localhost.
- "Scan Deck with Robot" fills + validates the deck field on a robot with a
  taught deck position; clear error when untaught or bridge offline.
- Teach page can teach/retest the deck-barcode position.
- `npm run check` clean vs baseline.

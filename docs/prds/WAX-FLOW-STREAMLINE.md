# WAX-FLOW-STREAMLINE — fewer clicks, grid-driven Start Run

**Date:** 2026-06-15 · **Owner:** Jacob · **Status:** Approved (conversation 2026-06-15)

## Goal
Cut the wax-filling flow down to the minimum operator clicks, driven by the
cartridge-layout grid, removing redundant selectors / pages / checklists.

## Changes
1. **Robot selection** — remove the top-left robot dropdown (`wax-filling/+layout.svelte`).
   Clicking a robot card goes straight to `?robot=<id>` and into wax setup,
   auto-creating the run (no intermediate "Start Wax Filling Run" page).
2. **Deprecate opentron-control** — delete the hub (`opentron-control/+page.*`),
   wax/reagent run-control (`wax/[runId]`, `reagent/[runId]`), `scanner-test`,
   `sweeps`; remove all nav links (wax/reagent +layout queue links, AskBimsWidget).
   **KEEP `settings/scanner-positions/**`** (deck/slot position teaching — the auto
   deck-scan depends on it) and surface a link to it from the wax-filling area.
3. **Wax setup (one screen)** — `WaxPreparation.svelte`: wax-lot dropdown +
   cartridge-count dropdown shown together, live "Fill the 2 ml tube with X µL",
   single **"Wax setup complete"** button. Remove the 1-2-3 sub-step bubble.
4. **Timeline label** — `stageLabel`: "1. Load" → "1. Wax fill setup".
5. **Start Run (grid-driven)** — one Start Run button runs the existing
   orchestration (deck-scan → cartridge sweep → loadDeck → startRun) with no
   intermediate clicks. The **cartridge-layout grid is the live display**: slots
   fill green as scanned; **failed slots turn red and are click-to-manual-scan**
   (existing DeckLoadingGrid per-slot rescan). Remove: the orchestration checklist
   (Scan deck/Scan cartridges/Load deck/Start protocol), the Start-Run instruction
   sprawl, the "Manual scanning (fallback)" collapsible wrapper (grid is primary
   now), and the LAN auto-scan banner.

## Behavior on scan failure
Orchestration runs to completion; failed cartridge slots show red in the grid;
operator clicks a red slot and scans it by hand. No dead-end, no separate fallback UI.

## Out of scope
- Reagent-filling flow (mirror later if wanted).
- Changing the run/QC/storage stages.

## Acceptance
- No robot dropdown; click robot → wax setup directly.
- opentron-control hub/run-control unreachable; scanner-positions still reachable.
- Wax setup is one screen ending in "Wax setup complete".
- Timeline shows "Wax fill setup".
- Start Run auto-runs all 3 steps; grid shows live fill + red click-to-rescan; no
  checklist / banner / fallback wrapper.
- `npm run check` clean vs baseline; build green.

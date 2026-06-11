# WAX-FLOW-1 — Split Opentron Control into Wax Filling / Reagent Filling tabs

**Date:** 2026-06-11 · **Owner:** Jacob · **Status:** Approved (conversation 2026-06-11)

## Problem

`/manufacturing/cart-mfg/opentron-control` is a combined hub: pick a robot card, then choose
"Start Wax Filling" or "Start Reagent Filling". The process type should be explicit from the
menu, not chosen mid-page.

## Decision (Jacob)

- Cart-mfg side menu (`cart-mfg/+layout.svelte:12-26`): **remove** "Opentron Control" entry,
  **add** "Wax Filling" → `/manufacturing/cart-mfg/wax-filling`, "Reagent Filling" →
  `/manufacturing/cart-mfg/reagent-filling`, and "Wax Inspect" → `/manufacturing/cart-mfg/wax-inspect`
  (see WAX-FLOW-4).
- The `/opentron-control` route and all its sub-routes (queues, sweeps, settings,
  scanner-positions, wax/[runId], reagent/[runId]) **stay alive untouched** as a reachable
  backup. If it later clashes with the inline flow, we rename/retire it then.
- The robot-selection capability from the hub moves **into each filling page** as the primary
  path: when the page has no `?robot=` param and no active run, render a robot-select start
  screen (same availability semantics as the hub's robot cards: in-use while a run is in
  Setup→Awaiting Removal for wax / Setup→Inspection for reagent).

## Implementation

1. `src/routes/manufacturing/cart-mfg/+layout.svelte` — menu swap (3 entries in, 1 out).
2. `wax-filling/+page.server.ts` + `reagent-filling/+page.server.ts` — load already receives
   `?robot=` (wax: `+page.server.ts:128`). Add `robotCards` data (reuse the hub's robot-status
   query from `opentron-control/+page.server.ts:33-205` — extract to a shared helper
   `src/lib/server/manufacturing/robot-cards.ts` so the hub and both filling pages share it).
3. `wax-filling/+page.svelte` + `reagent-filling/+page.svelte` — when no robot selected and no
   active run: render robot cards; clicking one navigates to `?robot=<id>`.

## Acceptance

- Menu shows Wax Filling / Reagent Filling / Wax Inspect; no Opentron Control entry.
- Visiting `/cart-mfg/wax-filling` with no params shows robot picker; picking one enters the
  existing flow. Same for reagent.
- `/cart-mfg/opentron-control` still loads and works (backup).
- `npm run check` introduces no new errors.

# SPU-INV-01 — SPU Inventory: Card Grid → List View

**Status:** Draft
**Branch:** `feat/spu-tweaks`
**Companion:** [SPU-INV-02](SPU-INV-02-inventory-at-spu-root.md) (moves this page to `/spu`; implemented together)

## Problem

The SPU inventory page (today `/spu/mfg`, the "Overview" tab) renders every SPU as a 3-across
card grid (`src/routes/spu/mfg/+page.svelte`). Each card shows only UDI, device ID, status, and a
validation chip. With a growing fleet the grid is hard to scan: you can't run your eye down a
column, compare statuses, or see barcode/owner/batch without clicking into each unit.

## Goal

Replace the card grid with a table list view — one row per SPU — matching the existing Tron table
idiom already used in the SPU area (`src/routes/spu/mfg/barcodes/+page.svelte:375`).

## Requirements

1. **Table columns**, in order:
   - **UDI** — mono, cyan, the primary identifier.
   - **Device ID** — mono, `—` when unlinked.
   - **Barcode** — mono, `—` when unassigned.
   - **Status** — `SpuStatusBadge` (unchanged component).
   - **Batch** — batch number or `—`.
   - **Owner** — or `—`.
   - **Validation** — `n/3` chip, green when complete, red otherwise (same pass/reset semantics
     as today — server-computed `validationPassed` honoring `validationResetAt` is unchanged).
   - **Created** — short date.
2. **Row click navigates to `/spu/{id}`** (whole row is the link target, same destination as the
   old cards; keep the interactive hover affordance).
3. **Search behavior is preserved exactly**: live filter across UDI / device ID / barcode / owner /
   batch, and Enter jumps straight to an exact UDI / device-ID / barcode match.
4. **Empty state preserved**: "No SPUs …" message when nothing matches.
5. Table lives inside a card container with `overflow-x-auto` so narrow screens scroll the table,
   not the page.
6. **Load-function hygiene (drive-by fix):** the current load does `Spu.find()` with no projection,
   which drags every `attachments[].content` CSV blob and all `assembly.stepRecords[]` over the
   wire for every unit on every page view. Add a `.select()` limited to the fields the page maps
   (`udi barcode status qcStatus owner batch particleLink validation validationResetAt createdAt`).
   No behavior change — the mapper already only reads these.

## Non-goals

- No pagination, sorting controls, or column filters (fleet size doesn't warrant it yet).
- No new columns beyond the data the load already returns.
- No changes to the SPU detail page.

## Acceptance

- `/spu` (post SPU-INV-02) shows all SPUs as table rows; clicking a row opens the detail page.
- Typing in search filters rows live; Enter on an exact identifier jumps to that SPU.
- `npm run check` error count at or below baseline.

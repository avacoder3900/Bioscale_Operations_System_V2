# PRD-ROG-REPLICATE-PRINT — ROG Replicate Barcode Sheet

**Status:** Implementing
**Owner:** alejandrov@fannininnovation.com
**Branch:** `ui/rog-tron-recolor`
**Date:** 2026-05-06

## Problem

When parts arrive at receiving, the warehouse needs many physical barcode
stickers per part — one for every bin, bag, or container. The ROG page's
existing **Print QR Labels** action (in the Registered Parts section)
produces a 3-column HTML grid with one sticker per part, which is fine for
labelling a part definition once but inefficient for receiving where ops
need 8–80 identical stickers per SKU.

The cartridge print page (`/manufacturing/print-barcodes`) already has a
production-grade Avery 94102 layout: 8×10 grid, ¾" cells, operator-tuned
shift/shrink, single-PNG-per-sheet rendering with `bwip-js`. But it mints
fresh `CART-NNNNNN` UUIDs intended for cartridges — not what receiving needs.

## Goal

Add a **Replicate Print** workflow to the ROG page that prints an Avery
94102 sheet filled with N replicates of each selected *part* barcode,
reusing the cartridge layout 1:1 (same DPI, geometry, QR rendering, print
CSS). Page capacity is 80; for N=8 the sheet prints 10 parts × 8 replicates,
for N=4 it prints 20 parts × 4 replicates, and so on.

## User Flow

1. On the ROG page Registered Parts section, click **Print Replicate Sheet**.
2. Navigates to `/parts/accession/replicate-print`.
3. Form:
   - Number input: **Replicates per part** (1–80).
   - Live calc: *"Fits up to X parts per sheet"* where `X = floor(80 / N)`.
   - Checkbox list of every registered part (any with a `barcode`). Order
     of selection determines order on the sheet. Disable selecting beyond
     `X`.
   - **Generate Preview** button.
4. Preview area renders the Avery 94102 sheet identically to the cartridge
   page (single PNG, same `SHRINK`/`shiftX`/`shiftY`, ABC labels, QR centered,
   two-line UUID text below).
5. **Print Sheet** triggers `window.print()` with the same print stylesheet
   (`@page { size: 8.5in 11in; margin: 0; }`).
6. **No inventory mutation, no audit log, no batch record.** These are
   reprints of part-definition barcodes that already exist; nothing to
   account for.

## Layout Spec

Cells are addressed in row-major order: `i = row * 8 + col`, where
`col ∈ [0..7]` and `row ∈ [0..9]`.

For inputs `N` and `selectedParts = [P₁, P₂, …, P_M]` with `M ≤ floor(80/N)`:

| Cell range | Content |
|---|---|
| `0 .. N-1` | `P₁.barcode` repeated `N` times |
| `N .. 2N-1` | `P₂.barcode` repeated `N` times |
| … | … |
| `(M-1)·N .. M·N-1` | `P_M.barcode` repeated `N` times |
| `M·N .. 79` | blank |

**N=8 example** (matches user's stated expectation): P₁ fills row 0
(cells 0–7), P₂ fills row 1 (cells 8–15), …, P₁₀ fills row 9 (cells 72–79).

**N values that don't divide 8** (e.g., 5, 7) still pack contiguously and
may span row boundaries; this is acceptable for v1.

## Technical Notes

- Reuse the exact `sheetPng(cells)` renderer from
  `src/routes/manufacturing/print-barcodes/+page.svelte`:
  `DPI=300`, `cellMargin=0.125"`, `cellSize=0.75"`, `cellPitch=1.0"`,
  `padX=0.23"+0.1125·cellSize`, `padY=0.46"+0.1·cellSize`, `SHRINK=0.85`,
  ABC labels in courier monospace, QR centered on B-column, UUID text
  split across 2 lines beneath the QR.
- For v1, the renderer is **duplicated** into the new route. A follow-up
  can extract `sheetPng()` into `src/lib/client/avery94102.ts` and have
  both pages import — but that requires modifying
  `print-barcodes/+page.svelte` (a frozen `.svelte` file), so we defer it.
- Same print stylesheet (`@page` + `:global` chrome-hide rules).
- `bwip-js@^4.10.1` is already a dependency.

## Out of Scope (v1)

- Server-side rendering (browser canvas only — fine for ≤2 sheets).
- Multi-sheet output. One sheet per Generate; operator can re-generate.
- "Skip N cells" partial-sheet support (not requested).
- Tracking these prints in `BarcodeSheetBatch` or part inventory counts.
- Sharing the layout module between routes (deferred follow-up).

## Success Criteria

- Click **Print Replicate Sheet** on ROG → land on new page; existing ROG
  behavior unchanged.
- N=8 + 10 registered parts → preview shows 10 rows of 8 identical
  stickers each, identical typography/alignment to cartridge sheet.
- Print produces sheet aligned with physical Avery 94102 stock.
- N=4 + 20 parts → 20 contiguous blocks of 4, filling the sheet.
- Selecting beyond `floor(80/N)` parts is disabled in the UI.

## Files Touched

- `docs/prds/PRD-ROG-REPLICATE-PRINT.md` (new)
- `src/routes/parts/accession/replicate-print/+page.server.ts` (new)
- `src/routes/parts/accession/replicate-print/+page.svelte` (new)
- `src/routes/parts/accession/+page.svelte` (modify — add nav button)

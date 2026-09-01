# SPU-INV-03 — SPU Inventory: Sortable Columns

**Status:** Draft
**Branch:** `feat/spu-tweaks`
**Builds on:** [SPU-INV-01](SPU-INV-01-list-view.md) (the list view)

## Problem

The inventory table (`/spu`) renders in a fixed order (server `createdAt` desc). You can't
reorder by status, validation progress, batch, or identifier without leaving the page.

## Requirements

1. **Every column header is clickable and sorts the table** by that column: UDI, Device ID,
   Barcode, Status, Batch, Owner, Validation, Created.
2. **Clicking an already-active column toggles** ascending ↔ descending. Clicking a different
   column activates it ascending.
3. **Default sort: UDI ascending.**
4. The active column shows a direction indicator (▲ asc / ▼ desc); inactive headers show none.
5. Sort semantics per column:
   - UDI / Device ID / Barcode / Batch / Owner — case-insensitive string compare.
   - Status — **lifecycle order** (draft → assembling → assembled → validating → validated →
     released-* → deployed → servicing → retired → voided), not alphabetical.
   - Validation — by passed count (0–3).
   - Created — chronological.
   - **Missing values (`—`) always sort last**, in both directions.
6. Sorting is client-side over the filtered rows; search and Enter-to-jump are unaffected.
7. Headers are real `<button>`s (keyboard focusable), with `aria-sort` on the active column.

## Non-goals

- No multi-column sort, no persisted sort preference, no server-side sorting.

## Acceptance

- Fresh load of `/spu` lists units by UDI ascending.
- Clicking "Status" groups rows in lifecycle order; clicking again reverses it.
- Rows with no barcode/batch/owner sit at the bottom either direction.
- `npm run check` error count at or below baseline (11).

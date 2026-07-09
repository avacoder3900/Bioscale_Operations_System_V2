# PRD: Deck Calibration — Align selection to an anchor hole (straighten every line)

## Problem
Within a cartridge, some fill lines are shifted slightly relative to the other lines
(line-to-line mismatch that shouldn't exist — the holes are drilled on a regular grid).
Today the operator fixes this line by line with the relative Offset tool, doing the
arithmetic by hand. Wanted: jog-verify ONE good hole, select the whole cartridge, and
one click lines every hole up to it.

## Semantics (confirmed with operator, 2026-07-09 — "Straighten every line")
The anchor (most-recently-clicked selected hole, same anchor rule as "Set position →
selection") is the trusted, jog-verified hole. Every OTHER selected hole of the SAME
role (wax/reagent) snaps onto a clean grid ruled by the anchor's row + column line:

- `new x = x(anchorRow, thisCol)` — the X of the hole in the anchor's row at this
  hole's column → every column line becomes perfectly straight (constant X), with
  line-to-line spacing taken from the anchor's row.
- `new y = y(thisRow, anchorCol)` — the Y of the hole in this hole's row at the
  anchor's column → every row becomes level (constant Y per role), with row spacing
  taken from the anchor's line.
- `z` is never touched.

Opposite-role holes in the selection are SKIPPED and reported: wax and reagent rows
are deliberately staggered (~one row pitch in Y), so their Y ruler must be a column of
their own role — the operator re-runs with an anchor of the other type. Ruler holes
(anchor's row/column) are read from the live Mongo def; they don't need to be selected.

## Implementation
- **`apply-edit.ts`**: new `applyDeckEditsPerWell({deckLoadName, edits:[{wellName,
  delta}], user, robotId})` — same guarantees as `applyDeckEditBatch` (one Mongo read +
  one `$set` write, per-well `DeckCalibrationEdit` history rows each carrying its own
  delta, one summary AuditLog `mode:'per-well'`, physical-bounds guard per well,
  best-effort local labware-JSON mirror) but a DIFFERENT delta per well.
- **`deck-calibration/+page.server.ts`**: new `applyPerWell` action
  (`manufacturing:write`) — parses `edits` JSON `[{wellName, dx, dy, dz}]`.
- **`deck-calibration/+page.svelte`**:
  - `rowOf()` helper (row letters) beside `colOf()`.
  - `applyPerWellEdits()` client helper; undo-stack entries extended with an optional
    per-well `edits` list; `undoLast` inverts each per-well delta.
  - `alignSelectionToAnchor()` — computes the per-hole deltas from the anchor cross,
    skips opposite-role/already-aligned holes, confirm dialog, posts `applyPerWell`.
  - New "Align selection → anchor hole" panel (cyan button) between "Set position →
    selection" and "Robot global offset".

## Inherited behavior (unchanged)
Bounds guard, per-hole history, AuditLog, one-step Undo (whole alignment reverts),
live-run note (`deckDirty` / absolute-move path), and "Sync for real fills" — the deck
only reaches the robot on Sync/re-upload, exactly like every other Studio edit.

## Acceptance
- Select a cartridge (24 holes), click a jog-verified hole last, Align → every
  same-role hole snaps so all lines share the anchor-row X per line and the anchor-line
  Y per row; opposite-role holes untouched + reported; one Undo reverts all of it.
- Single-line selection behaves as a line straightener (X := anchor X down the line).
- Out-of-bounds targets report via `failed[]`; `npm run check` baseline unchanged.

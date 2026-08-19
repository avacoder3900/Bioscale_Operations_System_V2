# PRD: Quick-Seal shortcut (wax_qc / wax_ready → sealed)

> **Updated 2026-08-19 (`REAGENT-TOPSEAL-IMPLICIT.md`):** the target state is now
> `reagent_filled`, not `sealed` (`sealed` is retired; top seal is implicit). No `topSeal`
> stub is written any more. Everything else below still applies.

> **Amended 2026-08-17 by WAX-SIMPLIFY-1..3:** accepted input statuses are now
> `wax_filled` / `wax_ready` (plus legacy `wax_qc` rows). `wax_qc` is no longer produced.

## Goal
A dead-simple cart-mfg page where an operator **bulk-scans cartridge barcodes**
into a free-text box (no clicking between scans) and moves them all from the wax
inspection stage straight to **`sealed`** — the state right before the reagent
picture. This shortcuts the normal `wax_qc → wax_ready → reagent_filling →
reagent_filled → sealed` path for a workflow where those steps are handled outside
BIMS.

## Decisions (from operator)
- **Accepted input statuses:** `wax_qc` OR `wax_ready`. Anything else is rejected.
- **Transition:** set `status = 'sealed'`. Stamp operator + timestamp + AuditLog +
  a marker note. NO top-seal lot capture (keep the page fast). Record `priorStatus`
  for traceability.
- **Bad scans:** reject that individual cart (not found / wrong status) and report
  it; still process every valid cart in the batch.

## Route
`/manufacturing/cart-mfg/quick-seal` — new page + sidebar entry in cart-mfg.
`requirePermission('manufacturing:read')` to view, `'manufacturing:write')` to seal.

## UI (one screen)
- **Big free-text scan box** (`<textarea>`, autofocused, monospace). A keyboard-wedge
  scanner types the barcode + Enter; in a textarea Enter = newline, so each scan
  lands on its own line and **focus is retained** — scan many without clicking. Refocus
  the box after submit.
- Live count of distinct barcodes entered; **"Seal N carts"** button (disabled when
  empty / submitting); **Clear** button.
- Optional context: a small readout of how many carts are currently at `wax_qc` /
  `wax_ready` (load-function counts).
- **Results panel** after submit:
  - ✓ Sealed: N (list the barcodes).
  - ✗ Rejected: list `barcode — reason` (not found / status=<x>).
- Keep the scanned text after submit only for rejects (so the operator can re-scan
  or fix), or clear on full success.

## Server (`+page.server.ts`)
- `load`: counts of `wax_qc` + `wax_ready` carts (cheap `countDocuments`).
- action `seal`:
  1. Parse the textarea: split on any whitespace/newlines, trim, drop blanks, dedup.
  2. For each barcode: `CartridgeRecord.findById(barcode)`.
     - not found → reject `{barcode, reason:'not found'}`.
     - status ∉ {`wax_qc`,`wax_ready`} → reject `{barcode, reason:'status=<x>'}`.
     - else `updateOne($set: { status:'sealed', priorStatus:<old>, topSeal:{ operator,
       timestamp, recordedAt, source:'quick-seal-shortcut' } })` + push a note + AuditLog.
  3. Return `{ sealed:[...], rejected:[{barcode,reason}], counts }`.
- Direct DB writes (insert/update not blocked by sacred middleware — `finalizedAt`
  never set). One AuditLog row per sealed cart (`action:'quick_seal'`).

## Out of scope
- Top-seal lot linkage (deliberately omitted; the real Cut-Top-Seal step still does it).
- Undo UI — `priorStatus` + AuditLog make a manual revert possible if needed.

## Validation
- `npm run check` stays at the 11-error baseline; build green.
- Scan a mix of wax_qc, wax_ready, a completed cart, and a bogus barcode → the two
  wax-stage carts flip to `sealed`; the others are listed as rejected with reasons.
- The scan box keeps focus across many scans without a click.

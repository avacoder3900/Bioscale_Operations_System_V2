# BACKING-LOT-VISIBILITY — surface the backing lot (batch) + its cartridges

**Date:** 2026-06-15 · **Owner:** Jacob · **Status:** Approved (conversation 2026-06-15)
**Depends on:** WI01-BACKING-OVEN-SESSION

## Problem

After WAX-FLOW-2 the "backing lot" concept survives as the `LotRecord` batch
(every cartridge scanned in a session shares `backing.parentLotRecordId`, and each
cartridge already carries its scan time `backing.ovenEntryTime` and scanner
`backing.operator`). But the UI doesn't make this legible:

1. The backing page calls the batch list "Recent batches", and its row link points
   at `/manufacturing/lots/{lotId}` — a **dead route** (the real one is
   `/manufacturing/cart-mfg/lots/{lotId}`).
2. The lot detail page shows lot metadata + notes but **not the cartridges in the
   batch**, the **material lots consumed**, or the **oven** — so you can't see the
   per-cartridge who/when that the new atomic model captures.

## Design

### Backing page (`wi-01/+page.svelte`)
- Rename the "Recent batches" heading → **"Backing lots"**.
- Fix the row link to `/manufacturing/cart-mfg/lots/{lot.lotId}`.
- (Columns already show output lot # + qty/count — no change.)

### Lot detail (`cart-mfg/lots/[lotId]`)
- **load:** additionally return
  - `outputLotNumber`, `inputLots` (the 3 material lots), `ovenPlacement`/oven name
  - `cartridges` = `CartridgeRecord.find({ 'backing.parentLotRecordId': lotId })`
    projected to `{ barcode, status, scannedAt: backing.ovenEntryTime,
    scannedBy: backing.operator.username, oven: backing.ovenLocationName }`,
    sorted by scannedAt.
- **UI:**
  - Title prefers `outputLotNumber` for new lots (falls back to bucketBarcode/lotId).
  - New **Materials** block: the 3 input lots + the oven.
  - New **Cartridges in this batch** table: barcode · scanned-at · scanned-by ·
    oven · status. This is the per-cartridge atomic record, grouped by the lot.

## Out of scope
- Legacy aggregate `BackingLot` retirement (separate PRD BACKINGLOT-LEGACY-RETIREMENT).
- Editing the lot's cartridge membership from this page (read-only list).

## Acceptance
- Backing page shows a "Backing lots" list whose links open the correct lot page.
- The lot page shows the materials, oven, and a table of every cartridge in the
  batch with its scan time + scanner.
- `npm run check` clean vs baseline; build green.

# WAX-FLOW-2 — Per-cartridge origination at backing; retire BackingLot aggregate

**Date:** 2026-06-11 · **Owner:** Jacob · **Status:** Approved (conversation 2026-06-11)

## Problem

Today cartridges exist only as an aggregate `BackingLot.cartridgeCount` between WI-01 and wax
fill. Individuation (CartridgeRecord creation) happens at wax-deck loading
(`wax-filling/+page.server.ts:758-841`), gated by a bucket-barcode scan (`scanBackingLot`,
lines 425-566) with a per-lot oven-time check. Jacob's call: **kill the aggregate concept** —
scan every individual backed cartridge as it goes into the oven, originating its
CartridgeRecord right there. Wax fill then needs no backing-lot scan at all.

## New flow

### WI-01 (cartridge backing)

- `checkAndStart` unchanged: validate 3 material lots (PT-CT-104/112/106), create LotRecord.
- **`confirmComplete` is replaced by a per-cartridge scan screen** ("Add to Oven"):
  1. Operator picks the oven once (existing oven selection UI).
  2. Operator scans each backed cartridge's barcode (handheld scanner, autofocused input —
     same wedge pattern as `/capture`). Each scan **upserts a CartridgeRecord**:
     - `_id` = scanned barcode (UUID)
     - `status: 'backed'` (new status)
     - `backing: { parentLotRecordId, lotQrCode, cartridgeBlankLot, thermosealLot,
       barcodeLabelLot, ovenEntryTime: now, ovenLocationId, ovenLocationName, operator,
       recordedAt }` — note **`ovenLocationId`/`ovenLocationName` are new fields** on the
       `backing` subdoc (they previously lived only on BackingLot).
     - Duplicate guard: scan rejected if a CartridgeRecord already exists (any status).
  3. Running list + count shown; finish → LotRecord `status='Completed'`,
     `quantityProduced = scanned count`; inventory consumption (3 InventoryTransaction rows)
     exactly as today (`wi-01/+page.server.ts:289-396`).
- `BackingLot` documents are **no longer created**. `bucketBarcode` no longer collected.
- Per-scan AuditLog batched: one AuditLog row per finish summarizing cartridge ids.

### Wax filling

- **Delete** `scanBackingLot` action, `activeLotId` on WaxFillingRun, the BackingLot
  decrement/refund/`closeBackingLotEarly` machinery (`wax-filling/+page.server.ts:425-566,
  771-786, 1400-1467, 1490-1573`) and the lot-scan UI.
- `loadDeck` validation becomes per-cartridge: each scanned barcode must match an existing
  CartridgeRecord with `status: 'backed'`, and `now − backing.ovenEntryTime ≥
  settings.waxFilling.minOvenTimeMin`. Admin override (re-auth + reason, as today) applies
  per run. Lineage no longer copied at load time — it's already on the record. `loadDeck`
  stamps `backing.ovenExitTime`, `status='wax_filling'`, `waxFilling.runId`, `deckPosition`.
- Test mode: synthesizes `status:'backed'` CartridgeRecords instead of a TEST-LOT BackingLot.

### Downstream consumers (all switch from BackingLot to `CartridgeRecord {status:'backed'}`)

| File | Change |
|---|---|
| `cart-mfg/+page.server.ts:44-274` | Oven tiles: group backed carts by `backing.ovenLocationId`; ready = elapsed ≥ minOvenTimeMin |
| `pipeline/+page.server.ts:136-163` | Backing stage rows: group by parentLotRecordId (one row per WI-01 batch), count from records |
| `cartridge-dashboard/+page.server.ts:111-149` | Oven occupancy aggregation on CartridgeRecord |
| `consumables/+page.server.ts:28-32` | "Backed" tile via countDocuments |
| `equipment-status.ts:77-122` | Oven inUse = any backed cart with that ovenLocationId |
| `equipment-activity.ts:96-107` | Activity events from backed carts (grouped per lot per day) |
| `scrap/+page.server.ts:134-221` | `removeFromBackingLot` → scan individual cartridge, set `status:'scrapped'` (cartridge-level, ManualCartridgeRemoval with cartridgeIds) |

## Legacy data / transition

- Existing non-consumed BackingLots (aggregate counts in ovens) can't be auto-converted — no
  per-cartridge barcodes were recorded. Transition: dashboard/pipeline keep a **read-only
  legacy row** for BackingLots with `cartridgeCount > 0` (labeled "legacy lot"), but wax fill
  no longer accepts them. Physical cartridges from those buckets get scanned through the new
  WI-01 "Add to Oven" screen (a `backfill` mode on that screen lets the operator attach them to
  their original LotRecord, or to a generic legacy LotRecord if unknown).
- BackingLot model stays in the codebase (historical reads); no new writes anywhere.
- One-off script `scripts/close-legacy-backing-lots.ts` (dry-run default) to mark drained lots
  `consumed` once the floor confirms buckets are empty.

## Acceptance

- A cartridge scanned at WI-01 immediately exists as CartridgeRecord `status='backed'` with
  full material lineage and oven entry time; visible on dashboard oven tiles and pipeline.
- Wax fill deck loading accepts only `backed` carts past min oven time (override path works);
  no bucket scan anywhere in the flow.
- Counts on dashboard/pipeline/consumables match `status:'backed'` queries; checked-out filter
  (`getCheckedOutCartridgeIds`) still applied where it is today.
- `npm run check` clean of new errors.

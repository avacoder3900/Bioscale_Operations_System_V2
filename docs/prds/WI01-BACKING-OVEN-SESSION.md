# WI01-BACKING-OVEN-SESSION — Oven-first backing session (dropdowns + rapid scan)

**Date:** 2026-06-15 · **Owner:** Jacob · **Status:** Approved (conversation 2026-06-15)
**Supersedes the front half of:** WAX-FLOW-2 WI-01 flow (the lot-scan + quantity steps)

## Problem

The Backing page (`/manufacturing/cart-mfg/wi-01`) makes the operator scan 3
material-lot barcodes, then enter a quantity, then "work", and only *then* select
an oven and rapid-scan cartridges. Jacob wants the fast path the floor actually
needs: **configure the batch once (pick the 3 material lots + the oven from
dropdowns), then stay in a scanning "session" and rapid-fire scan cartridge
barcodes — each cartridge inheriting the selected lots + oven.**

The oven rapid-scan and per-cartridge origination already exist (WAX-FLOW-2); this
just moves the config to the front, swaps barcode scans for dropdowns, and drops
the quantity step.

## Design

### Flow: `config → session → finish`  (was start → scan → qty → working → oven → confirm)

**1. Config (one screen):**
- Three **dropdowns**, one per consumed material, populated from the available
  ReceivingLots for that part (not rejected/returned), showing lotId + remaining qty:
  - Cartridge blank (`PT-CT-104`)
  - Thermoseal laser-cut sheet (`PT-CT-112`)
  - Barcode label (`PT-CT-106`)
- One **oven dropdown** (existing `ovens` list).
- Inventory summary cards stay at top. "Resume in-progress batch" stays.
- Button **Start session** → `checkAndStart` with the 3 selected lotIds (no quantity).

**2. Session (rapid scan):**
- Header shows the locked-in config (3 lots + oven) — read-only for the session.
- Autofocused barcode input; each Enter → `scanBackedCartridge { lotId, barcode, ovenId }`
  → CartridgeRecord `status:'backing'` stamped with the 3 lots + oven + entry time.
- Running list + live count, per-item remove (existing `removeBackedCartridge`),
  success/error beep (existing). No planned target — count = whatever is scanned.
- Button **Finish session**.

**3. Finish:**
- Optional per-part scrap counts + reason + notes (existing confirm UI), then
  `confirmComplete` → consumes inventory = scanned count (+scrap) per material,
  lot → Completed. (Already computes from `cartridgeIds.length`, not quantity.)

### Server changes (small — most already exists)
- `load`: add `availableLots` = for each consumed part, the ReceivingLots
  (status not rejected/returned) with `{ lotId, quantity, remaining }` for the
  dropdowns. (Reuse the consumed-aggregate math from `validateLot`.)
- `checkAndStart`: make `quantity` **optional** — if absent/0, set
  `plannedQuantity` accordingly and **skip** the upfront insufficient-inventory
  precheck (consumption is reconciled at `confirmComplete` from the real count).
  Still validates each selected lot via `validateLotForPart`.
- `scanBackedCartridge`, `removeBackedCartridge`, `confirmComplete`: **unchanged.**

### UI file
- Rewrites `wi-01/+page.svelte` flow (a `.svelte` UI change — deliberate feature
  work, authorized in this conversation). Reuses the existing oven-scan and
  confirm markup/handlers; replaces the scan/qty/working stages with the config
  dropdowns. No change to shared components.

## Out of scope
- Wax-fill changes (separate; the oven-scan was never in wax fill).
- Robot auto-sweep at the backing station (manual handheld scan only, as today).

## Acceptance
- Backing page opens to: 3 material-lot dropdowns + oven dropdown + Start session.
- Start session → immediately a scanning session; rapid-fire scans each create a
  `backing` CartridgeRecord with the selected 3 lots + oven + entry time.
- Finish → inventory consumed = scanned count (+scrap); lot Completed; cartridges
  appear on the oven queue / pipeline exactly as today.
- `npm run check` clean vs baseline; build green.

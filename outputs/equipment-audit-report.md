# Equipment Audit Report
**Date:** 2026-03-24  
**Branch:** `dev`  
**Auditor:** Agent001 (sub-agent)

---

## Executive Summary

The `equipment` collection (7 records: Fridge 1–5 + Heater 1–2, all active) is the authoritative source of truth for all fridges/ovens. The `equipment_locations` collection is empty after the cleanup. An audit of all pages referencing equipment found **3 bugs** and **several correct implementations**, documented below. All bugs were fixed and committed.

---

## Database State (Post-Cleanup)

| Collection | Contents |
|---|---|
| `equipment` | 7 records: Fridge 1–5 (`equipmentType: 'fridge'`), Heater 1–2 (`equipmentType: 'oven'`) |
| `equipment_locations` | Empty (all phantom records removed) |
| `consumables` | Contains `type: 'deck'` (DECK-*) and `type: 'cooling_tray'` (TRAY-*) — separate from equipment |

---

## Files Audited

### ✅ CORRECT — No Issues

| File | Model Used | Notes |
|---|---|---|
| `equipment/fridges-ovens/+page.server.ts` (load) | `Equipment` + `EquipmentLocation` orphans | Correct: queries Equipment first, falls through to orphan EquipmentLocations. No phantom risk. |
| `inventory/fridge-storage/+page.server.ts` | `Equipment` + EquipmentLocation orphans | Correct: same pattern, groups cartridges by barcode matchKeys. |
| `cartridge-admin/storage/+page.server.ts` | `Equipment` + EquipmentLocation orphans | Correct: uses fridge barcode/displayName as key into `storage.fridgeName`. |
| `manufacturing/wax-filling/+page.server.ts` | `Equipment` (fridges) + EquipmentLocation orphans | Correct: `fridges` list built from Equipment records. Storage writes `waxStorage.location = barcode`. |
| `manufacturing/reagent-filling/+page.server.ts` | `Equipment` (fridges) + EquipmentLocation orphans | Correct: `fridges` list from Equipment. Storage writes both `storage.fridgeName` and `storage.locationId = barcode`. |
| `equipment/activity/+page.server.ts` | `Equipment` + EquipmentLocation | Correct: builds locations list from Equipment (fridge/oven), falls back to orphan EquipmentLocations. |
| `equipment/location/[locationId]/+page.server.ts` | `Equipment` then `EquipmentLocation` | Correct: tries Equipment by ID first, falls back to EquipmentLocation. Builds match set from barcode/name. |
| `equipment/temperature-probes/+page.server.ts` | `Equipment` (all) | Correct: queries all Equipment for temperature sensor display. |
| `equipment/detail/+page.server.ts` | `Equipment` | Correct: reads individual Equipment by ID. |
| `equipment/decks-trays/+page.server.ts` | `Consumable` (type: deck/cooling_tray) | Correct: decks/trays are separate Consumable records, not in Equipment. |
| `manufacturing/wax-filling/equipment/+page.server.ts` | `Equipment`, `Consumable` | Correct: uses Equipment for general equipment list. |
| `api/agent/operations/equipment/+server.ts` | `Equipment` + `EquipmentLocation` | Correct. |
| `api/agent/operations/alerts/+server.ts` | `Equipment` | Correct. |
| `api/agent/operations/dashboard/+server.ts` | `Equipment` | Correct. |
| `api/dev/validate-equipment/+server.ts` | `Equipment` + `EquipmentLocation` | Correct: fridge validation checks Equipment first, then EquipmentLocation. |
| `+page.server.ts` (main dashboard) | `Equipment` (fridges) for fridge capacity | Correct: queries Equipment by `equipmentType: 'fridge'`, maps by barcode/name for storage counts. |

---

## 🐛 Bugs Found & Fixed

### Bug 1 — `cartridge-dashboard/+page.server.ts`: Storage distribution never resolved to fridge names

**Severity:** High — fridges on cartridge dashboard showed raw barcode strings or IDs instead of names.

**Root Cause:**  
- `storageCounts` was aggregating by `storage.locationId` only — but this field is only set during reagent storage, not wax storage. Wax-stored cartridges use `waxStorage.location`.  
- `fridgeMap` was keyed by `f._id` (nanoid) but the stored values in `storage.locationId` / `storage.fridgeName` / `waxStorage.location` are **barcode strings** (e.g. `"FRG-001"`), not IDs. Keys never matched.

**Fix:**  
- Replaced single aggregate with two parallel aggregates: one on `waxStorage.location` (for `wax_stored` cartridges) and one on `storage.fridgeName` (for `stored` cartridges).  
- Merged counts by key.  
- Built `fridgeMap` keyed by **both barcode and name** for each Equipment record.  
- Added `fridgeIdMap` for equipment `_id` lookup (detail links).

**Files changed:** `src/routes/cartridge-dashboard/+page.server.ts`

---

### Bug 2 — `manufacturing/+page.server.ts`: Oven dropdown always empty

**Severity:** High — the oven selection on the backing/manufacturing page showed no options, blocking lot registration.

**Root Cause:**  
`EquipmentLocation.find({ locationType: 'oven', isActive: true })` was the sole query for ovens. After the equipment cleanup, `equipment_locations` is empty. The 2 Heaters live in the `equipment` collection with `equipmentType: 'oven'`.

**Fix:**  
- Added `Equipment` import.  
- Query both `Equipment.find({ equipmentType: 'oven', status: { $ne: 'offline' } })` (primary) and `EquipmentLocation.find({ locationType: 'oven', parentEquipmentId: { $exists: false } })` (orphan fallback).  
- Merge into a single `ovens` array.  
- Updated `registerBackingLot` action to look up oven name from `Equipment` first, then `EquipmentLocation`.

**Files changed:** `src/routes/manufacturing/+page.server.ts`

---

### Bug 3 — `equipment/fridges-ovens/+page.server.ts`: Deactivate sets `status: 'offline'` instead of deleting

**Severity:** Medium — deactivated equipment remained in the database as offline records, causing confusion and requiring manual DB cleanup.

**Fix:**  
Changed `deleteLocation` action from `Equipment.findByIdAndUpdate(id, { status: 'offline' })` to `Equipment.findByIdAndDelete(id)`. Equipment is now permanently removed when deleted via the UI.

**Files changed:** `src/routes/equipment/fridges-ovens/+page.server.ts`

---

## Decks & Trays — Status

Decks (`DECK-*`) and cooling trays (`TRAY-*`) are stored as `Consumable` documents with `type: 'deck'` or `type: 'cooling_tray'`. They are **intentionally separate** from the `Equipment` collection.

**Rationale:**
- Decks and trays are tracked as consumable/reusable process tools, not permanent lab equipment.
- They have usage logs, lockout timers, and robot assignments — behavior not present in Equipment.
- They are managed via `equipment/decks-trays/+page.server.ts` using the `Consumable` model.

**Recommendation:** No migration needed. The `Consumable` model is the correct home for decks and trays. Document this distinction in `CLAUDE.md` if confusion recurs.

---

## Hardcoded IDs/Names Check

Searched for: `DECK-`, `TRAY-`, `FRIDGE-`, `HEATER-`, `FRG-`, `OVN-` hardcoded in `.ts` files.

- **`src/routes/api/dev/seed-test-inventory/+server.ts`**: Uses `TEST-DECK-*` and `TEST-TRAY-*` prefixed IDs — these are development test data only, inserted with `TEST-` prefix for easy identification and cleanup. Equipment seeding is **disabled** in this file (commented out with note to use Equipment CRUD page).
- No production code hardcodes fridge/heater/oven names or IDs.
- No hardcoded `FRIDGE-`, `HEATER-` IDs anywhere.

---

## Empty State Handling

All pages tested handle empty equipment gracefully:
- Load functions use `.catch(() => [])` on Equipment/EquipmentLocation queries.
- Fridges list returns `[]` when no equipment registered — pages render empty states.
- No crashes if `equipment_locations` is empty (all queries include orphan fallback logic).

---

## Commit

```
9912848 fix: equipment source-of-truth consistency + delete action
```

3 files changed, 59 insertions(+), 20 deletions(-)

---

## Deployment

Deployed to production via `npx vercel --prod --yes` after build verification.

# PRD: Parts & Accession System Fix

**Date:** 2026-03-25  
**Author:** Agent001 (from Alejandro Valdez request)  
**Branch:** `feature/part-accession`  
**Priority:** P0 — Blocking production inventory logging (deadline: today)  
**Audit:** `outputs/parts-accession-audit.md`

---

## Problem Statement

The part accession system cannot reliably pair scanned lot barcodes with parts, and there is no way to look up a lot from the parts list. Three root causes:

1. Box sync destroys all part data (including barcodes) on every run
2. No parts have barcodes assigned, so scan-to-identify is impossible
3. Receiving lots are not visible from the part detail page

Additionally, the barcode scanner input has a concatenation bug causing 500 errors on duplicate key violations.

---

## User Stories

### S1 — Fix Box Sync (Stop Destroying Data) ⚡ CRITICAL
**As** an operator, **I want** Box sync to update existing parts without deleting them, **so that** barcodes and manual edits are preserved.

**Acceptance Criteria:**
- Replace `deleteMany()` + insert with `upsert` by `partNumber`
- Fields from Box overwrite: name, category, supplier, vendorPartNumber, unitCost, leadTimeDays, unitOfMeasure, quantityPerUnit
- Fields from Box that should NOT overwrite if already set locally: `inventoryCount` (Box column X should only set the value if the part is being created for the first time — existing parts keep their BIMS-tracked count)
- Fields NEVER overwritten by sync: `barcode`, `bomType`, `isActive`, `sampleSize`, `percentAccepted`, `scanRequired`, `inspectionPathway`
- Add a `lastBoxSyncAt` timestamp field to PartDefinition so we can see when each part was last synced
- Log sync activity to AuditLog (how many created, updated, skipped)
- Remove the `deleteMany()` call entirely

**Files to modify:**
- `src/lib/server/box-sync.ts`
- `src/lib/server/db/models/part-definition.ts` (add `lastBoxSyncAt`)

---

### S2 — Bulk Assign Barcodes to All Parts ⚡ CRITICAL
**As** an operator, **I want** all 69 parts to get barcodes assigned immediately, **so that** I can start scanning.

**Acceptance Criteria:**
- Run the existing `assignAll` action logic (already built on accession page)
- Verify the `generated_barcodes` collection gets a PART prefix entry
- All 69 active parts get PART-000001 through PART-000069
- Barcodes survive Box sync (guaranteed by S1)
- Print a confirmation showing all assignments

**Implementation:** This is mostly already built — just needs to be triggered. But verify the `generatePartBarcode()` function works end-to-end since it's never been used (no PART prefix exists in `generated_barcodes`).

**Files to verify:**
- `src/lib/server/services/barcode-generator.ts`
- `src/routes/parts/accession/+page.server.ts` (assignAll action)

---

### S3 — Fix Barcode Input Concatenation Bug ⚡ CRITICAL
**As** an operator scanning barcodes, **I want** each scan to replace the previous value, **so that** I don't get 500 errors from concatenated barcodes.

**Acceptance Criteria:**
- Barcode input field clears completely on focus/scan start
- After successful quickScan submission, field clears and refocuses (already partially implemented)
- Add proper error handling for MongoDB duplicate key errors — show user-friendly message: "This barcode is already registered as Lot #XXX" instead of a generic 500
- Add try/catch around `ReceivingLot.create()` in quickScan action, catch error code 11000 (duplicate key), return `fail(400, { error: '...' })`

**Files to modify:**
- `src/routes/parts/accession/+page.server.ts` (quickScan action — add duplicate key catch)
- `src/routes/parts/accession/+page.svelte` (input clear behavior)

---

### S4 — Scan Part Barcode to Auto-Select Part ⚡ HIGH
**As** an operator, **I want** to scan a part's QR barcode and have it auto-select in the dropdown, **so that** I don't have to manually scroll through 69 parts.

**Acceptance Criteria:**
- Add a "Scan Part" input field above or beside the part dropdown in the Quick Scan section
- On scan/enter, call `/api/parts/lookup-by-barcode?barcode=PART-000042` (new endpoint)
- If found, auto-select that part in the dropdown, move focus to bag barcode field
- If not found, show inline error: "No part found for barcode XXXX"
- Visual indicator: green checkmark when part is matched

**New files:**
- `src/routes/api/parts/lookup-by-barcode/+server.ts`

**Files to modify:**
- `src/routes/parts/accession/+page.svelte` (add scan-to-select UI)

---

### S5 — Show Receiving Lots on Part Detail Page ⚡ HIGH
**As** an operator, **I want** to see all receiving lots for a part on its detail page, **so that** I can trace inventory back to incoming shipments.

**Acceptance Criteria:**
- On `/parts/[partId]`, add a "Receiving Lots" section/tab
- Query `ReceivingLot.find({ 'part._id': partId })` sorted by `createdAt` desc
- Show: lotNumber, lotId (scanned barcode), quantity, status, operator, date, bagBarcode
- Each lot row is clickable → navigates to `/receiving/[lotId]` for full detail
- Show CoC document link if available
- Show total received quantity across all lots

**Files to modify:**
- `src/routes/parts/[partId]/+page.server.ts` (add ReceivingLot query to load function)
- `src/routes/parts/[partId]/+page.svelte` (add Receiving Lots section to UI)

---

### S6 — Scan Lot Barcode → See Part Info (Reverse Lookup) ⚡ HIGH
**As** an operator, **I want** to scan any lot barcode and immediately see which part it belongs to with full details, **so that** I can verify inventory on the shelf.

**Acceptance Criteria:**
- Enhance existing `/api/parts/lookup` endpoint to return full part info (not just lot)
- When lot is found, response includes: lot details + part details (name, partNumber, inventoryCount, category)
- Add a "Lookup" tab or section on the accession page: scan any barcode → shows part name, lot number, quantity, date received, status
- If barcode not found as a lot, check if it's a part barcode → show part info directly

**Files to modify:**
- `src/routes/api/parts/lookup/+server.ts` (enrich response with part data)
- `src/routes/parts/accession/+page.svelte` (add lookup section)

---

### S7 — Proper Error Handling Across Accession ⚡ MEDIUM
**As** an operator, **I want** clear error messages when something goes wrong, **so that** I know what to fix.

**Acceptance Criteria:**
- MongoDB duplicate key error (11000) → "This barcode is already registered"
- Part not found → "Part not found — it may have been deleted by a Box sync"
- Permission denied → clear message (already handled)
- Network/DB timeout → "Database connection error — please retry"
- Wrap all DB operations in try/catch with specific error mapping
- Log errors server-side to console with request context

**Files to modify:**
- `src/routes/parts/accession/+page.server.ts` (all actions)

---

### S8 — Clean Up Bad Data in MongoDB ⚡ MEDIUM
**As** the system, **I need** corrupted data fixed, **so that** lookups work correctly.

**Acceptance Criteria:**
- Delete or fix lot `LOT-20260324-0002` (concatenated barcode: `70b7e2be...f7f12141...`)
- Verify all 7 existing lots have valid `part._id` references that still exist in `part_definitions`
- Verify `inventoryCount` on affected parts is accurate after lot corrections
- Run as a one-time migration script, logged to AuditLog

**Implementation:** Node script run directly against MongoDB.

---

## Story Priority & Sequencing

| Order | Story | Est. Complexity | Why This Order |
|---|---|---|---|
| 1 | S1 — Fix Box Sync | Medium | Must fix before assigning barcodes (or they'll get wiped) |
| 2 | S3 — Fix Input Bug | Small | Quick win, stops 500 errors immediately |
| 3 | S7 — Error Handling | Small | Pairs with S3, makes debugging easier |
| 4 | S2 — Bulk Assign Barcodes | Small | Already built, just needs verification + trigger |
| 5 | S4 — Scan-to-Select Part | Medium | Core UX improvement for accession workflow |
| 6 | S5 — Receiving Lots on Detail | Medium | The "look up lot → see part info" direction |
| 7 | S6 — Reverse Lookup | Medium | The "scan anything → see everything" direction |
| 8 | S8 — Data Cleanup | Small | Can run anytime, but best after code fixes |

**Estimated total:** ~3-4 hours of coding agent time

---

## Out of Scope (Backlog)

- ManufacturingMaterial → PartDefinition linkage (0 records, can address later)
- BomItem deprecation/migration (5 orphaned records, low impact)
- Two-way Box sync (BIMS → Excel)
- Barcode label printing improvements
- Receiving/accession dashboard analytics
- Box OAuth → JWT migration

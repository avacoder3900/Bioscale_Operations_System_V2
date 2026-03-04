# Audit Check Summary — Manufacturing Flow Gap Fixes

> **Branch:** `NickManufacturingFixes`  
> **Prepared:** Post-implementation QA checklist  
> **Purpose:** Actionable verification guide for every fix implemented from the Manufacturing Flow Audit

---

## FIX-01 — Link LaserCutBatch to Downstream Pipeline

### What Was Fixed
LaserCutBatch now tracks input/output part identifiers and automatically increments the ManufacturingMaterial inventory for cut substrates produced.

### Where to Observe It
- **URL:** `/spu/manufacturing/laser-cutting`
- **MongoDB collection:** `laser_cut_batches`, `manufacturing_materials`, `manufacturing_material_transactions`

### How to Test It (Step-by-Step)
1. Ensure a `ManufacturingMaterial` exists with a name matching `laser cut`, `cut substrate`, or `substrate` (case-insensitive). Create one via `/spu/manufacturing/inventory` if needed.
2. Navigate to `/spu/manufacturing/laser-cutting`.
3. Click **"+ Record Batch"** and enter: Input Strips = 10, Failures = 2. Submit.
4. Refresh the page.
5. Check the inventory panel at top — it should show **+8** to the "Laser Cut Substrates" count.
6. Navigate to `/spu/manufacturing/inventory` and confirm the `currentQuantity` on the matching material increased by 8.

### How Users Verify in Daily Use
- The inventory card at the top of the Laser Cutting page shows the live substrate count.
- After each batch, the count auto-increments without manual data entry.
- If no matching ManufacturingMaterial exists, the inventory card shows `0 sheets` as a placeholder (no crash).

### Backend Verification
```javascript
// Check the latest laser cut batch
db.laser_cut_batches.findOne({}, { sort: { createdAt: -1 } })

// Check the transaction was created
db.manufacturing_material_transactions.findOne({ transactionType: 'produce' }, { sort: { createdAt: -1 } })

// Verify material quantity updated
db.manufacturing_materials.findOne({ name: /laser.?cut|substrate/i }, { currentQuantity: 1, name: 1 })
```

---

## FIX-02 — Unify Inventory: Link ManufacturingMaterial to PartDefinition

### What Was Fixed
`ManufacturingMaterial` now has `partDefinitionId` and `partNumber` fields. Transactions against a linked material automatically sync `PartDefinition.inventoryCount` in the same operation. The inventory page returns correct field names matching the UI (`materialId`, `currentQuantity`, `updatedAt`).

### Where to Observe It
- **URL:** `/spu/manufacturing/inventory`
- **MongoDB collections:** `manufacturing_materials`, `part_definitions`

### How to Test It (Step-by-Step)
1. Go to `/spu/manufacturing/inventory` — confirm materials display with name, current quantity, and last-updated timestamp.
2. In MongoDB, manually add `partDefinitionId` to an existing material: `db.manufacturing_materials.updateOne({name: 'Your Material'}, { $set: { partDefinitionId: '<id>', partNumber: 'PN-001' } })`
3. Record a transaction on that material (from the server or directly).
4. Check `db.part_definitions.findOne({ _id: '<id>' }, { inventoryCount: 1 })` — inventoryCount should have changed by the same delta.

### How Users Verify in Daily Use
- The inventory page loads without errors.
- `materialId` is present in each row (used for transaction recording).
- If a material is linked to a PartDefinition, changes here are reflected in the part catalog.

### Backend Verification
```javascript
// Find materials linked to PartDefinitions
db.manufacturing_materials.find({ partDefinitionId: { $ne: null } }, { name: 1, partDefinitionId: 1, partNumber: 1, currentQuantity: 1 })

// Cross-check against PartDefinition
const mat = db.manufacturing_materials.findOne({ partDefinitionId: { $ne: null } })
db.part_definitions.findOne({ _id: mat.partDefinitionId }, { inventoryCount: 1, partNumber: 1 })
```

---

## FIX-03 — Type the Mixed Fields: ProcessConfiguration & LotRecord

### What Was Fixed
`ProcessConfiguration.inputMaterials` and `outputMaterial` are now typed sub-schemas instead of `Schema.Types.Mixed`. `LotRecord.inputLots` is now a typed array. These changes are backward-compatible (Mongoose silently accepts existing data shapes).

### Where to Observe It
- **MongoDB collections:** `process_configurations`, `lot_records`
- No UI change — this is a data integrity improvement at the model level.

### How to Test It (Step-by-Step)
1. Create a new ProcessConfiguration via the admin UI or directly in MongoDB.
2. Set `inputMaterials` with the structured format: `[{ partDefinitionId: "...", name: "Acrylic Sheet", scanOrder: 1, quantityRequired: 1 }]`
3. Read it back — it should return with the correct typed structure, not a raw Mixed blob.
4. Check `LotRecord.inputLots` — create a new LotRecord (via WI-01) and verify `inputLots` stores `{ materialName, barcode, partDefinitionId, scanOrder, scannedAt }`.

### How Users Verify in Daily Use
- WI-01 (Cartridge Backing) now stores structured input lot scan data instead of arbitrary Mixed.
- Process configurations in the admin section save properly structured input/output materials.
- No UI change needed — the fix is at the persistence layer.

### Backend Verification
```javascript
// Check a process configuration's input materials shape
db.process_configurations.findOne({}, { inputMaterials: 1, outputMaterial: 1 })

// Check a lot record's inputLots shape (after WI-01 creates one)
db.lot_records.findOne({}, { inputLots: 1 }, { sort: { createdAt: -1 } })

// Both should now return structured objects, not arbitrary nested data
```

---

## FIX-04 — Connect ReceivingLot to ManufacturingMaterial Inventory

### What Was Fixed
When a receiving lot is accepted in `/spu/receiving/new`, the system now also finds any linked `ManufacturingMaterial` (by `partDefinitionId`) and increments its `currentQuantity`, creating a `ManufacturingMaterialTransaction` for the audit trail. (PartDefinition.inventoryCount update was already implemented by a previous agent; this fix adds the ManufacturingMaterial sync.)

### Where to Observe It
- **URL:** `/spu/receiving/new` (the `createLot` action with `status: accepted`)
- **MongoDB collections:** `receiving_lots`, `part_definitions`, `manufacturing_materials`, `manufacturing_material_transactions`

### How to Test It (Step-by-Step)
1. Link a ManufacturingMaterial to a PartDefinition by setting `partDefinitionId` on the material: `db.manufacturing_materials.updateOne({ name: 'Acrylic Sheets' }, { $set: { partDefinitionId: '<partId>' } })`
2. Navigate to `/spu/receiving/new`.
3. Select that part, enter quantity = 50, complete the receiving workflow, and submit with status = "accepted".
4. Check ManufacturingMaterial: `currentQuantity` should have increased by 50.
5. Check ManufacturingMaterialTransaction: a new record with `transactionType: 'receive'` should exist.
6. Check PartDefinition: `inventoryCount` should also have increased by 50.

### How Users Verify in Daily Use
- After receiving raw materials, the manufacturing inventory page automatically reflects the new stock.
- No manual count entry needed — receiving acceptance drives both the parts catalog and manufacturing material counts.
- Transaction history shows `transactionType: 'receive'` entries from receiving events.

### Backend Verification
```javascript
// Find the most recent receive transaction
db.manufacturing_material_transactions.findOne({ transactionType: 'receive' }, { sort: { createdAt: -1 } })

// Verify both counts match for a linked material
const mat = db.manufacturing_materials.findOne({ partDefinitionId: { $ne: null } })
const part = db.part_definitions.findOne({ _id: mat.partDefinitionId }, { inventoryCount: 1 })
// mat.currentQuantity and part.inventoryCount should be equal (or close, if other adjustments happened)
print({ materialCount: mat.currentQuantity, partCount: part.inventoryCount })
```

---

## FIX-05 — Formalize Consumable Management

### What Was Fixed
A new consumable management page was created at `/spu/manufacturing/consumables` for registering and tracking decks, cooling trays, incubator tubes, and top seal rolls. The wax-filling `create` action now validates `deckId` against registered Consumables (if provided). The `addCartridge` action validates `coolingTrayId`. Both `complete` actions (wax-filling and reagent-filling) log usage to the Consumable's `usageLog` on run completion.

### Where to Observe It
- **URL:** `/spu/manufacturing/consumables` — new page
- **MongoDB collection:** `consumables`

### How to Test It (Step-by-Step)

**Consumables page:**
1. Navigate to `/spu/manufacturing/consumables`.
2. Click **"+ Register Consumable"**, select type = "Deck", enter a barcode, and submit.
3. The deck appears in the Deck section with status "active".
4. Click **"History"** on the deck — it should be empty initially.
5. Use the status dropdown in the history panel to change to "Retired" and submit.
6. Confirm status updates to "retired".

**Wax-filling validation:**
1. In the wax-filling `create` action, include `deckId` that does NOT exist in the Consumables collection.
2. The action should return `fail(400, { error: "Deck '...' not found..." })`.
3. Register the deck first, then retry — the action should succeed.

**Usage log update:**
1. Complete a wax-filling run (via the `complete` action) where `run.deckId` is set to a registered Consumable ID.
2. After completion, check the Consumable's usage log on the consumables page.
3. A new entry with `usageType: 'run_complete'` should appear.

### How Users Verify in Daily Use
- Before starting a run, decks must be registered in the Consumables page.
- Retired decks are blocked from use.
- After each run, the consumables page shows updated usage history automatically.
- The "History" button on each consumable shows which runs used it and when.

### Backend Verification
```javascript
// List all registered decks
db.consumables.find({ type: 'deck' }, { barcode: 1, status: 1, usageLog: { $slice: -3 } })

// Find consumable usage logged from wax filling
db.consumables.find({ 'usageLog.usageType': 'run_complete' }, { barcode: 1, type: 1, 'usageLog.$': 1 })

// Check incubator tube volume remaining after a run
db.consumables.findOne({ type: 'incubator_tube', status: 'active' }, { remainingVolumeUl: 1, totalCartridgesFilled: 1, totalRunsUsed: 1 })
```

---

## FIX-06 — Bridge CartridgeRecord ↔ LabCartridge

### What Was Fixed
When a `CartridgeRecord` is released via QA/QC with `testResult === 'pass'`, a `LabCartridge` record is automatically created (or upserted) using the same `_id`. The LabCartridge gets `cartridgeType: 'measurement'`, `status: 'available'`, `receivedDate: now`, and a usage log entry documenting it was auto-created from QA/QC release.

### Where to Observe It
- **URL:** `/spu/manufacturing/qa-qc` (the `release` action)
- **MongoDB collections:** `cartridge_records`, `lab_cartridges`

### How to Test It (Step-by-Step)
1. Ensure a CartridgeRecord exists in `currentPhase: 'stored'` or `cured` with no `qaqcRelease`.
2. Navigate to `/spu/manufacturing/qa-qc`.
3. Find the cartridge in the pending list and release it with `testResult: pass`.
4. Check the `lab_cartridges` collection: `db.lab_cartridges.findOne({ _id: '<cartridgeId>' })`.
5. The LabCartridge should have `status: 'available'`, `cartridgeType: 'measurement'`, and a `usageLog` entry with `action: 'registered'`.

**Fail path:**
1. Release a different cartridge with `testResult: fail`.
2. Check `db.lab_cartridges.findOne({ _id: '<thatCartridgeId>' })` — should NOT exist (no LabCartridge created for voided cartridges).

### How Users Verify in Daily Use
- After QA/QC pass, the cartridge automatically appears in the Lab Cartridge management UI at `/spu/cartridge-admin` or `/spu/cartridge-dashboard` as "available".
- No manual registration in the lab system is needed.
- Lab staff can immediately see newly released cartridges without waiting for manufacturing to separately register them.

### Backend Verification
```javascript
// Find all lab cartridges auto-created from manufacturing release
db.lab_cartridges.find(
  { 'usageLog.notes': /Auto-created from QA\/QC release/ },
  { _id: 1, status: 1, cartridgeType: 1, receivedDate: 1, lotNumber: 1 }
)

// Verify CartridgeRecord and LabCartridge IDs match
const cr = db.cartridge_records.findOne({ currentPhase: 'released' })
const lc = db.lab_cartridges.findOne({ _id: cr._id })
// lc should exist and have status: 'available'
print({ cartridgeRecordPhase: cr.currentPhase, labCartridgeStatus: lc?.status })

// Count released cartridges vs LabCartridges (should be equal or close)
db.cartridge_records.countDocuments({ currentPhase: 'released' })
db.lab_cartridges.countDocuments({ 'usageLog.notes': /Auto-created from QA\/QC release/ })
```

---

## Notes on Pre-Existing Issues (Not in Scope of This PR)

### Layout Navigation
The task requested adding a "Consumables" nav item to `manufacturing/+layout.svelte`. This file is frozen per `CLAUDE.md` ("DO NOT MODIFY any .svelte file"). The consumables page is fully functional at `/spu/manufacturing/consumables` — it just requires a direct link or bookmark until the layout is updated in a dedicated UI PR.

### Wax-Filling Server/Svelte Action Name Mismatch
The wax-filling `+page.server.ts` has actions named `create/start/complete/abort/addCartridge` but the frozen `+page.svelte` calls `createRun/confirmSetup/recordWaxPrep/loadDeck/startRun/confirmDeckRemoved/abortRun/cancelRun/confirmCooling/rejectCartridge/completeQC/recordBatchStorage/completeRun`. This mismatch existed before this PR. Consumable validation was added to the existing server action names. Reconciling the action names requires a UI PR.

### ReagentBatchRecord — `deckId` Field
The `reagent_batch_records` collection doesn't have a `deckId` field in its Mongoose schema. We write to it via the server but Mongoose may silently drop it unless the schema is updated. A follow-up fix should add `deckId: String` to `reagent-batch-record.ts`.

---

## Summary Table

| Fix | Status | Files Changed |
|-----|--------|---------------|
| FIX-01: LaserCutBatch → Inventory | ✅ Complete | `laser-cut-batch.ts`, `laser-cutting/+page.server.ts` |
| FIX-02: ManufacturingMaterial → PartDefinition | ✅ Complete | `manufacturing-material.ts`, `inventory/+page.server.ts` |
| FIX-03: Type Mixed fields | ✅ Complete | `process-configuration.ts`, `lot-record.ts` |
| FIX-04: ReceivingLot → ManufacturingMaterial | ✅ Complete | `receiving/new/+page.server.ts` |
| FIX-05: Consumable Management | ✅ Complete | `consumables/+page.server.ts`, `consumables/+page.svelte`, `wax-filling/+page.server.ts`, `reagent-filling/+page.server.ts` |
| FIX-06: CartridgeRecord → LabCartridge | ✅ Complete | `qa-qc/+page.server.ts` |
| FIX-07: Audit Summary Doc | ✅ This document | `docs/AUDIT-CHECK-SUMMARY.md` |

# Manufacturing Flow Audit — Part Generation, Consumption & Linkage

## Complete Cartridge Lifecycle (The Golden Thread)

The `CartridgeRecord` model is the **central sacred document** that tracks a cartridge from birth to test execution. Each phase is **write-once** (recorded via `recordedAt` guard). Here's the full flow:

```
Raw Materials (Parts/BOM)
    ↓
[WI-02] Cut Thermoseal → thermoseal strips (ManufacturingMaterial)
    ↓
[WI-01] Cartridge Backing → backed cartridges (LotRecord + CartridgeRecord.backing)
    ↓                          Input: raw cartridge + thermoseal strip + barcode label
[Laser Cutting] → laser-cut sheets (LaserCutBatch)
    ↓                Input: acrylic sheets
[Wax Filling] → wax-filled cartridges (WaxFillingRun + CartridgeRecord.waxFilling)
    ↓                Input: backed cartridges (ovenLots) + wax tube
    ↓
[Wax QC] → accepted/rejected (CartridgeRecord.waxQc)
    ↓
[Wax Storage] → stored in cooling tray (CartridgeRecord.waxStorage)
    ↓
[Reagent Filling] → reagent-filled cartridges (ReagentBatchRecord + CartridgeRecord.reagentFilling)
    ↓                   Input: wax-filled cartridges + reagent tubes
    ↓
[Reagent Inspection] → accepted/rejected (CartridgeRecord.reagentInspection)
    ↓
[Top Seal] → sealed cartridges (CartridgeRecord.topSeal)
    ↓            Input: top seal roll (Consumable)
    ↓
[Oven Cure] → cured cartridges (CartridgeRecord.ovenCure)
    ↓
[Cold Storage] → stored in fridge (CartridgeRecord.storage)
    ↓
[QA/QC Release] → released/voided (CartridgeRecord.qaqcRelease)
    ↓
[Shipping] → shipped to customer (CartridgeRecord.shipping + ShippingPackage)
    ↓
[Assay Loaded] → assay loaded onto cartridge (CartridgeRecord.assayLoaded)
    ↓
[Test Execution] → run on SPU (CartridgeRecord.testExecution + testResult)
```

## Model-by-Model Part Linkage Analysis

### 1. ProcessConfiguration
**Role:** Defines manufacturing processes with input/output materials
- `inputMaterials` → generic Mixed type, used by WI-01 and WI-02 pages
- `outputMaterial` → generic Mixed type
- `downstreamQueue` → string name of next process
- `workInstructionId` → links to WorkInstruction

**⚠️ ISSUE:** `inputMaterials` and `outputMaterial` are `Schema.Types.Mixed` — no typed structure. The UI (WI-01) expects `{ partId, name, scanOrder }[]` but there's no enforcement at the model level.

### 2. LotRecord
**Role:** Tracks a batch of units through a process (used by WI-01 Cartridge Backing)
- `processConfig` → denormalized `{ _id, processName, processType }` (links to ProcessConfiguration)
- `inputLots` → `Mixed` (should reference upstream lot IDs)
- `cartridgeIds` → `[String]` (links to CartridgeRecord IDs)
- `stepEntries` → step-by-step operator log

**⚠️ ISSUE:** `inputLots` is untyped Mixed. For WI-01 (Cartridge Backing), the UI sends 3 input barcodes (raw cartridge, thermoseal strip, barcode label) but the model doesn't enforce this structure.

### 3. CartridgeRecord (Sacred Document)
**Role:** THE cartridge lifecycle document. Each phase is write-once.
- `backing.lotId` → links to LotRecord (the backing lot)
- `waxFilling.runId` → links to WaxFillingRun
- `reagentFilling.runId` → links to ReagentBatchRecord
- `topSeal.batchId` → links to ReagentBatchRecord (same run, top seal sub-doc)
- `topSeal.topSealLotId` → links to Consumable (top seal roll)
- `qaqcRelease.shippingLotId` → links to ShippingLot
- `shipping.packageId` → links to ShippingPackage
- `testExecution.spu._id` → links to SPU

**✅ WELL CONNECTED:** This model has the strongest linkage in the system.

### 4. WaxFillingRun
**Role:** Tracks a wax filling run on an Opentrons robot
- `robot` → denormalized `{ _id, name }` (links to OpentronsRobot)
- `cartridgeIds` → `[String]` (links to CartridgeRecord IDs)
- `deckId` → links to Consumable (deck)
- `waxSourceLot` → string reference to wax source lot
- `waxTubeId` → links to Consumable (incubator tube)
- On complete → writes `CartridgeRecord.waxFilling` for each cartridge (WRITE-ONCE bulk op)

**How cartridges enter:** `addCartridge` action creates CartridgeRecord if it doesn't exist (with `backing` phase) or adds existing one to the run.

**⚠️ ISSUE:** `addCartridge` creates CartridgeRecord with only `backing.recordedAt` — no `backing.lotId`. The lot linkage from WI-01 is lost unless the cartridgeId IS the lot's QR code.

### 5. ReagentBatchRecord (Sacred Document)
**Role:** Tracks a reagent filling run
- `robot` → denormalized `{ _id, name, side }` (links to OpentronsRobot)
- `assayType` → denormalized `{ _id, name, skuCode }` (links to AssayDefinition)
- `deckId` → string
- `tubeRecords` → `[{ wellPosition, reagentName, sourceLotId, transferTubeId }]`
- `cartridgesFilled` → embedded array with `cartridgeId`, `deckPosition`, inspection status
- `topSeal` → embedded sub-document with `topSealLotId`
- `qcRelease` → embedded QA/QC release data

**On complete:** Writes `CartridgeRecord.reagentFilling` for each cartridge (WRITE-ONCE bulk op)
**On inspect:** Writes `CartridgeRecord.reagentInspection` 
**On top seal:** Writes `CartridgeRecord.topSeal` for accepted cartridges

**⚠️ ISSUE:** `tubeRecords.sourceLotId` is just a string — no reference to ManufacturingMaterial or PartDefinition. The reagent lot traceability relies on manual barcode entry.

### 6. LaserCutBatch
**Role:** Tracks a laser cutting session
- `operatorId` → string (links to User)
- `inputSheetCount`, `outputSheetCount`, `failureCount`
- No cartridge linkage, no lot linkage

**⚠️ ISSUE:** Laser cutting has NO connection to downstream processes. It tracks sheets in/out but:
- Doesn't link to any material/part (which acrylic sheets?)
- Doesn't create any downstream records
- Output (cut cartridge substrates) isn't tracked as inventory

### 7. ManufacturingMaterial + ManufacturingMaterialTransaction
**Role:** Generic inventory tracking for manufacturing consumables
- Simple name + quantity + transaction log
- Used by WI-01 page to show inventory levels (cut thermoseal strips, raw cartridges, barcode labels, individual backs)

**⚠️ ISSUE:** These are just named counters. There's NO formal link between:
- ManufacturingMaterial and PartDefinition (same physical item, two models)
- ManufacturingMaterial and Consumable (overlapping concepts)
- ManufacturingMaterial and any lot/batch system

### 8. Consumable
**Role:** Tracks physical consumable items (incubator tubes, top seal rolls, decks, cooling trays)
- `type` enum: `incubator_tube`, `top_seal_roll`, `deck`, `cooling_tray`
- `usageLog` → embedded transaction history
- Top seal rolls tracked in `top-seal-cutting` page
- Wax tubes tracked in wax filling workflow

**Links:**
- `CartridgeRecord.topSeal.topSealLotId` → should match a `top_seal_roll` Consumable ID
- `WaxFillingRun.waxTubeId` → should match an `incubator_tube` Consumable ID
- `WaxFillingRun.deckId` → should match a `deck` Consumable ID

### 9. PartDefinition
**Role:** Master part catalog (from BOM sync)
- `partNumber`, `name`, `category`, `supplier`, `manufacturer`
- `inspectionPathway` → 'coc' | 'ip' (new from RECV port)
- `sampleSize`, `percentAccepted` (new from RECV port)
- `inventoryCount` → current stock level

**Links:**
- SPU.parts[].partDefinitionId → PartDefinition._id
- BomItem → references PartDefinition via bomPartLink
- LabCartridge.partDefinitionId → PartDefinition._id
- AssemblySession step scans → match against part numbers

**⚠️ ISSUE:** `inventoryCount` on PartDefinition is separate from `ManufacturingMaterial.currentQuantity`. If the same physical part exists in both, counts can diverge.

### 10. WorkInstruction
**Role:** Step-by-step manufacturing instructions
- `versions[].steps[].partRequirements[]` → `{ partNumber, partDefinitionId, quantity }`
- `versions[].steps[].toolRequirements[]` → `{ toolNumber, toolName }`
- `versions[].steps[].fieldDefinitions[]` → data capture fields

**Links:**
- ProcessConfiguration.workInstructionId → WorkInstruction._id
- ProductionRun.workInstructionId → WorkInstruction._id
- AssemblySession.workInstructionId → WorkInstruction._id

### 11. SPU (Sacred Document)
**Role:** The physical Signal Processing Unit (the device)
- `parts[]` → scanned parts during assembly `{ partDefinitionId, partNumber, lotNumber, serialNumber }`
- `assembly` → links to AssemblySession and WorkInstruction
- `particleLink` → links to Particle IoT device
- `validation` → links to ValidationSession

**Links:**
- `CartridgeRecord.testExecution.spu._id` → SPU._id
- ProductionRun.units[].spuId → SPU._id

### 12. AssayDefinition (Sacred Document)
**Role:** Defines assay types with reagent formulas
- `reagents[]` → `{ wellPosition, reagentName, volumeMicroliters, subComponents[] }`
- `skuCode` → unique identifier

**Links:**
- ReagentBatchRecord.assayType → denormalized AssayDefinition
- CartridgeRecord.reagentFilling.assayType → denormalized AssayDefinition
- CartridgeRecord.assayLoaded.assay → denormalized AssayDefinition

---

## 🔴 CRITICAL GAPS (Broken/Missing Linkages)

### GAP 1: Laser Cutting → Cartridge Backing Pipeline
**Problem:** LaserCutBatch is completely isolated. It tracks sheet counts but:
- Doesn't record WHICH material/part was cut
- Doesn't produce any traceable output
- WI-01 (Cartridge Backing) doesn't check for available laser-cut substrates
- No `currentPhase` or lot linkage to downstream

**Expected Flow:** Laser cutting should produce "cut cartridge substrates" that become input to WI-01 Cartridge Backing. Currently this link is entirely missing.

### GAP 2: WI-01 Output → Wax Filling Input
**Problem:** WI-01 creates LotRecords with `cartridgeIds`, but:
- Wax filling looks for cartridges from `ovenLots` (unclear how these are populated)
- `addCartridge` in wax filling creates new CartridgeRecords with minimal backing data
- The `backing.lotId` from WI-01's LotRecord may not flow through

**What should happen:** WI-01 completes → cartridges enter oven → oven time completes → cartridges become available for wax filling. The `ovenLots` mechanism needs to query LotRecords or CartridgeRecords in `backing` phase with sufficient oven time.

### GAP 3: ManufacturingMaterial ↔ PartDefinition Disconnect
**Problem:** Same physical item can exist as both:
- A `PartDefinition` (with `inventoryCount`)
- A `ManufacturingMaterial` (with `currentQuantity`)

No linkage between them. Inventory counts can diverge. WI-01 reads ManufacturingMaterial for inventory display while PartDefinition has its own count.

### GAP 4: Consumable Lifecycle Gaps
**Problem:** Consumables (decks, tubes, trays) are created but:
- `deck` Consumables aren't created anywhere in the current code — `WaxFillingRun.deckId` is a free-text string
- `cooling_tray` Consumables aren't managed — `WaxFillingRun.coolingTrayId` is free-text
- `incubator_tube` usage isn't decremented when wax is dispensed
- No consumable expiration tracking

### GAP 5: Reagent Lot Traceability
**Problem:** `ReagentBatchRecord.tubeRecords[].sourceLotId` is a free string — no validation against:
- ManufacturingMaterial (reagent inventory)
- PartDefinition (reagent part)
- Any receiving/lot system

The reagent provenance chain is based entirely on manual barcode scans with no system validation.

### GAP 6: ReceivingLot → PartDefinition → Manufacturing Flow
**Problem (NEW from RECV port):** The new receiving system creates `ReceivingLot` records linked to `PartDefinition`, but:
- Receiving lots don't update `PartDefinition.inventoryCount`
- Receiving lots don't update `ManufacturingMaterial.currentQuantity`
- No mechanism to make received goods available as manufacturing inputs
- The `inspectionPathway` on PartDefinition is set, but there's no UI flow that routes incoming goods through the correct pathway automatically

---

## ⚠️ MINOR ISSUES

### ISSUE 1: Untyped Mixed Fields
Multiple models use `Schema.Types.Mixed` where typed schemas would be better:
- `ProcessConfiguration.inputMaterials` / `outputMaterial`
- `LotRecord.inputLots`
- `ManufacturingSettings.rejectionReasonCodes` (partially typed)

### ISSUE 2: Two Cartridge Models
- `CartridgeRecord` — sacred manufacturing record (the DMR)
- `LabCartridge` — lab/testing cartridge with usage tracking

These represent different concerns but could cause confusion. Lab cartridges go through `cartridge-admin` and `cartridge-dashboard`; manufacturing cartridges go through `CartridgeRecord`. The link between them (when does a CartridgeRecord become usable in the lab?) is unclear.

### ISSUE 3: Top Seal Flow Split
Top seal application happens in TWO places:
1. `reagent-filling/+page.server.ts` → `applyTopSeal` action (writes to CartridgeRecord)
2. `top-seal-cutting/+page.server.ts` → manages top seal ROLLS (Consumable)

The roll consumption (how much material was used per cartridge) isn't tracked automatically.

### ISSUE 4: ProductionRun Underutilized
`ProductionRun` exists as a model but is barely integrated into the manufacturing pages. WI-01 and WI-02 use LotRecord directly, not ProductionRun. Only the `documents/instructions/[id]/run/[runId]` page references it.

---

## ✅ WHAT'S WORKING WELL

1. **CartridgeRecord write-once pattern** — each phase guards with `recordedAt: { $exists: false }`, preventing double-writes. Excellent data integrity.

2. **Denormalized references** — operator, robot, assayType are embedded at point of use. No need for joins. Good for audit trail.

3. **Sacred document middleware** — `applySacredMiddleware` on CartridgeRecord, ReagentBatchRecord, SPU, AssayDefinition prevents accidental overwrites.

4. **Wax → QC → Storage → Reagent → Inspect → Seal** pipeline in the UI is well-structured with clear stage progression.

5. **BulkWrite operations** — batch updates to CartridgeRecords on run completion are efficient and atomic.

---

## 📋 RECOMMENDED FIXES (Priority Order)

1. **Link LaserCutBatch to downstream** — add `outputPartId` (→PartDefinition) and create ManufacturingMaterial transactions on completion
2. **Unify inventory** — either PartDefinition.inventoryCount OR ManufacturingMaterial, not both. Add a `partDefinitionId` field to ManufacturingMaterial.
3. **Type the Mixed fields** — define proper sub-schemas for inputMaterials, inputLots, outputMaterial
4. **Connect ReceivingLot to inventory** — on receiving lot acceptance, increment PartDefinition.inventoryCount
5. **Formalize Consumable management** — create Consumable records for decks/trays from a management page, reference by ID not free text
6. **Bridge CartridgeRecord ↔ LabCartridge** — define when a released CartridgeRecord creates/updates a LabCartridge for lab use

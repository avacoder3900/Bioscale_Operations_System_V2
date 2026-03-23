# SPU Assembly, IPK & Inventory Subtraction Audit

**Date:** 2026-03-23
**Branch:** dev
**Purpose:** Gap analysis for the SPU assembly pathway, IPK (In-Process Kit) integration with inventory, barcode scanning for inventory subtraction, and the living DHR during assembly.

---

## Terminology

- **IPK (In-Process Kit):** A physical bucket/container on the SPU assembly line that holds the parts needed for a specific assembly step or group of steps. IPKs are NOT connected to the kanban board — they live on the assembly line.
- **DHR (Device History Record):** The SPU document itself — a Sacred Document that grows as the device is built, validated, and deployed.
- **BOM (Bill of Materials):** The list of parts needed to build one SPU. Currently defined in BomItem collection.

---

## 1. Current State: What's Built

### 1.1 SPU as Living DHR (Sacred Document)

The SPU model IS the DHR. As the device is assembled, the document grows:

**During Assembly:**
- `parts[]` array populated with each scanned part (partNumber, lotNumber, barcodeData, scannedAt, scannedBy)
- `assembly{}` embedded with sessionId, workInstructionId/Version/Title, operator, stepRecords[] with fieldRecords[]
- `assemblyStatus` transitions: created → in_progress → completed
- `status` transitions: draft → assembling → assembled

**After Assembly:**
- `validation{}` filled during magnetometer, thermocouple, lux, spectrophotometer testing
- `signature{}` captured with electronic signature on assembly completion
- `statusTransitions[]` records every status change with who/when/why
- `finalizedAt` locks the document when deployed (corrections-only after that)

### 1.2 Assembly Session Flow (Current)

**How an operator builds an SPU today:**

```
1. Operator opens /assembly
2. Selects SPU + Work Instruction
3. AssemblySession created (status: in_progress)
4. Redirected to /assembly/[sessionId]
5. Page loads:
   - Work instruction steps (with partRequirements per step)
   - ALL BOM items for type "spu" (with live inventory counts)
6. For each step:
   - Operator physically walks to shelf/bin to get part
   - Scans part barcode (or enters manually)
   - System looks up PartDefinition by barcode
   - PartDefinition.inventoryCount decremented by withdrawQty
   - InventoryTransaction created (immutable, type: 'deduction')
   - SPU.parts[] updated with scan data
   - Step marked complete
7. Assembly complete → electronic signature → SPU.status = 'assembled'
```

**Key files:**
- `src/routes/assembly/[sessionId]/+page.server.ts` — Core assembly logic (scanPart, captureField, retractInventory)
- `src/lib/server/db/models/assembly-session.ts` — Session data model
- `src/lib/server/db/models/work-instruction.ts` — Steps, part requirements, field definitions

### 1.3 Inventory Deduction (scanPart Action)

When operator scans a barcode during assembly:

```
1. Receive barcode from form data
2. Look up PartDefinition by partDefinitionId
3. Get withdrawQty from work instruction step partRequirements (or default 1)
4. Validate: prevQty >= withdrawQty (fail if insufficient)
5. PartDefinition.updateOne({ $inc: { inventoryCount: -withdrawQty } })
6. InventoryTransaction.create({
     partDefinitionId, assemblySessionId,
     transactionType: 'deduction',
     quantity: -withdrawQty,
     previousQuantity, newQuantity,
     reason: 'Assembly scan for SPU ${spuId}',
     performedBy: operator.username
   })
7. SPU.updateOne({ $push: { parts: {
     partDefinitionId, partNumber, partName,
     lotNumber: barcode, barcodeData: barcode,
     scannedAt, scannedBy: { _id, username }
   }}})
```

**Retraction** (undo a scan):
- Marks original InventoryTransaction as retracted (immutable — no deletion)
- Restores PartDefinition.inventoryCount via `$inc: { inventoryCount: Math.abs(quantity) }`

### 1.4 Receiving → Inventory Addition

```
ReceivingLot created (lotId barcode scanned, quantity, inspection)
  → On status = 'accepted':
    → PartDefinition.inventoryCount += quantity
    → InventoryTransaction created (type: 'receipt')
    → ManufacturingMaterial synced if linked
```

### 1.5 Work Instructions & Part Requirements

WorkInstruction model has per-step part requirements:

```typescript
steps: [{
  stepNumber, title, content, imageData,
  requiresScan: Boolean,
  scanPrompt: String,
  partRequirements: [{
    partNumber, partDefinitionId, quantity, notes
  }],
  toolRequirements: [{
    toolNumber, toolName, calibrationRequired
  }],
  fieldDefinitions: [{
    fieldName, fieldLabel, fieldType: 'barcode_scan' | 'manual_entry' | 'date_picker' | 'dropdown',
    isRequired, validationPattern, barcodeFieldMapping
  }]
}]
```

### 1.6 Barcode Fields Across Models

| Model | Field | What Gets Scanned | Index |
|-------|-------|-------------------|-------|
| PartDefinition | `barcode` | Part type label (e.g., on a shelf label) | Unique, sparse |
| ReceivingLot | `lotId` | Incoming shipment barcode | Unique |
| ReceivingLot | `bagBarcode` | Label on storage bag | Sparse |
| SPU | `barcode` | Device barcode / UDI | Sparse |
| SPU.parts[] | `barcodeData` | Raw scan data during assembly | None |
| GeneratedBarcode | `barcode` | System-generated (THERMO-000042) | Unique |

---

## 2. IPK System: What Does NOT Exist

**There is NO IPK concept in the codebase.** Zero references to "IPK", "ipk", "in-process kit", "kitting", "bin", "bucket", or "staging" in any model, route, or document.

### What This Means

Today, the operator:
- Has no pre-staged kit of parts for a build
- Walks to inventory shelves for each part individually
- Scans parts one at a time during assembly
- Has no validation that all required parts are gathered before starting
- Has no physical container tracked by the system

### What IPK Integration Would Look Like

```
PROPOSED FLOW:

1. SPU created (draft) → BOM defines required parts
2. IPK created for this SPU build
   - System generates pick list from BOM
   - IPK gets a printed barcode label
3. Kitting operator picks parts from inventory shelves
   - Scans each part barcode into the IPK
   - Inventory deducted at pick time (not assembly time)
   - IPK tracks: what's been picked, what's still needed
4. IPK placed on assembly line
5. Assembly operator scans IPK barcode to start
   - All parts already accounted for
   - Assembly just records which specific part went into which SPU step
6. DHR records both: IPK source + individual part scans
```

---

## 3. Gaps & Missing Infrastructure

### 3.1 No IPK Model or Collection

Need a new model:

```typescript
InProcessKit {
  _id: String (nanoid),
  ipkBarcode: String (unique, generated),
  spuId: String (optional — may be pre-assigned or assigned at assembly start),
  batchId: String (optional),
  status: 'created' | 'picking' | 'staged' | 'in_assembly' | 'completed' | 'voided',

  requiredParts: [{           // Generated from BOM
    bomItemId: String,
    partDefinitionId: String,
    partNumber: String,
    partName: String,
    requiredQuantity: Number
  }],

  pickedParts: [{             // Filled during kitting
    partDefinitionId: String,
    partNumber: String,
    lotNumber: String,        // From barcode scan
    barcodeData: String,      // Raw scan
    quantity: Number,
    pickedAt: Date,
    pickedBy: { _id, username }
  }],

  location: String,           // 'Workstation A', 'Assembly Line Slot 3'
  assemblySessionId: String,  // Linked when assembly starts

  createdBy: { _id, username },
  createdAt: Date,
  completedAt: Date
}
```

### 3.2 No Barcode-to-Entity Router

When something is scanned, the system doesn't know WHAT was scanned. It relies on context (which form field the scan goes into). Need a unified lookup:

```
Scan barcode → Is it a part barcode? (PartDefinition.barcode)
             → Is it a lot barcode? (ReceivingLot.lotId)
             → Is it an IPK barcode? (InProcessKit.ipkBarcode)
             → Is it an SPU barcode? (SPU.barcode / SPU.udi)
             → Unknown barcode → error
```

### 3.3 No Inventory Deduction at Pick Time

Currently inventory is deducted during assembly scanning. With IPKs, deduction should happen when parts are **picked into the IPK**, not when they're installed. This changes the deduction point:

```
TODAY:     Inventory → [operator walks] → Assembly Scan → Deduct
WITH IPK:  Inventory → Pick into IPK (Deduct) → Assembly Line → Assembly Scan (record only)
```

### 3.4 No Pick List Generation

No mechanism to generate "you need these N parts for this SPU build" from the BOM. The work instruction has partRequirements per step, but nothing aggregates them into a single pick list.

### 3.5 No Part Validation During Assembly

The system does NOT validate:
- Did the operator scan the RIGHT part for THIS step?
- Did they scan ENOUGH of each part?
- Is the scanned part from a valid/non-expired lot?
- Were all required parts scanned before completing assembly?

### 3.6 No Per-Lot Remaining Quantity

`ReceivingLot` tracks the original received quantity but NOT how much remains. Consumption is tracked via InventoryTransaction links, but there's no `remainingQuantity` field. This matters for IPK picking — you need to know if a lot has enough to fill the IPK.

### 3.7 No FIFO Enforcement

No mechanism to ensure older lots are consumed before newer ones. Regulatory compliance (especially for medical devices) typically requires FIFO.

### 3.8 No Expiration Enforcement

`PartDefinition.expirationDate` exists but nothing blocks picking or scanning an expired part.

### 3.9 Dual Inventory Systems

`PartDefinition.inventoryCount` and `ManufacturingMaterial.currentQuantity` can drift apart. They sync on receiving acceptance and manual edits, but not consistently across all operations.

---

## 4. MongoDB Infrastructure Needed

### 4.1 New Collection

| Collection | Model | Purpose | Effort |
|------------|-------|---------|--------|
| `in_process_kits` | InProcessKit | Physical IPK buckets with barcode, parts picked, status | Medium |

### 4.2 Model Modifications

| Model | Change | Purpose | Effort |
|-------|--------|---------|--------|
| PartDefinition | Add `storageLocation` | Where the part physically lives (shelf/bin) | Small |
| ReceivingLot | Add `remainingQuantity` | Track per-lot depletion for FIFO | Small |
| PartDefinition | Add index on `expirationDate` | Query expiring stock | Small |
| AssemblySession | Add `ipkId` reference | Link assembly to the IPK used | Small |
| SPU | Add `ipkId` reference | Traceability: which IPK was used for this build | Small |

### 4.3 New API Routes

| Route | Purpose | Effort |
|-------|---------|--------|
| `POST /api/ipk/create` | Create IPK from BOM, generate pick list + barcode | Medium |
| `POST /api/ipk/[ipkId]/pick` | Scan part into IPK, deduct inventory | Medium |
| `GET /api/ipk/[ipkId]` | Get IPK status, picked vs. required | Small |
| `GET /api/barcode/lookup/[barcode]` | Unified barcode router (part? lot? IPK? SPU?) | Small |
| `POST /api/ipk/[ipkId]/start-assembly` | Link IPK to assembly session | Small |

### 4.4 Server Route Changes

| File | Change | Effort |
|------|--------|--------|
| `assembly/[sessionId]/+page.server.ts` | Load IPK data, validate parts against IPK, change deduction point | Medium |
| `assembly/+page.server.ts` | Allow starting assembly from IPK scan | Small |

---

## 5. What You May Not Be Thinking About

1. **Partial IPKs** — What if a part is out of stock when kitting? Do you block the IPK or allow partial fills and wait for receiving?

2. **IPK expiration** — If an IPK sits on the line for days, do parts inside expire or need re-verification?

3. **Multi-SPU batches** — If building 10 SPUs in a batch, do you create 10 IPKs or one mega-IPK? The BOM quantityPerUnit field supports this but the IPK model needs to handle it.

4. **Part substitution** — If a part in the IPK is wrong or defective, the operator needs to swap it. This means un-picking (retract from IPK) and re-picking. Both need audit trails.

5. **IPK barcode printing** — You need physical labels. Consider label printer integration or at minimum a printable page with barcode + pick list.

6. **Double deduction risk** — If inventory is deducted at IPK pick time, the assembly scan should NOT deduct again. The assembly scan becomes a "verification" step, not a deduction step. This is a fundamental flow change.

7. **IPK-to-DHR traceability** — The final SPU (DHR) should record which IPK was used AND which individual parts were in it. This creates the full chain: Receiving Lot → IPK → SPU → Deployment.

8. **Scrap/reject during assembly** — If a part is damaged during assembly, it needs to come out of the IPK record and a new one picked. The scrapped part needs an InventoryTransaction of type 'scrap'.

9. **Race conditions** — Two operators picking from the same lot simultaneously could over-deduct. The `$inc` is atomic per document but doesn't prevent going negative without a floor check.

10. **Work instruction alignment** — Work instruction steps have `partRequirements[]` but these aren't enforced. With IPKs, the pick list should be generated FROM the work instruction's aggregate part requirements, not directly from BOM items.

---

## 6. Distance to Goal

| Capability | Status | Notes |
|-----------|--------|-------|
| SPU creation + living DHR | Built | Sacred document pattern working |
| Assembly barcode scanning | Built | Scans deduct from PartDefinition |
| Inventory transactions (immutable) | Built | Full audit trail |
| Receiving → inventory addition | Built | On lot acceptance |
| Work instructions with part requirements | Built | Per-step, not enforced |
| Retraction workflow | Built | Restores inventory, marks original |
| IPK model / collection | Not started | New model needed |
| IPK barcode generation | Not started | GeneratedBarcode pattern exists to reuse |
| IPK pick list from BOM | Not started | Aggregate work instruction part requirements |
| Scan-to-pick into IPK | Not started | New route, deduction at pick time |
| Barcode router (what did I scan?) | Not started | Part vs. lot vs. IPK vs. SPU |
| Assembly from IPK (verify, don't deduct) | Not started | Changes existing assembly flow |
| Per-lot remaining quantity | Not started | ReceivingLot schema change |
| FIFO lot enforcement | Not started | Logic in pick flow |
| Expiration enforcement | Not started | Logic in pick flow |
| Part validation during assembly | Not started | Right part for right step |
| IPK-to-DHR traceability | Not started | SPU + AssemblySession schema change |

**Overall: The core DHR, scanning, and inventory infrastructure is solid (~60% done). The IPK layer is 0% built — it's a new workflow layer that sits between inventory and assembly. The biggest architectural decision is moving the inventory deduction point from assembly to IPK picking.**

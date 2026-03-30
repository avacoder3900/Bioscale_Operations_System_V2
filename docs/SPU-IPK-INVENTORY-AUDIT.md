# SPU Assembly, IPK & Inventory Subtraction Audit

**Date:** 2026-03-23 (Updated: 2026-03-23)
**Branch:** dev
**Purpose:** Gap analysis and DECIDED architecture for SPU assembly, IPK placement acknowledgment, inventory subtraction during Work Instructions, and build checklist generation.

---

## Terminology

- **IPK (In-Process Kit):** A physical bucket/container on the SPU assembly line that holds the parts needed for assembly. IPKs are NOT connected to the kanban board — they live on the assembly line. **IPKs do NOT withdraw inventory.** They only acknowledge that parts have been placed in their appropriate positions.
- **DHR (Device History Record):** The SPU document itself — a Sacred Document that grows as the device is built, validated, and deployed.
- **BOM (Bill of Materials):** The list of parts needed to build one SPU. Currently defined in BomItem collection.
- **Build Checklist:** A generated list of all parts needed when an operator initiates a new build of X SPUs. This is the preparation step before IPKs are loaded.

---

## DECIDED ARCHITECTURE (Owner-Approved)

> These decisions override any previous proposals in this document.

### Decision 1: IPKs Acknowledge Placement Only — NO Inventory Withdrawal
IPKs confirm that parts have been placed in the correct positions on the assembly line. The system records WHAT is in the IPK and WHERE it was placed, but does NOT deduct inventory at this stage.

### Decision 2: Inventory Withdrawal Happens in Work Instructions
Inventory is subtracted when the operator scans/uses a part during the actual Work Instruction assembly steps. This is the ONLY point where `PartDefinition.inventoryCount` is decremented.

### Decision 3: Discard/Scrap Inventory is Step-Dependent in Work Instructions
Operators can only discard (scrap) a part when they are ON the WI step that requires that part. You don't pull a part until you reach its step, so scrap only applies within the context of the current step. This creates an InventoryTransaction of type 'scrap' with a reason, without installing the part into the SPU. The operator then scans a replacement part within the same step.

### Decision 4: Build Checklist When Prompting New Build of X SPUs
When an operator initiates a new build run of X SPUs, the system generates a checklist of ALL parts needed (BOM quantities multiplied by X). This checklist is used to verify inventory availability and prepare the line before assembly begins.

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

### Decided IPK Integration Flow

```
DECIDED FLOW:

1. Operator initiates "New Build of X SPUs"
   → System generates BUILD CHECKLIST (BOM × X)
   → Shows: part name, part number, total qty needed, current inventory, shortfall
   → Operator reviews and confirms inventory is sufficient

2. Operator loads IPKs on the assembly line
   → Scans/acknowledges each IPK placement
   → System records: which parts are in which IPK, placed by whom, when
   → NO INVENTORY IS DEDUCTED — acknowledgment only

3. Operator starts assembly (Work Instructions)
   → For each WI step, operator scans the part barcode
   → INVENTORY IS DEDUCTED HERE (PartDefinition.inventoryCount -= qty)
   → InventoryTransaction created (type: 'deduction')
   → SPU.parts[] updated with scan data
   → DHR grows with each step

4. If part is damaged/defective during a WI step:
   → Operator is ON the step that requires this part
   → Operator chooses "Discard" within that step's context
   → InventoryTransaction created (type: 'scrap', with reason, linked to step)
   → Part NOT added to SPU.parts[]
   → Step remains incomplete — operator scans replacement part (new deduction)
   → Step only completes when a good part is scanned

5. Assembly complete → signature → SPU.status = 'assembled'
```

---

## 3. Gaps & Missing Infrastructure

### 3.1 No IPK Model or Collection

Need a new model for placement acknowledgment (NOT inventory deduction):

```typescript
InProcessKit {
  _id: String (nanoid),
  ipkBarcode: String (unique, generated),
  ipkLabel: String,                     // Human-readable name ('IPK-A: Heater Assembly')
  linePosition: String,                 // Where on the assembly line this IPK sits
  status: 'empty' | 'loaded' | 'in_use' | 'completed',

  assignedParts: [{                     // What SHOULD be in this bucket
    partDefinitionId: String,
    partNumber: String,
    partName: String,
    expectedQuantity: Number            // Per single SPU build
  }],

  placementAcknowledgments: [{          // Log of each time IPK is loaded
    acknowledgedAt: Date,
    acknowledgedBy: { _id, username },
    buildRunId: String,                 // Which build run this loading is for
    notes: String
  }],

  createdBy: { _id, username },
  createdAt: Date
}
```

### 3.2 No Build Checklist / Build Run Model

Need a model to represent "we are building X SPUs":

```typescript
BuildRun {
  _id: String (nanoid),
  quantity: Number,                     // How many SPUs to build
  status: 'checklist' | 'ipk_loading' | 'assembling' | 'completed',
  batchId: String (optional),

  checklist: [{                         // BOM × quantity
    partDefinitionId: String,
    partNumber: String,
    partName: String,
    quantityPerUnit: Number,            // From BOM
    totalRequired: Number,              // quantityPerUnit × build quantity
    currentInventory: Number,           // Snapshot at checklist generation
    shortfall: Number,                  // max(0, totalRequired - currentInventory)
    verified: Boolean,                  // Operator checked this line
    verifiedBy: { _id, username },
    verifiedAt: Date
  }],

  ipkAcknowledgments: [{               // Which IPKs were loaded for this run
    ipkId: String,
    acknowledgedAt: Date,
    acknowledgedBy: { _id, username }
  }],

  spuIds: [String],                     // SPUs created in this run
  assemblySessionIds: [String],         // Assembly sessions for this run

  createdBy: { _id, username },
  createdAt: Date,
  completedAt: Date
}
```

### 3.3 No Step-Level Discard/Scrap Action in Work Instructions

The assembly page has `scanPart` (deduct + install) and `retractInventory` (undo deduction), but NO action to discard/scrap a part. Discard must be **step-dependent** — the operator is on a specific WI step and the part for THAT step is damaged. Need:

```typescript
// New action: discardPart
// - Only available when operator is on a step that requires a part
// - Tied to the current step's partRequirements
// - Deducts from PartDefinition.inventoryCount
// - Creates InventoryTransaction (type: 'scrap', reason: required, stepNumber, stepTitle)
// - Does NOT add part to SPU.parts[]
// - Logs in AssemblySession.stepRecords[] for audit trail
// - Step remains incomplete — operator must scan replacement
// - Step only completes when a good part is successfully scanned
```

### 3.4 No Build Checklist Generation

No mechanism to aggregate BOM × quantity and check against current inventory. Need:

```
Operator says: "Build 5 SPUs"
System generates:
┌──────────────┬─────────────┬──────────┬───────────┬───────────┐
│ Part Number  │ Part Name   │ Per Unit │ Total (×5)│ In Stock  │
├──────────────┼─────────────┼──────────┼───────────┼───────────┤
│ PT-SPU-001   │ Heater Block│ 1        │ 5         │ 12    ✓   │
│ PT-SPU-002   │ Thermistor  │ 2        │ 10        │ 8     ✗   │
│ PT-SPU-003   │ PCB Assy    │ 1        │ 5         │ 5     ✓   │
│ PT-SPU-004   │ Linear Rail │ 1        │ 5         │ 3     ✗   │
└──────────────┴─────────────┴──────────┴───────────┴───────────┘
SHORTFALL: 2× Thermistor, 2× Linear Rail — cannot proceed until restocked
```

### 3.5 No Part Validation During Assembly

The system does NOT validate:
- Did the operator scan the RIGHT part for THIS step?
- Did they scan ENOUGH of each part?
- Is the scanned part from a valid/non-expired lot?
- Were all required parts scanned before completing assembly?

### 3.6 No Per-Lot Remaining Quantity

`ReceivingLot` tracks the original received quantity but NOT how much remains. This matters when the operator needs to know if a lot has enough parts left.

### 3.7 No FIFO Enforcement

No mechanism to ensure older lots are consumed before newer ones. Regulatory compliance (especially for medical devices) typically requires FIFO.

### 3.8 No Expiration Enforcement

`PartDefinition.expirationDate` exists but nothing blocks scanning an expired part during WI assembly.

### 3.9 Dual Inventory Systems

`PartDefinition.inventoryCount` and `ManufacturingMaterial.currentQuantity` can drift apart. They sync on receiving acceptance and manual edits, but not consistently across all operations.

---

## 4. MongoDB Infrastructure Needed

### 4.1 New Collections

| Collection | Model | Purpose | Effort |
|------------|-------|---------|--------|
| `in_process_kits` | InProcessKit | IPK buckets — placement acknowledgment only, no inventory deduction | Medium |
| `build_runs` | BuildRun | Build checklist for X SPUs, tracks the entire build session | Medium |

### 4.2 Model Modifications

| Model | Change | Purpose | Effort |
|-------|--------|---------|--------|
| PartDefinition | Add `storageLocation` | Where the part physically lives (shelf/bin) | Small |
| ReceivingLot | Add `remainingQuantity` | Track per-lot depletion for FIFO | Small |
| PartDefinition | Add index on `expirationDate` | Query expiring stock | Small |
| AssemblySession | Add `buildRunId` reference | Link assembly to the build run | Small |
| AssemblySession | Add `ipkIds[]` reference | Which IPKs were used for this assembly | Small |
| SPU | Add `buildRunId` reference | Traceability: which build run produced this SPU | Small |

### 4.3 New Routes

| Route | Purpose | Effort |
|-------|---------|--------|
| `POST /api/build-run/create` | Generate build checklist for X SPUs from BOM | Medium |
| `GET /api/build-run/[runId]` | Get checklist, IPK status, progress | Small |
| `POST /api/build-run/[runId]/verify-checklist` | Operator confirms inventory is ready | Small |
| `POST /api/build-run/[runId]/acknowledge-ipk` | Record IPK placement on line (no deduction) | Small |
| `GET /api/barcode/lookup/[barcode]` | Unified barcode router (part? lot? IPK? SPU?) | Small |

### 4.4 Server Route Changes

| File | Change | Effort |
|------|--------|--------|
| `assembly/[sessionId]/+page.server.ts` | Add `discardPart` action (scrap with reason, no SPU install) | Medium |
| `assembly/[sessionId]/+page.server.ts` | Link assembly to build run + IPK acknowledgments | Small |
| `assembly/+page.server.ts` | Allow starting assembly from build run context | Small |

---

## 5. Things To Consider

1. **Build checklist shortfall handling** — When the checklist shows insufficient inventory for X SPUs, does the system block the build entirely, or allow a reduced quantity? (e.g., "You can build 3 of the 5 requested")

2. **IPK re-acknowledgment** — If an IPK is emptied and refilled between builds, does the operator need to re-acknowledge? Should there be a "clear IPK" action between build runs?

3. **Scrap reason categories** — The discard action needs a reason. Should these be freeform or a dropdown? Common reasons: damaged, defective, contaminated, expired, wrong part. Categorized reasons help with reporting.

4. **Scrap-then-replace flow** — After discarding within a step, the step stays open until a replacement is scanned. If the IPK has spares, they grab from there. If not, they go to inventory. The WI page must keep the step active (not advance) until a good part is scanned and deducted.

5. **IPK barcode printing** — Physical labels for IPK buckets. Consider label printer integration or a printable page with barcode + part list.

6. **Build checklist as gate** — Should the checklist BLOCK assembly from starting if there's a shortfall? Or is it advisory only? Blocking is safer for compliance.

7. **IPK-to-DHR traceability** — The final SPU (DHR) should record which build run it came from. The chain: Receiving Lot → Build Checklist → IPK Acknowledgment → WI Scan (deduction) → SPU (DHR).

8. **Race conditions on inventory** — Two operators building simultaneously both deducting from the same PartDefinition. `$inc` is atomic but doesn't prevent going negative. Consider a floor check: `if (currentInventory < needed) fail()`.

9. **Partial build completion** — If building 5 SPUs and you finish 3 but run out of a part, what happens to the build run? Need a way to close out a partial run and handle remaining checklist items.

10. **Checklist snapshot vs. live inventory** — The checklist captures inventory at generation time. During a long build, inventory could change (receiving adds stock, another build deducts). Should the checklist update live or stay as a snapshot?

---

## 6. Distance to Goal

### Already Built (no changes needed)

| Capability | Status | Notes |
|-----------|--------|-------|
| SPU creation + living DHR | Built | Sacred document pattern working |
| Assembly barcode scanning → inventory deduction | Built | Scans deduct from PartDefinition during WI steps |
| Inventory transactions (immutable) | Built | Full audit trail |
| Receiving → inventory addition | Built | On lot acceptance |
| Work instructions with part requirements | Built | Per-step definitions exist |
| Retraction workflow | Built | Restores inventory, marks original |

### Needs to Be Built

| Capability | Status | Priority | Notes |
|-----------|--------|----------|-------|
| Build checklist generation (BOM × X) | Not started | HIGH | Core feature — gate for starting builds |
| BuildRun model + collection | Not started | HIGH | Tracks build of X SPUs end-to-end |
| Discard/scrap action in WI page | Not started | HIGH | InventoryTransaction type 'scrap' + reason |
| IPK model + collection | Not started | MEDIUM | Placement acknowledgment, no deduction |
| IPK barcode generation | Not started | MEDIUM | Reuse GeneratedBarcode pattern |
| IPK placement acknowledgment flow | Not started | MEDIUM | Scan IPK → confirm parts loaded |
| Build checklist shortfall detection | Not started | MEDIUM | Block or warn when inventory insufficient |
| Barcode router (what did I scan?) | Not started | LOW | Part vs. lot vs. IPK vs. SPU lookup |
| Per-lot remaining quantity | Not started | LOW | ReceivingLot schema change |
| FIFO lot enforcement | Not started | LOW | Logic in WI scan flow |
| Expiration enforcement | Not started | LOW | Logic in WI scan flow |
| Part validation during assembly | Not started | LOW | Right part for right step |

### Implementation Order (Recommended)

```
Phase 1 — Build Checklist + Scrap (HIGH priority, enables core workflow)
  1. BuildRun model + create route
  2. Checklist generation (BOM × quantity, inventory check)
  3. Discard/scrap action in assembly/[sessionId]/+page.server.ts
  4. Link AssemblySession + SPU to BuildRun

Phase 2 — IPK Acknowledgment (MEDIUM priority, adds line organization)
  5. InProcessKit model
  6. IPK barcode generation
  7. IPK placement acknowledgment route
  8. Link IPK acknowledgments to BuildRun

Phase 3 — Enforcement (LOW priority, compliance hardening)
  9. Part validation (right part for right step)
  10. FIFO lot enforcement
  11. Expiration blocking
  12. Barcode router
```

**Overall: ~65% of the backend infrastructure exists. The inventory deduction point stays where it is (WI assembly scanning). The main new work is the BuildRun checklist system (Phase 1) and the IPK acknowledgment layer (Phase 2).**

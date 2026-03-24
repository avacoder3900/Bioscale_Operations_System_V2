# SPU Creation, Inventory & Kanban Barcode Audit

**Date:** 2026-03-23
**Branch:** thermocouple-and-spec-validation
**Purpose:** Gap analysis for the SPU creation pathway, inventory subtraction via barcode scanning, and kanban bin integration with MongoDB infrastructure.

---

## 1. Current State: What's Built

### 1.1 SPU as Device History Record (Sacred Document)

The SPU model **is** the DHR. It is a Tier 1 Sacred Document with:

- **Lifecycle status tracking:** draft → assembling → assembled → validating → validated → released-rnd/manufacturing/field → deployed → servicing → retired/voided
- **Embedded `parts[]` array:** partDefinitionId, partNumber, partName, lotNumber, serialNumber, barcodeData, scannedAt, scannedBy, isReplaced, replacedBy, replaceReason
- **Embedded `assembly{}`:** sessionId, workInstructionId/Version/Title, startedAt, completedAt, operator, workstationId, stepRecords[] with fieldRecords[] (including rawBarcodeData)
- **Embedded `validation{}`:** magnetometer, thermocouple, lux, spectrophotometer — each with status, sessionId, completedAt, rawData, results, failureReasons, criteriaUsed
- **Sacred middleware:** finalization locks the document; corrections-only after finalizedAt is set
- **Electronic signatures, audit logging, status transitions with reasons**

**Key files:**
- `src/lib/server/db/models/spu.ts`
- `src/routes/spu/+page.server.ts` (create, register, updateStatus, assignSpu)
- `src/routes/spu/[spuId]/+page.server.ts` (detail, lifecycle, signatures)
- `src/lib/server/db/middleware/sacred.ts`

### 1.2 Assembly + Barcode Scanning → Inventory Deduction

When a part is scanned during assembly:

1. SPU.parts[] updated with scan data (partNumber, lotNumber, barcodeData, scannedBy, scannedAt)
2. `PartDefinition.inventoryCount` decremented by 1 (`$inc: { inventoryCount: -1 }`)
3. Immutable `InventoryTransaction` created (type: 'deduction', quantity: -1, previousQuantity, newQuantity)
4. Retraction workflow exists (creates inverse transaction, restores PartDefinition count)

**Key files:**
- `src/routes/spu/assembly/[sessionId]/+page.server.ts` (scanPart, captureField, retractInventory)
- `src/lib/server/db/models/assembly-session.ts`

### 1.3 Receiving → Inventory Pipeline

- `ReceivingLot` captures incoming material (lotId barcode, quantity, inspection pathway, COC docs, photos, checklist)
- System generates `lotNumber` format: `LOT-YYYYMMDD-XXXX`
- On acceptance: `PartDefinition.inventoryCount += quantity`, `InventoryTransaction` created (type: 'receipt')
- Syncs to `ManufacturingMaterial` if linked (FIX-04 mechanism)
- Override workflow with admin password + reason for edge cases

**Key files:**
- `src/lib/server/db/models/receiving-lot.ts`
- `src/routes/spu/receiving/new/+page.server.ts`
- `src/routes/spu/receiving/[lotId]/+page.server.ts`

### 1.4 Lot Traceability Chain

```
ReceivingLot (lotId, bagBarcode, serialNumber, quantity)
  → LotRecord (qrCodeRef, inputLots[].barcode → cartridgeIds[])
    → CartridgeRecord (backing.lotId, waxFilling.waxSourceLot, topSeal.topSealLotId)
      → InventoryTransaction (lotId, cartridgeRecordId, manufacturingStep, quantity)
```

### 1.5 Existing Barcode Fields Across Models

| Model | Field | Purpose | Index |
|-------|-------|---------|-------|
| PartDefinition | `barcode` | Scannable label for part type | Unique, sparse |
| ReceivingLot | `lotId` | Incoming shipment barcode (scanned) | Unique |
| ReceivingLot | `bagBarcode` | Label on storage bag | Sparse |
| GeneratedBarcode | `barcode` | System-generated (e.g., THERMO-000042) | Unique |
| CartridgeRecord | `storage.containerBarcode` | Fridge storage bin label | Indexed |
| CartridgeRecord | `shipping.packageBarcode` | Shipping box barcode | Not indexed |
| SPU | `barcode` | Device barcode (UDI-related) | Sparse |
| SPU parts[] | `barcodeData` | Raw barcode scan data | Not indexed |
| Consumable | `barcode` | Top seal rolls etc. | Not indexed |

### 1.6 Audit & Compliance Infrastructure

- **AuditLog** (Tier 3, immutable): Every SPU/inventory mutation logged with action, oldData, newData, changedBy, changedAt
- **InventoryTransaction** (Tier 3, immutable): Complete ledger of all inventory movements
- **ManufacturingMaterialTransaction** (Tier 3, immutable): Raw material tracking
- **ElectronicSignature** (Tier 3, immutable): Digital signatures for assembly completion

### 1.7 Kanban System (Current)

- `KanbanTask` model with sourceRef, source, tags, status buckets (backlog → ready → wip → waiting → done)
- `KanbanProject` for grouping
- **No direct link to inventory operations** — purely a workflow coordination tool
- Tasks can reference part IDs or receiving lots via sourceRef but don't trigger inventory actions

---

## 2. Gaps: What's Missing

### 2.1 Kanban-to-Parts Integration (NOT WIRED)

Kanban tasks don't know which BOM parts they need. There's no concept of:
- Assembly kits grouped per SPU build
- Kanban buckets that track required PartDefinitions + quantities
- Status transitions triggering inventory reservations or deductions

### 2.2 Part-Level Barcodes for Kanban Bins (MISSING)

No "bin barcode" or "kanban card barcode" that ties a physical bin in a kanban bucket to a specific part + quantity. Need a model like:
```
KanbanBin {
  binBarcode, partDefinitionId, lotId, quantity,
  location, kanbanBucketId, status
}
```

### 2.3 Generic Scan-to-Deduct Flow (MISSING)

Assembly scanning deducts inventory — this works. But there's **no generic barcode scan → identify part → deduct** flow outside of assembly. If operators scan parts from kanban bins during staging/kitting, there's no route for that.

### 2.4 Individual Unit Serial Number Tracking (WEAK)

- `ReceivingLot.serialNumber` captures one serial per lot
- SPU `parts[].serialNumber` exists
- **No per-unit serial number generation** for components needing individual traceability (e.g., 50 thermistors arrive in one lot — no way to assign each a unique ID)

### 2.5 Stock Location / Bin Management (MISSING)

- No warehouse bin/shelf/location field on `PartDefinition`
- Kanban bins need physical location tracking
- Only `CartridgeRecord` has storage location for finished cartridges

### 2.6 Low Stock Alerts / Reorder Points (PARTIAL)

- `PartDefinition.minimumOrderQty` exists but no automated alert system
- BOM dashboard shows "low stock count" with hardcoded < 5 threshold — not configurable per part

### 2.7 Lot Depletion Tracking (MISSING)

- `ReceivingLot` tracks original quantity but not remaining quantity per lot
- Consumption tracked via InventoryTransaction links but no `remainingQuantity` on the lot itself
- No automatic suggestion of next available lot when current lot runs out

### 2.8 Expiration Enforcement (MISSING)

- `PartDefinition.expirationDate` exists
- **Nothing blocks using expired parts during assembly**
- No index on expirationDate for querying soon-to-expire stock

### 2.9 FIFO Enforcement (MISSING)

- No First-In-First-Out enforcement for lot consumption
- Older lots should be consumed first for regulatory compliance
- No mechanism to surface or enforce this during scanning

### 2.10 Barcode Format Standardization (MISSING)

Multiple barcode formats exist with no unified parser:
- `LOT-YYYYMMDD-XXXX` (receiving lots)
- `THERMO-000001` (validation barcodes)
- `SPU-{serial}` (SPU UDIs)
- Custom part barcodes (freeform on PartDefinition)

A unified barcode parsing/routing function would help the scan flow determine what was scanned and what action to take.

---

## 3. MongoDB Infrastructure Needed

### 3.1 New Collections

| Collection | Model | Purpose | Effort |
|------------|-------|---------|--------|
| `kanban_bins` | KanbanBin | Physical bin barcodes mapped to parts, lots, quantities, locations | Medium |
| `inventory_reservations` | InventoryReservation | Pre-deduct holds (partId, qty, reservedFor SPU/session, expiresAt) | Medium |
| `serial_numbers` | SerialNumber | Individual unit tracking within a lot (lotId, serialNumber, status, consumedBy) | Medium |

### 3.2 Model Modifications (Existing Collections)

| Model | Change | Purpose | Effort |
|-------|--------|---------|--------|
| PartDefinition | Add `storageLocation`, `reorderPoint`, `reorderQty` | Bin location + configurable alerts | Small |
| PartDefinition | Add index on `expirationDate` | Query expiring stock | Small |
| KanbanTask | Add `bomItems[]` with partDefinitionId + requiredQty | Link tasks to required parts | Small |
| ReceivingLot | Add `remainingQuantity` field | Track per-lot depletion | Small |
| ReceivingLot | Add `serialNumbers[]` array | Per-unit serial tracking within lot | Medium |

### 3.3 New API Routes

| Route | Purpose | Effort |
|-------|---------|--------|
| `POST /api/inventory/scan-deduct` | Generic barcode scan → identify → deduct flow | Small |
| `GET /api/inventory/barcode-lookup/{barcode}` | Unified barcode parser — returns entity type + details | Small |
| `POST /api/kanban/bins/create` | Create kanban bin with barcode | Small |
| `GET /api/inventory/expiring` | Parts expiring within N days | Small |
| `GET /api/inventory/low-stock` | Parts below configurable reorder point | Small |

---

## 4. Things To Consider

1. **Race conditions on inventory count** — `$inc` is atomic in MongoDB but if two operators scan the same part type simultaneously, count could go negative. Consider a check-and-decrement pattern or minimum floor of 0.

2. **Kitting vs. point-of-use scanning** — Do you want operators to scan parts *when staging a kanban bin* (kitting) or *when installing into the SPU* (point-of-use)? Currently only point-of-use exists. Both may be needed.

3. **Partial lot consumption** — When a lot is partially used, the system should know how many units remain in that specific lot, not just the global PartDefinition count.

4. **Barcode printing integration** — Generating barcodes in the system is one thing; printing physical labels for kanban bins, parts bags, and SPU devices is another. Consider label printer integration (Zebra, DYMO, etc.).

5. **Offline/disconnected scanning** — If the web app goes down or network drops during assembly, scans could be lost. Consider a local buffer/queue for scan events.

6. **BomItem vs. PartDefinition dual inventory** — BomItem.inventoryCount is denormalized from PartDefinition.inventoryCount. This can drift. Consider removing BomItem.inventoryCount and always reading from PartDefinition.

7. **Consumable tracking divergence** — `Consumable` model tracks usage differently (volume-based with usageLog[]) than `PartDefinition` (count-based). These should eventually converge or have clear boundaries.

---

## 5. Estimated Distance to Goal

| Capability | Status | Gap |
|-----------|--------|-----|
| SPU creation + DHR | Built | None |
| Assembly barcode scanning → inventory deduction | Built | None |
| Receiving → inventory pipeline | Built | None |
| Lot traceability chain | Built | None |
| Audit trail + immutable transactions | Built | None |
| Sacred document pattern (finalization/corrections) | Built | None |
| Kanban workflow (basic) | Built | No inventory link |
| Kanban bins with barcodes | Not started | New model + routes |
| Generic scan-to-deduct (outside assembly) | Not started | New API route |
| Per-unit serial numbers | Not started | New model or schema change |
| Stock location / bin management | Not started | Schema additions |
| FIFO lot enforcement | Not started | Logic in scan flow |
| Expiration enforcement | Not started | Logic in scan flow |
| Barcode format router | Not started | Utility function |
| Low stock alerts (configurable) | Partial | Schema + notification system |

**Overall: ~60-70% complete on the backend.** The core DHR, assembly scanning, inventory deduction, and audit infrastructure is solid. The main new work is the kanban-to-inventory bridge (bin barcodes, scan routing, reservation system) and the enforcement features (FIFO, expiration, stock levels).

# PRD-3: Inventory Transactions & Traceability

## Overview
Wire up inventory consumption and creation events at every manufacturing step so that any cartridge or SPU can be traced back through its entire history to receiving of goods. Add traceability views accessible from Cart Admin, SPU Admin, and individual unit pages.

## Background
- `inventory_transactions` collection exists but is empty
- Manufacturing pages exist (wax filling, reagent filling, top seal, QA/QC, etc.) but don't record consumption/creation events
- Nick's vision: trace any finished cartridge back through every step to the original received lot, with operator, timestamp, and documentation at each point
- Lot-level tracking for raw/processed materials; serialized tracking from wax filling barcode scan onward

## Manufacturing Chain (Cartridge)
```
Raw Materials (lot-level)
  ├─ Thermoseal roll (PT-CT-101) ──→ Cut Thermoseal step ──→ cut sheets (lot)
  ├─ Cartridge mold (PT-CT-104) ──→ Laser Cut step ──→ individual backs (lot)
  ├─ Barcode (PT-CT-106) ──────────→ Backing step ──→ backed cartridge (lot)
  │
  Serialization point: Wax Filling barcode scan
  │
  ├─ Backed cartridge + Wax (PT-CT-105) ──→ Wax Filling (Opentrons) ──→ wax-filled cartridge (serialized, deck position tracked)
  ├─ Wax-filled cartridge + Reagents ──→ Reagent Filling (Opentrons) ──→ reagent-filled cartridge (serialized)
  ├─ Reagent-filled cartridge + Top Seal (PT-CT-103) ──→ Top Seal step ──→ sealed cartridge (serialized)
  └─ Sealed cartridge ──→ Storage (fridge, barcoded) ──→ ready for customer
```

## Stories

### S1: Inventory Transaction Model & Service
**As a** developer, **I want** a standardized transaction logging service **so that** every manufacturing step records consumption and creation events consistently.

**Acceptance Criteria:**
- `InventoryTransaction` model with fields:
  - `transactionType`: enum ['receipt', 'consumption', 'creation', 'scrap', 'adjustment']
  - `partDefinitionId`: reference to part consumed/created
  - `lotId`: reference to receiving lot (for traceability)
  - `cartridgeRecordId`: reference to serialized cartridge (if applicable)
  - `quantity`: amount consumed/created
  - `previousQuantity`: inventory before transaction
  - `newQuantity`: inventory after transaction
  - `manufacturingStep`: enum ['cut_thermoseal', 'laser_cut', 'backing', 'wax_filling', 'reagent_filling', 'top_seal', 'storage', 'qa_qc', 'scrap']
  - `manufacturingRunId`: reference to the specific run/session
  - `operatorId`: who performed the action
  - `notes`: optional
  - `timestamp`: auto
- Service function: `recordTransaction(params)` that creates transaction + updates `part_definitions.inventoryCount`
- All transactions are immutable (append-only, no edits)

### S2: Wire Transactions into Manufacturing Pages
**As an** operator, **when** I complete a manufacturing step **then** the system automatically records what was consumed and created.

**Acceptance Criteria:**
- Each manufacturing `+page.server.ts` action calls `recordTransaction()` on form submission
- Wax Filling: consumes backed cartridge (lot) + wax (lot), creates wax-filled cartridge (serialized with deck position)
- Reagent Filling: consumes wax-filled cartridge + reagents, creates reagent-filled cartridge
- Top Seal: consumes reagent-filled cartridge + top seal material, creates sealed cartridge
- Storage: records storage location (fridge ID, shelf, position)
- Each transaction links to the originating `receiving_lot` via `lotId`
- No UI changes to manufacturing pages — transactions happen in the background on existing form actions

### S3: QC Rejection Workflow
**As an** operator, **I want** to scrap a cartridge that fails QC **so that** failed units are recorded and removed from active inventory.

**Acceptance Criteria:**
- QC page: "Fail/Scrap" button on any cartridge under inspection
- Scrap form: reason (dropdown: dimensional, contamination, seal failure, wax defect, reagent defect, other), operator notes (free text), photo upload
- Creates `inventory_transaction` with type "scrap"
- Cartridge record status → "scrapped", immutable after
- Admin override: enter admin password to overturn a scrap decision (creates new transaction with type "adjustment", notes required)
- Scrap event visible in cartridge history and traceability view

### S4: Cartridge Traceability View
**As a** user, **I want** to view the full history of any serialized cartridge **so that** I can trace it back to raw materials.

**Acceptance Criteria:**
- Accessible from: Cart Admin → click any cartridge → "Traceability" tab
- Timeline view showing every step chronologically:
  - Receiving lot(s) that supplied materials (with CoC/inspection links)
  - Each manufacturing step: timestamp, operator, what was consumed/created
  - QC results (pass/fail)
  - Storage location
  - Current status
- Each step expandable to show: operator name, exact timestamp, lot IDs consumed, notes, photos
- Links to: receiving lot detail, inspection results, CoC documents
- Search by cartridge serial number or barcode

### S5: Lot Traceability View
**As a** user, **I want** to see where a received lot was consumed **so that** I can trace forward from raw material to finished cartridges.

**Acceptance Criteria:**
- Accessible from: ROG → lot detail → "Usage" tab
- Shows all `inventory_transactions` referencing this lot
- Groups by manufacturing step
- Shows which cartridges (serialized) consumed material from this lot
- If lot was rejected/returned, show disposition details
- Useful for recalls: "Lot X of wax was bad → which cartridges used it?"

### S6: Part Traceability Summary
**As a** user, **I want** to see transaction history for any part **so that** I can understand inventory movements over time.

**Acceptance Criteria:**
- Accessible from: Part Management → part detail → "Transactions" tab
- Chronological list of all `inventory_transactions` for this part
- Filter by: transaction type, date range, operator
- Running inventory count shown
- Summary stats: total received, total consumed, total scrapped, current count

## Dependencies
- PRD-1 (Part Management) — parts must exist with IDs
- PRD-2 (ROG) — lots must be created via receiving workflow to link transactions

## Estimated Effort
- 6-8 hours across 1 Ralph loop

## Notes
- Manufacturing pages already exist — we're adding transaction logging to their existing form actions, not rebuilding them
- Pre-serialization steps (cut thermoseal, laser cut, backing) track at lot level only
- Post-serialization steps (wax, reagent, top seal, storage) track per cartridge
- SPU assembly traceability follows same pattern but is out of scope for this PRD (future work)

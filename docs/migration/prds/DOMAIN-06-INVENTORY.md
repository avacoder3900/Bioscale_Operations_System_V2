# DOMAIN-06-INVENTORY — Parts, BOM & Inventory Transactions

## Overview
**Domain:** Part Definitions, Bill of Materials, Inventory Ledger
**Dependencies:** Auth
**MongoDB Collections:** `part_definitions`, `bom_items`, `bom_column_mapping`, `inventory_transactions`
**Test File:** `tests/contracts/06-inventory.test.ts` (7 tests)
**Contract Registry Sections:** SPU Parts Routes, SPU BOM Routes, SPU Inventory Routes, API Routes (bom/search, inventory/transactions)

---

## Story INV-01: Part Definitions CRUD

### Description
Implement part definition management — list, create, detail with lot history and transactions.

### Routes Covered
- `GET /spu/parts` — parts list
- `POST /spu/parts` (action: create)
- `GET /spu/parts/[partId]` — part detail with lots and transactions
- `POST /spu/parts/[partId]` (actions: update, receiveLot)

### Contract References
**GET /spu/parts returns:**
```typescript
{
  items: {
    id: string, partNumber: string, name: string, description: string | null,
    category: string | null, currentStock: number, unit: string,
    reorderPoint: number | null, isActive: boolean, createdAt: Date
  }[]
}
```
Note: test checks for key `items`.

**GET /spu/parts/[partId] returns:**
```typescript
{
  part: {
    id: string, partNumber: string, name: string, description: string | null,
    category: string | null, currentStock: number, unit: string,
    reorderPoint: number | null, isActive: boolean, createdAt: Date, updatedAt: Date
  }
  lots: { id: string, lotNumber: string, quantity: number, receivedAt: Date, expirationDate: Date | null, status: string }[]
  transactions: {
    id: string, transactionType: string, quantity: number, lotNumber: string | null,
    notes: string | null, createdAt: Date, createdByUsername: string
  }[]
}
```

### MongoDB Models Used
- `PartDefinition` — CRUD
- `InventoryTransaction` — query by `partDefinitionId` for transaction history

### MongoDB-Specific Notes
- `currentStock` is derived from inventory transactions (sum of all transaction quantities for this part)
- Transactions are in the **immutable** `inventory_transactions` collection (Tier 3)
- Lots: inventory transactions of type 'receipt' grouped by lotNumber

### Acceptance Criteria
- Test 1 in `06-inventory.test.ts` passes (parts list returns items)
- Part CRUD works
- Lot receiving creates inventory transaction

---

## Story INV-02: BOM Items & Folders

### Description
Implement BOM item management with folder organization.

### Routes Covered
- `GET /spu/bom` — BOM item list with folders
- `GET /spu/bom/[bomId]` — BOM item detail
- `POST /spu/bom/[bomId]` (actions: update, delete)
- `GET /spu/bom/folders` — folder list
- `POST /spu/bom/folders` (actions: create, rename, delete)
- `GET /api/bom/search` — search API

### Contract References
**GET /spu/bom returns:**
```typescript
{
  items: {
    id: string, partNumber: string, name: string, description: string | null,
    unitCost: number | null, quantity: number | null, supplier: string | null,
    category: string | null, isActive: boolean, expirationDate: Date | null,
    folderId: string | null, folderName: string | null, createdAt: Date, updatedAt: Date
  }[]
  folders: { id: string, name: string }[]
}
```

### MongoDB Models Used
- `BomItem` — CRUD. Has `bomType: 'spu' | 'cartridge'` discriminator. Embedded `versionHistory[]` and `partLinks[]`

### MongoDB-Specific Notes
- Old code had `BomItem` + `CartridgeBomItem` + `BomItemVersion` + `BomPartLink` — merged into one collection with `bomType` discriminator
- Folders: BOM items reference a `folderId`. Folders may be a simple embedded array in a settings document or a lightweight query pattern
- Search API: `BomItem.find({ $or: [{ name: /query/i }, { partNumber: /query/i }] })`

### Acceptance Criteria
- Tests 2-4 in `06-inventory.test.ts` pass (BOM page, folders, settings)
- BOM item CRUD works
- Folder management works
- Search API returns results

---

## Story INV-03: Inventory Transactions & BOM Settings

### Description
Implement the inventory transaction ledger, retraction flow, and BOM sync settings.

### Routes Covered
- `GET /spu/inventory/transactions` — transaction list
- `POST /spu/inventory/transactions` (actions: create, retract)
- `GET /api/inventory/transactions` — API endpoint
- `POST /api/inventory/transactions/[transactionId]/retract` — retract API
- `GET /spu/bom/settings` — BOM sync settings (Box integration)
- `GET /spu/bom/settings/mapping` — column mapping

### Contract References
**GET /spu/inventory/transactions returns:**
```typescript
{
  transactions: {
    id: string, partId: string, partNumber: string, partName: string,
    transactionType: 'receive' | 'consume' | 'adjust' | 'return',
    quantity: number, lotNumber: string | null, notes: string | null,
    createdAt: Date, createdByUsername: string, isRetracted: boolean
  }[]
  parts: { id: string, partNumber: string, name: string }[]
}
```

### MongoDB Models Used
- `InventoryTransaction` — **immutable** Tier 3 collection. Create-only, never update
- `PartDefinition` — for parts dropdown
- `BomColumnMapping` — column mapping singleton
- `Integration` — Box integration settings (type: 'box')

### MongoDB-Specific Notes
- Transactions are immutable — "retract" creates a NEW compensating transaction, doesn't modify the original
- `isRetracted` is derived: check if a retraction transaction exists for this transaction
- Transaction creation updates `PartDefinition.currentStock` (or computed on read)

### Acceptance Criteria
- Tests 5-7 in `06-inventory.test.ts` pass (transactions page, transactions API, BOM search)
- Transaction creation works
- Retraction creates compensating transaction
- BOM settings page loads

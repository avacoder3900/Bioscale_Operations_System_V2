# INFRA-02 — Server Load Function Data Shape Fixes

## Overview
**Problem:** 7 routes crash with 500 errors because `+page.server.ts` load functions return data shapes that don't match what the frozen `.svelte` UI components expect. The `.svelte` files were copied from the old Postgres app and cannot be modified — all fixes must be in server files.

**Root Cause:** During the weekend migration, agents wrote load functions that return partial or incorrectly-named data. The Svelte SSR renderer crashes when it accesses `undefined.property` (e.g., `data.stats.spectrophotometer` when `data.stats` is undefined).

**Pattern:** Every crash is `TypeError: Cannot read properties of undefined (reading 'X')` in a `.svelte` file because the server didn't provide the expected property.

**Files Modifiable:** Only `+page.server.ts` and `+layout.server.ts` files.
**Files Frozen:** All `.svelte` files.

---

## Story INFRA-02-A: Fix `/spu/manufacturing` Page Load

### Problem
`+page.svelte:25` calls `Object.keys(data.stats)` but the server never returns a `stats` property. Additionally, field names in `recentLots` are wrong (`id` vs `lotId`, `operatorUsername` vs `username`).

### File to Modify
`src/routes/spu/manufacturing/+page.server.ts`

### Current Return Shape (WRONG)
```typescript
{
  recentLots: [{ id, qrCodeRef, processName, processType, status, operatorUsername, quantityProduced, startTime, finishTime, createdAt }],
  activeWaxRuns: [...],       // not used by +page.svelte
  activeReagentRuns: [...],   // not used by +page.svelte
  phaseDistribution: [...]    // not used by +page.svelte
}
```

### Required Return Shape
```typescript
{
  recentLots: Array<{
    lotId: string;            // was: id
    qrCodeRef: string;
    configId: string;         // MISSING — processConfig._id
    quantityProduced: number;
    startTime: string | null;
    finishTime: string | null;
    cycleTime: number | null; // MISSING — LotRecord.cycleTime
    status: string;
    username: string | null;  // was: operatorUsername
  }>;
  stats: Record<string, {    // MISSING ENTIRELY
    lotsToday: number;
    unitsToday: number;
  }>;
}
```

### Implementation Notes
- `stats` should be keyed by `processConfig._id` (configId). Query `LotRecord` for lots created today, group by `processConfig._id`, count lots and sum `quantityProduced`.
- `configId` comes from `LotRecord.processConfig._id`.
- `cycleTime` is stored directly on `LotRecord.cycleTime`.
- Remove `activeWaxRuns`, `activeReagentRuns`, `phaseDistribution` from the return — the `+page.svelte` doesn't use them (the manufacturing **layout** handles those).
- Rename `id` → `lotId`, `operatorUsername` → `username`.

### Acceptance Criteria
- `/spu/manufacturing` loads without 500 error
- Stats cards render (may show zeros with no data)
- Recent lots table renders

---

## Story INFRA-02-B: Fix `/spu/validation` Page Load

### Problem
`+page.svelte:75` accesses `data.stats.spectrophotometer.total` but the server returns `{ instruments: [...] }` — a completely wrong data shape (just a navigation link list).

### File to Modify
`src/routes/spu/validation/+page.server.ts`

### Current Return Shape (WRONG)
```typescript
{
  instruments: [{ name: string, path: string }]  // Not used by +page.svelte at all
}
```

### Required Return Shape
```typescript
{
  recentSessions: Array<{
    id: string;
    type: string;             // 'spectrophotometer' | 'thermocouple' | 'magnetometer'
    status: string;           // 'pending' | 'in_progress' | 'completed' | 'failed'
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string;
    barcode: string | null;
    username: string | null;
  }>;
  stats: {
    spectrophotometer: { total: number; passed: number; failed: number };
    thermocouple: { total: number; passed: number; failed: number };
    magnetometer: { total: number; passed: number; failed: number };
  };
  barcodeStats: {
    today: number;
  };
}
```

### Implementation Notes
- Query `ValidationSession` model for recent sessions (limit 20, sorted by `createdAt` desc).
- For `stats`, aggregate `ValidationSession` grouped by `type`, counting total and tallying `status === 'completed'` with `results[].passed` checks for pass/fail breakdown. If the `results` array is too complex, count by `status`: completed = passed, failed = failed.
- For `barcodeStats.today`, count `GeneratedBarcode` documents created since midnight today.
- Join `User` for `username` via `ValidationSession.userId`.
- Join `GeneratedBarcode` for `barcode` via `ValidationSession.generatedBarcodeId`.
- If no validation sessions exist, return zeros — the page will show empty state gracefully.

### Models Used
- `ValidationSession` — main data source
- `GeneratedBarcode` — barcode text and today's count
- `User` — username lookup

### Acceptance Criteria
- `/spu/validation` loads without 500 error
- Stats cards render with correct counts (or zeros)
- Recent sessions table renders
- Barcode count shows today's count

---

## Story INFRA-02-C: Fix `/spu/parts` Page Load

### Problem
`+page.svelte:283` accesses `data.boxStatus.isConnected` but the server only returns `{ items: [...] }` — missing 7+ top-level properties.

### File to Modify
`src/routes/spu/parts/+page.server.ts`

### Current Return Shape (WRONG)
```typescript
{
  items: [{ id, partNumber, name, description, category, currentStock, unit, reorderPoint, isActive, createdAt }]
}
```

### Required Return Shape
```typescript
{
  items: Array<{
    id: string;
    partNumber: string;
    name: string;
    description: string | null;
    category: string | null;
    supplier: string | null;           // MISSING
    manufacturer: string | null;       // MISSING
    inventoryCount: number;            // MISSING (was: currentStock, wrong name)
    quantityPerUnit: number | null;    // MISSING
    unitCost: number | null;           // MISSING
    totalValue: number | null;         // MISSING (computed: inventoryCount * unitCost)
    minimumStockLevel: number;         // MISSING
    leadTimeDays: number | null;       // MISSING
  }>;
  cartridgeParts: Array<{             // MISSING ENTIRELY — BomItem where bomType='cartridge'
    id: string;
    partNumber: string;
    name: string;
    category: string | null;
    quantityPerUnit: number | null;
    inventoryCount: number;
    unitCost: number | null;
    totalValue: number | null;
    manufacturer: string | null;
    supplier: string | null;
    minimumStockLevel: number;
    leadTimeDays: number | null;
  }>;
  cartridgeBomSummary: {              // MISSING ENTIRELY
    totalParts: number;
    totalValue: number | null;
    categories: string[];
    lowStockCount: number;
  } | null;
  lowStockItems: Array<{             // MISSING ENTIRELY
    id: string;
    partNumber: string;
    name: string;
    inventoryCount: number;
    minimumStockLevel: number;
  }>;
  boxStatus: {                        // MISSING ENTIRELY
    isConnected: boolean;
    lastSyncAt: string | null;
    lastSyncStatus: string | null;
  };
  syncErrorDetail: {                  // MISSING ENTIRELY
    message: string;
    failedRows: string[];
    columnIssues: string[];
  } | null;
  stats: {                            // MISSING ENTIRELY
    total: number;
    categories: number;
    totalInventoryValue: number | null;
    lowStockCount: number;
  };
  categories: string[];               // MISSING ENTIRELY
}
```

### Implementation Notes
- `items` comes from `PartDefinition.find()`. Add missing fields: `supplier`, `manufacturer`, `inventoryCount` (from BomItem join or PartDefinition itself), `quantityPerUnit`, `unitCost` (parse from String to Number), `totalValue` (computed), `minimumStockLevel`, `leadTimeDays`.
- Note: `PartDefinition.unitCost` is stored as String (known schema bug). Parse to Number with `parseFloat()`, fallback to `null`.
- `cartridgeParts` comes from `BomItem.find({ bomType: 'cartridge' })`.
- `cartridgeBomSummary` is computed from `cartridgeParts`.
- `lowStockItems` = items where `inventoryCount < minimumStockLevel` (from BomItem or PartDefinition).
- `boxStatus` comes from `Integration.findOne({ type: 'box' })` — map `accessToken` existence to `isConnected`, plus `lastSyncAt` and `lastSyncStatus`.
- `syncErrorDetail` = `null` unless `Integration.lastSyncStatus === 'error'`, in which case populate from `lastSyncError`.
- `stats` is computed from the items array.
- `categories` = unique list of category strings from items.

### Models Used
- `PartDefinition` — main SPU parts
- `BomItem` — cartridge BOM parts
- `Integration` — Box.com connection status

### Acceptance Criteria
- `/spu/parts` loads without 500 error
- Parts table renders with all columns
- Stats cards (total, categories, value, low stock) render
- Box.com connection status indicator renders
- Low stock alert section renders
- Cartridge BOM summary section renders

---

## Story INFRA-02-D: Create `/spu/cartridge-admin` Page Load

### Problem
`+page.svelte:8` accesses `data.filters.search` but there is NO `+page.server.ts` file at all — only a layout providing `user`.

### File to Create
`src/routes/spu/cartridge-admin/+page.server.ts`

### Required Return Shape
```typescript
{
  filters: {
    search: string;
    sortBy: string;
    sortDir: 'asc' | 'desc';
    assayTypeId: string;
    lifecycleStage: string;
    operatorId: string;
  };
  cartridges: Array<{
    cartridgeId: string;
    backedLotId: string | null;
    assayTypeName: string | null;
    waxRunId: string | null;
    reagentRunId: string | null;
    currentLifecycleStage: string;
    operatorName: string | null;
    createdAt: string;
    expirationDate: string | null;
    storageLocation: string | null;
    waxStatus: string | null;
    waxQcStatus: string | null;
    inspectionStatus: string | null;
    topSealBatchId: string | null;
    coolingTrayId: string | null;
    ovenEntryTime: string | null;
  }>;
  assayTypes: Array<{ id: string; name: string }>;
  operators: Array<{ id: string; name: string }>;
  total: number;
  pageSize: number;
  pageNum: number;
}
```

### Implementation Notes
- Parse URL search params for filters: `search`, `sortBy` (default: `createdAt`), `sortDir` (default: `desc`), `assayTypeId`, `lifecycleStage`, `operatorId`, `page` (default: 1).
- Build MongoDB query from filters. For `search`, match against `_id` (cartridgeId) or `backing.lotQrCode`. For `lifecycleStage`, match `currentPhase`. For `assayTypeId`, match `reagentFilling.assayType._id`.
- Query `CartridgeRecord` with pagination (pageSize=25). Get `total` count via `countDocuments()`.
- Map CartridgeRecord fields:
  - `cartridgeId` = `_id`
  - `backedLotId` = `backing.lotId`
  - `assayTypeName` = `reagentFilling.assayType.name`
  - `waxRunId` = `waxFilling.runId`
  - `reagentRunId` = `reagentFilling.runId`
  - `currentLifecycleStage` = `currentPhase`
  - `operatorName` = first available operator username from any phase
  - `expirationDate` = `reagentFilling.expirationDate`
  - `storageLocation` = `storage.fridgeName` or `storage.locationId`
  - `waxStatus` = derive from `waxFilling.recordedAt` existence
  - `waxQcStatus` = `waxQc.status`
  - `inspectionStatus` = `reagentInspection.status`
  - `topSealBatchId` = `topSeal.batchId`
  - `coolingTrayId` = `waxStorage.coolingTrayId`
  - `ovenEntryTime` = `backing.ovenEntryTime`
- `assayTypes` from `AssayDefinition.find()` → `[{ id: _id, name }]`.
- `operators` from `User.find({ isActive: true })` → `[{ id: _id, name: username }]`.
- Add `requirePermission(locals.user, 'cartridgeAdmin:read')`.

### Models Used
- `CartridgeRecord` — main data source
- `AssayDefinition` — dropdown options
- `User` — operator dropdown options

### Acceptance Criteria
- `/spu/cartridge-admin` loads without 500 error
- Cartridge table renders with data (when seeded)
- Filter dropdowns populate with assay types and operators
- Pagination works
- Sort by column works

---

## Story INFRA-02-E: Fix `/spu/equipment/activity` Page Load

### Problem
`+page.svelte:93` accesses `data.locations.filter(...)` but the server only returns `{ activities: [...] }` — the wrong data entirely. The page expects 9 properties (decks, trays, locations, equipmentTemps, placements, activeWaxRuns, activeReagentRuns, waxRunHistory, reagentRunHistory).

### File to Modify
`src/routes/spu/equipment/activity/+page.server.ts`

### Current Return Shape (WRONG)
```typescript
{
  activities: [{ id, equipmentId, equipmentName, activityType, description, performedAt, performedByUsername, notes }]
}
```

### Required Return Shape
```typescript
{
  decks: Array<{
    deckId: string;
    status: string;
    currentRobotId: string | null;
    lastUsed: string | null;
  }>;
  trays: Array<{
    trayId: string;
    status: string;
    assignedRunId: string | null;
  }>;
  locations: Array<{
    id: string;
    barcode: string;
    locationType: string;      // 'fridge' | 'oven'
    displayName: string;
    isActive: boolean;
    capacity: number | null;
  }>;
  equipmentTemps: Record<string, number | null>;  // keyed by displayName
  placements: Array<{
    locationId: string;
    locationType: string;
    displayName: string;
    itemType: string;
    itemId: string;
  }>;
  activeWaxRuns: Array<{
    runId: string;
    robotId: string;
    deckId: string | null;
    coolingTrayId: string | null;
    status: string;
  }>;
  activeReagentRuns: Array<{
    runId: string;
    robotId: string;
    deckId: string | null;
    status: string;
  }>;
  waxRunHistory: Array<{
    runId: string;
    robotId: string;
    deckId: string | null;
    coolingTrayId: string | null;
    waxSourceLot: string | null;
    status: string;
    operatorName: string;
    abortReason: string | null;
    plannedCartridgeCount: number | null;
    runStartTime: string | null;
    runEndTime: string | null;
    createdAt: string;
  }>;
  reagentRunHistory: Array<{
    runId: string;
    robotId: string;
    deckId: string | null;
    status: string;
    operatorName: string;
    abortReason: string | null;
    cartridgeCount: number | null;
    runStartTime: string | null;
    runEndTime: string | null;
    createdAt: string;
  }>;
}
```

### Implementation Notes
- `decks` from `Consumable.find({ type: 'deck' })` → map `_id` → `deckId`, include `status`, `currentRobotId`, `lastUsed`.
- `trays` from `Consumable.find({ type: 'cooling_tray' })` → map `_id` → `trayId`, include `status`, `assignedRunId`.
- `locations` from `EquipmentLocation.find()`.
- `equipmentTemps` from `Equipment.find()` → build `{ [name]: currentTemperatureC }` record.
- `placements` from `EquipmentLocation` — flatten `currentPlacements[]` from each location, include the parent location's `locationType` and `displayName`.
- `activeWaxRuns` from `WaxFillingRun.find({ status: { $in: ['setup', 'running'] } })`.
- `activeReagentRuns` from `ReagentBatchRecord.find({ status: { $in: ['setup', 'running'] } })`.
- `waxRunHistory` from `WaxFillingRun.find().sort({ createdAt: -1 }).limit(50)`.
- `reagentRunHistory` from `ReagentBatchRecord.find().sort({ createdAt: -1 }).limit(50)`.
- Add `requirePermission(locals.user, 'equipment:read')`.

### Models Used
- `Consumable` (type: 'deck' and 'cooling_tray')
- `EquipmentLocation`
- `Equipment`
- `WaxFillingRun`
- `ReagentBatchRecord`

### Acceptance Criteria
- `/spu/equipment/activity` loads without 500 error
- Equipment locations / fridges / ovens section renders
- Deck and tray status displays
- Temperature readings display
- Active run indicators display
- Run history tables render

---

## Story INFRA-02-F: Fix `/spu/inventory/transactions` Page Load

### Problem
`+page.svelte:45` accesses `data.filters.partId` but the server doesn't return `filters` or `canRetract`. Also, transaction field names are wrong (`notes` vs `reason`, `createdAt` vs `performedAt`, etc.).

### File to Modify
`src/routes/spu/inventory/transactions/+page.server.ts`

### Current Return Shape (WRONG)
```typescript
{
  transactions: [{
    id, partId, partNumber, partName, transactionType, quantity,
    lotNumber, notes, createdAt, createdByUsername, isRetracted  // WRONG NAMES
  }],
  parts: [{ id, partNumber, name }]
  // MISSING: filters, canRetract
}
```

### Required Return Shape
```typescript
{
  transactions: Array<{
    id: string;
    partDefinitionId: string;       // was: partId
    partName: string | null;
    partNumber: string | null;
    transactionType: string;
    quantity: number;
    previousQuantity: number;       // MISSING — from InventoryTransaction model
    newQuantity: number;            // MISSING — from InventoryTransaction model
    reason: string | null;          // was: notes
    performedBy: string;            // MISSING
    performedByName: string | null; // was: createdByUsername
    performedAt: string | null;     // was: createdAt
    assemblySessionId: string | null; // MISSING
    retractedAt: string | null;     // MISSING
    retractedBy: string | null;     // MISSING
    retractionReason: string | null;  // MISSING
    isRetracted: boolean;
  }>;
  parts: Array<{ id: string; name: string; partNumber: string | null }>;
  canRetract: boolean;              // MISSING — hasPermission(user, 'inventory:write')
  filters: {                        // MISSING ENTIRELY
    partId: string | null;
    type: string | null;
    startDate: string | null;
    endDate: string | null;
    retracted: string | null;
  };
}
```

### Implementation Notes
- Parse URL search params for filters: `partId`, `type`, `startDate`, `endDate`, `retracted`.
- Build MongoDB query from filters. If `partId`, add to query. If `type`, filter `transactionType`. If date range, filter `performedAt`. If `retracted === 'yes'`, filter `retractedAt: { $exists: true }`.
- All the "missing" transaction fields (`previousQuantity`, `newQuantity`, `assemblySessionId`, `retractedAt`, `retractedBy`, `retractionReason`) are already on the `InventoryTransaction` model — just not being mapped.
- `performedByName` requires a User lookup by `performedBy` field.
- `canRetract` = `hasPermission(locals.user, 'inventory:write')`.
- `filters` = echo back the parsed URL params.

### Models Used
- `InventoryTransaction`
- `PartDefinition`
- `User` (for performedByName lookup)

### Acceptance Criteria
- `/spu/inventory/transactions` loads without 500 error
- Transaction table renders with all columns
- Filter dropdowns (part, type, date range, retracted) work
- Retraction button shows/hides based on `canRetract`
- Retracted transactions display correctly with reason

---

## Story INFRA-02-G: Fix `/spu/assays` Page Load

### Problem
`+page.svelte:7` accesses `data.filters.search` but the server only returns `{ assays: [...] }` — missing `filters`, `stats`, `canWrite`, `canDelete`. Also, assay field names are wrong (`id` vs `assayId`, missing `duration`, `bcodeLength`, `linkedCartridges`, `isActive`).

### File to Modify
`src/routes/spu/assays/+page.server.ts`

### Current Return Shape (WRONG)
```typescript
{
  assays: [{
    id, name, skuCode, version, status, description, createdAt, updatedAt  // WRONG NAMES
  }]
}
```

### Required Return Shape
```typescript
{
  assays: Array<{
    assayId: string;              // was: id
    name: string;
    duration: number | null;      // MISSING — AssayDefinition.duration
    bcodeLength: number | null;   // MISSING — AssayDefinition.bcodeLength
    version: number;
    linkedCartridges: number;     // MISSING — count of CartridgeRecords referencing this assay
    isActive: boolean;            // MISSING (was computed as status string)
    updatedAt: string | null;
  }>;
  stats: {                        // MISSING ENTIRELY
    total: number;
    active: number;
    inactive: number;
    totalLinkedCartridges: number;
  };
  filters: {                      // MISSING ENTIRELY
    search: string | null;
    status: string | null;
  };
  canWrite: boolean;              // MISSING — hasPermission(user, 'assay:write')
  canDelete: boolean;             // MISSING — hasPermission(user, 'assay:write') or admin
}
```

### Implementation Notes
- Parse URL search params for filters: `search`, `status`.
- Apply search filter to query (match `name` or `skuCode` with regex). Apply status filter (`isActive` boolean).
- For `linkedCartridges`, aggregate `CartridgeRecord` by `reagentFilling.assayType._id` to get count per assay. Build a map, then look up per assay.
- `stats` is computed from the full assay list (before pagination).
- `canWrite` = `hasPermission(locals.user, 'assay:write')`.
- `canDelete` = `hasPermission(locals.user, 'assay:write')` (same — only admins typically have this).
- Rename `id` → `assayId`.
- Add fields from AssayDefinition model: `duration`, `bcodeLength`, `isActive` (boolean, not derived string).

### Models Used
- `AssayDefinition`
- `CartridgeRecord` (for linkedCartridges count)

### Acceptance Criteria
- `/spu/assays` loads without 500 error
- Stats cards (total, active, inactive, linked cartridges) render
- Search and status filter work
- Write/delete buttons show/hide based on permissions
- Assay table renders with all columns

---

## Implementation Order

1. **INFRA-02-F** (inventory/transactions) — Simplest: mostly renaming fields, adding `filters` and `canRetract`
2. **INFRA-02-G** (assays) — Simple: renaming fields, adding `filters`, `stats`, `canWrite`
3. **INFRA-02-A** (manufacturing) — Moderate: needs `stats` aggregation
4. **INFRA-02-B** (validation) — Moderate: completely new queries
5. **INFRA-02-C** (parts) — Complex: 8 top-level properties to add
6. **INFRA-02-E** (equipment/activity) — Complex: 9 data sources across 5 models
7. **INFRA-02-D** (cartridge-admin) — Complex: new file, pagination, filtering

## Verification
For each story:
1. `npm run build` — must pass (Vite compilation, ignore Vercel symlink error on Windows)
2. Navigate to the route in browser — no 500 error, page renders
3. Verify data displays correctly with seed data present

## Complete File List
- `src/routes/spu/manufacturing/+page.server.ts` (modify)
- `src/routes/spu/validation/+page.server.ts` (modify)
- `src/routes/spu/parts/+page.server.ts` (modify)
- `src/routes/spu/cartridge-admin/+page.server.ts` (CREATE)
- `src/routes/spu/equipment/activity/+page.server.ts` (modify)
- `src/routes/spu/inventory/transactions/+page.server.ts` (modify)
- `src/routes/spu/assays/+page.server.ts` (modify)

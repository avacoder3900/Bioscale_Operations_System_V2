# DOMAIN-08-MANUFACTURING — Manufacturing Pipeline

## Overview
**Domain:** Lot Records, Wax Filling, Reagent Filling, Assays, Process Config, Manufacturing Settings, Materials, Laser Cutting, Consumables
**Dependencies:** Auth, Equipment, SPU
**MongoDB Collections:** `lot_records`, `wax_filling_runs`, `reagent_batch_records` (Sacred), `assay_definitions` (Sacred), `process_configurations`, `manufacturing_settings`, `manufacturing_materials`, `manufacturing_material_transactions`, `laser_cut_batches`, `consumables`, `cartridge_records` (Sacred)
**Test File:** `tests/contracts/08-manufacturing.test.ts` (12 tests)
**Contract Registry Sections:** SPU Manufacturing Routes, SPU Assay Routes, SPU Manufacturing Layouts

## Sacred Document Notes
- **Reagent Batch Records** — Tier 1 Sacred. `finalizedAt` blocks mutations. `corrections[]` append-only. Embeds tube records, top seal, cartridge list, QC release.
- **Assay Definitions** — Tier 1 Sacred. `lockedAt` blocks formula changes. `corrections[]` append-only. Embeds reagents with sub-components, version history.
- **Cartridge Records** — Tier 1 Sacred. Manufacturing phases are WRITE-ONCE. This domain writes the manufacturing phases (backing through shipping).

---

## Story MFG-01: Manufacturing Dashboard, Lots & Process Config

### Description
Implement the manufacturing landing page, lot record management, and process configuration.

### Routes Covered
- `GET /spu/manufacturing` — dashboard with recent lots
- `GET /spu/manufacturing/lots/[lotId]` — lot detail with steps and usage
- `GET /spu/manufacturing/opentrons` — robots and recent runs
- `GET /spu/manufacturing/opentrons/history` — completed runs

### Contract References
**GET /spu/manufacturing returns (layout + page):**
```typescript
{
  // From manufacturing layout:
  user: User, isAdmin: boolean,
  processConfigs: { configId: string, processName: string, processType: string }[]
  // From page:
  recentLots: { ... }[]  // test checks for 'recentLots' key
}
```

**GET /spu/manufacturing/lots/[lotId] returns:**
```typescript
{
  lot: { id: string, lotNumber: string, partId: string, partNumber: string, partName: string, status: string, quantity: number, receivedAt: Date, expirationDate: Date | null, ... }
  steps: { id: string, stepName: string, status: string, completedAt: Date | null, completedByUsername: string | null, notes: string | null }[]
  usageHistory: { spuId: string, spuUdi: string, quantityUsed: number, recordedAt: Date }[]
}
```

### MongoDB Models Used
- `LotRecord` — with **embedded** `stepEntries[]`. Operational tier (demoted from sacred in v2)
- `ProcessConfiguration` — with **embedded** `steps[]`
- `OpentronsRobot` — for robot list

### MongoDB-Specific Notes
- Lot step entries are embedded: `lotRecord.stepEntries[]`
- Process config steps are embedded: `processConfig.steps[]`
- Lots are **operational** (not sacred) — freely mutable, no immutability controls

### Acceptance Criteria
- Test 1 in `08-manufacturing.test.ts` passes (manufacturing dashboard with recentLots)

---

## Story MFG-02: Wax Filling Pipeline

### Description
Implement wax filling run management — create runs, equipment view, oven queue, settings.

### Routes Covered
- `GET /spu/manufacturing/wax-filling` — runs list (from wax-filling layout: robots, dashboardState)
- `POST /spu/manufacturing/wax-filling` (action: create)
- `GET /spu/manufacturing/wax-filling/equipment` — equipment for wax filling
- `GET /spu/manufacturing/wax-filling/oven-queue` — oven queue
- `GET /spu/manufacturing/wax-filling/settings` — wax filling settings
- `POST /spu/manufacturing/wax-filling/settings` (action: update)

### Contract References
**Wax Filling Layout provides:**
```typescript
{
  user: User
  robots: { robotId: string, name: string, description: string | null, isActive: boolean, sortOrder: number }[]
  dashboardState: {
    robotId: string, name: string, description: string | null,
    hasActiveRun: boolean, runId: string | null, stage: string | null,
    assayTypeName: string | null, runStartTime: string | null, runEndTime: string | null,
    cartridgeCount: number,
    postRobotRuns: { runId: string, stage: string, assayTypeName: string | null, cartridgeCount: number | null, runStartTime: string | null, runEndTime: string | null }[]
  }[]
}
```

**GET /spu/manufacturing/wax-filling returns:**
```typescript
{
  runs: { id: string, robotId: string, robotName: string, status: string, stage: string, assayTypeId: string | null, assayTypeName: string | null, cartridgeCount: number | null, startTime: Date | null, endTime: Date | null, createdAt: Date }[]
  assayTypes: { id: string, name: string, skuCode: string | null }[]
}
```

### MongoDB Models Used
- `WaxFillingRun` — run management
- `OpentronsRobot` — for robot list and dashboard state
- `ManufacturingSettings` — singleton (`_id: 'default'`), `.waxFilling` section
- `Equipment` — for equipment display
- `CartridgeRecord` — creating cartridge records on run completion (writes `backing` and `waxFilling` phases)

### MongoDB-Specific Notes
- Dashboard state is **computed** from `WaxFillingRun` data grouped by robot
- Creating a wax run creates cartridge records with `backing` phase set, then `waxFilling` phase on completion
- Settings: `ManufacturingSettings.findById('default')` — returns `.waxFilling` section

### Acceptance Criteria
- Tests 2-5 in `08-manufacturing.test.ts` pass (wax-filling, equipment, oven-queue, settings)

---

## Story MFG-03: Reagent Filling Pipeline

### Description
Implement reagent filling run management — create runs, cooling queue, settings. This creates Sacred reagent batch records.

### Routes Covered
- `GET /spu/manufacturing/reagent-filling` — runs list (from reagent-filling layout: robots, dashboardState)
- `POST /spu/manufacturing/reagent-filling` (action: create)
- `GET /spu/manufacturing/reagent-filling/cooling-queue` — cooling queue
- `GET /spu/manufacturing/reagent-filling/settings` — settings
- `POST /spu/manufacturing/reagent-filling/settings` (action: update)

### Contract References
**Reagent Filling Layout provides:** (same structure as wax filling layout)

**GET /spu/manufacturing/reagent-filling returns:**
```typescript
{
  runs: { id: string, robotId: string, robotName: string, status: string, stage: string, assayTypeId: string | null, assayTypeName: string | null, cartridgeCount: number | null, startTime: Date | null, endTime: Date | null, createdAt: Date }[]
  assayTypes: { id: string, name: string, skuCode: string | null }[]
}
```

### MongoDB Models Used
- `ReagentBatchRecord` — **Sacred Tier 1**. Embeds `tubeRecords[]`, `topSeal`, `cartridgesFilled[]`, `qcRelease`
- `AssayDefinition` — for assay type dropdown
- `OpentronsRobot` — for robot list
- `ManufacturingSettings` — `.reagentFilling` section
- `CartridgeRecord` — writes `reagentFilling` phase on completion

### MongoDB-Specific Notes
- **Sacred document handling:** ReagentBatchRecord uses `finalizedAt`. Once finalized, reject all mutations except `corrections[]` push
- Tube records are embedded: `reagentBatch.tubeRecords[]`
- Top seal is embedded: `reagentBatch.topSeal`
- Cartridges filled list is embedded: `reagentBatch.cartridgesFilled[]`
- Creating a reagent run also updates cartridge records with `reagentFilling` phase (WRITE-ONCE on cartridge)

### Acceptance Criteria
- Tests 6-8 in `08-manufacturing.test.ts` pass (reagent-filling, cooling-queue, settings)

---

## Story MFG-04: Assay Definitions

### Description
Implement assay definition management — list, create, detail, edit, import, version history.

### Routes Covered
- `GET /spu/assays` — assay list
- `GET /spu/assays/new` — create form
- `POST /spu/assays/new` — create assay
- `GET /spu/assays/[assayId]` — detail with versions
- `GET /spu/assays/[assayId]/edit` — edit form
- `POST /spu/assays/[assayId]/edit` — update assay
- `GET /spu/assays/[assayId]/assign` — assign to cartridges
- `GET /spu/assays/import` — import form
- `GET /spu/assays/[assayId]/versions` — version history API
- `GET /spu/assays/export` — export API

### Contract References
**GET /spu/assays returns:**
```typescript
{
  assays: { id: string, name: string, skuCode: string | null, version: number, status: string, description: string | null, createdAt: Date, updatedAt: Date }[]
}
```

### MongoDB Models Used
- `AssayDefinition` — **Sacred Tier 1**. Embeds `reagents[]` (with `subComponents[]`), `versionHistory[]`, `corrections[]`

### MongoDB-Specific Notes
- **Sacred document:** `lockedAt` blocks reagent formula changes. Only new versions can be created after lock
- Reagents are embedded: `assay.reagents[]` with `subComponents[]` inside each reagent
- Version history is embedded: `assay.versionHistory[]`
- Old code: 3 separate collections (`AssayType`, `ReagentDefinition`, `ReagentSubComponent`) — all embedded now
- One query loads the complete assay with all reagents and sub-components

### Acceptance Criteria
- Test in `07-spu.test.ts` (assays page loads) — already covered
- Assay CRUD works
- Version history tracks changes
- Lock prevents formula modification

---

## Story MFG-05: QA/QC, Laser Cutting, Top Seal, Materials & Settings

### Description
Implement remaining manufacturing features — QA/QC inspections, laser cutting batches, top seal cutting sessions, manufacturing materials/inventory, and the settings singleton.

### Routes Covered
- `GET /spu/manufacturing/qa-qc` — QA/QC inspections
- `GET /spu/manufacturing/laser-cutting` — laser cut batches
- `GET /spu/manufacturing/top-seal-cutting` — top seal sessions
- `GET /spu/manufacturing/inventory` — manufacturing materials
- `GET /spu/manufacturing/wi-01` — work instruction 01 runs
- `GET /spu/manufacturing/wi-01/steps` — WI 01 steps
- `GET /spu/manufacturing/wi-02` — work instruction 02 runs
- `GET /spu/manufacturing/wi-02/steps` — WI 02 steps

### MongoDB Models Used
- `LaserCutBatch` — CRUD
- `Consumable` — for top seal rolls (`type: 'top_seal_roll'`), incubator tubes (`type: 'incubator_tube'`)
- `ManufacturingMaterial` — with **embedded** `recentTransactions[]`
- `ManufacturingMaterialTransaction` — immutable Tier 3 log
- `ManufacturingSettings` — singleton (`_id: 'default'`) with all settings + `rejectionReasonCodes[]`
- `ProductionRun` — for WI runs
- `WorkInstruction` — for WI steps

### MongoDB-Specific Notes
- Manufacturing settings merged 4 old collections into 1 singleton with sections: `.waxFilling`, `.reagentFilling`, `.general`, `.rejectionReasonCodes[]`
- Material transactions: recent ones embedded in material document, full log in immutable collection
- Consumables use type discriminator: `Consumable.find({ type: 'incubator_tube' })`

### Acceptance Criteria
- Tests 9-12 in `08-manufacturing.test.ts` pass (qa-qc, inventory, laser-cutting, top-seal-cutting)

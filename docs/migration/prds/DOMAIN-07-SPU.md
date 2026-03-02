# DOMAIN-07-SPU — SPU Build Records, Assembly, Validation & Production

## Overview
**Domain:** SPU CRUD, Assembly Sessions, Production Runs, Batches, Validation, Barcodes
**Dependencies:** Auth, Inventory, Documents, Equipment
**MongoDB Collections:** `spus` (Sacred Tier 1), `assembly_sessions`, `batches`, `production_runs`, `validation_sessions`, `generated_barcodes`, `electronic_signatures`, `particle_devices`, `integrations`
**Test File:** `tests/contracts/07-spu.test.ts` (8 tests)
**Contract Registry Sections:** SPU Core Routes, SPU Assembly Routes, SPU Batch Routes, SPU Validation Routes, SPU Device Routes

## Sacred Document Notes
**SPU is a Tier 1 Sacred Document.** Key rules:
- Never deleted — can be `voided` with reason
- Each phase is written once (parts, assembly, validation, signature)
- `finalizedAt` — once set (when deployed to customer), all mutations rejected
- `corrections[]` array — append-only, original data untouched
- Assembly data is **copied** from `assembly_sessions` into `spus.assembly` on completion

---

## Story SPU-01: SPU Dashboard & CRUD

### Description
Implement the main SPU listing page with filters, create/register actions, state updates, and customer assignment.

### Routes Covered
- `GET /spu` — SPU dashboard with list, batches, BOM summary, active runs, fleet summary
- `POST /spu` (actions: create, register, updateState, bulkUpdateState, assignSpu, retrySync)

### Contract References
**GET /spu returns:**
```typescript
{
  spus: {
    id: string, udi: string, status: string, deviceState: string,
    owner: string | null, ownerNotes: string | null,
    batchId: string | null, batchNumber: string | null,
    createdAt: Date, createdByUsername: string | null,
    assignmentType: string | null, assignmentCustomerId: string | null,
    customerName: string | null, qcStatus: string, qcDocumentUrl: string | null,
    assemblyStatus: string
  }[]
  batches: { id: string, batchNumber: string }[]
  bomSummary: { totalItems: number, activeItems: number, totalCost: string, expiringWithin30Days: number, lastSyncAt: Date | null, lastSyncStatus: string | null, lastSyncError: string | null }
  expiringItems: { partNumber: string, name: string, expirationDate: Date }[]
  syncErrorDetail: { message: string, failedRows?: string[], columnIssues?: string[], timestamp: string } | null
  costBreakdown: { materialSubtotal: number, laborSubtotal: number, lineItems: { partId: string | null, partName: string, materialCost: number, laborCost: number }[], totalCost: number } | null
  activeRuns: { id: string, runNumber: string, status: string, quantity: number, workInstructionId: string, workInstructionTitle: string, completedUnits: number }[]
  stateCounts: Record<string, number>
  stateFilter: string | null
  fieldHints: { batchRecommended: boolean, ownerRecommended: boolean }
  fleetSummary: FleetSummary | null
  activeCustomers: { id: string, name: string, customerType: string }[]
}
```

### MongoDB Models Used
- `Spu` — main query with denormalized batch, assignment, creator data
- `Batch` — for batch dropdown
- `BomItem` — for BOM summary aggregation
- `ProductionRun` — for active runs
- `Customer` — for customer dropdown

### MongoDB-Specific Notes
- SPU list: `Spu.find()` — batch info is **denormalized** as `batch: { _id, batchNumber }`, assignment as `assignment: { type, customer: { _id, name } }`
- `batchNumber`, `customerName`, `createdByUsername` are denormalized in the SPU document
- `stateCounts`: `Spu.aggregate([{ $group: { _id: '$deviceState', count: { $sum: 1 } } }])`
- `bomSummary`: aggregation on `BomItem` collection
- `assignSpu` action updates `spu.assignment` embedded object

### Acceptance Criteria
- Test 1 in `07-spu.test.ts` passes (SPU dashboard returns spus)
- SPU list loads with all sidebar data
- Create, register, updateState, assignSpu actions work

---

## Story SPU-02: SPU Detail Page

### Description
Implement the SPU detail page showing full build record, parts, assembly sessions, signatures, particle link, and audit trail.

### Routes Covered
- `GET /spu/[spuId]` — full SPU detail
- `POST /spu/[spuId]` (actions: updateState, linkParticle, unlinkParticle, pingDevice, pushUpdate, assignSpu, updateAssemblyStatus)

### Contract References
**GET /spu/[spuId] returns:**
```typescript
{
  spu: { id: string, udi: string, status: string, deviceState: string, ... /* all SPU fields */ }
  batch: { id: string, batchNumber: string, ... } | null
  createdByName: string | null
  assignmentCustomerName: string | null
  activeCustomers: { id: string, name: string }[]
  particleLink: { id: string, spuId: string, particleDeviceId: string, linkedAt: Date, ... } | null
  particleDevice: { id: string, deviceId: string, name: string | null, ... } | null
  parts: { id: string, partNumber: string, partName: string, partId: string, lotNumber: string | null, lotId: string | null, quantityUsed: number, recordedAt: Date, recordedByName: string, source: 'assembly' | 'usage' }[]
  sessions: { id: string, startedAt: Date, completedAt: Date | null, status: string, operatorId: string, operatorName: string }[]
  signatures: { id: string, entityType: string, meaning: string, signedAt: Date, userId: string, userName: string }[]
  assemblySignature: { ... } | null
  assemblyStatusHistory: { id: string, from: string | null, to: string, changedBy: string, changedAt: Date }[]
  auditTrail: { id: string, action: string, oldData: Record<string, unknown> | null, newData: Record<string, unknown> | null, changedBy: string, changedAt: Date }[]
}
```

### MongoDB Models Used
- `Spu` — single document contains parts (embedded), assembly (embedded), particleLink (embedded), signature (embedded)
- `AssemblySession` — for sessions list
- `ElectronicSignature` — for signatures
- `ParticleDevice` — for particle device info
- `AuditLog` — for audit trail
- `Customer` — for customer dropdown
- `Batch` — for batch details

### MongoDB-Specific Notes
- Parts are **embedded** in SPU: `spu.parts[]`
- ParticleLink is **embedded** in SPU: `spu.particleLink`
- Assembly signature is **embedded** in SPU: `spu.signature`
- Assembly sessions remain as separate collection (working documents)
- `updateAssemblyStatus` with e-signature: verify password, create ElectronicSignature, update SPU

### Acceptance Criteria
- SPU detail page loads with all data
- Particle link/unlink works
- Assembly status update with e-signature works
- Audit trail displays

---

## Story SPU-03: Assembly Sessions

### Description
Implement the guided assembly workflow — start session, scan parts, capture fields, complete/abort.

### Routes Covered
- `GET /spu/assembly` — active and recent sessions
- `POST /spu/assembly` (action: start)
- `GET /spu/assembly/[sessionId]` — session detail with parts
- `POST /spu/assembly/[sessionId]` (actions: scan, complete, abort)
- `GET /spu/assembly/complete` — recently completed sessions

### Contract References
**GET /spu/assembly returns:**
```typescript
{
  activeSessions: { id: string, spuId: string, spuUdi: string, status: string, startedAt: Date, operatorName: string, partsScanned: number, totalParts: number }[]
  recentCompleted: { id: string, spuId: string, spuUdi: string, completedAt: Date, operatorName: string }[]
  spus: { id: string, udi: string }[]
}
```

**GET /spu/assembly/[sessionId] returns:**
```typescript
{
  session: { id: string, spuId: string, spuUdi: string, status: string, startedAt: Date, completedAt: Date | null, userId: string, operatorName: string }
  parts: { id: string, partDefinitionId: string, partNumber: string, partName: string, lotNumber: string | null, scannedAt: Date | null, isScanned: boolean, isRequired: boolean }[]
  partDefinitions: { id: string, partNumber: string, name: string, ... }[]
}
```

### MongoDB Models Used
- `AssemblySession` — working document with **embedded** `stepRecords[]` and `fieldRecords[]`
- `Spu` — link session to SPU
- `PartDefinition` — for part lookup during scanning
- `WorkInstruction` — for step definitions

### MongoDB-Specific Notes
- Assembly sessions are **working documents** — frequent writes during build
- On completion: **copy** full session data into `Spu.assembly` embedded field
- Step records and field records are embedded in session: `session.stepRecords[].fieldRecords[]`
- Old code: 3 separate collections (`AssemblySession`, `AssemblyStepRecord`, `StepFieldRecord`) — all embedded

### Acceptance Criteria
- Tests 2-3 in `07-spu.test.ts` pass (assembly page, completed assemblies)
- Start session creates working document
- Scan action records part
- Complete action copies data to SPU sacred document

---

## Story SPU-04: Batches & Production Runs

### Description
Implement batch management and production run tracking.

### Routes Covered
- `GET /spu/batches` — batch list
- `POST /spu/batches` (action: create)
- `GET /spu/batches/[batchId]` — batch detail with SPUs
- `GET /spu/documents/instructions/[id]/run/[runId]` — production run detail
- `POST` actions for run management

### Contract References
**GET /spu/batches returns:**
```typescript
{
  batches: { id: string, batchNumber: string, status: string, createdAt: Date, spuCount: number }[]
}
```

### MongoDB Models Used
- `Batch` — CRUD
- `Spu` — count by batch: `Spu.countDocuments({ 'batch._id': batchId })`
- `ProductionRun` — with **embedded** `units[]`

### MongoDB-Specific Notes
- `spuCount` on batch list: derived from SPU query (batch is denormalized in SPU)
- Production run units are embedded: `productionRun.units[]`

### Acceptance Criteria
- Test 4 in `07-spu.test.ts` passes (batches list)
- Batch CRUD works
- Production run management works

---

## Story SPU-05: Validation Sessions & Instruments

### Description
Implement the three validation instruments — magnetometer, spectrophotometer, thermocouple — with sessions, barcode generation, and result recording.

### Routes Covered
- `GET /spu/validation` — landing page
- `GET /spu/validation/magnetometer` — recent sessions + stats
- `POST /spu/validation/magnetometer` (action: start)
- `GET /spu/validation/magnetometer/[sessionId]` — session detail + result
- `GET /spu/validation/magnetometer/history` — historical sessions with filters
- Same pattern for `/spectrophotometer` and `/thermocouple`
- `POST /api/validation/magnetometer` — submit results API
- `POST /api/validation/spectrophotometer` — submit results API
- `POST /api/validation/thermocouple` — submit results API

### Contract References
**GET /spu/validation/magnetometer returns:**
```typescript
{
  recentSessions: { id: string, status: string, startedAt: string | null, completedAt: string | null, createdAt: string, barcode: string | null, username: string | null }[]
  stats: { total: number, passed: number, failed: number, inProgress: number }
}
```

### MongoDB Models Used
- `ValidationSession` — with **embedded** `results[]`
- `GeneratedBarcode` — atomic barcode generation with `findOneAndUpdate` + `$inc`

### MongoDB-Specific Notes
- Barcode generation: `GeneratedBarcode.findOneAndUpdate({ prefix }, { $inc: { sequence: 1 } }, { upsert: true, new: true })`
- Validation results embedded in session: `session.results[]`
- Stats: aggregation on validation sessions

### Acceptance Criteria
- Test 5 in `07-spu.test.ts` passes (validation page loads)
- All three instrument pages work
- Session start generates barcode
- Result submission updates session

---

## Story SPU-06: Devices & Particle Integration

### Description
Implement firmware device listing and Particle.io integration settings.

### Routes Covered
- `GET /spu/devices` — device list
- `GET /spu/devices/[deviceId]` — device detail with SPU link and sensor readings
- `GET /spu/particle/settings` — Particle integration config
- `POST /spu/particle/settings` (actions: saveConfig, sync, disconnect)

### Contract References
**GET /spu/devices returns:**
```typescript
{
  devices: {
    id: string, deviceId: string, name: string | null, platform: string | null,
    linkedSpuId: string | null, linkedSpuUdi: string | null,
    lastSyncAt: Date | null, isOnline: boolean, firmwareVersion: string | null
  }[]
}
```

### MongoDB Models Used
- `ParticleDevice` — device list and detail
- `Spu` — for linked SPU info
- `Integration` — Particle integration settings (type: 'particle')

### MongoDB-Specific Notes
- `linkedSpuUdi` is denormalized or joined from SPU collection
- Particle sync is an external API call — stub if credentials unavailable

### Acceptance Criteria
- Tests 7-8 in `07-spu.test.ts` pass (devices page, test results page)
- Device list and detail pages load
- Particle settings page works

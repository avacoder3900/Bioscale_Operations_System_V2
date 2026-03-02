# MongoDB Document Schema Redesign — Full Architecture

## Philosophy

**Relational databases** normalize data to eliminate redundancy. You store a fact once and JOIN to reconstruct it. This works because the DB engine handles joins efficiently, enforces referential integrity, and guarantees ACID transactions.

**Document databases** denormalize data around access patterns. You store data the way you READ it — embedding related data inside the parent document so a single query returns everything the UI needs. The tradeoff: some data duplication, but dramatically simpler reads and better performance at scale.

**The migration that was done:** 1:1 table → collection mapping. Every Postgres table became a MongoDB collection with the same flat shape. This is the worst possible outcome — you lost relational guarantees (FKs, transactions, joins) without gaining document benefits (embedding, single-query reads, natural aggregation).

**What this redesign does:** Collapse 110 collections → ~28 collections by embedding data that's always accessed together, converting junction tables to arrays, and keeping separate collections only for data that needs independent querying or grows unbounded.

---

## Guiding Principles

### 1. Embed what you read together
If data is always displayed on the same page/component, embed it. One query, one document, one render.

### 2. Reference what grows unbounded
If a subdocument array could grow to thousands of items (logs, events, readings), keep it in a separate collection. MongoDB documents have a 16MB limit, and large arrays degrade update performance.

### 3. Reference what needs independent queries
If you need to query/filter/sort across entities independently (e.g., "find all tasks assigned to user X across all projects"), that entity should be its own collection with proper indexes.

### 4. Duplicate what changes rarely
Store the user's `username` alongside their `userId` in embedded records. It rarely changes, and it saves a join on every read. If it does change, batch-update the denormalized copies.

### 5. Use transactions for multi-document writes
When a write touches multiple collections, use MongoDB sessions/transactions. This is non-negotiable for HIPAA-auditable operations.

---

## Current State: 110 Collections

```
Auth (8):        User, Session, Role, Permission, UserRole, RolePermission, InviteToken, AuditLog
Customer (2):    Customer, CustomerNote
SPU (5):         Batch, Spu, ParticleLink, PartDefinition, SpuPart
Assembly (3):    AssemblySession, ElectronicSignature, AssemblyStepRecord
Documents (5):   Document, DocumentRevision, DocumentTraining, Files, DocumentRepository
Work Inst (8):   WorkInstructions, WorkInstruction, WorkInstructionVersion, WorkInstructionStep,
                 StepPartRequirement, StepToolRequirement, StepFieldDefinition, StepFieldRecord
Inventory (1):   InventoryTransaction
Production (6):  ProductionRun, ProductionRunUnit, GeneratedBarcode, ValidationSession,
                 ValidationResult, ProcessConfiguration
Mfg Core (6):    LotRecord, ProcessStep, LotStepEntry, DeckRecord, CoolingTrayRecord,
                 RejectionReasonCode
Mfg Wax (3):     WaxFillingSettings, WaxFillingRun, WaxCartridgeRecord
Mfg Reagent (8): AssayType, ReagentDefinition, ReagentSubComponent, ReagentFillingSettings,
                 ReagentFillingRun, ReagentTubeRecord, TopSealBatch, ReagentCartridgeRecord
Mfg Materials (3): ManufacturingSettings, ManufacturingMaterial, ManufacturingMaterialTransaction
Cartridge (9):   CartridgeGroup, Cartridge, CartridgeUsageLog, Assay, FirmwareDevice,
                 FirmwareCartridge, TestResult, SpectroReading, DeviceEvent
Shipping (4):    ShippingLot, QaqcRelease, ShippingPackage, PackageCartridge
BOM (5):         BomItem, CartridgeBomItem, BomItemVersion, BomPartLink, BomColumnMapping
Equipment (15):  EquipmentLocation, LocationPlacement, Equipment, EquipmentEventLog,
                 OpentronsRobot, OpentronsProtocolRecord, OpentronsHealthSnapshot,
                 AssayVersion, LaborEntry, SpuPartUsage, IncubatorTube, IncubatorTubeUsage,
                 TopSealRoll, TopSealCutRecord, LaserCutBatch
Kanban (8):      KanbanProject, KanbanTask, KanbanComment, KanbanTag, KanbanTaskTag,
                 KanbanActionLog, KanbanTaskProposal, KanbanBoardEvent
Agent (5):       AgentQuery, SchemaMetadata, AgentMessage, CommunicationPreference, RoutingPattern
Approval (3):    ApprovalRequest, SystemDependency, ApprovalHistory
Integrations (3): BoxIntegration, ParticleIntegration, ParticleDevice
```

---

## Target State: ~28 Collections

### Domain 1: Auth & Access Control

**Current: 8 collections → Target: 4 collections**

#### `users` (collection)
```typescript
{
  _id: string,            // nanoid
  username: string,
  passwordHash: string,
  firstName?: string,
  lastName?: string,
  email?: string,
  phone?: string,
  isActive: boolean,
  lastLoginAt?: Date,
  invitedBy?: string,

  // EMBEDDED: roles + permissions (was 3 separate collections + 2 junction tables)
  roles: [{
    roleId: string,
    roleName: string,       // denormalized — avoids join
    assignedAt: Date,
    assignedBy?: string,
    permissions: string[]   // permission names, e.g. ["kanban:read", "kanban:write"]
  }],

  // EMBEDDED: communication preferences (was separate collection)
  communicationPreferences: [{
    channel: string,
    frequency: 'real_time' | 'hourly_digest' | 'daily_digest' | 'urgent_only',
    formatPreference: 'detailed' | 'summary' | 'bullet_points',
    urgencyThreshold: string,
    domainInterests?: any,
    quietHoursStart?: string,
    quietHoursEnd?: string,
    isActive: boolean,
    isDefault: boolean
  }],

  createdAt: Date,
  updatedAt: Date
}
```
**Why:** Roles, permissions, and comm prefs are ALWAYS loaded with the user (auth check on every request). Embedding eliminates 3-4 queries per request. Permission arrays are small (< 50 items) and change rarely.

#### `sessions` (collection — keep separate)
```typescript
{
  _id: string,
  userId: string,
  expiresAt: Date     // TTL index
}
```
**Why:** Sessions are high-churn, TTL-indexed. Embedding in user would cause constant user doc updates.

#### `roles` (collection — keep as reference catalog)
```typescript
{
  _id: string,
  name: string,
  description?: string,
  permissions: string[],   // permission names directly embedded
  createdAt: Date
}
```
**Why:** Roles are a lookup table. When you create/edit a role, you update this doc AND batch-update all users with that role. This is rare (role changes happen weekly/monthly, not per-request).

**Eliminated collections:** Permission (→ string array in roles), UserRole (→ embedded in users), RolePermission (→ embedded in roles), CommunicationPreference (→ embedded in users)

#### `invite_tokens` (collection — keep separate)
Unchanged. Low-volume, independent lifecycle.

---

### Domain 2: Kanban Board

**Current: 8 collections → Target: 2 collections**

#### `kanban_projects` (collection)
```typescript
{
  _id: string,
  name: string,
  description?: string,
  color: string,
  sortOrder: number,
  isActive: boolean,
  createdAt: Date,
  createdBy?: string,

  // EMBEDDED: tags belong to the board (max ~50)
  tags: [{
    _id: string,
    name: string,
    color: string,
    isActive: boolean
  }]
}
```
**Note:** Tags could also be board-level rather than project-level. If tags are shared across projects, make a single `kanban_settings` doc or embed tags at a higher level. Evaluate access patterns.

**Actually — reconsider.** Looking at the current code, tags are board-global, not project-scoped. And tasks need independent querying (filter by status, assignee, project). Let me revise:

#### `kanban_tasks` (collection — keep separate, but enriched)
```typescript
{
  _id: string,
  title: string,
  description?: string,
  status: 'backlog' | 'ready' | 'wip' | 'waiting' | 'done',
  priority: 'high' | 'medium' | 'low',
  taskLength: 'short' | 'medium' | 'long',
  sortOrder: number,

  // DENORMALIZED project info (avoids join on every board render)
  project: {
    _id: string,
    name: string,
    color: string
  },

  // DENORMALIZED assignee info
  assignee?: {
    _id: string,
    username: string
  },

  dueDate?: Date,
  tags: string[],         // tag names directly (was junction table KanbanTaskTag)
  source: string,
  sourceRef?: string,

  // STATUS TRACKING
  statusChangedAt?: Date,
  backlogDate?: Date,
  readyDate?: Date,
  wipDate?: Date,
  waitingDate?: Date,
  completedDate?: Date,
  waitingReason?: string,
  waitingOn?: string,

  // EMBEDDED: comments (typically < 50 per task)
  comments: [{
    _id: string,
    content: string,
    createdAt: Date,
    createdBy: { _id: string, username: string }
  }],

  // EMBEDDED: activity log (typically < 100 per task)
  activityLog: [{
    _id: string,
    action: string,
    details?: any,
    createdAt: Date,
    createdBy?: string
  }],

  // ARCHIVE
  archived: boolean,
  archivedAt?: Date,

  createdAt: Date,
  updatedAt: Date,
  createdBy?: string
}
```
**Why:** The board page loads ALL active tasks and groups by project. Embedding project name/color means zero joins. Comments and activity are always viewed on the task detail page — embed them. Tags as string array eliminates the junction table entirely.

**Eliminated collections:** KanbanComment (→ embedded), KanbanTag (→ string array or embedded in settings), KanbanTaskTag (→ string array), KanbanActionLog (→ embedded), KanbanBoardEvent (→ can be part of audit log or dropped), KanbanTaskProposal (keep if heavily used, or embed in task as `proposals[]`)

---

### Domain 3: Work Instructions (the deepest nesting)

**Current: 8 collections → Target: 1 collection**

#### `work_instructions` (collection)
```typescript
{
  _id: string,
  documentNumber: string,
  title: string,
  description?: string,
  documentType: string,
  status: 'draft' | 'active' | 'retired',
  currentVersion: number,
  originalFileName?: string,
  fileSize?: number,
  mimeType?: string,

  // EMBEDDED: versions (a WI typically has < 10 versions)
  versions: [{
    _id: string,
    version: number,
    content?: string,
    rawContent?: string,
    changeNotes?: string,
    parsedAt?: Date,
    parsedBy?: string,
    createdAt: Date,

    // EMBEDDED: steps within version (typically < 30 steps)
    steps: [{
      _id: string,
      stepNumber: number,
      title?: string,
      content?: string,
      imageData?: string,        // NOTE: large field — may need GridFS if images are big
      imageContentType?: string,
      requiresScan: boolean,
      scanPrompt?: string,
      notes?: string,
      partDefinitionId?: string,
      partQuantity: number,

      // EMBEDDED: step requirements (typically < 5 each)
      partRequirements: [{
        partNumber: string,
        partDefinitionId?: string,
        quantity: number,
        notes?: string
      }],
      toolRequirements: [{
        toolNumber: string,
        toolName?: string,
        calibrationRequired: boolean,
        notes?: string
      }],
      fieldDefinitions: [{
        _id: string,
        fieldName: string,
        fieldLabel: string,
        fieldType: 'barcode_scan' | 'manual_entry' | 'date_picker' | 'dropdown',
        isRequired: boolean,
        validationPattern?: string,
        options?: any,
        barcodeFieldMapping?: string,
        sortOrder: number
      }]
    }]
  }],

  // Legacy WI fields (from WorkInstructions model — merge into same collection)
  revision?: string,
  category?: string,
  effectiveDate?: Date,
  fileId?: string,
  preparedBy?: string,
  preparedAt?: Date,
  reviewedBy?: string,
  reviewedAt?: Date,
  approvedBy?: string,
  approvedAt?: Date,

  createdAt: Date,
  updatedAt: Date,
  createdBy?: string
}
```
**Why:** A work instruction is a self-contained document. You NEVER view a step without its parent version and WI. Embedding versions→steps→requirements→field definitions means one query loads the entire work instruction tree. The typical document size would be 10-100KB — well under the 16MB limit.

**⚠️ Warning:** `imageData` (base64 step images) could be large. If images are > 1MB each, consider storing them in GridFS or an object store and referencing by URL. This is the one place where the 16MB limit matters.

**Eliminated collections:** WorkInstructions (→ merged), WorkInstructionVersion (→ embedded), WorkInstructionStep (→ embedded), StepPartRequirement (→ embedded), StepToolRequirement (→ embedded), StepFieldDefinition (→ embedded)

**StepFieldRecord stays separate** — see Assembly domain below.

---

### Domain 4: SPU & Assembly

**Current: 8 collections → Target: 3 collections**

#### `spus` (collection)
```typescript
{
  _id: string,
  udi: string,
  status: string,
  deviceState: string,
  owner?: string,
  ownerNotes?: string,

  // DENORMALIZED batch info
  batch?: {
    _id: string,
    batchNumber: string
  },

  // DENORMALIZED customer info
  assignmentCustomer?: {
    _id: string,
    name: string
  },
  assignmentType?: string,

  assembledBy?: string,
  assemblyStartedAt?: Date,
  assemblyCompletedAt?: Date,
  assemblySignatureId?: string,
  qcStatus: string,
  qcDocumentUrl?: string,
  assemblyStatus: string,

  // EMBEDDED: parts used in this SPU (typically < 30)
  parts: [{
    _id: string,
    partDefinitionId: string,
    partNumber: string,        // denormalized
    partName: string,          // denormalized
    lotNumber?: string,
    serialNumber?: string,
    scannedAt: Date,
    scannedBy?: string,
    barcodeData?: string,
    isReplaced: boolean,
    replacedBy?: string,
    replaceReason?: string
  }],

  // EMBEDDED: particle link (1:1 with SPU)
  particleLink?: {
    particleSerial: string,
    particleDeviceId?: string,
    linkedAt: Date,
    linkedBy?: string,
    previousSpuId?: string,
    unlinkReason?: string
  },

  createdAt: Date,
  updatedAt: Date,
  createdBy?: string
}
```

#### `assembly_sessions` (collection — keep separate)
```typescript
{
  _id: string,
  spuId: string,
  userId: string,
  status: 'in_progress' | 'paused' | 'completed',
  currentStepIndex: number,
  startedAt: Date,
  pausedAt?: Date,
  completedAt?: Date,
  workstationId?: string,
  notes?: string,

  // EMBEDDED: step records (one per step, typically < 30)
  stepRecords: [{
    _id: string,
    workInstructionStepId: string,
    scannedLotNumber?: string,
    scannedPartNumber?: string,
    completedAt?: Date,
    completedBy?: string,
    signatureId?: string,
    notes?: string,

    // EMBEDDED: field records captured during this step
    fieldRecords: [{
      _id: string,
      stepFieldDefinitionId: string,
      fieldValue: string,
      rawBarcodeData?: string,
      bomItemId?: string,
      scannedAt?: Date,
      enteredAt?: Date,
      capturedBy?: string
    }]
  }],

  createdAt: Date
}
```
**Why:** Assembly sessions are actively written to during the build process. Embedding step records + field records means the operator's UI loads in one query. Sessions have bounded size (< 30 steps × < 10 fields = < 300 embedded records).

#### `batches` (collection — keep separate)
Unchanged. Batches are queried independently for list views and reporting.

**Eliminated collections:** SpuPart (→ embedded in SPU), ParticleLink (→ embedded in SPU), AssemblyStepRecord (→ embedded in session), StepFieldRecord (→ embedded in step records)

---

### Domain 5: Customers

**Current: 2 collections → Target: 1 collection**

#### `customers` (collection)
```typescript
{
  _id: string,
  name: string,
  customerType: string,
  contactName?: string,
  contactEmail?: string,
  contactPhone?: string,
  address?: string,
  status: string,
  customFields?: any,

  // EMBEDDED: notes (typically < 100)
  notes: [{
    _id: string,
    noteText: string,
    createdBy: { _id: string, username: string },
    createdAt: Date
  }],

  createdAt: Date,
  updatedAt: Date
}
```

---

### Domain 6: Documents & Files

**Current: 5 collections → Target: 3 collections**

#### `documents` (collection)
```typescript
{
  _id: string,
  documentNumber: string,
  title: string,
  category?: string,
  currentRevision: string,
  status: string,
  effectiveDate?: Date,
  retiredDate?: Date,
  ownerId?: string,

  // EMBEDDED: revisions (typically < 20)
  revisions: [{
    _id: string,
    revision: string,
    content?: string,
    changeDescription?: string,
    status: string,
    createdAt: Date,
    createdBy?: string,
    approvedAt?: Date,
    approvedBy?: string,
    approvalSignatureId?: string,

    // EMBEDDED: training records per revision (typically < 20)
    trainingRecords: [{
      _id: string,
      userId: string,
      username: string,        // denormalized
      trainedAt: Date,
      trainerId?: string,
      signatureId?: string,
      notes?: string
    }]
  }],

  createdAt: Date,
  updatedAt: Date,
  createdBy?: string
}
```

#### `files` (collection — keep separate)
Unchanged. Files are referenced from many places and queried independently.

#### `document_repository` (collection — keep separate)
Unchanged. Independent upload/search lifecycle.

---

### Domain 7: Manufacturing — Cartridge Pipeline

This is the most complex domain. The pipeline is:
**Laser Cut → Backing/Lot → Wax Filling → Reagent Filling → Top Seal → QC → Storage → Shipping**

**Current: 20+ collections → Target: 7 collections**

#### `lot_records` (collection)
```typescript
{
  _id: string,
  qrCodeRef: string,
  configId: string,
  operator: { _id: string, username: string },
  inputLots: any,
  quantityProduced: number,
  startTime?: Date,
  finishTime?: Date,
  cycleTime?: number,
  wiRevision?: string,
  status: string,
  ovenEntryTime?: Date,
  desiredQuantity?: number,
  quantityDiscrepancyReason?: string,

  // EMBEDDED: step entries (typically < 20)
  stepEntries: [{
    _id: string,
    stepId?: string,
    note?: string,
    imageUrl?: string,
    operatorId: string,
    createdAt: Date
  }],

  createdAt: Date,
  updatedAt: Date
}
```
**Eliminated:** LotStepEntry (→ embedded). ProcessStep stays as part of ProcessConfiguration.

#### `wax_filling_runs` (collection)
```typescript
{
  _id: string,
  robotId: string,
  deckId?: string,
  waxSourceLot?: string,
  waxTubeId?: string,
  waxTubeTimestamp?: Date,
  setupTimestamp?: Date,
  runStartTime?: Date,
  runEndTime?: Date,
  deckRemovedTime?: Date,
  coolingConfirmedTime?: Date,
  coolingTrayId?: string,
  ovenLocationId?: string,
  coolingLocationId?: string,
  status: string,
  operator: { _id: string, username: string },
  abortReason?: string,
  plannedCartridgeCount?: number,

  // EMBEDDED: cartridge records for this run (typically 8-96 per run)
  cartridges: [{
    _id: string,
    backedLotId: string,
    ovenEntryTime?: Date,
    deckPosition?: number,
    waxTubeId?: string,
    coolingTrayId?: string,
    transferTimeSeconds?: number,
    qcStatus: string,
    rejectionReason?: string,
    qcTimestamp?: Date,
    currentInventory: string,
    storageLocation?: string,
    storageTimestamp?: Date,
    storageOperatorId?: string
  }],

  createdAt: Date,
  updatedAt: Date
}
```
**Eliminated:** WaxCartridgeRecord as separate collection (→ embedded in run). **Note:** If cartridge records need to be queried independently across runs (e.g., "find all cartridges in Fridge-1"), this embedding won't work well. In that case, keep WaxCartridgeRecord separate but denormalize run info into it.

**Actually — REVISION:** Cartridge records need independent lifecycle tracking (they move through wax → reagent → storage → shipping). Keep `cartridge_records` as a separate collection:

#### `cartridge_records` (collection — the cartridge's full lifecycle)
```typescript
{
  _id: string,              // the cartridge barcode/ID

  // WAX PHASE
  wax: {
    runId: string,
    backedLotId: string,
    ovenEntryTime?: Date,
    deckPosition?: number,
    waxTubeId?: string,
    coolingTrayId?: string,
    transferTimeSeconds?: number,
    qcStatus: string,
    rejectionReason?: string,
    qcTimestamp?: Date,
    currentInventory: string,
    storageLocation?: string,
    storageTimestamp?: Date,
    storageOperatorId?: string
  },

  // REAGENT PHASE
  reagent?: {
    runId: string,
    assayTypeId: string,
    deckPosition: number,
    inspectionStatus: string,
    inspectionReason?: string,
    inspectionTimestamp?: Date,
    inspectionOperatorId?: string,
    topSealBatchId?: string,
    topSealTimestamp?: Date,
    reagentFillDate?: Date,
    expirationDate?: Date,
    ovenEntryTime?: Date,
  },

  // STORAGE PHASE
  storage?: {
    location?: string,
    locationId?: string,
    containerBarcode?: string,
    fridgeId?: string,
    timestamp?: Date,
    operatorId?: string,
  },

  // SHIPPING PHASE
  shipping?: {
    lotId?: string,
    linkedAt?: Date,
    linkedBy?: string,
    packageId?: string,
    addedAt?: Date,
  },

  currentStatus: string,     // single source of truth for "where is this cartridge now"
  createdAt: Date,
  updatedAt: Date
}
```
**Why:** A cartridge is a single entity that moves through manufacturing phases. Instead of scattering its state across WaxCartridgeRecord + ReagentCartridgeRecord + PackageCartridge, consolidate into ONE document that tracks its full lifecycle. This is the MongoDB way — model the entity, not the tables.

#### `reagent_filling_runs` (collection)
```typescript
{
  _id: string,
  robotId: string,
  operator: { _id: string, username: string },
  assayType: { _id: string, name: string, skuCode: string },
  deckId?: string,
  status: string,
  setupTimestamp?: Date,
  runStartTime?: Date,
  runEndTime?: Date,
  cartridgeCount?: number,
  abortReason?: string,
  abortPhotoUrl?: string,

  // EMBEDDED: tube records (typically 6-12 per run)
  tubeRecords: [{
    wellPosition: number,
    reagentName: string,
    sourceLotId: string,
    transferTubeId: string,
    createdAt: Date
  }],

  // EMBEDDED: top seal batch (1:1 with run typically)
  topSealBatch?: {
    _id: string,
    topSealLotId: string,
    operatorId: string,
    firstScanTime?: Date,
    completionTime?: Date,
    durationSeconds?: number,
    cartridgeCount: number,
    status: string
  },

  createdAt: Date,
  updatedAt: Date
}
```
**Eliminated:** ReagentTubeRecord (→ embedded), TopSealBatch (→ embedded), ReagentCartridgeRecord (→ merged into cartridge_records)

#### `assay_types` (collection — keep as reference catalog)
```typescript
{
  _id: string,
  name: string,
  skuCode: string,
  isActive: boolean,
  shelfLifeDays?: number,
  bomCostOverride?: string,
  useSingleCost: boolean,

  // EMBEDDED: reagent definitions (typically < 20 per assay)
  reagentDefinitions: [{
    _id: string,
    wellPosition: number,
    reagentName: string,
    unitCost?: string,
    volumeMicroliters?: number,
    unit?: string,
    classification?: string,
    hasBreakdown: boolean,
    sortOrder: number,
    isActive: boolean,

    // EMBEDDED: sub-components (typically < 5 per reagent)
    subComponents: [{
      _id: string,
      name: string,
      unitCost?: string,
      unit?: string,
      volumeMicroliters?: number,
      classification?: string,
      sortOrder: number
    }]
  }],

  createdAt: Date,
  updatedAt: Date
}
```
**Eliminated:** ReagentDefinition (→ embedded), ReagentSubComponent (→ embedded)

#### `process_configurations` (collection)
```typescript
{
  _id: string,
  processName: string,
  processType: string,
  inputMaterials: any,
  outputMaterial: any,
  maxBatchSize: number,
  handoffPrompt: string,
  downstreamQueue?: string,
  workInstructionId?: string,

  // EMBEDDED: process steps (typically < 20)
  steps: [{
    _id: string,
    stepNumber: number,
    title: string,
    description?: string,
    imageUrl?: string
  }],

  createdAt: Date,
  updatedAt: Date
}
```
**Eliminated:** ProcessStep (→ embedded)

#### `manufacturing_settings` (single document collection)
```typescript
{
  _id: 'default',

  waxFilling: {
    minOvenTimeMin: number,
    runDurationMin: number,
    removeDeckWarningMin: number,
    coolingWarningMin: number,
    deckLockoutMin: number,
    incubatorTempC: number,
    heaterTempC: number,
    waxPerDeckUl: number,
    tubeCapacityUl: number,
    waxPerCartridgeUl: number,
    cartridgesPerColumn: number,
  },

  reagentFilling: {
    fillTimePerCartridgeMin: number,
    minCoolingTimeMin: number,
  },

  general: {
    topSealLengthPerCutFt: number,
    defaultRollLengthFt: number,
    cartridgesPerLaserCutSheet: number,
    sheetsPerLaserBatch: number,
    defaultLaserTools?: string,
    defaultCuttingProgramLink?: string,
  },

  // EMBEDDED: rejection reason codes (< 50)
  rejectionReasonCodes: [{
    code: string,
    label: string,
    processType: string,
    sortOrder: number
  }],

  updatedAt: Date
}
```
**Eliminated:** WaxFillingSettings, ReagentFillingSettings, ManufacturingSettings, RejectionReasonCode (→ all merged into one settings document)

---

### Domain 8: Equipment & Manufacturing Resources

**Current: 15 collections → Target: 5 collections**

#### `equipment` (collection)
```typescript
{
  _id: string,
  name: string,
  equipmentType: 'fridge' | 'oven',
  location?: string,
  status: string,
  mocreoDeviceId?: string,
  mocreoAssetId?: string,
  temperatureMinC?: number,
  temperatureMaxC?: number,
  currentTemperatureC?: number,
  lastTemperatureReadAt?: Date,
  notes?: string,
  createdAt: Date,
  updatedAt: Date
}
```

#### `equipment_locations` (collection)
```typescript
{
  _id: string,
  barcode: string,
  locationType: string,
  displayName: string,
  isActive: boolean,
  capacity?: number,
  notes?: string,

  // CURRENT placements (typically < 20 items per location)
  currentPlacements: [{
    _id: string,
    itemType: string,
    itemId: string,
    placedBy: string,
    placedAt: Date,
    runId?: string,
    notes?: string
  }],

  createdAt: Date,
  updatedAt: Date
}
```
**Note:** Historical placements (removedAt != null) should be moved to `audit_log` or a separate history collection to prevent unbounded growth.

#### `opentrons_robots` (collection)
```typescript
{
  _id: string,
  name: string,
  ip: string,
  port: number,
  robotSide?: string,
  isActive: boolean,
  firmwareVersion?: string,
  apiVersion?: string,
  robotModel?: string,
  robotSerial?: string,
  lastHealthAt?: Date,
  lastHealthOk?: boolean,
  source: string,

  // EMBEDDED: protocol records (typically < 50 per robot)
  protocols: [{
    _id: string,
    opentronsProtocolId: string,
    protocolName: string,
    protocolType?: string,
    fileHash?: string,
    parametersSchema?: any,
    analysisStatus?: string,
    analysisData?: any,
    labwareDefinitions?: any,
    pipettesRequired?: any,
    uploadedBy?: string,
    createdAt: Date
  }],

  createdAt: Date,
  updatedAt: Date
}
```
**Eliminated:** OpentronsProtocolRecord (→ embedded)

#### `consumables` (collection — merges tubes, rolls, decks, trays)
```typescript
{
  _id: string,
  type: 'incubator_tube' | 'top_seal_roll' | 'deck' | 'cooling_tray',

  // Common fields
  status: string,
  createdAt: Date,
  updatedAt: Date,

  // Type-specific fields (use discriminator or just optional fields)
  // Incubator tube
  initialVolumeUl?: number,
  remainingVolumeUl?: number,
  totalCartridgesFilled?: number,
  totalRunsUsed?: number,

  // Top seal roll
  barcode?: string,
  initialLengthFt?: number,
  remainingLengthFt?: number,

  // Deck
  currentRobotId?: string,
  lockoutUntil?: Date,
  lastUsed?: Date,

  // Cooling tray
  currentCartridges?: any,
  assignedRunId?: string,

  // EMBEDDED: usage log (bounded — tubes used ~20-50 times)
  usageLog: [{
    _id: string,
    runId?: string,
    quantityChanged?: number,
    volumeChanged?: number,
    operatorId: string,
    notes?: string,
    createdAt: Date
  }]
}
```
**Eliminated:** IncubatorTube, IncubatorTubeUsage, TopSealRoll, TopSealCutRecord, DeckRecord, CoolingTrayRecord (→ unified consumables collection with embedded usage)

#### `laser_cut_batches` (collection — keep separate)
Unchanged. Independent tracking.

**Also eliminated:** OpentronsHealthSnapshot (→ keep as separate time-series collection or embed last N in robot), EquipmentEventLog (→ bounded embed in equipment or separate log), SpuPartUsage (→ merged into SPU parts), AssayVersion (→ embedded version history in assay), LaborEntry (→ keep if needed for costing)

---

### Domain 9: BOM & Inventory

**Current: 6 collections → Target: 2 collections**

#### `bom_items` (collection)
```typescript
{
  _id: string,
  partNumber: string,
  name: string,
  description?: string,
  category?: string,
  quantityPerUnit: number,
  unitOfMeasure?: string,
  supplier?: string,
  manufacturer?: string,
  vendorPartNumber?: string,
  unitCost?: string,
  leadTimeDays?: number,
  minimumOrderQty?: number,
  certifications?: any,
  expirationDate?: Date,
  msdsFileId?: string,
  hazardClass?: string,
  inventoryCount?: number,
  minimumStockLevel: number,
  isActive: boolean,
  boxRowIndex?: number,

  // EMBEDDED: version history (typically < 20)
  versionHistory: [{
    version: number,
    changeType: string,
    previousValues?: any,
    newValues?: any,
    changedBy?: string,
    changedAt: Date,
    changeReason?: string
  }],

  // EMBEDDED: part links (typically < 5)
  partLinks: [{
    partDefinitionId: string,
    partNumber: string,      // denormalized
    linkType: string,
    notes?: string,
    createdBy?: string,
    createdAt: Date
  }],

  createdAt: Date,
  updatedAt: Date,
  createdBy?: string
}
```
**Eliminated:** BomItemVersion (→ embedded), BomPartLink (→ embedded)

**Note:** CartridgeBomItem appears to be a separate BOM for cartridge-specific items. Could merge with BomItem using a `bomType: 'spu' | 'cartridge'` discriminator, or keep separate if the schemas diverge significantly. For now, merge.

#### `part_definitions` (collection — keep separate)
Unchanged. Referenced from many places (SPU, BOM, work instructions, inventory). Needs independent querying.

#### `bom_column_mapping` (single document — keep)
Unchanged.

---

### Domain 10: Inventory & Transactions

**Current: 1 collection → Target: 1 collection**

#### `inventory_transactions` (collection)
Keep separate. This is an append-only audit trail that can grow unbounded. Never embed unbounded time-series data.

---

### Domain 11: Cartridge Management (Lab/Firmware)

**Current: 9 collections → Target: 4 collections**

#### `cartridge_groups` (collection — keep)
Small reference table. Unchanged.

#### `cartridges` (collection — lab-side cartridge tracking)
```typescript
{
  _id: string,
  barcode: string,
  serialNumber?: string,
  lotNumber: string,
  cartridgeType: string,
  status: string,
  groupId?: string,
  partDefinitionId?: string,
  manufacturer?: string,
  expirationDate?: Date,
  // ... all existing fields ...
  isActive: boolean,

  // EMBEDDED: usage log (typically < 100 per cartridge)
  usageLog: [{
    _id: string,
    action: string,
    previousValue?: string,
    newValue?: string,
    spuId?: string,
    notes?: string,
    performedBy: { _id: string, username: string },
    performedAt: Date
  }],

  createdAt: Date,
  updatedAt: Date,
  createdBy?: string
}
```
**Eliminated:** CartridgeUsageLog (→ embedded)

#### `firmware_devices` (collection — keep, external system mirror)
Unchanged. These represent external devices.

#### `test_results` (collection)
```typescript
{
  _id: string,
  dataFormatCode?: string,
  cartridgeUuid?: string,
  assayId?: string,
  deviceId?: string,
  // ... all existing fields ...
  status: string,

  // EMBEDDED: spectro readings (can be large — 100-1000 per test)
  // ⚠️ If readings exceed ~1000 per test, keep SpectroReading separate
  readings: [{
    readingNumber: number,
    channel: string,
    position?: number,
    temperature?: number,
    laserOutput?: number,
    timestampMs?: number,
    f1?: number, f2?: number, f3?: number, f4?: number,
    f5?: number, f6?: number, f7?: number, f8?: number,
    clearChannel?: number,
    nirChannel?: number
  }],

  createdAt: Date,
  processedAt?: Date
}
```
**Eliminated:** SpectroReading (→ embedded, with size caveat)

**FirmwareCartridge and DeviceEvent:** Keep as separate collections. FirmwareCartridge is heavily queried independently. DeviceEvent is an unbounded log.

---

### Domain 12: Shipping & Fulfillment

**Current: 4 collections → Target: 2 collections**

#### `shipping_lots` (collection)
```typescript
{
  _id: string,
  assayType: { _id: string, name: string },
  customer?: { _id: string, name: string },
  status: string,
  cartridgeCount?: number,
  releasedAt?: Date,
  releasedBy?: string,
  notes?: string,

  // EMBEDDED: QA/QC releases (typically < 5 per lot)
  qaqcReleases: [{
    _id: string,
    reagentRunId: string,
    qaqcCartridgeIds: any,
    testResult?: string,
    testedBy?: string,
    testedAt?: Date,
    notes?: string,
    createdAt: Date
  }],

  createdAt: Date,
  updatedAt: Date
}
```
**Eliminated:** QaqcRelease (→ embedded)

#### `shipping_packages` (collection)
```typescript
{
  _id: string,
  barcode: string,
  customer: { _id: string, name: string },
  trackingNumber?: string,
  carrier?: string,
  status: string,
  notes?: string,
  packedBy?: string,
  packedAt?: Date,
  shippedAt?: Date,
  deliveredAt?: Date,

  // EMBEDDED: cartridges in this package (typically < 100)
  cartridges: [{
    cartridgeId: string,
    addedAt: Date
  }],

  createdAt: Date,
  updatedAt: Date
}
```
**Eliminated:** PackageCartridge (→ embedded)

---

### Domain 13: Production & Validation

**Current: 6 collections → Target: 3 collections**

#### `production_runs` (collection)
```typescript
{
  _id: string,
  workInstructionId: string,
  workInstructionVersionId: string,
  quantity: number,
  status: string,
  leadBuilder: { _id: string, username: string },
  runNumber: string,
  startedAt?: Date,
  completedAt?: Date,

  // EMBEDDED: units (bounded by quantity, typically < 50)
  units: [{
    _id: string,
    spuId: string,
    assemblySessionId?: string,
    unitIndex: number,
    status: string,
    startedAt?: Date,
    completedAt?: Date
  }],

  createdAt: Date,
  updatedAt: Date
}
```
**Eliminated:** ProductionRunUnit (→ embedded)

#### `generated_barcodes` (collection — keep separate)
Counter/sequence table. Needs atomic increments. Keep separate.

#### `validation_sessions` (collection)
```typescript
{
  _id: string,
  type: string,
  spuId?: string,
  generatedBarcodeId: string,
  status: string,
  startedAt?: Date,
  completedAt?: Date,
  userId: string,

  // EMBEDDED: results (typically < 20 per session)
  results: [{
    _id: string,
    testType: string,
    rawData?: any,
    processedData?: any,
    passed?: boolean,
    notes?: string,
    createdAt: Date
  }],

  createdAt: Date
}
```
**Eliminated:** ValidationResult (→ embedded)

---

### Domain 14: Agent, Approval, Integrations

**Current: 11 collections → Target: 7 collections**

These are mostly fine as-is (low-volume, independent lifecycles):

- `agent_queries` — keep (queried by name)
- `schema_metadata` — keep (reference catalog)
- `agent_messages` — keep (unbounded, queried independently)
- `routing_patterns` — keep
- `approval_requests` — embed ApprovalHistory inside (typically < 10 entries per request)
- `system_dependencies` — keep
- `integrations` — merge BoxIntegration + ParticleIntegration into one `integrations` collection with `type` discriminator

**Eliminated:** ApprovalHistory (→ embedded), separate Box/Particle collections (→ merged)

---

### Domain 15: Audit & Electronic Signatures

#### `audit_log` (collection — keep separate, append-only)
Unchanged. This is an unbounded time-series collection. Never embed.

#### `electronic_signatures` (collection — keep separate)
Unchanged. Referenced from many places (assembly, documents, approvals). HIPAA requirement for independent verification.

---

### Domain 16: Manufacturing Materials

**Current: 3 collections → Target: 1 collection**

#### `manufacturing_materials` (collection)
```typescript
{
  _id: string,
  name: string,
  unit: string,
  currentQuantity: number,

  // EMBEDDED: recent transactions (keep last 100, archive older to audit_log)
  recentTransactions: [{
    _id: string,
    transactionType: string,
    quantityChanged: number,
    quantityBefore: number,
    quantityAfter: number,
    relatedBatchId?: string,
    operatorId: string,
    notes?: string,
    createdAt: Date
  }],

  updatedAt: Date
}
```
**Note:** If transaction history must be fully preserved (HIPAA), keep a separate `manufacturing_material_transactions` collection as an immutable log and embed only the last N in the material doc for quick display.

---

## Final Collection Count

| Domain | Current | Target | Collections |
|--------|---------|--------|-------------|
| Auth & Access | 8 | 4 | users, sessions, roles, invite_tokens |
| Kanban | 8 | 2 | kanban_projects, kanban_tasks |
| Work Instructions | 8 | 1 | work_instructions |
| SPU & Assembly | 8 | 3 | spus, assembly_sessions, batches |
| Customers | 2 | 1 | customers |
| Documents | 5 | 3 | documents, files, document_repository |
| Manufacturing Pipeline | 20 | 7 | lot_records, wax_filling_runs, cartridge_records, reagent_filling_runs, assay_types, process_configurations, manufacturing_settings |
| Equipment | 15 | 5 | equipment, equipment_locations, opentrons_robots, consumables, laser_cut_batches |
| BOM & Inventory | 6 | 3 | bom_items, part_definitions, bom_column_mapping |
| Inventory Tx | 1 | 1 | inventory_transactions |
| Cartridge/Firmware | 9 | 4 | cartridge_groups, cartridges, firmware_devices, test_results (+firmware_cartridges, device_events) |
| Shipping | 4 | 2 | shipping_lots, shipping_packages |
| Production | 6 | 3 | production_runs, generated_barcodes, validation_sessions |
| Agent/Approval/Integrations | 11 | 7 | agent_queries, schema_metadata, agent_messages, routing_patterns, approval_requests, system_dependencies, integrations |
| Audit | 2 | 2 | audit_log, electronic_signatures |
| Manufacturing Materials | 3 | 1-2 | manufacturing_materials (+tx log if HIPAA) |
| **TOTAL** | **110** | **~28-32** | |

---

## Cross-Cutting Concerns

### 1. The `_id` / `id` Problem — Global Fix

Add a Mongoose global plugin that adds `id` virtual to lean results:

```typescript
// In db/index.ts
import mongoose from 'mongoose';

// Global plugin: add 'id' getter to all schemas
mongoose.plugin((schema) => {
  schema.set('toJSON', { virtuals: true });
  schema.set('toObject', { virtuals: true });
});

// For lean() queries, use a transform:
// Option A: Global lean default (Mongoose 7+)
mongoose.set('translateAliases', true);

// Option B: Helper function
export function withId<T extends { _id: string }>(doc: T): T & { id: string } {
  return { ...doc, id: doc._id };
}
export function withIds<T extends { _id: string }>(docs: T[]): (T & { id: string })[] {
  return docs.map(d => ({ ...d, id: d._id }));
}
```

**Use `withId` / `withIds` in every server load function.** This is the bridge between MongoDB's `_id` and the frontend's `id`.

### 2. Transactions — Where Required

Wrap multi-document writes in sessions:

```typescript
const session = await mongoose.startSession();
try {
  await session.withTransaction(async () => {
    await KanbanTask.create([{ ... }], { session });
    await AuditLog.create([{ ... }], { session });
  });
} finally {
  session.endSession();
}
```

**Required for:**
- Task creation + audit log
- Assembly step completion + inventory deduction
- Cartridge phase transitions
- Any HIPAA-auditable operation

**Note:** MongoDB Atlas free tier supports multi-document transactions. Self-hosted requires replica set.

### 3. Denormalization Update Strategy

When a denormalized field changes (e.g., user renames themselves), batch-update all documents containing the denormalized copy:

```typescript
// When user.username changes:
await KanbanTask.updateMany(
  { 'assignee._id': userId },
  { $set: { 'assignee.username': newUsername } }
);
await Customer.updateMany(
  { 'notes.createdBy._id': userId },
  { $set: { 'notes.$[elem].createdBy.username': newUsername } },
  { arrayFilters: [{ 'elem.createdBy._id': userId }] }
);
```

This is rare (username changes are infrequent) and the tradeoff is worth it vs. joining on every read.

### 4. Indexing Strategy

Every collection needs indexes aligned with query patterns:

```typescript
// kanban_tasks
{ 'project._id': 1, status: 1, archived: 1 }  // board view
{ 'assignee._id': 1, status: 1 }                // "my tasks"
{ archived: 1, archivedAt: -1 }                 // archive view

// cartridge_records
{ currentStatus: 1 }
{ 'storage.locationId': 1 }
{ 'reagent.assayTypeId': 1 }
{ 'shipping.lotId': 1 }

// spus
{ udi: 1 }  // unique
{ 'batch._id': 1, status: 1 }
{ assemblyStatus: 1 }
```

### 5. Migration Strategy

**Phase 1: Critical fixes (immediate)**
- Add `withId`/`withIds` helpers and fix all server load functions
- Fix `{ id: }` queries → `{ _id: }` queries
- Add transactions to HIPAA-critical operations

**Phase 2: Schema redesign (per domain)**
- Start with Kanban (smallest, most visible bug)
- Then Work Instructions (deepest nesting, biggest win)
- Then Manufacturing Pipeline (most complex, biggest collection reduction)
- Then Auth (most impactful for performance — every request)

**Phase 3: Data migration**
- Write migration scripts per domain that read old collections and write to new schema
- Run in parallel (old + new) with a feature flag
- Validate data integrity before switching
- Drop old collections after validation

---

## Key Decisions Needed

1. **SpectroReading embedding:** If tests commonly have > 1000 readings, keep SpectroReading separate. Need data on actual reading counts.

2. **Cartridge lifecycle:** The unified `cartridge_records` approach vs. keeping phase-specific collections. Depends on whether queries are phase-centric ("all cartridges in reagent run X") or cartridge-centric ("full history of cartridge Y").

3. **Manufacturing material transactions:** Embed recent + archive to audit log, or keep fully separate? Depends on HIPAA requirements for transaction immutability.

4. **Image storage in work instructions:** If step images are large (> 1MB), use GridFS or external object storage instead of embedding base64 in the document.

5. **Equipment event logs:** Embed bounded recent events in equipment doc, or keep separate unbounded collection? Depends on query patterns (recent alerts vs. full history).

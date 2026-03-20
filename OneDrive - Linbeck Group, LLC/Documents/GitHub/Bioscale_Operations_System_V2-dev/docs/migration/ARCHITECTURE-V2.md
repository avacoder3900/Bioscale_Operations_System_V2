# MongoDB Schema Redesign v2 — Two-Tier Architecture

## Design Philosophy

This system has two fundamentally different kinds of data:

**Tier 1 — Sacred Documents:** The regulated, traceable, business-critical records that accumulate data over their lifecycle and then freeze as immutable golden records. These are the *product* of the business. A cartridge DMR, an SPU build record, a reagent batch — these are what you'd hand to an auditor, a customer, or the FDA.

**Tier 2 — Operational Scaffolding:** Everything that supports building those sacred documents — task management, auth, equipment tracking, work instructions, settings. This data is mutable, queryable, and follows standard document-DB embedding patterns for performance.

**Tier 3 — Immutable Logs:** Append-only audit trails that can never be modified. These exist for compliance and traceability independent of the sacred documents.

---

## Tier 1: Sacred Documents

### Design Principles

1. **Append-only accumulation.** Each lifecycle phase is written ONCE and never modified after.
2. **Self-contained.** Pull one document → complete story. No joins needed. An auditor reads one JSON object.
3. **Denormalize aggressively.** Store operator names, assay names, lot numbers directly. If a username changes later, the sacred document preserves who it was *at the time of the action*. This is a feature, not a bug — it's point-in-time truth.
4. **Freeze on finalization.** Once a document reaches its terminal state (shipped, deployed, locked), set `finalizedAt` and reject all further mutations.
5. **Never delete.** Sacred documents are never deleted. They can be marked `voided` with a reason, but the original data remains.

### Immutability Enforcement

```typescript
// Mongoose middleware — prevent modification of finalized sacred documents
function sacredDocumentGuard(schema: Schema) {
  const mutatingOps = ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne'];

  for (const op of mutatingOps) {
    schema.pre(op, async function () {
      const filter = this.getFilter();
      const doc = await this.model.findOne(filter).select('finalizedAt').lean();
      if (doc?.finalizedAt) {
        throw new Error(
          `Cannot modify finalized document ${doc._id}. ` +
          `Finalized at ${doc.finalizedAt}. ` +
          `To correct data, create a correction record instead.`
        );
      }
    });
  }

  // Also prevent delete
  schema.pre('deleteOne', function () {
    throw new Error('Sacred documents cannot be deleted. Use void() instead.');
  });
  schema.pre('deleteMany', function () {
    throw new Error('Sacred documents cannot be deleted. Use void() instead.');
  });
}
```

### Phase-Writing Pattern

Each phase is written via a dedicated function that validates the transition and appends data atomically:

```typescript
// Example: writing the wax filling phase to a cartridge DMR
async function recordWaxFilling(
  cartridgeId: string,
  waxData: WaxPhaseData,
  operatorId: string
) {
  const session = await mongoose.startSession();
  await session.withTransaction(async () => {
    // Validate: cartridge must be in 'backing' phase
    const cart = await CartridgeRecord.findOne(
      { _id: cartridgeId, currentPhase: 'backing', finalizedAt: null },
      null,
      { session }
    );
    if (!cart) throw new Error('Cartridge not in backing phase or already finalized');

    // Append wax phase (write-once)
    await CartridgeRecord.updateOne(
      { _id: cartridgeId, 'waxFilling': null },  // ensure not already written
      {
        $set: {
          waxFilling: {
            ...waxData,
            operator: { _id: operatorId, username: await getUsername(operatorId) },
            recordedAt: new Date()
          },
          currentPhase: 'wax_filled'
        }
      },
      { session }
    );

    // Audit log
    await AuditLog.create([{
      _id: nanoid(),
      tableName: 'cartridge_records',
      recordId: cartridgeId,
      action: 'PHASE_ADVANCE',
      newData: { phase: 'wax_filled' },
      changedBy: operatorId,
      changedAt: new Date()
    }], { session });
  });
  session.endSession();
}
```

---

### 1. Cartridge Device Master Record (`cartridge_records`)

The most important document in the system. One cartridge, one document, complete chain of custody.

```typescript
interface ICartridgeRecord {
  _id: string;                    // cartridge barcode / ID — the physical identifier

  // === LIFECYCLE PHASES (each written once, never modified) ===

  backing: {
    lotId: string;
    lotQrCode: string;
    ovenEntryTime?: Date;
    recordedAt: Date;
  };

  waxFilling?: {
    runId: string;
    robotId: string;
    deckId?: string;
    deckPosition: number;
    waxTubeId?: string;
    waxSourceLot?: string;
    transferTimeSeconds?: number;
    operator: { _id: string; username: string };
    runStartTime?: Date;
    runEndTime?: Date;
    recordedAt: Date;
  };

  waxQc?: {
    status: 'Accepted' | 'Rejected' | 'Pending';
    rejectionReason?: string;
    operator?: { _id: string; username: string };
    timestamp: Date;
    recordedAt: Date;
  };

  waxStorage?: {
    location?: string;
    coolingTrayId?: string;
    operator?: { _id: string; username: string };
    timestamp: Date;
    recordedAt: Date;
  };

  reagentFilling?: {
    runId: string;
    robotId: string;
    assayType: { _id: string; name: string; skuCode: string };
    deckPosition: number;
    tubeRecords: {
      wellPosition: number;
      reagentName: string;
      sourceLotId: string;
      transferTubeId: string;
    }[];
    operator: { _id: string; username: string };
    fillDate: Date;
    expirationDate?: Date;
    recordedAt: Date;
  };

  reagentInspection?: {
    status: 'Accepted' | 'Rejected' | 'Pending';
    reason?: string;
    operator?: { _id: string; username: string };
    timestamp: Date;
    recordedAt: Date;
  };

  topSeal?: {
    batchId: string;
    topSealLotId: string;
    operator: { _id: string; username: string };
    timestamp: Date;
    recordedAt: Date;
  };

  ovenCure?: {
    locationId?: string;
    entryTime: Date;
    recordedAt: Date;
  };

  storage?: {
    fridgeId?: string;
    locationId?: string;
    containerBarcode?: string;
    operator: { _id: string; username: string };
    timestamp: Date;
    recordedAt: Date;
  };

  qaqcRelease?: {
    shippingLotId: string;
    testResult: 'pass' | 'fail' | 'pending';
    testedBy?: { _id: string; username: string };
    testedAt?: Date;
    notes?: string;
    recordedAt: Date;
  };

  shipping?: {
    packageId: string;
    packageBarcode: string;
    customerId: string;
    customerName: string;
    trackingNumber?: string;
    carrier?: string;
    shippedAt?: Date;
    recordedAt: Date;
  };

  // === LIFECYCLE STATE ===
  currentPhase: 'backing' | 'wax_filled' | 'wax_qc' | 'wax_stored' |
                'reagent_filled' | 'inspected' | 'sealed' | 'cured' |
                'stored' | 'released' | 'shipped' | 'voided';

  // === IMMUTABILITY ===
  finalizedAt?: Date;             // set when shipped — document frozen after this
  voidedAt?: Date;                // if voided, when
  voidReason?: string;            // why it was voided

  // === METADATA ===
  createdAt: Date;
  updatedAt: Date;
}
```

**What this gives you:** Pull cartridge `CART-2026-A1-00042` and you can see:
- Which backing lot it came from
- Which robot ran the wax filling, what deck position, who operated it
- Whether it passed wax QC and who inspected it
- Which assay type and reagent lots were used
- Who sealed it, what top seal lot
- Which fridge it was stored in
- Which shipping lot released it, the test results
- Which package it shipped in, to which customer, with what tracking number

**One document. Complete traceability. No joins.**

---

### 2. SPU Build Record (`spus`)

The complete build record for a Signal Processing Unit.

```typescript
interface ISpu {
  _id: string;
  udi: string;                    // unique device identifier — the physical label

  // === BUILD RECORD (accumulated during assembly) ===

  batch?: {
    _id: string;
    batchNumber: string;
  };

  parts: {
    _id: string;
    partDefinitionId: string;
    partNumber: string;           // denormalized at time of scan
    partName: string;             // denormalized at time of scan
    lotNumber?: string;
    serialNumber?: string;
    scannedAt: Date;
    scannedBy: { _id: string; username: string };
    barcodeData?: string;
    isReplaced: boolean;
    replacedBy?: string;
    replaceReason?: string;
  }[];

  assembly?: {
    sessionId: string;
    workInstructionId: string;
    workInstructionVersion: number;
    workInstructionTitle: string;  // denormalized at time of assembly
    startedAt: Date;
    completedAt?: Date;
    operator: { _id: string; username: string };
    workstationId?: string;

    stepRecords: {
      stepNumber: number;
      stepTitle: string;
      scannedLotNumber?: string;
      scannedPartNumber?: string;
      completedAt?: Date;
      completedBy: { _id: string; username: string };
      fieldRecords: {
        fieldName: string;
        fieldLabel: string;
        fieldValue: string;
        rawBarcodeData?: string;
        capturedAt: Date;
        capturedBy: string;
      }[];
    }[];
  };

  signature?: {
    _id: string;
    userId: string;
    username: string;
    meaning: string;
    signedAt: Date;
    ipAddress?: string;
    dataHash?: string;
  };

  particleLink?: {
    particleSerial: string;
    particleDeviceId?: string;
    linkedAt: Date;
    linkedBy: { _id: string; username: string };
  };

  validation?: {
    sessionId: string;
    type: string;
    status: string;
    results: {
      testType: string;
      passed?: boolean;
      rawData?: any;
      processedData?: any;
      notes?: string;
      createdAt: Date;
    }[];
    completedAt?: Date;
  };

  // === ASSIGNMENT & DEPLOYMENT ===
  assignment?: {
    type: string;
    customer: { _id: string; name: string };
    assignedAt: Date;
    assignedBy: { _id: string; username: string };
  };

  // === LIFECYCLE STATE ===
  status: 'draft' | 'assembling' | 'assembled' | 'validating' | 'validated' |
          'assigned' | 'deployed' | 'retired' | 'voided';
  deviceState: string;
  qcStatus: 'pending' | 'passed' | 'failed';
  qcDocumentUrl?: string;

  // === IMMUTABILITY ===
  finalizedAt?: Date;             // set when deployed
  voidedAt?: Date;
  voidReason?: string;

  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
}
```

**What this gives you:** Pull SPU `BRV-2026-001234` and you see every part that went into it (with lot numbers for traceability), every assembly step completed (with field captures and operator signatures), the particle IoT link, validation results, and customer assignment. One document. Complete build record.

---

### 3. Assay Definition (`assay_definitions`)

The locked reference document for an assay — its reagent formula, bcode, and version history.

```typescript
interface IAssayDefinition {
  _id: string;
  assayId: string;                // human-readable ID
  name: string;
  description?: string;
  skuCode: string;

  // === CURRENT CONFIGURATION ===
  duration?: number;
  bcode?: Buffer;
  bcodeLength?: number;
  checksum?: number;
  isActive: boolean;
  shelfLifeDays?: number;
  bomCostOverride?: string;
  useSingleCost: boolean;

  // === REAGENT FORMULA (the recipe) ===
  reagents: {
    _id: string;
    wellPosition: number;
    reagentName: string;
    unitCost?: string;
    volumeMicroliters?: number;
    unit?: string;
    classification?: string;
    hasBreakdown: boolean;
    sortOrder: number;
    isActive: boolean;

    subComponents: {
      _id: string;
      name: string;
      unitCost?: string;
      unit?: string;
      volumeMicroliters?: number;
      classification?: string;
      sortOrder: number;
    }[];
  }[];

  // === VERSION HISTORY (append-only) ===
  versionHistory: {
    version: number;
    previousName?: string;
    previousDescription?: string;
    previousBcode?: Buffer;
    previousBcodeLength?: number;
    previousChecksum?: number;
    previousDuration?: number;
    previousMetadata?: any;
    changedBy: { _id: string; username: string };
    changedAt: Date;
    changeNotes?: string;
  }[];

  // === IMMUTABILITY ===
  lockedAt?: Date;                // once locked, only new versions can be created
  lockedBy?: { _id: string; username: string };

  metadata?: any;
  createdAt: Date;
  updatedAt: Date;
}
```

---

### 4. Reagent Batch Record (`reagent_batch_records`)

Complete traceability for a reagent filling run — from tube preparation through filling to QC. Every cartridge filled in this batch is linked. Every reagent source lot is recorded.

```typescript
interface IReagentBatchRecord {
  _id: string;
  runNumber?: string;             // human-readable run ID

  // === RUN CONFIGURATION ===
  robot: {
    _id: string;
    name: string;
    side?: string;
  };
  assayType: {
    _id: string;
    name: string;
    skuCode: string;
    version?: number;             // which assay version was active at time of run
  };
  operator: { _id: string; username: string };
  deckId?: string;

  // === TUBE PREPARATION (reagent source traceability) ===
  tubeRecords: {
    wellPosition: number;
    reagentName: string;
    sourceLotId: string;          // which reagent lot this came from
    transferTubeId: string;       // which physical tube was used
    preparedAt?: Date;
  }[];

  // === RUN TIMELINE ===
  setupTimestamp?: Date;
  runStartTime?: Date;
  runEndTime?: Date;
  status: 'setup' | 'running' | 'completed' | 'aborted' | 'voided';
  abortReason?: string;
  abortPhotoUrl?: string;

  // === CARTRIDGES FILLED (the output of this batch) ===
  cartridgesFilled: {
    cartridgeId: string;          // reference to cartridge DMR
    deckPosition: number;
    inspectionStatus: 'Accepted' | 'Rejected' | 'Pending';
    inspectionReason?: string;
    inspectedBy?: { _id: string; username: string };
    inspectedAt?: Date;
  }[];
  cartridgeCount: number;

  // === TOP SEAL (if done as part of this batch) ===
  topSeal?: {
    batchId: string;
    topSealLotId: string;
    operator: { _id: string; username: string };
    firstScanTime?: Date;
    completionTime?: Date;
    durationSeconds?: number;
    cartridgeCount: number;
    status: string;
  };

  // === QC RELEASE ===
  qcRelease?: {
    qaqcCartridgeIds: string[];
    testResult: 'pass' | 'fail' | 'pending';
    testedBy?: { _id: string; username: string };
    testedAt?: Date;
    notes?: string;
  };

  // === IMMUTABILITY ===
  finalizedAt?: Date;             // set when all cartridges are QC'd and released/rejected
  voidedAt?: Date;
  voidReason?: string;

  createdAt: Date;
  updatedAt: Date;
}
```

**What this gives you:** Pull reagent batch `RR-2026-018` and you see: which robot and operator ran it, exactly which reagent lots went into which wells, every cartridge that came out of it (with inspection results), the top seal batch, and the QC release decision. Complete traceability from input materials to output cartridges.

**Cross-reference:** The cartridge DMR also records its `reagentFilling.runId` pointing back to this batch. So you can trace both directions: "which cartridges came from this batch?" (query the batch) and "which batch made this cartridge?" (read the cartridge DMR).

---

### 5. Lot Record (`lot_records`)

Backing lot traceability — the starting point of the manufacturing pipeline.

```typescript
interface ILotRecord {
  _id: string;
  qrCodeRef: string;
  processConfig: {
    _id: string;
    processName: string;
    processType: string;
  };
  operator: { _id: string; username: string };
  inputLots: any;                 // traceability to upstream lots
  quantityProduced: number;
  desiredQuantity?: number;
  quantityDiscrepancyReason?: string;

  // === PROCESS STEPS ===
  stepEntries: {
    _id: string;
    stepNumber: number;
    stepTitle: string;
    note?: string;
    imageUrl?: string;
    operator: { _id: string; username: string };
    completedAt: Date;
  }[];

  // === TIMELINE ===
  startTime?: Date;
  finishTime?: Date;
  cycleTime?: number;
  ovenEntryTime?: Date;
  wiRevision?: string;
  status: string;

  // === OUTPUT CARTRIDGES (what this lot produced) ===
  cartridgeIds?: string[];        // references to cartridge DMRs produced from this lot

  // === IMMUTABILITY ===
  finalizedAt?: Date;
  voidedAt?: Date;
  voidReason?: string;

  createdAt: Date;
  updatedAt: Date;
}
```

---

## Tier 2: Operational Scaffolding

These collections follow standard document-DB best practices (embed what you read together, reference what grows unbounded). Full details in the original ARCHITECTURE.md. Summary:

### Auth & Access (4 collections)
| Collection | Notes |
|-----------|-------|
| `users` | Roles + permissions embedded. Comm prefs embedded. |
| `sessions` | Separate — TTL-indexed, high churn |
| `roles` | Reference catalog — sync to user docs on change |
| `invite_tokens` | Separate — independent lifecycle |

### Kanban (2 collections)
| Collection | Notes |
|-----------|-------|
| `kanban_projects` | Project metadata, tags |
| `kanban_tasks` | Comments, activity, tags embedded. Project name/color denormalized. |

### Work Instructions (1 collection)
| Collection | Notes |
|-----------|-------|
| `work_instructions` | Versions → steps → requirements → field defs all embedded |

### Equipment & Consumables (5 collections)
| Collection | Notes |
|-----------|-------|
| `equipment` | Fridges, ovens with current state |
| `equipment_locations` | Current placements embedded |
| `opentrons_robots` | Protocols embedded |
| `consumables` | Tubes, rolls, decks, trays unified. Usage log embedded. |
| `laser_cut_batches` | Separate — independent tracking |

### BOM & Parts (3 collections)
| Collection | Notes |
|-----------|-------|
| `bom_items` | Version history + part links embedded |
| `part_definitions` | Separate — referenced from many places |
| `bom_column_mapping` | Single-document config |

### Production (3 collections)
| Collection | Notes |
|-----------|-------|
| `production_runs` | Units embedded |
| `generated_barcodes` | Separate — atomic sequence counter |
| `validation_sessions` | Results embedded |

### Shipping (2 collections)
| Collection | Notes |
|-----------|-------|
| `shipping_lots` | QA/QC releases embedded |
| `shipping_packages` | Cartridge list embedded |

### Customers (1 collection)
| Collection | Notes |
|-----------|-------|
| `customers` | Notes embedded |

### Documents & Files (3 collections)
| Collection | Notes |
|-----------|-------|
| `documents` | Revisions + training records embedded |
| `files` | Separate — referenced from many places |
| `document_repository` | Separate — independent upload/search |

### Agent & Approval (6 collections)
| Collection | Notes |
|-----------|-------|
| `agent_queries` | Unchanged |
| `schema_metadata` | Unchanged |
| `agent_messages` | Unchanged — unbounded |
| `approval_requests` | History embedded |
| `system_dependencies` | Unchanged |
| `integrations` | Box + Particle merged |

### Manufacturing Settings (1 collection)
| Collection | Notes |
|-----------|-------|
| `manufacturing_settings` | All settings + rejection codes in one doc |

### Cartridge Lab Tracking (4 collections)
| Collection | Notes |
|-----------|-------|
| `cartridge_groups` | Reference catalog |
| `cartridges` | Usage log embedded (lab-side tracking, separate from mfg DMR) |
| `firmware_devices` | Unchanged |
| `firmware_cartridges` | Unchanged — external system mirror |

---

## Tier 3: Immutable Logs

These are append-only collections that are never modified. They exist for compliance, auditing, and traceability.

| Collection | Purpose | Growth |
|-----------|---------|--------|
| `audit_log` | HIPAA audit trail — every action by every user | Unbounded |
| `electronic_signatures` | 21 CFR Part 11 compliance — digital signatures | Bounded (per entity) |
| `inventory_transactions` | Immutable ledger of all inventory movements | Unbounded |
| `device_events` | IoT device event stream | Unbounded |
| `manufacturing_material_transactions` | Material usage ledger | Unbounded |

These collections get **TTL indexes** or **archival policies** for old data (e.g., move events older than 2 years to cold storage) but are never modified in place.

---

## Collection Summary

| Tier | Collections | Purpose |
|------|------------|---------|
| **Tier 1: Sacred** | 5 | cartridge_records, spus, assay_definitions, reagent_batch_records, lot_records |
| **Tier 2: Operational** | ~23 | Auth, kanban, WI, equipment, BOM, production, shipping, customers, docs, agent, settings, cartridge lab |
| **Tier 3: Immutable Logs** | 5 | audit_log, electronic_signatures, inventory_transactions, device_events, material_transactions |
| **TOTAL** | **~33** | Down from 110 |

---

## Data Flow: Cartridge Lifecycle

```
                    Tier 1 Sacred Documents
                    ═══════════════════════

  lot_records ──┐
                │   ┌──────────────────────────────────────┐
                ├──→│         cartridge_records              │
                │   │                                        │
  wax_filling   │   │  backing ← lot_records._id            │
  (Tier 2)   ───┤   │  waxFilling ← written at wax phase    │
                │   │  waxQc ← written at inspection         │
  reagent_      │   │  reagentFilling ← reagent_batch._id    │
  batch_records─┤   │  topSeal ← written at seal phase       │
                │   │  storage ← written at storage           │
                │   │  qaqcRelease ← written at release       │
                │   │  shipping ← written at shipment         │
                │   │                                        │
                │   │  finalizedAt ← FROZEN                  │
                │   └──────────────────────────────────────┘
                │
  reagent_batch_records ──→ links back to cartridge_records
                            (bidirectional traceability)
```

---

## Correction Records (Instead of Mutations)

When a sacred document has an error after finalization, you don't modify it. You create a correction record:

```typescript
interface ICorrectionRecord {
  _id: string;
  entityType: 'cartridge' | 'spu' | 'assay' | 'reagent_batch' | 'lot';
  entityId: string;
  fieldPath: string;              // e.g., "waxFilling.operator.username"
  previousValue: any;
  correctedValue: any;
  reason: string;
  correctedBy: { _id: string; username: string };
  correctedAt: Date;
  approvedBy?: { _id: string; username: string };
  approvedAt?: Date;
}
```

This preserves the original record AND the correction history — exactly what auditors want to see. The original document is never touched. The application layer knows to check for corrections when displaying data.

---

## Implementation Order

| Phase | What | Why First |
|-------|------|-----------|
| **0** | `withId`/`withIds` fix + `{ id: }` → `{ _id: }` query fix | Stop active breakage |
| **1** | Cartridge DMR + immutability middleware | Most important business document |
| **2** | Reagent batch records | Traceability requirement |
| **3** | SPU build records | Second most important |
| **4** | Assay definitions + lot records | Complete sacred tier |
| **5** | Auth (embed roles/perms) | Biggest performance win |
| **6** | Kanban (embed comments/tags) | Most visible current bug |
| **7** | Work instructions (collapse tree) | Biggest structural win |
| **8** | Everything else (equipment, BOM, shipping, etc.) | Incremental cleanup |

# Bioscale Operations System — Complete MongoDB Schema Specification

**Version:** 2.0
**Date:** February 27, 2026
**Author:** Agent001 (Architecture), for review by Jacob Quick and Lead Engineer
**Purpose:** Comprehensive specification of every database collection in the redesigned MongoDB schema, organized by functional area of the web application.
**Status:** Ready for review — incorporates all decisions from the February 27 session with Jacob.

---

## Document Conventions

- Every schema is shown as a **TypeScript interface** matching the Mongoose model shape
- Fields marked `// DENORMALIZED` store a copy of data from another collection for read performance
- Fields marked `// EMBEDDED (was: CollectionName)` indicate data that previously lived in a separate collection
- Fields marked `// WRITE-ONCE` are set during a specific lifecycle phase and never modified after
- Fields marked `// SNAPSHOT` capture the full state of a referenced entity at a point in time
- Fields marked `// REFERENCE` identify a related entity without snapshotting its full state
- The `_id` field on every collection uses `string` (nanoid), not MongoDB ObjectId
- Every embedded sub-object also has a string `_id` for addressability

---

## Architecture Overview

### Three Tiers of Data

| Tier | Purpose | Mutability | Collections |
|------|---------|------------|-------------|
| **Sacred Documents** | Business-critical traceable records | Append-only until finalized, then frozen | 5 |
| **Operational** | Everything that supports building sacred documents | Freely mutable, follows embedding best practices | ~23 |
| **Immutable Logs** | Compliance audit trails | Append-only, never modified or deleted | 5 |

### Collection Count

| | Current (Legacy) | v1 Redesign | v2 Redesign |
|--|---------|-----------|-------------|
| **Total collections** | 110 | 33 | ~33 |
| **Junction table collections** | 7 | 0 | 0 |
| **Settings singleton collections** | 3 | 1 | 1 |
| **Separate log collections** | 12 | 5 (rest embedded) | 5 (rest embedded) |

### What Changed from v1 to v2

| Change | Detail |
|--------|--------|
| **User → Sacred** | Users promoted to Tier 1 with roleHistory, training records, corrections |
| **Lot → Operational** | Lot records demoted from sacred to operational |
| **Correction Records → Eliminated** | Each sacred document embeds its own `corrections[]` array |
| **Cartridge: 4 new phases** | assayLoaded, testExecution (full SPU snapshot), sample, testResult |
| **SPU: Full assembly embedded** | Complete step records + field records, not just summary reference |
| **Reagent Batch: Assay reference** | `{ _id, name, skuCode }` not full snapshot |
| **Shipping Packages: Full customer** | Full customer snapshot, not just `{ _id, name }` |

### Data Flow Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          SACRED DOCUMENTS (Tier 1)                          │
│                       (the product of this system)                          │
│                                                                             │
│  ┌──────────────────┐  ┌───────────┐  ┌────────────┐  ┌────────────────┐   │
│  │    CARTRIDGE      │  │    SPU    │  │   ASSAY    │  │ REAGENT BATCH  │   │
│  │  (TERMINAL DOC)   │  │   Build   │  │ Definition │  │    Record      │   │
│  │                   │  │  Record   │  │            │  │                │   │
│  │ mfg → device →   │  │           │  │            │  │                │   │
│  │ patient → result  │  │           │  │            │  │                │   │
│  └────────┬──────────┘  └─────┬─────┘  └─────┬──────┘  └───────┬────────┘  │
│           │                   │               │                 │           │
│           │         ┌─────────┘               │                 │           │
│           │         │                         │                 │           │
│  ┌────────┴─────────┴─────────────────────────┴─────────────────┴────────┐  │
│  │                          USER RECORD                                  │  │
│  │         (the WHO behind every action in every sacred doc)             │  │
│  │         roleHistory + training records + HIPAA compliance             │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
                                     ▲
    ╔════════════════════════════════╪════════════════════════════════════════╗
    ║  OPERATIONAL SCAFFOLDING (Tier 2)                                     ║
    ║  All roads lead to sacred documents                                   ║
    ╠═══════════════════════════════════════════════════════════════════════╣
    ║                                                                       ║
    ║  Lot Records ──→ upstream grouping of cartridge bodies                ║
    ║  Auth & Sessions ──→ WHO is performing actions on sacred docs         ║
    ║  Work Instructions ──→ HOW to build SPUs (assembly blueprint)         ║
    ║  Assembly Sessions ──→ working doc during build → copied to SPU       ║
    ║  BOM & Parts ──→ WHAT GOES INTO each SPU                             ║
    ║  Equipment ──→ WHICH MACHINES processed cartridges                    ║
    ║  Wax Filling Runs ──→ feeds cartridge wax phase                       ║
    ║  Manufacturing Settings ──→ configures the pipeline                   ║
    ║  Consumables ──→ tracks resources consumed during production           ║
    ║  Shipping ──→ feeds cartridge shipping phase                           ║
    ║  Customers ──→ WHO receives the final sacred products                 ║
    ║  Kanban ──→ tracks TASKS needed to improve the pipeline               ║
    ║  Documents ──→ SOPs and controlled docs governing the process         ║
    ║  Validation ──→ PROVES the SPU works (feeds SPU validation)           ║
    ║  Production Runs ──→ batches SPU assembly (feeds SPU records)         ║
    ║                                                                       ║
    ╚═══════════════════════════════════════════════════════════════════════╝
```

### The Cartridge as Terminal Document

The cartridge is where the entire system converges. It is the **terminal document** — the record that starts with raw materials and ends with a clinical test result:

```
Manufacturing Pipeline:
  backing → waxFilling → waxQc → waxStorage → reagentFilling →
  reagentInspection → topSeal → ovenCure → storage → qaqcRelease → shipping

Clinical Pipeline:
  assayLoaded → testExecution (full SPU snapshot) → sample → testResult
```

All other sacred documents are either **source documents** (assay definition, reagent batch) or get **snapshotted into the cartridge** at key moments (SPU at test time, customer at shipment time). One cartridge document = complete chain from raw materials → device → patient → result.

### Snapshot vs Reference Decision

When a sacred document references another entity:
- **Snapshot** (full embedded copy) — when you need point-in-time truth. Example: SPU state at test time, customer address at shipment.
- **Reference** (`{ _id, name, skuCode }`) — when you just need identification of a slowly-changing entity. Example: which assay a reagent batch is making.

### Document Size at Brevitest Scale

Document size is irrelevant at Brevitest's scale:
- Full SPU with complete assembly session: ~25KB
- Full cartridge with all manufacturing + clinical phases: ~50-100KB
- MongoDB 16MB limit: at 0.5% utilization
- Projections (`.select()`) handle selective loading — the full doc only loads when explicitly requested

### System Flexibility

New phases can be added to sacred documents as optional fields. Old documents without the new fields work fine. No migrations needed. This is a core advantage of the document model for Brevitest's use case.

---

# TIER 1: SACRED DOCUMENTS

These are the regulated, traceable, business-critical records. They accumulate data over their lifecycle and freeze as immutable golden records. You could hand any one of these to an auditor and it tells the complete story.

**Shared behaviors:**
- Each phase is written once and never modified
- `finalizedAt` field — once set, all mutations are rejected by middleware
- Never deleted — can be `voided` with a reason, but original data preserved
- Denormalize aggressively — store operator names, assay names, lot numbers at time of action (point-in-time truth)
- Corrections are embedded as append-only `corrections[]` arrays — original data stays untouched, corrections show what was fixed, by whom, and why

**Sacred Document Count: 5**
1. Cartridge Record — the terminal document
2. SPU Build Record — complete device build record
3. Assay Definition — locked reference formula
4. Reagent Batch Record — filling run traceability
5. User Record — the WHO behind every action (HIPAA)

---

## 1.1 Cartridge Device Master Record

**Collection name:** `cartridge_records`
**Web app section:** Manufacturing Pipeline → flows through Wax Filling, Reagent Filling, Top Seal, QC, Storage, Shipping → Clinical Use
**Routes:** `/spu/cartridge-admin/*`, `/spu/manufacturing/*`, `/spu/shipping`

**What this is:** The single most important document in the system — the **terminal document**. One document per physical cartridge, tracking its complete chain of custody from backing lot creation through customer shipment, then through clinical use: which assay was loaded, which SPU ran the test (full snapshot), the patient sample data, and the test result. Every hand that touched it, every machine that processed it, every QC decision made about it, every clinical outcome.

**Why one document:** In the old schema, a cartridge's data was scattered across `WaxCartridgeRecord`, `ReagentCartridgeRecord`, and `PackageCartridge` — three separate collections that each knew about one phase but not the others. In the redesign, one query returns everything. And with v2's clinical phases, the cartridge becomes the complete chain from raw materials → device → patient → result.

**Current collections replaced:** `WaxCartridgeRecord`, `ReagentCartridgeRecord`, `PackageCartridge` (3 → 1)

```typescript
interface ICartridgeRecord {
  _id: string;                      // cartridge barcode / physical identifier

  // ══════════════════════════════════════════════════════
  // MANUFACTURING PHASES — each written once, never modified
  // ══════════════════════════════════════════════════════

  // PHASE 1: Created from a backing lot
  backing: {                         // WRITE-ONCE
    lotId: string;                   // reference to lot_records._id
    lotQrCode: string;               // denormalized — the QR code at time of creation
    ovenEntryTime?: Date;
    recordedAt: Date;
  };

  // PHASE 2: Wax filling by Opentrons robot
  waxFilling?: {                     // WRITE-ONCE — set when wax run completes
    runId: string;                   // reference to wax_filling_runs._id
    robotId: string;
    robotName: string;               // DENORMALIZED
    deckId?: string;
    deckPosition: number;
    waxTubeId?: string;
    waxSourceLot?: string;
    transferTimeSeconds?: number;
    operator: {                      // DENORMALIZED — who operated at time of fill
      _id: string;
      username: string;
    };
    runStartTime?: Date;
    runEndTime?: Date;
    recordedAt: Date;
  };

  // PHASE 3: Wax QC inspection
  waxQc?: {                          // WRITE-ONCE — set when inspector decides
    status: 'Accepted' | 'Rejected' | 'Pending';
    rejectionReason?: string;        // from rejection_reason_codes
    operator?: {                     // DENORMALIZED — who inspected
      _id: string;
      username: string;
    };
    timestamp: Date;
    recordedAt: Date;
  };

  // PHASE 4: Post-wax storage
  waxStorage?: {                     // WRITE-ONCE
    location?: string;
    coolingTrayId?: string;
    operator?: {
      _id: string;
      username: string;
    };
    timestamp: Date;
    recordedAt: Date;
  };

  // PHASE 5: Reagent filling
  reagentFilling?: {                 // WRITE-ONCE — set when reagent run completes
    runId: string;                   // reference to reagent_batch_records._id
    robotId: string;
    robotName: string;               // DENORMALIZED
    assayType: {                     // REFERENCE — which assay at time of fill
      _id: string;
      name: string;
      skuCode: string;
    };
    deckPosition: number;
    // Which reagent lots went into this specific cartridge
    tubeRecords: {
      wellPosition: number;
      reagentName: string;
      sourceLotId: string;
      transferTubeId: string;
    }[];
    operator: {
      _id: string;
      username: string;
    };
    fillDate: Date;
    expirationDate?: Date;           // calculated from assay shelfLifeDays
    recordedAt: Date;
  };

  // PHASE 6: Post-reagent inspection
  reagentInspection?: {              // WRITE-ONCE
    status: 'Accepted' | 'Rejected' | 'Pending';
    reason?: string;
    operator?: {
      _id: string;
      username: string;
    };
    timestamp: Date;
    recordedAt: Date;
  };

  // PHASE 7: Top seal application
  topSeal?: {                        // WRITE-ONCE
    batchId: string;
    topSealLotId: string;
    operator: {
      _id: string;
      username: string;
    };
    timestamp: Date;
    recordedAt: Date;
  };

  // PHASE 8: Oven curing
  ovenCure?: {                       // WRITE-ONCE
    locationId?: string;
    locationName?: string;           // DENORMALIZED
    entryTime: Date;
    recordedAt: Date;
  };

  // PHASE 9: Cold storage
  storage?: {                        // WRITE-ONCE
    fridgeId?: string;
    fridgeName?: string;             // DENORMALIZED
    locationId?: string;
    containerBarcode?: string;
    operator: {
      _id: string;
      username: string;
    };
    timestamp: Date;
    recordedAt: Date;
  };

  // PHASE 10: QA/QC release
  qaqcRelease?: {                    // WRITE-ONCE
    shippingLotId: string;
    testResult: 'pass' | 'fail' | 'pending';
    testedBy?: {
      _id: string;
      username: string;
    };
    testedAt?: Date;
    notes?: string;
    recordedAt: Date;
  };

  // PHASE 11: Shipment
  shipping?: {                       // WRITE-ONCE
    packageId: string;
    packageBarcode: string;
    customer: {                      // SNAPSHOT — full customer at time of shipment
      _id: string;
      name: string;
      customerType: string;
      contactName?: string;
      contactEmail?: string;
      contactPhone?: string;
      address?: string;
    };
    trackingNumber?: string;
    carrier?: string;
    shippedAt?: Date;
    recordedAt: Date;
  };

  // ══════════════════════════════════════════════════════
  // CLINICAL PHASES — post-shipment, when the cartridge is used
  // ══════════════════════════════════════════════════════

  // PHASE 12: Assay loaded onto cartridge
  assayLoaded?: {                    // WRITE-ONCE — REFERENCE, not full snapshot
    assay: {                         // REFERENCE — which assay was loaded
      _id: string;
      name: string;
      skuCode: string;
    };
    loadedAt: Date;
    recordedAt: Date;
  };

  // PHASE 13: Test execution — captures the SPU that ran the test
  testExecution?: {                  // WRITE-ONCE
    spu: {                           // SNAPSHOT — full SPU state at time of test
      _id: string;
      udi: string;
      parts: {
        partNumber: string;
        partName: string;
        lotNumber?: string;
        serialNumber?: string;
      }[];
      firmwareVersion?: string;
      lastValidation?: {
        type: string;
        status: string;
        completedAt?: Date;
      };
      particleLink?: {
        particleSerial: string;
        particleDeviceId?: string;
      };
    };
    operator: {
      _id: string;
      username: string;
    };
    executedAt: Date;
    recordedAt: Date;
  };

  // PHASE 14: Sample / patient data
  sample?: {                         // WRITE-ONCE
    subjectId: string;               // patient/subject identifier
    sampleType: string;              // e.g., 'blood', 'urine', 'saliva'
    collectedAt: Date;
    collectedBy: {
      _id: string;
      username: string;
    };
    metadata?: any;                  // flexible — additional sample attributes
    recordedAt: Date;
  };

  // PHASE 15: Test result — the clinical output
  testResult?: {                     // WRITE-ONCE
    analyte: string;
    value: number;
    unit: string;
    referenceRange?: {
      low?: number;
      high?: number;
    };
    interpretation?: string;         // 'positive', 'negative', 'indeterminate', etc.
    spectroReadings?: {
      readingNumber: number;
      channel: string;
      value: number;
      timestampMs?: number;
    }[];
    processedData?: any;             // flexible — algorithm outputs, curves, etc.
    status: 'pending' | 'completed' | 'failed' | 'invalid';
    completedAt?: Date;
    recordedAt: Date;
  };

  // ══════════════════════════════════════════════════════
  // LIFECYCLE STATE
  // ══════════════════════════════════════════════════════

  currentPhase: 'backing' | 'wax_filled' | 'wax_qc' | 'wax_stored' |
                'reagent_filled' | 'inspected' | 'sealed' | 'cured' |
                'stored' | 'released' | 'shipped' |
                'assay_loaded' | 'testing' | 'completed' | 'voided';

  // ══════════════════════════════════════════════════════
  // IMMUTABILITY CONTROLS
  // ══════════════════════════════════════════════════════

  finalizedAt?: Date;                // set when test result is recorded — document frozen
  voidedAt?: Date;                   // if voided (scrapped/rejected), when
  voidReason?: string;               // why it was voided

  // ══════════════════════════════════════════════════════
  // CORRECTIONS — append-only, original data untouched
  // ══════════════════════════════════════════════════════

  corrections: {
    _id: string;
    fieldPath: string;               // e.g., "waxFilling.operator.username"
    previousValue: any;
    correctedValue: any;
    reason: string;
    correctedBy: {
      _id: string;
      username: string;
    };
    correctedAt: Date;
    approvedBy?: {                   // second person approval
      _id: string;
      username: string;
    };
    approvedAt?: Date;
  }[];

  createdAt: Date;
  updatedAt: Date;
}
```

**Indexes:**
```typescript
{ currentPhase: 1 }                              // filter dashboard by phase
{ 'backing.lotId': 1 }                           // find cartridges from a lot
{ 'waxFilling.runId': 1 }                        // find cartridges from a wax run
{ 'reagentFilling.runId': 1 }                    // find cartridges from a reagent run
{ 'reagentFilling.assayType._id': 1 }            // filter by assay type
{ 'storage.locationId': 1 }                      // what's in this fridge
{ 'storage.containerBarcode': 1 }                // what's on this tray
{ 'qaqcRelease.shippingLotId': 1 }              // cartridges in a shipping lot
{ 'shipping.packageId': 1 }                      // cartridges in a package
{ currentPhase: 1, 'reagentFilling.expirationDate': 1 }  // expiring soon
{ 'testExecution.spu._id': 1 }                  // find cartridges tested on a specific SPU
{ 'sample.subjectId': 1 }                       // find cartridges for a patient
{ 'testResult.status': 1 }                      // filter by result status
```

---

## 1.2 SPU Build Record

**Collection name:** `spus`
**Web app section:** SPU Tracking, Assembly
**Routes:** `/spu`, `/spu/[spuId]`, `/spu/assembly/*`, `/spu/batches/*`, `/spu/validation/*`, `/spu/particle/*`

**What this is:** The complete build record for a Signal Processing Unit — every part installed, every assembly step completed, operator signatures, validation results, and customer assignment. The SPU is self-contained — hand it to an auditor and you get the complete build record in one document.

**Why embed parts and particle link:** An SPU has 10-30 parts. They're always displayed on the SPU detail page. The particle link is 1:1 with the SPU. Embedding these means the SPU detail page loads in one query instead of three.

**Why embed full assembly (v2 change):** Jacob asked "does the whole assembly session go in the SPU?" — yes. Document size is ~25KB with full assembly. No performance concern. Projections (`.select()`) mean the full doc only loads when requested. The `assembly_sessions` collection still exists as a **working document** during assembly (frequent writes during the build process). On completion, full session data is **copied** into the SPU. The assembly session is retained as backup/audit trail, but the SPU is the golden record.

**Current collections replaced:** `Spu` + `SpuPart` + `ParticleLink` (3 → 1). Assembly sessions remain separate as working documents (see Tier 2).

```typescript
interface ISpu {
  _id: string;
  udi: string;                      // Unique Device Identifier — the physical label

  // ══════════════════════════════════════════════════════
  // BUILD RECORD
  // ══════════════════════════════════════════════════════

  batch?: {                          // DENORMALIZED — which production batch
    _id: string;
    batchNumber: string;
  };

  // EMBEDDED (was: SpuPart collection) — every part installed in this SPU
  parts: {
    _id: string;
    partDefinitionId: string;
    partNumber: string;              // DENORMALIZED at time of scan
    partName: string;                // DENORMALIZED at time of scan
    lotNumber?: string;              // traceability — which lot this part came from
    serialNumber?: string;
    scannedAt: Date;
    scannedBy: {                     // DENORMALIZED at time of scan
      _id: string;
      username: string;
    };
    barcodeData?: string;
    isReplaced: boolean;
    replacedBy?: string;
    replaceReason?: string;
  }[];

  // FULL ASSEMBLY RECORD — copied from assembly_sessions on completion
  assembly?: {
    sessionId: string;               // reference back to working document
    workInstructionId: string;
    workInstructionVersion: number;
    workInstructionTitle: string;     // DENORMALIZED at time of assembly
    startedAt: Date;
    completedAt?: Date;
    operator: {                      // DENORMALIZED
      _id: string;
      username: string;
    };
    workstationId?: string;

    // FULL step records — copied from assembly session on completion
    stepRecords: {
      _id: string;
      stepNumber: number;
      stepTitle?: string;
      scannedLotNumber?: string;
      scannedPartNumber?: string;
      completedAt?: Date;
      completedBy?: {
        _id: string;
        username: string;
      };

      // FULL field records per step
      fieldRecords: {
        _id: string;
        fieldName: string;
        fieldLabel?: string;
        fieldValue: string;
        rawBarcodeData?: string;
        capturedAt?: Date;
        capturedBy?: string;
      }[];
    }[];
  };

  // Electronic signature on completed assembly
  signature?: {                      // EMBEDDED (was: ElectronicSignature lookup)
    _id: string;
    userId: string;
    username: string;                // DENORMALIZED at time of signature
    meaning: string;                 // e.g., "I verify this SPU was assembled correctly"
    signedAt: Date;
    ipAddress?: string;
    dataHash?: string;               // SHA-256 of document state at signing
  };

  // EMBEDDED (was: ParticleLink collection) — IoT device link
  particleLink?: {
    particleSerial: string;
    particleDeviceId?: string;
    linkedAt: Date;
    linkedBy: {
      _id: string;
      username: string;
    };
    previousSpuId?: string;          // if re-linked from another SPU
    unlinkReason?: string;
  };

  // Validation test summary (full results in validation_sessions)
  validation?: {
    sessionId: string;
    type: string;
    status: 'pending' | 'passed' | 'failed';
    completedAt?: Date;
    results: {
      testType: string;
      passed?: boolean;
      notes?: string;
      createdAt: Date;
    }[];
  };

  // ══════════════════════════════════════════════════════
  // ASSIGNMENT & DEPLOYMENT
  // ══════════════════════════════════════════════════════

  assignment?: {
    type: string;
    customer: {                      // DENORMALIZED
      _id: string;
      name: string;
    };
    assignedAt: Date;
    assignedBy: {
      _id: string;
      username: string;
    };
  };

  // ══════════════════════════════════════════════════════
  // LIFECYCLE STATE
  // ══════════════════════════════════════════════════════

  status: 'draft' | 'assembling' | 'assembled' | 'validating' | 'validated' |
          'assigned' | 'deployed' | 'retired' | 'voided';
  deviceState: string;
  assemblyStatus: 'created' | 'in_progress' | 'completed';
  qcStatus: 'pending' | 'passed' | 'failed';
  qcDocumentUrl?: string;

  // ══════════════════════════════════════════════════════
  // IMMUTABILITY CONTROLS
  // ══════════════════════════════════════════════════════

  finalizedAt?: Date;                // set when deployed to customer
  voidedAt?: Date;
  voidReason?: string;

  // ══════════════════════════════════════════════════════
  // CORRECTIONS — append-only, original data untouched
  // ══════════════════════════════════════════════════════

  corrections: {
    _id: string;
    fieldPath: string;
    previousValue: any;
    correctedValue: any;
    reason: string;
    correctedBy: {
      _id: string;
      username: string;
    };
    correctedAt: Date;
    approvedBy?: {
      _id: string;
      username: string;
    };
    approvedAt?: Date;
  }[];

  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  owner?: string;
  ownerNotes?: string;
}
```

**Indexes:**
```typescript
{ udi: 1 }                           // unique — primary lookup
{ 'batch._id': 1, status: 1 }       // SPUs in a batch
{ status: 1, assemblyStatus: 1 }    // dashboard filters
{ 'assignment.customer._id': 1 }    // SPUs for a customer
{ 'parts.lotNumber': 1 }            // traceability — find SPUs using a specific lot
{ 'parts.partNumber': 1 }           // find SPUs containing a specific part
{ createdBy: 1 }
```

---

## 1.3 Assay Definition

**Collection name:** `assay_definitions`
**Web app section:** Assay Management
**Routes:** `/spu/assays/*`

**What this is:** The locked reference document for an assay — its reagent formula (which reagents, which wells, what volumes), the bcode firmware payload, and version history. Once validated and locked, this becomes the authoritative definition of how a test works.

**Why embed reagents and sub-components:** An assay has 6-12 reagents, each with 0-5 sub-components. They're always viewed together on the assay detail page. They define a single recipe. Embedding means one query loads the complete formula. The old schema had `AssayType` + `ReagentDefinition` + `ReagentSubComponent` as three separate collections requiring multi-query joins.

**Current collections replaced:** `AssayType` + `ReagentDefinition` + `ReagentSubComponent` (3 → 1)

**v2 note:** No schema changes from v1 other than addition of `corrections[]`.

```typescript
interface IAssayDefinition {
  _id: string;
  assayId: string;                   // human-readable identifier
  name: string;
  description?: string;
  skuCode: string;                   // SKU for ordering/shipping

  // ══════════════════════════════════════════════════════
  // CURRENT CONFIGURATION
  // ══════════════════════════════════════════════════════

  duration?: number;                 // test duration in seconds
  bcode?: Buffer;                    // firmware binary payload
  bcodeLength?: number;
  checksum?: number;
  isActive: boolean;
  shelfLifeDays?: number;            // for expiration date calculation
  bomCostOverride?: string;          // override unit cost
  useSingleCost: boolean;

  // ══════════════════════════════════════════════════════
  // REAGENT FORMULA — the recipe
  // ══════════════════════════════════════════════════════

  // EMBEDDED (was: ReagentDefinition collection)
  reagents: {
    _id: string;
    wellPosition: number;            // which well on the cartridge
    reagentName: string;
    unitCost?: string;
    volumeMicroliters?: number;
    unit?: string;                   // default: µL
    classification?: string;         // 'raw', 'processed', etc.
    hasBreakdown: boolean;           // true if has sub-components
    sortOrder: number;
    isActive: boolean;

    // EMBEDDED (was: ReagentSubComponent collection)
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

  // ══════════════════════════════════════════════════════
  // VERSION HISTORY — append-only record of changes
  // ══════════════════════════════════════════════════════

  // EMBEDDED (was: AssayVersion collection)
  versionHistory: {
    version: number;
    previousName?: string;
    previousDescription?: string;
    previousBcode?: Buffer;
    previousBcodeLength?: number;
    previousChecksum?: number;
    previousDuration?: number;
    previousMetadata?: any;
    changedBy: {                     // DENORMALIZED at time of change
      _id: string;
      username: string;
    };
    changedAt: Date;
    changeNotes?: string;
  }[];

  // ══════════════════════════════════════════════════════
  // IMMUTABILITY CONTROLS
  // ══════════════════════════════════════════════════════

  lockedAt?: Date;                   // once locked, reagent formula cannot change
  lockedBy?: {                       // only new versions can be created after lock
    _id: string;
    username: string;
  };

  // ══════════════════════════════════════════════════════
  // CORRECTIONS — append-only, original data untouched
  // ══════════════════════════════════════════════════════

  corrections: {
    _id: string;
    fieldPath: string;
    previousValue: any;
    correctedValue: any;
    reason: string;
    correctedBy: {
      _id: string;
      username: string;
    };
    correctedAt: Date;
    approvedBy?: {
      _id: string;
      username: string;
    };
    approvedAt?: Date;
  }[];

  metadata?: any;
  createdAt: Date;
  updatedAt: Date;
}
```

**Indexes:**
```typescript
{ skuCode: 1 }                       // unique — lookup by SKU
{ isActive: 1 }                      // filter active assays
{ name: 1 }                          // search
```

---

## 1.4 Reagent Batch Record

**Collection name:** `reagent_batch_records`
**Web app section:** Manufacturing → Reagent Filling
**Routes:** `/spu/manufacturing/reagent-filling/*`, `/spu/manufacturing/qa-qc`

**What this is:** Complete traceability record for a reagent filling run. Which robot ran it, which operator, which reagent source lots went into which wells, every cartridge that was filled, inspection results, top seal application, and QC release. Bidirectional with cartridge DMR — the batch knows its cartridges, and each cartridge knows its batch.

**Why embed tube records, top seal, and cartridge list:** A reagent run has 6-12 tube records (always viewed on run detail), one top seal batch (1:1), and 8-96 cartridges (always viewed as part of the run). All are bounded and always accessed together.

**v2 change:** Assay reference is now `{ _id, name, skuCode }` — not a full assay snapshot. Jacob: "reagent batch doesn't need the whole assay definition, but it does need to know what assay it is going to make." Added `corrections[]`.

**Current collections replaced:** `ReagentFillingRun` + `ReagentTubeRecord` + `TopSealBatch` (3 → 1). Cartridge-level detail lives in the cartridge DMR; this collection stores the batch-level view.

```typescript
interface IReagentBatchRecord {
  _id: string;
  runNumber?: string;                // human-readable run identifier

  // ══════════════════════════════════════════════════════
  // RUN CONFIGURATION
  // ══════════════════════════════════════════════════════

  robot: {                           // DENORMALIZED
    _id: string;
    name: string;
    side?: string;
  };
  assayType: {                       // REFERENCE — which assay this batch is making
    _id: string;
    name: string;
    skuCode: string;
  };
  operator: {                        // DENORMALIZED
    _id: string;
    username: string;
  };
  deckId?: string;

  // ══════════════════════════════════════════════════════
  // TUBE PREPARATION — reagent source traceability
  // ══════════════════════════════════════════════════════

  // EMBEDDED (was: ReagentTubeRecord collection)
  tubeRecords: {
    wellPosition: number;
    reagentName: string;
    sourceLotId: string;             // which reagent lot this came from
    transferTubeId: string;          // which physical tube was loaded
    preparedAt?: Date;
  }[];

  // ══════════════════════════════════════════════════════
  // RUN TIMELINE
  // ══════════════════════════════════════════════════════

  setupTimestamp?: Date;
  runStartTime?: Date;
  runEndTime?: Date;
  status: 'setup' | 'running' | 'completed' | 'aborted' | 'voided';
  abortReason?: string;
  abortPhotoUrl?: string;

  // ══════════════════════════════════════════════════════
  // OUTPUT — cartridges filled in this batch
  // ══════════════════════════════════════════════════════

  cartridgesFilled: {
    cartridgeId: string;             // reference to cartridge_records._id
    deckPosition: number;
    inspectionStatus: 'Accepted' | 'Rejected' | 'Pending';
    inspectionReason?: string;
    inspectedBy?: {
      _id: string;
      username: string;
    };
    inspectedAt?: Date;
  }[];
  cartridgeCount: number;

  // ══════════════════════════════════════════════════════
  // TOP SEAL
  // ══════════════════════════════════════════════════════

  // EMBEDDED (was: TopSealBatch collection)
  topSeal?: {
    _id: string;
    topSealLotId: string;
    operator: {
      _id: string;
      username: string;
    };
    firstScanTime?: Date;
    completionTime?: Date;
    durationSeconds?: number;
    cartridgeCount: number;
    status: string;
  };

  // ══════════════════════════════════════════════════════
  // QC RELEASE
  // ══════════════════════════════════════════════════════

  qcRelease?: {
    qaqcCartridgeIds: string[];      // which cartridges were tested
    testResult: 'pass' | 'fail' | 'pending';
    testedBy?: {
      _id: string;
      username: string;
    };
    testedAt?: Date;
    notes?: string;
  };

  // ══════════════════════════════════════════════════════
  // IMMUTABILITY CONTROLS
  // ══════════════════════════════════════════════════════

  finalizedAt?: Date;
  voidedAt?: Date;
  voidReason?: string;

  // ══════════════════════════════════════════════════════
  // CORRECTIONS — append-only, original data untouched
  // ══════════════════════════════════════════════════════

  corrections: {
    _id: string;
    fieldPath: string;
    previousValue: any;
    correctedValue: any;
    reason: string;
    correctedBy: {
      _id: string;
      username: string;
    };
    correctedAt: Date;
    approvedBy?: {
      _id: string;
      username: string;
    };
    approvedAt?: Date;
  }[];

  createdAt: Date;
  updatedAt: Date;
}
```

**Indexes:**
```typescript
{ 'assayType._id': 1, status: 1 }
{ 'operator._id': 1 }
{ 'robot._id': 1 }
{ status: 1, createdAt: -1 }
{ 'cartridgesFilled.cartridgeId': 1 }  // find batch by cartridge
```

---

## 1.5 User Record

**Collection name:** `users`
**Web app section:** Admin → User Management, Authentication
**Routes:** `/login`, `/logout`, `/invite/*`, `/spu/admin/*`

**What this is:** The authoritative record of every person who interacts with the system. Users are sacred because they are the **WHO** behind every action in every other sacred document. Every operator snapshot in every cartridge, every SPU, every reagent batch points back to a user. For HIPAA compliance, you must be able to prove who had what permissions at what time, and that they were trained and qualified to perform the actions they performed.

**Why sacred (v2 promotion):** Jacob: "users are sacred documents." Users are never deleted, only deactivated. The user record must be immutable and auditable because:
- They're referenced by every other sacred document's operator fields
- HIPAA requires knowing who had what permissions at what time
- Training records prove a person was qualified to perform an action
- Role history provides a complete audit trail of permission changes

**Why embed roles, roleHistory, and training:** Permission checking runs on EVERY authenticated request. Role history is append-only and bounded (a user changes roles maybe 10-20 times over their career). Training records are bounded (one per document/procedure trained on). All are always needed together for compliance queries.

**Current collections replaced:** `User` + `UserRole` + `RolePermission` + `Permission` + `CommunicationPreference` (5 → 1)

```typescript
interface IUser {
  _id: string;
  username: string;
  passwordHash: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  isActive: boolean;                 // deactivated users have isActive: false
  lastLoginAt?: Date;
  invitedBy?: string;
  age?: number;

  // ══════════════════════════════════════════════════════
  // CURRENT ROLES — derived from roleHistory (revokedAt === null)
  // ══════════════════════════════════════════════════════

  // EMBEDDED (was: UserRole + RolePermission + Permission — 3 junction tables)
  roles: {
    roleId: string;
    roleName: string;                // DENORMALIZED — avoids join on every request
    assignedAt: Date;
    assignedBy?: string;
    permissions: string[];           // e.g., ["kanban:read", "kanban:write", "spu:read"]
  }[];

  // ══════════════════════════════════════════════════════
  // ROLE HISTORY — append-only audit trail of permission changes
  // ══════════════════════════════════════════════════════

  roleHistory: {
    _id: string;
    roleId: string;
    roleName: string;
    permissions: string[];           // permissions at time of grant
    grantedAt: Date;
    grantedBy: {
      _id: string;
      username: string;
    };
    revokedAt?: Date;                // null = currently active
    revokedBy?: {
      _id: string;
      username: string;
    };
    revokeReason?: string;
  }[];

  // ══════════════════════════════════════════════════════
  // TRAINING RECORDS — proves qualification for actions
  // ══════════════════════════════════════════════════════

  trainingRecords: {
    _id: string;
    documentId: string;              // which SOP/procedure
    documentTitle: string;           // DENORMALIZED
    documentRevision: string;        // which revision was trained on
    trainedAt: Date;
    trainerId?: {
      _id: string;
      username: string;
    };
    signatureId?: string;            // reference to electronic_signatures
    notes?: string;
  }[];

  // ══════════════════════════════════════════════════════
  // COMMUNICATION PREFERENCES
  // ══════════════════════════════════════════════════════

  // EMBEDDED (was: CommunicationPreference collection)
  communicationPreferences: {
    channel: string;
    frequency: 'real_time' | 'hourly_digest' | 'daily_digest' | 'urgent_only';
    formatPreference: 'detailed' | 'summary' | 'bullet_points';
    urgencyThreshold: string;
    domainInterests?: any;
    quietHoursStart?: string;
    quietHoursEnd?: string;
    isActive: boolean;
    isDefault: boolean;
  }[];

  // ══════════════════════════════════════════════════════
  // IMMUTABILITY CONTROLS
  // ══════════════════════════════════════════════════════

  deactivatedAt?: Date;              // users are never deleted, only deactivated
  deactivatedBy?: {
    _id: string;
    username: string;
  };
  deactivationReason?: string;

  // ══════════════════════════════════════════════════════
  // CORRECTIONS — append-only, original data untouched
  // ══════════════════════════════════════════════════════

  corrections: {
    _id: string;
    fieldPath: string;
    previousValue: any;
    correctedValue: any;
    reason: string;
    correctedBy: {
      _id: string;
      username: string;
    };
    correctedAt: Date;
    approvedBy?: {
      _id: string;
      username: string;
    };
    approvedAt?: Date;
  }[];

  createdAt: Date;
  updatedAt: Date;
}
```

**Indexes:**
```typescript
{ username: 1 }                      // unique — login lookup
{ email: 1 }                         // unique, sparse — email lookup
{ isActive: 1 }
{ 'roleHistory.roleId': 1 }         // find users who ever had a specific role
{ 'trainingRecords.documentId': 1 } // find who was trained on a specific document
```

**Denormalization update:** When a role's permissions change, batch-update all users with that role:
```typescript
await User.updateMany(
  { 'roles.roleId': roleId },
  { $set: { 'roles.$[r].permissions': newPermissions, 'roles.$[r].roleName': newName } },
  { arrayFilters: [{ 'r.roleId': roleId }] }
);
```

**Note on `roles` vs `roleHistory`:** The `roles` array is a **convenience projection** — current active roles derived from `roleHistory` entries where `revokedAt` is null. It exists for fast permission checks on every request. The `roleHistory` array is the **authoritative audit trail**. When a role is granted or revoked, write to `roleHistory` first, then update `roles`.

---

# TIER 2: OPERATIONAL SCAFFOLDING

**Every operational collection exists to serve one purpose: creating, populating, and managing the sacred documents.**

The sacred documents are the OUTPUT of this system. Everything else is tooling. Here's how each operational section feeds the sacred tier:

| Operational Collection | Feeds Sacred Document | What It Contributes |
|---|---|---|
| `lot_records` | Cartridge Record | Upstream lot grouping — provenance for cartridge backing |
| `sessions` | User Record | Authentication state |
| `roles` | User Record | Role catalog for assignment |
| `invite_tokens` | User Record | User onboarding |
| `work_instructions` | SPU Build Record | Assembly blueprint — which steps, which parts, which scans |
| `assembly_sessions` | SPU Build Record | Working doc during build → copied to SPU on completion |
| `batches` | SPU Build Record | Production batch grouping |
| `production_runs` | SPU Build Record | Multi-SPU production tracking |
| `validation_sessions` | SPU Build Record | Test results proving the SPU works |
| `part_definitions` | SPU Build Record + Cartridge Record | Part catalog — what gets installed |
| `bom_items` | SPU Build Record | Bill of materials — what's needed |
| `wax_filling_runs` | Cartridge Record | Wax phase operational data |
| `process_configurations` | Lot Record | Process templates for lot production |
| `manufacturing_settings` | Cartridge Record + Reagent Batch | Pipeline configuration |
| `consumables` | Cartridge Record + Reagent Batch | Resource consumption tracking |
| `equipment` | Cartridge Record | Which machines were used |
| `equipment_locations` | Cartridge Record | Where cartridges were stored |
| `opentrons_robots` | Cartridge Record + Reagent Batch | Which robot ran which protocol |
| `shipping_lots` | Cartridge Record | Release decisions |
| `shipping_packages` | Cartridge Record | Final shipping destination |
| `customers` | Cartridge Record + SPU Build Record | Who receives the product |
| `lab_cartridges` | (QC support) | Calibration/reference cartridges for testing |
| `firmware_devices` | SPU Build Record | Device identity for linked SPUs |
| `firmware_cartridges` | (QC support) | Firmware-side cartridge validation |
| `test_results` | SPU Build Record | Spectro/validation data |
| `kanban_tasks` | (Process improvement) | Task tracking to improve the pipeline |
| `documents` | (Governance) | SOPs and controlled docs governing all processes |
| `agent_*`, `approval_*` | (Operations support) | AI and approval tooling |

These collections are freely mutable and follow standard document-DB best practices: embed what you read together, reference what grows unbounded.

---

## Section A: Lot Records (Demoted from Sacred)

**Web app routes:** `/spu/manufacturing/lots/*`

---

### 2.1 Lot Records

**Collection name:** `lot_records`

**What this is:** Traceability record for a backing lot — a batch of cartridge bodies that went through backing/wax/QR coding together. Records input materials, process steps, operator actions, and output quantities. Each cartridge carries its lot ID as provenance.

**Why demoted from sacred (v2 change):** Jacob clarified: "lots are the group of parts, parts for either SPUs or cartridges." A lot is an upstream grouping — useful for querying ("show me all cartridges from lot L-042") but the CARTRIDGE DMR is the sacred record, not the lot. The lot is operational scaffolding that feeds data into the cartridge.

**Why embed step entries:** A lot has 5-20 process step entries recorded during production. They're always viewed on the lot detail page. Small, bounded, always accessed together.

**Current collections replaced:** `LotRecord` + `LotStepEntry` (2 → 1)

```typescript
interface ILotRecord {
  _id: string;
  qrCodeRef: string;                // unique QR code on the physical lot

  processConfig: {                   // DENORMALIZED
    _id: string;
    processName: string;
    processType: string;
  };
  operator: {                        // DENORMALIZED
    _id: string;
    username: string;
  };
  inputLots: any;                    // upstream lot references for traceability
  quantityProduced: number;
  desiredQuantity?: number;
  quantityDiscrepancyReason?: string;

  // EMBEDDED (was: LotStepEntry collection)
  stepEntries: {
    _id: string;
    stepId?: string;
    stepNumber?: number;
    stepTitle?: string;              // DENORMALIZED from process config
    note?: string;
    imageUrl?: string;
    operator: {
      _id: string;
      username: string;
    };
    completedAt: Date;
  }[];

  // Timeline
  startTime?: Date;
  finishTime?: Date;
  cycleTime?: number;
  ovenEntryTime?: Date;
  wiRevision?: string;
  status: string;

  // Output — which cartridges were created from this lot
  cartridgeIds?: string[];           // references to cartridge_records

  createdAt: Date;
  updatedAt: Date;
}
```

**Indexes:**
```typescript
{ qrCodeRef: 1 }                    // unique — scan lookup
{ 'processConfig._id': 1 }
{ status: 1 }
{ 'operator._id': 1 }
```

---

## Section B: Authentication Support

**Web app routes:** `/login`, `/logout`, `/invite/*`

**What this section does:** Session management, role catalog, and user invitations. The user record itself is now in Tier 1 (Sacred).

---

### 2.2 Sessions

**Collection name:** `sessions`
**Kept separate because:** Sessions are high-churn (created/destroyed on every login/logout) and TTL-indexed (auto-expire). Embedding in the sacred user document would cause constant writes to a sacred record.

```typescript
interface ISession {
  _id: string;
  userId: string;
  expiresAt: Date;
}
```

**Indexes:**
```typescript
{ userId: 1 }
{ expiresAt: 1 }                    // TTL index — auto-delete expired sessions
```

---

### 2.3 Roles

**Collection name:** `roles`
**Kept separate because:** Roles are a reference catalog. When creating a new user or editing role assignments, you need to list available roles. Small collection (< 20 roles), rarely changes.

```typescript
interface IRole {
  _id: string;
  name: string;
  description?: string;
  permissions: string[];             // EMBEDDED (was: RolePermission + Permission)
  createdAt: Date;
}
```

**Note:** When a role is updated, also batch-update all users who have that role (see denormalization update in User Record).

---

### 2.4 Invite Tokens

**Collection name:** `invite_tokens`
**Kept separate because:** Independent lifecycle — created, emailed, accepted/expired. Low volume.

```typescript
interface IInviteToken {
  _id: string;
  email: string;
  token: string;
  roleId?: string;
  invitedBy: string;
  status: 'pending' | 'accepted' | 'expired';
  expiresAt: Date;
  acceptedAt?: Date;
  createdUserId?: string;
  createdAt: Date;
}
```

---

## Section C: Task Management (Kanban Board)

**Web app routes:** `/kanban`, `/kanban/projects`, `/kanban/list`, `/kanban/task/[taskId]`, `/kanban/archived`

**What this section does:** Project-grouped task board with drag-and-drop status columns, task detail with comments and activity, project management, archived tasks view, list view with filters.

---

### 2.5 Kanban Projects

**Collection name:** `kanban_projects`
**Kept separate because:** Projects are queried independently (project list page, project selector dropdowns). Also serves as the source-of-truth for project names/colors that get denormalized into tasks.

```typescript
interface IKanbanProject {
  _id: string;
  name: string;
  description?: string;
  color: string;                     // hex color for board display
  sortOrder: number;
  isActive: boolean;
  createdAt: Date;
  createdBy?: string;
}
```

---

### 2.6 Kanban Tasks

**Collection name:** `kanban_tasks`
**Current collections replaced:** `KanbanTask` + `KanbanComment` + `KanbanTag` + `KanbanTaskTag` + `KanbanActionLog` + `KanbanBoardEvent` + `KanbanTaskProposal` (7 → 1)

**Why embed comments:** A task has 5-50 comments. They're only viewed on the task detail page. Never queried independently. Small, bounded.

**Why embed tags as strings:** Tags were a junction table pattern. In MongoDB, just store the tag names directly. No junction table, no extra query, no join.

**Why embed activity log:** Activity is only viewed on the task detail page. Bounded (10-100 entries per task). Never queried across tasks.

**Why denormalize project name/color:** The board page loads ALL tasks and groups by project. Every task render needs project name and color.

```typescript
interface IKanbanTask {
  _id: string;
  title: string;
  description?: string;
  status: 'backlog' | 'ready' | 'wip' | 'waiting' | 'done';
  priority: 'high' | 'medium' | 'low';
  taskLength: 'short' | 'medium' | 'long';
  sortOrder: number;

  // DENORMALIZED project info
  project: {
    _id: string;
    name: string;
    color: string;
  };

  // DENORMALIZED assignee info
  assignee?: {
    _id: string;
    username: string;
  };

  dueDate?: Date;

  // EMBEDDED (was: KanbanTaskTag junction table + KanbanTag collection)
  tags: string[];

  source: string;
  sourceRef?: string;

  // Status tracking timestamps
  statusChangedAt?: Date;
  backlogDate?: Date;
  readyDate?: Date;
  wipDate?: Date;
  waitingDate?: Date;
  completedDate?: Date;
  waitingReason?: string;
  waitingOn?: string;

  // EMBEDDED (was: KanbanComment collection)
  comments: {
    _id: string;
    content: string;
    createdAt: Date;
    createdBy: {
      _id: string;
      username: string;
    };
  }[];

  // EMBEDDED (was: KanbanActionLog collection)
  activityLog: {
    _id: string;
    action: string;
    details?: any;
    createdAt: Date;
    createdBy?: string;
  }[];

  // EMBEDDED (was: KanbanTaskProposal collection)
  proposals?: {
    _id: string;
    proposedBy?: string;
    proposalType: string;
    decision: 'pending' | 'approved' | 'edited' | 'vetoed';
    decidedBy?: string;
    editNotes?: string;
    vetoReason?: string;
    batchId?: string;
    createdAt: Date;
    decidedAt?: Date;
  }[];

  archived: boolean;
  archivedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
}
```

**Indexes:**
```typescript
{ 'project._id': 1, status: 1, archived: 1 }   // board view (most common query)
{ 'assignee._id': 1, status: 1 }                 // "my tasks" filter
{ tags: 1 }                                       // multikey — filter by tag
{ archived: 1, archivedAt: -1 }                  // archive view
{ status: 1, sortOrder: 1 }                      // list view
```

---

## Section D: Work Instructions & Documents

**Web app routes:** `/spu/documents/instructions/*`, `/documents/*`, `/spu/documents/repository/*`, `/spu/documents/build-logs/*`, `/spu/documents/box/*`, `/spu/documents/upload/*`

**What this section does:** Managed work instructions with versioned steps (each step has part requirements, tool requirements, field capture definitions), controlled documents with revision tracking and training records, file repository, Box.com integration.

---

### 2.7 Work Instructions

**Collection name:** `work_instructions`
**Current collections replaced:** `WorkInstructions` + `WorkInstruction` + `WorkInstructionVersion` + `WorkInstructionStep` + `StepPartRequirement` + `StepToolRequirement` + `StepFieldDefinition` (7 → 1)

**Why collapse everything into one document:** A work instruction is a self-contained document. You NEVER view a step without its parent version and WI. The entire tree is always loaded together. One query loads the complete work instruction.

**Size analysis:** A complex WI with 3 versions × 20 steps × 5 requirements each = ~300 embedded objects at ~200 bytes each ≈ 60KB. Well under the 16MB MongoDB limit.

**⚠️ Image warning:** If `imageData` (base64 step images) exceeds 500KB per image, store images externally (GridFS or S3) and reference by URL instead.

```typescript
interface IWorkInstruction {
  _id: string;
  documentNumber: string;
  title: string;
  description?: string;
  documentType: string;
  status: 'draft' | 'active' | 'retired';
  currentVersion: number;
  originalFileName?: string;
  fileSize?: number;
  mimeType?: string;

  // Legacy WI fields
  revision?: string;
  category?: string;
  effectiveDate?: Date;
  fileId?: string;
  preparedBy?: string;
  preparedAt?: Date;
  reviewedBy?: string;
  reviewedAt?: Date;
  approvedBy?: string;
  approvedAt?: Date;

  // EMBEDDED (was: WorkInstructionVersion collection)
  versions: {
    _id: string;
    version: number;
    content?: string;
    rawContent?: string;
    changeNotes?: string;
    parsedAt?: Date;
    parsedBy?: string;
    createdAt: Date;

    // EMBEDDED (was: WorkInstructionStep collection)
    steps: {
      _id: string;
      stepNumber: number;
      title?: string;
      content?: string;
      imageData?: string;            // ⚠️ Consider external storage if large
      imageContentType?: string;
      requiresScan: boolean;
      scanPrompt?: string;
      notes?: string;
      partDefinitionId?: string;
      partQuantity: number;

      // EMBEDDED (was: StepPartRequirement collection)
      partRequirements: {
        _id: string;
        partNumber: string;
        partDefinitionId?: string;
        quantity: number;
        notes?: string;
      }[];

      // EMBEDDED (was: StepToolRequirement collection)
      toolRequirements: {
        _id: string;
        toolNumber: string;
        toolName?: string;
        calibrationRequired: boolean;
        notes?: string;
      }[];

      // EMBEDDED (was: StepFieldDefinition collection)
      fieldDefinitions: {
        _id: string;
        fieldName: string;
        fieldLabel: string;
        fieldType: 'barcode_scan' | 'manual_entry' | 'date_picker' | 'dropdown';
        isRequired: boolean;
        validationPattern?: string;
        options?: any;
        barcodeFieldMapping?: string;
        sortOrder: number;
      }[];
    }[];
  }[];

  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
}
```

---

### 2.8 Controlled Documents

**Collection name:** `documents`
**Current collections replaced:** `Document` + `DocumentRevision` + `DocumentTraining` (3 → 1)

**Why embed revisions and training:** A document has < 20 revisions. Each revision has < 20 training records. Always viewed together. Bounded and small.

```typescript
interface IDocument {
  _id: string;
  documentNumber: string;
  title: string;
  category?: string;
  currentRevision: string;
  status: 'draft' | 'in_review' | 'approved' | 'retired';
  effectiveDate?: Date;
  retiredDate?: Date;
  ownerId?: string;

  // EMBEDDED (was: DocumentRevision collection)
  revisions: {
    _id: string;
    revision: string;
    content?: string;
    changeDescription?: string;
    status: 'draft' | 'in_review' | 'approved';
    createdAt: Date;
    createdBy?: string;
    approvedAt?: Date;
    approvedBy?: string;
    approvalSignatureId?: string;

    // EMBEDDED (was: DocumentTraining collection)
    trainingRecords: {
      _id: string;
      userId: string;
      username: string;              // DENORMALIZED
      trainedAt: Date;
      trainerId?: string;
      signatureId?: string;
      notes?: string;
    }[];
  }[];

  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
}
```

---

### 2.9 Files

**Collection name:** `files`
**Kept separate because:** Files are referenced from many different entities. Needs independent querying for file browsers, search, cleanup jobs.

```typescript
interface IFiles {
  _id: string;
  projectId?: string;
  datasetId?: string;
  filename: string;
  storagePath: string;
  mimeType: string;
  fileSize?: number;
  checksum?: string;
  fileType?: 'raw_data' | 'image' | 'document' | 'spreadsheet' | 'other';
  description?: string;
  tags?: string[];
  metadata?: any;
  version: number;
  isLatest?: boolean;
  previousVersionId?: string;
  uploadedAt: Date;
  uploadedBy?: string;
  deletedAt?: Date;
}
```

---

### 2.10 Document Repository

**Collection name:** `document_repository`
**Kept separate because:** Independent upload/search lifecycle. Different from controlled documents.

```typescript
interface IDocumentRepository {
  _id: string;
  fileName: string;
  originalFileName: string;
  fileSize?: number;
  mimeType?: string;
  category?: string;
  tags?: string[];
  content?: string;                  // extracted text content for search
  description?: string;
  uploadedAt: Date;
  uploadedBy?: string;
}
```

---

## Section E: Assembly & Production

**Web app routes:** `/spu/assembly/*`, `/spu/documents/instructions/[id]/run/*`, `/spu/batches/*`

**What this section does:** Guided assembly sessions where operators follow work instruction steps, scan barcodes, capture field data, and record electronic signatures. Production runs track batched assembly of multiple SPUs.

---

### 2.11 Assembly Sessions

**Collection name:** `assembly_sessions`
**Current collections replaced:** `AssemblySession` + `AssemblyStepRecord` + `StepFieldRecord` (3 → 1)

**Role in v2:** Assembly sessions serve as the **working document** during the SPU build process. The operator's UI makes frequent updates (advance step, capture field, scan barcode). On completion, the full session data is **copied into the SPU sacred document**. The assembly session is retained as a backup/audit trail, but the SPU is the golden record.

**Why kept separate from SPU during build:** Embedding inside the SPU would mean every field capture update rewrites the entire SPU document. Separate collection isolates the high-frequency writes to the working document.

**Why embed step records and field records inside the session:** The assembly UI loads the session and all its step data in one go. A session has ~20 steps × ~5 fields = ~100 embedded records. Small, bounded, always accessed together.

```typescript
interface IAssemblySession {
  _id: string;
  spuId: string;                     // reference to spus._id
  userId: string;
  status: 'in_progress' | 'paused' | 'completed';
  currentStepIndex: number;
  startedAt: Date;
  pausedAt?: Date;
  completedAt?: Date;
  workstationId?: string;
  notes?: string;

  // Work instruction reference
  workInstructionId: string;
  workInstructionVersion: number;
  workInstructionTitle: string;      // DENORMALIZED

  // EMBEDDED (was: AssemblyStepRecord collection)
  stepRecords: {
    _id: string;
    stepNumber: number;
    stepTitle?: string;
    workInstructionStepId: string;
    scannedLotNumber?: string;
    scannedPartNumber?: string;
    completedAt?: Date;
    completedBy?: {
      _id: string;
      username: string;
    };
    signatureId?: string;
    notes?: string;

    // EMBEDDED (was: StepFieldRecord collection)
    fieldRecords: {
      _id: string;
      stepFieldDefinitionId: string;
      fieldName: string;
      fieldLabel?: string;
      fieldValue: string;
      rawBarcodeData?: string;
      bomItemId?: string;
      scannedAt?: Date;
      enteredAt?: Date;
      capturedBy?: string;
    }[];
  }[];

  createdAt: Date;
}
```

---

### 2.12 Batches

**Collection name:** `batches`
**Kept separate because:** Batches are queried independently (batch list page, batch selector dropdowns). Referenced from multiple SPUs.

```typescript
interface IBatch {
  _id: string;
  batchNumber: string;
  description?: string;
  targetQuantity?: number;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  createdBy?: string;
}
```

---

### 2.13 Production Runs

**Collection name:** `production_runs`
**Current collections replaced:** `ProductionRun` + `ProductionRunUnit` (2 → 1)

**Why embed units:** A production run has a fixed number of units. Each unit is a simple status tracker pointing to an SPU. Typically < 50 units. Always viewed on the run detail page.

```typescript
interface IProductionRun {
  _id: string;
  workInstructionId: string;
  workInstructionVersionId: string;
  quantity: number;
  status: 'planning' | 'in_progress' | 'paused' | 'completed';
  leadBuilder: {
    _id: string;
    username: string;
  };
  runNumber: string;
  startedAt?: Date;
  pausedAt?: Date;
  completedAt?: Date;

  // EMBEDDED (was: ProductionRunUnit collection)
  units: {
    _id: string;
    spuId: string;
    assemblySessionId?: string;
    unitIndex: number;
    status: 'pending' | 'in_progress' | 'completed';
    startedAt?: Date;
    completedAt?: Date;
  }[];

  createdAt: Date;
  updatedAt: Date;
}
```

---

### 2.14 Generated Barcodes

**Collection name:** `generated_barcodes`
**Kept separate because:** Atomic sequence counter. Needs `findOneAndUpdate` with `$inc` for unique barcode generation. Cannot be embedded.

```typescript
interface IGeneratedBarcode {
  _id: string;
  prefix: string;
  sequence: number;
  barcode: string;
  type: string;
  createdAt: Date;
}
```

---

### 2.15 Validation Sessions

**Collection name:** `validation_sessions`
**Current collections replaced:** `ValidationSession` + `ValidationResult` (2 → 1)

**Why embed results:** A validation session has < 20 results. Always viewed together. Bounded.

```typescript
interface IValidationSession {
  _id: string;
  type: string;                      // 'magnetometer', 'spectrophotometer', 'thermocouple'
  spuId?: string;
  generatedBarcodeId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  startedAt?: Date;
  completedAt?: Date;
  userId: string;

  // EMBEDDED (was: ValidationResult collection)
  results: {
    _id: string;
    testType: string;
    rawData?: any;
    processedData?: any;
    passed?: boolean;
    notes?: string;
    createdAt: Date;
  }[];

  createdAt: Date;
}
```

---

## Section F: Manufacturing Pipeline

**Web app routes:** `/spu/manufacturing/*`

**What this section does:** The cartridge manufacturing pipeline — laser cutting sheets, backing lots, wax filling runs, reagent filling runs, top seal application, QC inspection, and process configuration.

---

### 2.16 Wax Filling Runs

**Collection name:** `wax_filling_runs`
**Kept separate from cartridge records because:** A wax run is an operational event. The cartridge records contain the per-cartridge outcome. The run is the "what happened" view; the cartridge DMR is the "what is this cartridge" view.

```typescript
interface IWaxFillingRun {
  _id: string;
  robot: {
    _id: string;
    name: string;
  };
  deckId?: string;
  waxSourceLot?: string;
  waxTubeId?: string;
  waxTubeTimestamp?: Date;
  setupTimestamp?: Date;
  runStartTime?: Date;
  runEndTime?: Date;
  deckRemovedTime?: Date;
  coolingConfirmedTime?: Date;
  coolingTrayId?: string;
  ovenLocationId?: string;
  coolingLocationId?: string;
  status: string;
  operator: {
    _id: string;
    username: string;
  };
  abortReason?: string;
  plannedCartridgeCount?: number;

  // Cartridge IDs produced in this run
  cartridgeIds: string[];

  createdAt: Date;
  updatedAt: Date;
}
```

---

### 2.17 Process Configurations

**Collection name:** `process_configurations`
**Current collections replaced:** `ProcessConfiguration` + `ProcessStep` (2 → 1)

**Why embed steps:** A process config has 5-20 steps. Always viewed together. Defines a template.

```typescript
interface IProcessConfiguration {
  _id: string;
  processName: string;
  processType: string;
  inputMaterials: any;
  outputMaterial: any;
  maxBatchSize: number;
  handoffPrompt: string;
  downstreamQueue?: string;
  workInstructionId?: string;

  // EMBEDDED (was: ProcessStep collection)
  steps: {
    _id: string;
    stepNumber: number;
    title: string;
    description?: string;
    imageUrl?: string;
  }[];

  createdAt: Date;
  updatedAt: Date;
}
```

---

### 2.18 Manufacturing Settings

**Collection name:** `manufacturing_settings`
**Current collections replaced:** `WaxFillingSettings` + `ReagentFillingSettings` + `ManufacturingSettings` + `RejectionReasonCode` (4 → 1)

**Why merge:** Four separate singleton documents. One document with sections is cleaner and loads in one query.

```typescript
interface IManufacturingSettings {
  _id: string;                       // always 'default'

  waxFilling: {
    minOvenTimeMin: number;
    runDurationMin: number;
    removeDeckWarningMin: number;
    coolingWarningMin: number;
    deckLockoutMin: number;
    incubatorTempC: number;
    heaterTempC: number;
    waxPerDeckUl: number;
    tubeCapacityUl: number;
    waxPerCartridgeUl: number;
    cartridgesPerColumn: number;
  };

  reagentFilling: {
    fillTimePerCartridgeMin: number;
    minCoolingTimeMin: number;
  };

  general: {
    topSealLengthPerCutFt: number;
    defaultRollLengthFt: number;
    cartridgesPerLaserCutSheet: number;
    sheetsPerLaserBatch: number;
    defaultLaserTools?: string;
    defaultCuttingProgramLink?: string;
  };

  // EMBEDDED (was: RejectionReasonCode collection)
  rejectionReasonCodes: {
    code: string;
    label: string;
    processType: string;
    sortOrder: number;
  }[];

  updatedAt: Date;
}
```

---

### 2.19 Laser Cut Batches

**Collection name:** `laser_cut_batches`
**Kept separate because:** Independent tracking — each batch is a self-contained record of a laser cutting session.

```typescript
interface ILaserCutBatch {
  _id: string;
  inputSheetCount: number;
  outputSheetCount: number;
  failureCount: number;
  failureNotes?: string;
  cuttingProgramLink?: string;
  referencePhotos?: any;
  toolsUsed?: string;
  operatorId: string;
  createdAt: Date;
  updatedAt: Date;
}
```

---

### 2.20 Manufacturing Materials

**Collection name:** `manufacturing_materials`

**Why embed recent transactions:** The material detail page shows current quantity plus recent activity. Embedding the last ~100 transactions avoids a join. Older transactions live in the immutable `manufacturing_material_transactions` log.

```typescript
interface IManufacturingMaterial {
  _id: string;
  name: string;
  unit: string;
  currentQuantity: number;

  // Recent transactions — last 100, for display on detail page
  recentTransactions: {
    _id: string;
    transactionType: string;
    quantityChanged: number;
    quantityBefore: number;
    quantityAfter: number;
    relatedBatchId?: string;
    operatorId: string;
    notes?: string;
    createdAt: Date;
  }[];

  updatedAt: Date;
}
```

---

## Section G: Equipment & Resources

**Web app routes:** `/spu/equipment/*`, `/opentrons/*`

---

### 2.21 Equipment

**Collection name:** `equipment`
**Kept separate because:** Equipment is queried independently (equipment dashboard, temperature monitoring page). Referenced from many places.

```typescript
interface IEquipment {
  _id: string;
  name: string;
  equipmentType: 'fridge' | 'oven';
  location?: string;
  status: 'active' | 'maintenance' | 'offline';
  mocreoDeviceId?: string;
  mocreoAssetId?: string;
  temperatureMinC?: number;
  temperatureMaxC?: number;
  currentTemperatureC?: number;
  lastTemperatureReadAt?: Date;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

---

### 2.22 Equipment Locations

**Collection name:** `equipment_locations`
**Current collections replaced:** `EquipmentLocation` + `LocationPlacement` (active placements embedded)

**Why embed current placements:** The location detail page shows "what's in this fridge right now." That's always < 20 items. One query shows the location + its contents.

```typescript
interface IEquipmentLocation {
  _id: string;
  barcode: string;
  locationType: 'fridge' | 'oven';
  displayName: string;
  isActive: boolean;
  capacity?: number;
  notes?: string;

  // EMBEDDED — only CURRENT placements (not removed)
  currentPlacements: {
    _id: string;
    itemType: string;
    itemId: string;
    placedBy: string;
    placedAt: Date;
    runId?: string;
    notes?: string;
  }[];

  createdAt: Date;
  updatedAt: Date;
}
```

---

### 2.23 Opentrons Robots

**Collection name:** `opentrons_robots`
**Current collections replaced:** `OpentronsRobot` + `OpentronsProtocolRecord` + `OpentronsHealthSnapshot` (3 → 1)

**Why embed protocols:** A robot has 5-50 protocols. Always viewed on the robot detail page. Bounded.

**Why embed recent health snapshots:** Keep the last 10-20 health checks embedded for quick display.

```typescript
interface IOpentronsRobot {
  _id: string;
  name: string;
  ip: string;
  port: number;
  robotSide?: string;
  legacyRobotId?: string;
  isActive: boolean;
  firmwareVersion?: string;
  apiVersion?: string;
  robotModel?: string;
  robotSerial?: string;
  lastHealthAt?: Date;
  lastHealthOk?: boolean;
  source: string;

  // EMBEDDED (was: OpentronsProtocolRecord collection)
  protocols: {
    _id: string;
    opentronsProtocolId: string;
    protocolName: string;
    protocolType?: string;
    fileHash?: string;
    parametersSchema?: any;
    analysisStatus?: string;
    analysisData?: any;
    labwareDefinitions?: any;
    pipettesRequired?: any;
    uploadedBy?: string;
    createdAt: Date;
    updatedAt: Date;
  }[];

  // EMBEDDED — last 20 health checks (was: OpentronsHealthSnapshot collection)
  recentHealthSnapshots: {
    firmwareVersion?: string;
    apiVersion?: string;
    systemVersion?: string;
    leftPipette?: any;
    rightPipette?: any;
    modules?: any;
    isHealthy: boolean;
    responseTimeMs?: number;
    errorMessage?: string;
    createdAt: Date;
  }[];

  createdAt: Date;
  updatedAt: Date;
}
```

---

### 2.24 Consumables

**Collection name:** `consumables`
**Current collections replaced:** `IncubatorTube` + `IncubatorTubeUsage` + `TopSealRoll` + `TopSealCutRecord` + `DeckRecord` + `CoolingTrayRecord` (6 → 1)

**Why unify:** All follow the same pattern — a physical resource with a current state and a bounded usage history. One collection with a `type` discriminator is cleaner than 6 nearly-identical collections.

```typescript
interface IConsumable {
  _id: string;
  type: 'incubator_tube' | 'top_seal_roll' | 'deck' | 'cooling_tray';
  status: string;

  // === Type-specific fields ===

  // Incubator tube
  initialVolumeUl?: number;
  remainingVolumeUl?: number;
  totalCartridgesFilled?: number;
  totalRunsUsed?: number;
  firstUsedAt?: Date;
  lastUsedAt?: Date;
  registeredBy?: string;

  // Top seal roll
  barcode?: string;
  initialLengthFt?: number;
  remainingLengthFt?: number;

  // Deck
  currentRobotId?: string;
  lockoutUntil?: Date;
  lastUsed?: Date;

  // Cooling tray
  currentCartridges?: any;
  assignedRunId?: string;

  // EMBEDDED — usage log (bounded: tubes ~50 uses, rolls ~40 cuts)
  usageLog: {
    _id: string;
    usageType: string;
    runId?: string;
    quantityChanged?: number;
    volumeChangedUl?: number;
    remainingBefore?: number;
    remainingAfter?: number;
    operator: {
      _id: string;
      username: string;
    };
    notes?: string;
    createdAt: Date;
  }[];

  createdAt: Date;
  updatedAt: Date;
}
```

---

## Section H: BOM & Inventory

**Web app routes:** `/spu/bom/*`, `/spu/parts/*`, `/spu/inventory/*`

---

### 2.25 BOM Items

**Collection name:** `bom_items`
**Current collections replaced:** `BomItem` + `CartridgeBomItem` + `BomItemVersion` + `BomPartLink` (4 → 1)

**Why merge BomItem and CartridgeBomItem:** Nearly identical schemas. Use a `bomType` discriminator.

```typescript
interface IBomItem {
  _id: string;
  bomType: 'spu' | 'cartridge';
  partNumber: string;
  name: string;
  description?: string;
  category?: string;
  quantityPerUnit: number;
  unitOfMeasure?: string;
  supplier?: string;
  manufacturer?: string;
  vendorPartNumber?: string;
  unitCost?: string;
  leadTimeDays?: number;
  minimumOrderQty?: number;
  certifications?: any;
  expirationDate?: Date;
  msdsFileId?: string;
  hazardClass?: string;
  inventoryCount?: number;
  minimumStockLevel: number;
  isActive: boolean;
  boxRowIndex?: number;

  // EMBEDDED (was: BomItemVersion collection)
  versionHistory: {
    version: number;
    changeType: 'create' | 'update' | 'delete';
    previousValues?: any;
    newValues?: any;
    changedBy?: string;
    changedAt: Date;
    changeReason?: string;
  }[];

  // EMBEDDED (was: BomPartLink collection)
  partLinks: {
    _id: string;
    partDefinitionId: string;
    partNumber: string;              // DENORMALIZED
    linkType: string;
    notes?: string;
    createdBy?: string;
    createdAt: Date;
  }[];

  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
}
```

---

### 2.26 Part Definitions

**Collection name:** `part_definitions`
**Kept separate because:** Referenced from many places — SPU parts, work instruction steps, BOM links, inventory transactions. Needs independent querying.

```typescript
interface IPartDefinition {
  _id: string;
  partNumber: string;
  name: string;
  description?: string;
  category?: string;
  supplier?: string;
  manufacturer?: string;
  vendorPartNumber?: string;
  unitCost?: string;
  unitOfMeasure?: string;
  leadTimeDays?: number;
  minimumOrderQty?: number;
  hazardClass?: string;
  certifications?: any;
  expirationDate?: Date;
  msdsFileId?: string;
  inspectionPathway: string;
  scanRequired: boolean;
  sortOrder: number;
  isActive: boolean;
  sampleSize: number;
  percentAccepted: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
}
```

---

### 2.27 BOM Column Mapping

**Collection name:** `bom_column_mapping`
**Kept separate because:** Configuration singleton for Box import mapping.

```typescript
interface IBomColumnMapping {
  _id: string;
  columnMappings: any;
  headerRow: number;
  sheetName?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

---

## Section I: Cartridge Lab Management & Firmware

**Web app routes:** `/spu/cartridges/*`, `/spu/cartridge-dashboard`, `/spu/assays/[assayId]/assign`, `/spu/devices/*`, `/spu/test-results/*`

---

### 2.28 Cartridge Groups

**Collection name:** `cartridge_groups`
**Kept separate because:** Small reference table for organizing lab cartridges.

```typescript
interface ICartridgeGroup {
  _id: string;
  name: string;
  description?: string;
  color?: string;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

---

### 2.29 Lab Cartridges

**Collection name:** `lab_cartridges`
**Current collections replaced:** `Cartridge` + `CartridgeUsageLog` (2 → 1)

**Note:** This is SEPARATE from the manufacturing `cartridge_records`. Lab cartridges are calibration/reference cartridges used for testing.

```typescript
interface ILabCartridge {
  _id: string;
  barcode: string;
  serialNumber?: string;
  lotNumber: string;
  cartridgeType: 'measurement' | 'calibration' | 'reference' | 'test';
  status: 'available' | 'in_use' | 'depleted' | 'expired' | 'quarantine' | 'disposed';
  groupId?: string;
  partDefinitionId?: string;
  manufacturer?: string;
  expirationDate?: Date;
  receivedDate?: Date;
  openedDate?: Date;
  usesRemaining?: number;
  totalUses?: number;
  storageLocation?: string;
  storageConditions?: string;
  notes?: string;
  isActive: boolean;

  // EMBEDDED (was: CartridgeUsageLog collection)
  usageLog: {
    _id: string;
    action: 'registered' | 'scanned' | 'used' | 'returned' | 'quarantined' |
            'disposed' | 'status_changed' | 'group_changed' | 'exported' | 'deleted';
    previousValue?: string;
    newValue?: string;
    spuId?: string;
    validationSessionId?: string;
    notes?: string;
    performedBy: {
      _id: string;
      username: string;
    };
    performedAt: Date;
  }[];

  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
}
```

---

### 2.30 Firmware Devices

**Collection name:** `firmware_devices`
**Kept separate because:** External system mirror — represents physical SPU devices that report via firmware API.

```typescript
interface IFirmwareDevice {
  _id: string;
  deviceId: string;
  apiKey?: string;
  firmwareVersion?: string;
  dataFormatVersion?: string;
  lastSeen?: Date;
  metadata?: any;
  createdAt: Date;
  updatedAt: Date;
}
```

---

### 2.31 Firmware Cartridges

**Collection name:** `firmware_cartridges`
**Kept separate because:** External system mirror — represents cartridges as seen by the firmware/device system.

```typescript
interface IFirmwareCartridge {
  _id: string;
  cartridgeUuid: string;
  assayId?: string;
  status: string;
  lotNumber?: string;
  expirationDate?: Date;
  serialNumber?: string;
  siteId?: string;
  program?: string;
  experiment?: string;
  arm?: string;
  quantity?: number;
  validationErrors?: any;
  statusUpdatedAt?: Date;
  validationCount?: number;
  lastValidatedAt?: Date;
  lastValidatedBy?: string;
  testResultId?: string;
  metadata?: any;
  createdAt: Date;
  updatedAt: Date;
}
```

---

### 2.32 Test Results

**Collection name:** `test_results`
**Current collections replaced:** `TestResult` + `SpectroReading` (2 → 1, pending size check)

**Why embed readings:** Spectro readings are ONLY viewed on the test result detail page. Never queried independently. **⚠️ However:** If tests commonly have > 500 readings, each reading ~100 bytes, a single test result could reach 50KB+. Need to verify actual reading counts. If > 1000 per test, keep `SpectroReading` as a separate collection.

```typescript
interface ITestResult {
  _id: string;
  dataFormatCode?: string;
  cartridgeUuid?: string;
  assayId?: string;
  deviceId?: string;
  startTime?: number;
  duration?: number;
  astep?: number;
  atime?: number;
  again?: number;
  numberOfReadings?: number;
  baselineScans?: number;
  testScans?: number;
  checksum?: number;
  rawRecord?: Buffer;
  status: 'uploaded' | 'processing' | 'completed' | 'failed';
  metadata?: any;

  // EMBEDDED (was: SpectroReading collection) — ⚠️ see size warning above
  readings: {
    readingNumber: number;
    channel: 'A' | 'B' | 'C';
    position?: number;
    temperature?: number;
    laserOutput?: number;
    timestampMs?: number;
    f1?: number;
    f2?: number;
    f3?: number;
    f4?: number;
    f5?: number;
    f6?: number;
    f7?: number;
    f8?: number;
    clearChannel?: number;
    nirChannel?: number;
  }[];

  createdAt: Date;
  processedAt?: Date;
}
```

---

## Section J: Shipping & Fulfillment

**Web app routes:** `/spu/shipping`

---

### 2.33 Shipping Lots

**Collection name:** `shipping_lots`
**Current collections replaced:** `ShippingLot` + `QaqcRelease` (2 → 1)

**Why embed QA/QC releases:** A shipping lot has 1-5 QC releases. Always viewed on the lot detail page. Small, bounded.

```typescript
interface IShippingLot {
  _id: string;
  assayType: {                       // DENORMALIZED
    _id: string;
    name: string;
  };
  customer?: {                       // DENORMALIZED
    _id: string;
    name: string;
  };
  status: 'open' | 'testing' | 'released' | 'shipped' | 'cancelled';
  cartridgeCount?: number;
  releasedAt?: Date;
  releasedBy?: string;
  notes?: string;

  // EMBEDDED (was: QaqcRelease collection)
  qaqcReleases: {
    _id: string;
    reagentRunId: string;
    qaqcCartridgeIds: string[];
    testResult: 'pass' | 'fail' | 'pending';
    testedBy?: {
      _id: string;
      username: string;
    };
    testedAt?: Date;
    notes?: string;
    createdAt: Date;
  }[];

  createdAt: Date;
  updatedAt: Date;
}
```

---

### 2.34 Shipping Packages

**Collection name:** `shipping_packages`
**Current collections replaced:** `ShippingPackage` + `PackageCartridge` (2 → 1)

**Why embed cartridge list:** A package contains < 100 cartridges. The junction table `PackageCartridge` was unnecessary.

**v2 change:** Customer is now a full SNAPSHOT, not just `{ _id, name }`. If the customer moves next year, the shipping record shows where it was actually shipped.

```typescript
interface IShippingPackage {
  _id: string;
  barcode: string;
  customer: {                        // SNAPSHOT — full customer at time of shipment
    _id: string;
    name: string;
    customerType: string;
    contactName?: string;
    contactEmail?: string;
    contactPhone?: string;
    address?: string;
  };
  trackingNumber?: string;
  carrier?: string;
  status: 'created' | 'packing' | 'packed' | 'shipped' | 'delivered';
  notes?: string;
  packedBy?: string;
  packedAt?: Date;
  shippedAt?: Date;
  deliveredAt?: Date;

  // EMBEDDED (was: PackageCartridge junction table)
  cartridges: {
    cartridgeId: string;
    addedAt: Date;
  }[];

  createdAt: Date;
  updatedAt: Date;
}
```

---

## Section K: Customer Management

**Web app routes:** `/spu/customers/*`

---

### 2.35 Customers

**Collection name:** `customers`
**Current collections replaced:** `Customer` + `CustomerNote` (2 → 1)

**Why embed notes:** A customer has < 100 notes. Always viewed on the customer detail page. Small, bounded.

```typescript
interface ICustomer {
  _id: string;
  name: string;
  customerType: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  status: 'active' | 'inactive';
  customFields?: any;

  // EMBEDDED (was: CustomerNote collection)
  notes: {
    _id: string;
    noteText: string;
    createdBy: {
      _id: string;
      username: string;
    };
    createdAt: Date;
  }[];

  createdAt: Date;
  updatedAt: Date;
}
```

---

## Section L: Agent / AI Operations

**Web app routes:** `/api/agent/*`, `/admin/agent-activity`

---

### 2.36 Agent Queries

**Collection name:** `agent_queries`
**Kept separate because:** Queried by name at runtime. Independent lifecycle.

```typescript
interface IAgentQuery {
  _id: string;
  name: string;
  description: string;
  category: 'inventory' | 'manufacturing' | 'quality' | 'projects' |
            'customer' | 'audit' | 'reporting';
  sqlTemplate: string;
  parametersSchema?: any;
  resultFormat?: any;
  isActive: boolean;
  maxRows: number;
  timeoutMs: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
}
```

---

### 2.37 Schema Metadata

**Collection name:** `schema_metadata`
**Kept separate because:** Reference catalog for agent to understand the database schema.

```typescript
interface ISchemaMetadata {
  _id: string;
  tableName: string;
  businessName: string;
  businessPurpose: string;
  businessDomain: string;
  keyRelationships?: any;
  commonQueries?: any;
  businessConcepts?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

---

### 2.38 Agent Messages

**Collection name:** `agent_messages`
**Kept separate because:** Unbounded — grows with every message sent.

```typescript
interface IAgentMessage {
  _id: string;
  fromUserId?: string;
  toUserId: string;
  messageType: 'info' | 'alert' | 'request' | 'approval' | 'status_update' | 'meeting_summary';
  subject: string;
  content: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'actioned' | 'failed';
  relatedEntityType?: string;
  relatedEntityId?: string;
  routingReason?: string;
  audienceTier?: string;
  failureReason?: string;
  retryCount: number;
  sentAt?: Date;
  deliveredAt?: Date;
  readAt?: Date;
  actionedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
```

---

### 2.39 Routing Patterns

**Collection name:** `routing_patterns`
**Kept separate because:** Independent ML/pattern-matching data.

```typescript
interface IRoutingPattern {
  _id: string;
  contentType: string;
  keywords?: any;
  stakeholderRoles?: any;
  routingRules?: any;
  confidenceScore: number;
  successRate: number;
  usageCount: number;
  lastUsed?: Date;
  createdAt: Date;
  updatedAt: Date;
}
```

---

## Section M: Admin & Approvals

**Web app routes:** `/admin/*`, `/api/agent/approval/*`

---

### 2.40 Approval Requests

**Collection name:** `approval_requests`
**Current collections replaced:** `ApprovalRequest` + `ApprovalHistory` (2 → 1)

**Why embed history:** An approval request has < 10 history entries. Always viewed together. Small.

```typescript
interface IApprovalRequest {
  _id: string;
  requesterId: string;
  changeTitle: string;
  changeDescription: string;
  changeType: 'code' | 'configuration' | 'infrastructure' | 'process' | 'documentation' | 'database';
  priority: 'low' | 'normal' | 'high' | 'urgent' | 'emergency';
  affectedSystems?: any;
  impactAnalysis?: any;
  status: 'pending' | 'in_review' | 'approved' | 'rejected' | 'cancelled' | 'expired';
  dueDate?: Date;
  approvedAt?: Date;
  approvedBy?: string;

  // EMBEDDED (was: ApprovalHistory collection)
  history: {
    _id: string;
    stakeholderId: string;
    action: 'requested' | 'reviewed' | 'approved' | 'rejected' | 'escalated' | 'cancelled' | 'commented';
    comments?: string;
    decisionRationale?: string;
    timestamp: Date;
    ipAddress?: string;
  }[];

  createdAt: Date;
  updatedAt: Date;
}
```

---

### 2.41 System Dependencies

**Collection name:** `system_dependencies`
**Kept separate because:** Reference map of system architecture for impact analysis.

```typescript
interface ISystemDependency {
  _id: string;
  systemName: string;
  ownerId?: string;
  backupOwnerId?: string;
  systemType: 'application' | 'service' | 'database' | 'infrastructure' | 'process' | 'integration';
  dependencies?: string[];
  dependents?: string[];
  changeSensitivity: 'low' | 'medium' | 'high';
  impactScope: 'local' | 'team' | 'organization';
  lastUpdated: Date;
  createdAt: Date;
}
```

---

## Section N: Integrations

**Web app routes:** `/api/box/*`, `/spu/particle/*`

---

### 2.42 Integrations

**Collection name:** `integrations`
**Current collections replaced:** `BoxIntegration` + `ParticleIntegration` + `ParticleDevice` (Box and Particle config merged)

```typescript
interface IIntegration {
  _id: string;
  type: 'box' | 'particle';

  // Box-specific
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date;
  bomFolderId?: string;
  bomFileId?: string;

  // Particle-specific
  organizationSlug?: string;
  syncIntervalMinutes?: number;

  // Shared
  isActive: boolean;
  lastSyncAt?: Date;
  lastSyncStatus?: string;
  lastSyncError?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

---

### 2.43 Particle Devices

**Collection name:** `particle_devices`
**Kept separate because:** Queried independently for device list, status monitoring.

```typescript
interface IParticleDevice {
  _id: string;
  particleDeviceId: string;
  name: string;
  serialNumber?: string;
  platformId?: number;
  firmwareVersion?: string;
  systemVersion?: string;
  status?: string;
  lastHeardAt?: Date;
  lastIpAddress?: string;
  notes?: string;
  linkedSpuId?: string;
  linkedAt?: Date;
  linkedBy?: string;
  needsAttention: boolean;
  attentionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

---

# TIER 3: IMMUTABLE LOGS

These are append-only collections. Once a record is created, it is never modified or deleted. Mongoose middleware blocks all update and delete operations. These exist for HIPAA compliance, regulatory traceability, and audit purposes.

**No changes from v1.**

---

### 3.1 Audit Log

**Collection name:** `audit_log`
**Why immutable:** HIPAA requires tamper-proof records of who did what, when.

```typescript
interface IAuditLog {
  _id: string;
  tableName: string;                 // which collection was affected
  recordId: string;                  // which document was affected
  action: 'INSERT' | 'UPDATE' | 'DELETE' | 'PHASE_ADVANCE';
  oldData?: any;
  newData?: any;
  changedAt: Date;
  changedBy?: string;
  changedFields?: any;
  reason?: string;
  sessionId?: string;
  ipAddress?: string;
  userAgent?: string;
}
```

**Indexes:**
```typescript
{ tableName: 1, recordId: 1 }       // audit trail for a specific record
{ changedAt: -1 }                    // recent activity
{ changedBy: 1, changedAt: -1 }     // user activity log
```

---

### 3.2 Electronic Signatures

**Collection name:** `electronic_signatures`
**Why immutable:** 21 CFR Part 11 compliance. Once signed, a signature cannot be altered.
**Why separate (not embedded):** Referenced from multiple entity types. Needs independent querying for compliance audits.

```typescript
interface IElectronicSignature {
  _id: string;
  userId: string;
  entityType: string;
  entityId: string;
  meaning: string;
  signedAt: Date;
  ipAddress?: string;
  userAgent?: string;
  dataHash?: string;                 // SHA-256 of document state at signing
}
```

---

### 3.3 Inventory Transactions

**Collection name:** `inventory_transactions`
**Why immutable:** Ledger pattern — you don't edit past transactions; you add adjustment transactions.

```typescript
interface IInventoryTransaction {
  _id: string;
  partDefinitionId: string;
  bomItemId?: string;
  assemblySessionId?: string;
  assemblyStepRecordId?: string;
  transactionType: 'deduction' | 'retraction' | 'adjustment' | 'receipt';
  quantity: number;
  previousQuantity: number;
  newQuantity: number;
  reason?: string;
  performedBy: string;
  performedAt: Date;
  retractedBy?: string;
  retractedAt?: Date;
  retractionReason?: string;
}
```

---

### 3.4 Device Events

**Collection name:** `device_events`
**Why immutable:** IoT event stream from firmware devices. Events are facts about what happened — they cannot be changed after the fact.

```typescript
interface IDeviceEvent {
  _id: string;
  deviceId: string;
  eventType: 'validate' | 'load_assay' | 'upload' | 'reset' | 'error';
  eventData?: any;
  cartridgeUuid?: string;
  success?: boolean;
  errorMessage?: string;
  createdAt: Date;
}
```

---

### 3.5 Manufacturing Material Transactions

**Collection name:** `manufacturing_material_transactions`
**Why immutable:** Material usage ledger for manufacturing traceability.

```typescript
interface IManufacturingMaterialTransaction {
  _id: string;
  materialId: string;
  transactionType: string;
  quantityChanged: number;
  quantityBefore: number;
  quantityAfter: number;
  relatedBatchId?: string;
  operatorId: string;
  notes?: string;
  createdAt: Date;
}
```

---

# APPENDIX A: Migration Mapping

Complete mapping of old collections to new locations:

| # | Old Collection | New Location | Change |
|---|---------------|-------------|--------|
| 1 | User | `users` **(SACRED)** | + embedded roles, permissions, comm prefs, roleHistory, training records, corrections |
| 2 | Session | `sessions` | Unchanged |
| 3 | Role | `roles` | + embedded permissions |
| 4 | Permission | **ELIMINATED** | → string array in `roles.permissions` |
| 5 | UserRole | **ELIMINATED** | → embedded in `users.roles` and `users.roleHistory` |
| 6 | RolePermission | **ELIMINATED** | → embedded in `roles.permissions` |
| 7 | InviteToken | `invite_tokens` | Unchanged |
| 8 | AuditLog | `audit_log` | Unchanged (Tier 3) |
| 9 | CommunicationPreference | **ELIMINATED** | → embedded in `users.communicationPreferences` |
| 10 | Customer | `customers` | + embedded notes |
| 11 | CustomerNote | **ELIMINATED** | → embedded in `customers.notes` |
| 12 | Batch | `batches` | Unchanged |
| 13 | Spu | `spus` **(SACRED)** | + embedded parts, particle link, validation, full assembly, corrections |
| 14 | ParticleLink | **ELIMINATED** | → embedded in `spus.particleLink` |
| 15 | PartDefinition | `part_definitions` | Unchanged |
| 16 | SpuPart | **ELIMINATED** | → embedded in `spus.parts` |
| 17 | AssemblySession | `assembly_sessions` | + embedded step records, field records (working doc; copied to SPU on completion) |
| 18 | ElectronicSignature | `electronic_signatures` | Unchanged (Tier 3) |
| 19 | AssemblyStepRecord | **ELIMINATED** | → embedded in `assembly_sessions.stepRecords` |
| 20 | StepFieldRecord | **ELIMINATED** | → embedded in `stepRecords.fieldRecords` |
| 21 | Document | `documents` | + embedded revisions, training records |
| 22 | DocumentRevision | **ELIMINATED** | → embedded in `documents.revisions` |
| 23 | DocumentTraining | **ELIMINATED** | → embedded in `revisions.trainingRecords` |
| 24 | Files | `files` | Unchanged |
| 25 | DocumentRepository | `document_repository` | Unchanged |
| 26 | WorkInstructions | **ELIMINATED** | → merged into `work_instructions` |
| 27 | WorkInstruction | `work_instructions` | + embedded everything |
| 28 | WorkInstructionVersion | **ELIMINATED** | → embedded in `work_instructions.versions` |
| 29 | WorkInstructionStep | **ELIMINATED** | → embedded in `versions.steps` |
| 30 | StepPartRequirement | **ELIMINATED** | → embedded in `steps.partRequirements` |
| 31 | StepToolRequirement | **ELIMINATED** | → embedded in `steps.toolRequirements` |
| 32 | StepFieldDefinition | **ELIMINATED** | → embedded in `steps.fieldDefinitions` |
| 33 | InventoryTransaction | `inventory_transactions` | Unchanged (Tier 3) |
| 34 | ProductionRun | `production_runs` | + embedded units |
| 35 | ProductionRunUnit | **ELIMINATED** | → embedded in `production_runs.units` |
| 36 | GeneratedBarcode | `generated_barcodes` | Unchanged |
| 37 | ValidationSession | `validation_sessions` | + embedded results |
| 38 | ValidationResult | **ELIMINATED** | → embedded in `validation_sessions.results` |
| 39 | ProcessConfiguration | `process_configurations` | + embedded steps |
| 40 | ProcessStep | **ELIMINATED** | → embedded in `process_configurations.steps` |
| 41 | LotRecord | `lot_records` **(OPERATIONAL — demoted from sacred)** | + embedded step entries, removed finalizedAt/voidedAt |
| 42 | LotStepEntry | **ELIMINATED** | → embedded in `lot_records.stepEntries` |
| 43 | DeckRecord | **ELIMINATED** | → `consumables` (type: deck) |
| 44 | CoolingTrayRecord | **ELIMINATED** | → `consumables` (type: cooling_tray) |
| 45 | RejectionReasonCode | **ELIMINATED** | → embedded in `manufacturing_settings` |
| 46 | WaxFillingSettings | **ELIMINATED** | → merged into `manufacturing_settings` |
| 47 | WaxFillingRun | `wax_filling_runs` | Unchanged |
| 48 | WaxCartridgeRecord | **ELIMINATED** | → `cartridge_records` (SACRED) wax phase |
| 49 | AssayType | `assay_definitions` **(SACRED)** | + embedded reagents, sub-components, versions, corrections |
| 50 | ReagentDefinition | **ELIMINATED** | → embedded in `assay_definitions.reagents` |
| 51 | ReagentSubComponent | **ELIMINATED** | → embedded in `reagents.subComponents` |
| 52 | ReagentFillingSettings | **ELIMINATED** | → merged into `manufacturing_settings` |
| 53 | ReagentFillingRun | `reagent_batch_records` **(SACRED)** | + embedded tubes, top seal, cartridges, corrections |
| 54 | ReagentTubeRecord | **ELIMINATED** | → embedded in `reagent_batch_records.tubeRecords` |
| 55 | TopSealBatch | **ELIMINATED** | → embedded in `reagent_batch_records.topSeal` |
| 56 | ReagentCartridgeRecord | **ELIMINATED** | → `cartridge_records` (SACRED) reagent phase |
| 57 | ManufacturingSettings | **ELIMINATED** | → merged into `manufacturing_settings` |
| 58 | ManufacturingMaterial | `manufacturing_materials` | + embedded recent transactions |
| 59 | ManufacturingMaterialTransaction | `manufacturing_material_transactions` | Tier 3 immutable log |
| 60 | CartridgeGroup | `cartridge_groups` | Unchanged |
| 61 | Cartridge | `lab_cartridges` | + embedded usage log (renamed to avoid confusion) |
| 62 | CartridgeUsageLog | **ELIMINATED** | → embedded in `lab_cartridges.usageLog` |
| 63 | Assay | **ELIMINATED** | → merged into `assay_definitions` firmware fields |
| 64 | FirmwareDevice | `firmware_devices` | Unchanged |
| 65 | FirmwareCartridge | `firmware_cartridges` | Unchanged |
| 66 | TestResult | `test_results` | + embedded readings (pending size check) |
| 67 | SpectroReading | **ELIMINATED** | → embedded in `test_results.readings` (pending size) |
| 68 | DeviceEvent | `device_events` | Unchanged (Tier 3) |
| 69 | ShippingLot | `shipping_lots` | + embedded QA/QC releases |
| 70 | QaqcRelease | **ELIMINATED** | → embedded in `shipping_lots.qaqcReleases` |
| 71 | ShippingPackage | `shipping_packages` | + embedded cartridge list, full customer snapshot |
| 72 | PackageCartridge | **ELIMINATED** | → embedded in `shipping_packages.cartridges` |
| 73 | BomItem | `bom_items` | + embedded versions, part links, merged with CartridgeBomItem |
| 74 | CartridgeBomItem | **ELIMINATED** | → merged into `bom_items` with bomType discriminator |
| 75 | BomItemVersion | **ELIMINATED** | → embedded in `bom_items.versionHistory` |
| 76 | BomPartLink | **ELIMINATED** | → embedded in `bom_items.partLinks` |
| 77 | BomColumnMapping | `bom_column_mapping` | Unchanged |
| 78 | EquipmentLocation | `equipment_locations` | + embedded current placements |
| 79 | LocationPlacement | **ELIMINATED** | → embedded in `equipment_locations.currentPlacements` |
| 80 | Equipment | `equipment` | Unchanged |
| 81 | EquipmentEventLog | **ELIMINATED** | → embedded recent events in equipment OR audit_log |
| 82 | OpentronsRobot | `opentrons_robots` | + embedded protocols, health snapshots |
| 83 | OpentronsProtocolRecord | **ELIMINATED** | → embedded in `opentrons_robots.protocols` |
| 84 | OpentronsHealthSnapshot | **ELIMINATED** | → embedded in `opentrons_robots.recentHealthSnapshots` |
| 85 | AssayVersion | **ELIMINATED** | → embedded in `assay_definitions.versionHistory` |
| 86 | LaborEntry | `labor_entries` | Unchanged (if still needed for costing) |
| 87 | SpuPartUsage | **ELIMINATED** | → merged into `spus.parts` |
| 88 | IncubatorTube | **ELIMINATED** | → `consumables` (type: incubator_tube) |
| 89 | IncubatorTubeUsage | **ELIMINATED** | → embedded in `consumables.usageLog` |
| 90 | TopSealRoll | **ELIMINATED** | → `consumables` (type: top_seal_roll) |
| 91 | TopSealCutRecord | **ELIMINATED** | → embedded in `consumables.usageLog` |
| 92 | LaserCutBatch | `laser_cut_batches` | Unchanged |
| 93 | KanbanProject | `kanban_projects` | Unchanged |
| 94 | KanbanTask | `kanban_tasks` | + embedded comments, tags, activity, proposals |
| 95 | KanbanComment | **ELIMINATED** | → embedded in `kanban_tasks.comments` |
| 96 | KanbanTag | **ELIMINATED** | → string array in `kanban_tasks.tags` |
| 97 | KanbanTaskTag | **ELIMINATED** | → string array in `kanban_tasks.tags` |
| 98 | KanbanActionLog | **ELIMINATED** | → embedded in `kanban_tasks.activityLog` |
| 99 | KanbanTaskProposal | **ELIMINATED** | → embedded in `kanban_tasks.proposals` |
| 100 | KanbanBoardEvent | **ELIMINATED** | → audit_log or dropped |
| 101 | AgentQuery | `agent_queries` | Unchanged |
| 102 | SchemaMetadata | `schema_metadata` | Unchanged |
| 103 | AgentMessage | `agent_messages` | Unchanged |
| 104 | RoutingPattern | `routing_patterns` | Unchanged |
| 105 | ApprovalRequest | `approval_requests` | + embedded history |
| 106 | SystemDependency | `system_dependencies` | Unchanged |
| 107 | ApprovalHistory | **ELIMINATED** | → embedded in `approval_requests.history` |
| 108 | BoxIntegration | **ELIMINATED** | → `integrations` (type: box) |
| 109 | ParticleIntegration | **ELIMINATED** | → `integrations` (type: particle) |
| 110 | ParticleDevice | `particle_devices` | Unchanged |

**Summary:**
- **Collections kept/restructured:** ~33
- **Collections eliminated (embedded):** 67
- **Collections eliminated (merged):** 10
- **Total eliminated:** 77
- **v1 → v2 net change:** -1 (dropped `correction_records`)

---

# APPENDIX B: v1 → v2 Change Summary

| Item | v1 | v2 | Rationale |
|------|----|----|-----------|
| Sacred collections | 5 (cartridge, spu, assay, reagent batch, lot) + correction_records | 5 (cartridge, spu, assay, reagent batch, **user**) | Lot demoted, user promoted, corrections embedded |
| Correction records | Separate collection | Embedded `corrections[]` in each sacred doc | Simpler — everything in one place |
| Cartridge phases | 11 manufacturing phases | 11 mfg + 4 clinical (assayLoaded, testExecution, sample, testResult) | Terminal document — complete chain from mfg to result |
| SPU assembly | Summary reference (`sessionId` + metadata) | Full step records + field records embedded | Self-contained audit record |
| Assembly sessions | Primary record of assembly | Working document during build; copied to SPU on completion; retained as backup | SPU is the golden record |
| Reagent batch assay ref | `{ _id, name, skuCode, version }` | `{ _id, name, skuCode }` | Reference not snapshot — just needs identification |
| Shipping package customer | `{ _id, name }` | Full customer snapshot (type, contact, address) | Point-in-time truth for where it was shipped |
| Cartridge shipping customer | `{ _id, name }` | Full customer snapshot | Same rationale |
| User record | Operational (Tier 2) | Sacred (Tier 1) with roleHistory, training, corrections | HIPAA — who had what permissions when |
| Lot record | Sacred (Tier 1) with finalizedAt/voidedAt | Operational (Tier 2), no immutability controls | Upstream grouping, not the sacred record itself |

---

# APPENDIX C: Open Decisions

| # | Question | Options | Impact |
|---|----------|---------|--------|
| 1 | SpectroReading count per test? | If < 500: embed. If > 1000: keep separate. | test_results schema |
| 2 | WI step image sizes? | If < 100KB: embed base64. If > 500KB: external storage + URL. | work_instructions may hit 16MB |
| 3 | Equipment event log retention? | Full history: separate collection. Recent only: embed last N. | equipment schema |
| 4 | Labor entries still needed? | If yes: keep separate. If no: drop. | One less collection |
| 5 | Assay + Firmware Assay merge? | The `Assay` (firmware) and `AssayType` (manufacturing) models overlap. Merge into `assay_definitions`? | Schema simplification |
| 6 | Cartridge testResult detail level? | How much spectro data goes into the cartridge vs. staying in test_results? | Cartridge document size |
| 7 | User deactivation vs finalization? | Use `deactivatedAt` (current) or `finalizedAt`/`voidedAt` (standard sacred pattern)? | User record consistency |

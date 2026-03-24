# Handoff: Complete Schema Specification V2 Rewrite

**Date:** February 27, 2026
**Context:** 2+ hour session with Jacob refining the MongoDB redesign. The v1 spec (`COMPLETE-SCHEMA-SPECIFICATION.md`) was written and sent, then Jacob and I had an extensive Q&A that changed several fundamental decisions. This document captures EVERY decision so the v2 rewrite is accurate.

---

## The Task

Rewrite `projects/mongodb-redesign/COMPLETE-SCHEMA-SPECIFICATION.md` incorporating all changes below. The v1 file is still there as reference for the operational schemas that didn't change. The output should be one comprehensive file ready for Jacob to review with his lead engineer.

---

## Sacred Document Tier — FINAL (5 collections)

### 1. Cartridge Record (`cartridge_records`) — THE TERMINAL DOCUMENT

The most important document in the entire system. Everything converges here.

**Manufacturing phases (from v1, unchanged):**
- backing (lot origin, QR code, oven entry)
- waxFilling (run, robot, deck position, operator, tube)
- waxQc (status, rejection reason, inspector)
- waxStorage (location, cooling tray, operator)
- reagentFilling (run, robot, assay REFERENCE not snapshot, deck position, tube records, operator, fill date, expiration)
- reagentInspection (status, reason, inspector)
- topSeal (batch, lot, operator)
- ovenCure (location, entry time)
- storage (fridge, location, container, operator)
- qaqcRelease (shipping lot, test result, tester)
- shipping (package, customer SNAPSHOT, tracking, carrier)

**NEW clinical phases (added in v2):**
- assayLoaded — which assay was loaded (REFERENCE: _id, name, skuCode — NOT full snapshot. Jacob explicitly said reagent batch doesn't need whole assay definition, just needs to know what assay it's making. Same applies here.)
- testExecution — FULL SPU SNAPSHOT at time of test (udi, parts with lot numbers, firmware version, last validation, particle link). Also: operator, timestamp.
- sample — subject/patient data (subjectId, sampleType, collectedAt, collectedBy, metadata for flexibility)
- testResult — the clinical output (analyte, value, unit, reference range, interpretation, spectro readings, processed data, status)

**Corrections:** Append-only `corrections[]` array embedded in the document. NOT a separate collection. Original data stays untouched.

**Key clarifications from Jacob:**
- A lot is the GROUP of physical items (cartridge bodies). A reagent batch is the STUFF put into them.
- A reagent batch is applied to individual cartridges, but each cartridge carries its lot ID from upstream processes.
- The cartridge is the terminal document — it will ultimately contain the full assay reference, full SPU snapshot, sample data, and test result. One document = complete chain from raw materials → device → patient → result.

### 2. SPU Record (`spus`) — COMPLETE DEVICE BUILD RECORD

**Change from v1: Full assembly session embedded, not just summary.**

The SPU document contains:
- All v1 fields (batch, parts, particle link, validation, assignment, lifecycle state)
- `assembly` field now contains FULL step records and field records (was: just a sessionId reference)
- The `assembly_sessions` collection still exists as a WORKING DOCUMENT during assembly (frequent writes during the build process). On completion, full session data is copied into the SPU.

**Why embed:** Jacob asked "does the whole assembly session go in the SPU?" — yes. Document size is ~25KB with full assembly. No performance concern. Projections (`.select()`) mean the full doc only loads when requested. The SPU should be self-contained — hand it to an auditor, complete build record, one document.

**The assembly section in the SPU should include:**
```
assembly: {
  sessionId (reference back to working document)
  workInstructionId, version, title
  startedAt, completedAt
  operator: { _id, username }
  workstationId
  stepRecords: [{
    stepNumber, stepTitle
    scannedLotNumber, scannedPartNumber
    completedAt, completedBy: { _id, username }
    fieldRecords: [{
      fieldName, fieldLabel, fieldValue
      rawBarcodeData
      capturedAt, capturedBy
    }]
  }]
}
```

**Corrections:** Append-only `corrections[]` array embedded.

### 3. Assay Definition (`assay_definitions`) — LOCKED REFERENCE FORMULA

**No change from v1.** Reagents and sub-components embedded. Version history embedded. Lockable.

**Corrections:** Append-only `corrections[]` array embedded.

### 4. Reagent Batch Record (`reagent_batch_records`) — FILLING RUN TRACEABILITY

**Changes from v1:**
- Assay reference is just `{ _id, name, skuCode }` — NOT a full assay snapshot. Jacob: "reagent batch doesn't need the whole assay definition, but it does need to know what assay it is going to make."
- Should include "sum of the parts that made them" — the input materials/reagent source lots.

**Corrections:** Append-only `corrections[]` array embedded.

### 5. User Record (`users`) — PROMOTED TO SACRED

**New in v2.** Jacob: "users are sacred documents."

Users are sacred because:
- They're the WHO behind every action in every other sacred document
- HIPAA requires knowing who had what permissions at what time
- Training records prove this person was qualified to perform that action
- Users are never deleted, only deactivated

**Changes from v1 user schema:**
- Add `finalizedAt` / `voidedAt` / `voidReason` (though users probably use "deactivated" not "finalized")
- Add append-only `roleHistory[]` — not just current roles, but when each role was granted and revoked
- Embed training records (which documents/procedures this user was trained on)
- Add `corrections[]` array
- Immutability: deactivated users can never be deleted

**Role history pattern:**
```
roleHistory: [{
  roleId, roleName
  permissions: string[]
  grantedAt, grantedBy
  revokedAt?, revokedBy?, revokeReason?
}]
```

Current active roles = roleHistory entries where revokedAt is null.

---

## Operational Tier — Changes from v1

### Lots DOWNGRADED from sacred to operational

Jacob clarified: "lots are the group of parts, parts for either SPUs or cartridges." A lot is an upstream grouping — a batch of cartridge bodies that went through backing/wax/QR coding together. Each cartridge carries its lot ID as provenance.

The lot record is useful for querying ("show me all cartridges from lot L-042") but the CARTRIDGE DMR is the sacred record, not the lot.

`lot_records` stays as a collection but moves from Tier 1 to Tier 2. Remove immutability middleware, remove `finalizedAt`/`voidedAt` fields. Keep the schema otherwise the same (embedded step entries, process config reference, etc.).

### Assembly Sessions — KEPT but role clarified

`assembly_sessions` still exists as a collection. Its role is:
- DURING assembly: the working document that gets frequent writes (step advances, barcode scans, field captures)
- ON COMPLETION: full data is copied into the SPU sacred document
- AFTER completion: retained as a backup/audit trail, but the SPU is the golden record

### Shipping Packages — embed FULL customer record

v1 had `customer: { _id, name }`. v2 should snapshot the full customer at time of shipment:
```
customer: {
  _id, name, customerType,
  contactName, contactEmail, contactPhone,
  address
}
```
If the customer moves next year, the shipping record shows where it was actually shipped.

### Correction Records Collection — DROPPED

The separate `correction_records` collection is eliminated. Each sacred document has its own embedded `corrections[]` array instead. Simpler, everything in one place.

---

## Immutable Logs — No changes from v1

5 collections: audit_log, electronic_signatures, inventory_transactions, device_events, manufacturing_material_transactions

---

## Updated Collection Count

| Tier | v1 | v2 | Change |
|------|----|----|--------|
| Sacred | 5 (cartridge, spu, assay, reagent batch, lot) + 1 correction_records | 5 (cartridge, spu, assay, reagent batch, **user**) | Lot out, User in, correction_records dropped |
| Operational | ~23 | ~23 | lot_records added (from sacred), assembly_sessions role clarified |
| Immutable Logs | 5 | 5 | No change |
| **Total** | ~34 | ~33 | Net -1 (dropped correction_records) |

---

## Key Philosophical Points to Preserve in v2

These came up during Q&A and should be reflected in the document's framing:

1. **"All operational units serve the purpose of creating sacred items."** Every operational collection exists to feed data into one of the five sacred documents. Include the architecture diagram and mapping table showing what feeds what.

2. **The cartridge is the TERMINAL document.** It's where the entire system converges — manufacturing, device, assay, patient, result. All other sacred docs are either source documents (assay, reagent batch) or get snapshotted into the cartridge at key moments (SPU at test time).

3. **Snapshot vs reference decision:** When a sacred document references another entity at a point in time, snapshot the relevant data (like SPU state at test time, customer at shipment time). For slowly-changing references that just need identification (like which assay a reagent batch is making), a reference (id + name + sku) is sufficient.

4. **Document size is irrelevant at Brevitest's scale.** Full SPU with assembly = ~25KB. Full cartridge with all phases = ~50-100KB. 16MB limit is at 0.5%. Projections handle selective loading.

5. **The system is inherently flexible.** New phases can be added to sacred documents as optional fields. Old documents without the new fields work fine. No migrations needed. This is a core advantage of the document model for their use case.

6. **Users being sacred matters for HIPAA.** Every action in every sacred document has an operator snapshot. The user record is the authoritative source that proves "this person was qualified and authorized at that time."

---

## Files in `projects/mongodb-redesign/`

- `ARCHITECTURE.md` — v1 initial technical design (historical)
- `ARCHITECTURE-V2.md` — two-tier model (historical)
- `REDESIGN-REPORT.md` — example-driven report explaining relational vs document (still valid, sent to Jacob)
- `COMPLETE-SCHEMA-SPECIFICATION.md` — v1 comprehensive spec (TO BE REWRITTEN as v2)
- `HANDOFF-V2-REWRITE.md` — THIS FILE (instructions for the rewrite)

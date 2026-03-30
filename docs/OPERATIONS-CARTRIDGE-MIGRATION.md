# Operations App: CartridgeRecord `currentPhase` → `status` Migration

**Purpose:** This document describes every change needed in the Bioscale Operations System V2 to rename `currentPhase` to `status` on the CartridgeRecord model, unifying with the legacy CouchDB cartridge status system.

**Why:** The research app and operations app share the `cartridge_records` MongoDB collection. The legacy system (CouchDB + Lambda middleware + firmware) uses `status` as the cartridge lifecycle field. The operations app introduced `currentPhase` for manufacturing tracking. To unify, the operations app adopts `status` — the legacy name — with an expanded enum that covers both manufacturing and test-execution phases.

**Scope:** ~35 individual code references across 11 files. No firmware changes. No Lambda changes. No research app changes (it will be built against the new unified schema).

---

## Unified `status` Enum (replaces `currentPhase`)

```typescript
status: {
    type: String,
    enum: [
        // Manufacturing lifecycle (operations app)
        'backing',
        'wax_filled',
        'wax_qc',
        'wax_stored',
        'reagent_filled',
        'inspected',
        'sealed',
        'cured',
        'stored',
        'released',
        'shipped',

        // Test execution lifecycle (shared with research + Lambda + firmware)
        'linked',           // Ready for testing (research cartridges start here)
        'underway',         // Test in progress (set by Lambda validate-cartridge)
        'completed',        // Test finished with data (set by Lambda upload-test)
        'cancelled',        // Test finished without data (set by Lambda upload-test)
        'scrapped',         // Disposed of, never tested

        // Administrative
        'voided',           // Rejected during manufacturing QC

        // Legacy statuses (from CouchDB, may appear on migrated data)
        'packeted',
        'transferred',
        'refrigerated',
        'received'
    ]
}
```

**Lifecycle flow for manufactured cartridges:**
```
backing → wax_filled → wax_qc → wax_stored → reagent_filled → inspected →
sealed → cured → stored → released → shipped → linked → underway → completed/cancelled
                                                                  ↘ scrapped
At any manufacturing phase: → voided (QC rejection)
```

**Lifecycle flow for research cartridges:**
```
linked → underway → completed/cancelled
       ↘ scrapped
```

---

## Bug Found During Audit

**File:** `src/routes/spu/cartridge-admin/storage/+page.server.ts`, Line 22
```typescript
CartridgeRecord.find({
    currentPhase: { $in: ['qc_complete', 'assay_loaded'] },
    'storage.storedAt': { $exists: false }
})
```
**Issue:** `'qc_complete'` is NOT a valid enum value. This query silently returns no results for that phase.
**Fix:** Replace `'qc_complete'` with the correct phase. Likely `'released'` or `'inspected'` based on context (cartridges awaiting storage after QC).

---

## File-by-File Changes

### 1. `src/lib/server/db/models/cartridge-record.ts`

**Schema field rename:**
```typescript
// BEFORE (line ~97)
currentPhase: {
    type: String,
    enum: ['backing', 'wax_filled', 'wax_qc', 'wax_stored', 'reagent_filled', 'inspected',
        'sealed', 'cured', 'stored', 'released', 'shipped', 'assay_loaded', 'testing', 'completed', 'voided']
}

// AFTER
status: {
    type: String,
    enum: [
        'backing', 'wax_filled', 'wax_qc', 'wax_stored', 'reagent_filled', 'inspected',
        'sealed', 'cured', 'stored', 'released', 'shipped',
        'linked', 'underway', 'completed', 'cancelled', 'scrapped', 'voided',
        'packeted', 'transferred', 'refrigerated', 'received'
    ]
}
```

**Notes:**
- Removed `assay_loaded` and `testing` — these map to `linked` and `underway` respectively
- Added `linked`, `underway`, `cancelled`, `scrapped` from legacy system
- Added `packeted`, `transferred`, `refrigerated`, `received` for legacy data compatibility

**Index updates:**
```typescript
// BEFORE
cartridgeRecordSchema.index({ currentPhase: 1 });
cartridgeRecordSchema.index({ currentPhase: 1, 'reagentFilling.expirationDate': 1 });

// AFTER
cartridgeRecordSchema.index({ status: 1 });
cartridgeRecordSchema.index({ status: 1, 'reagentFilling.expirationDate': 1 });
```

---

### 2. `src/routes/spu/assays/[assayId]/assign/+page.server.ts`

**Line ~62 — bulkWrite operation:**
```typescript
// BEFORE
currentPhase: 'assay_loaded'

// AFTER
status: 'linked'
```
**Rationale:** When an assay is loaded onto a cartridge, it becomes ready for testing. In the legacy system, this is `linked`. The `assay_loaded` phase is removed from the enum — use `linked` instead. The assay loading details are still captured in the `assayLoaded` sub-object.

---

### 3. `src/routes/spu/manufacturing/wax-filling/+page.server.ts`

**Line ~123 — Display (QC inventory):**
```typescript
// BEFORE
currentInventory: c.currentPhase ?? 'wax_filled'

// AFTER
currentInventory: c.status ?? 'wax_filled'
```

**Line ~133 — Query (storage cartridges):**
```typescript
// BEFORE
CartridgeRecord.find({ ..., currentPhase: 'wax_stored' })

// AFTER
CartridgeRecord.find({ ..., status: 'wax_stored' })
```

**Line ~139 — Display (storage inventory):**
```typescript
// BEFORE
currentInventory: c.currentPhase ?? 'wax_stored'

// AFTER
currentInventory: c.status ?? 'wax_stored'
```

**Line ~289 — Bulk upsert (new cartridge stubs):**
```typescript
// BEFORE
currentPhase: 'backing'

// AFTER
status: 'backing'
```

**Line ~385 — Bulk update (run completion):**
```typescript
// BEFORE
currentPhase: 'wax_filled'

// AFTER
status: 'wax_filled'
```

**Line ~444 — Individual update (QC rejection):**
```typescript
// BEFORE
currentPhase: 'voided'

// AFTER
status: 'voided'
```

**Line ~480 — Bulk update (storage):**
```typescript
// BEFORE
currentPhase: 'wax_stored'

// AFTER
status: 'wax_stored'
```

---

### 4. `src/routes/spu/manufacturing/qa-qc/+page.server.ts`

**Line ~114 — Bulk update (testing start):**
```typescript
// BEFORE
currentPhase: 'released'

// AFTER
status: 'released'
```

**Line ~166 — Conditional bulk update (QC result):**
```typescript
// BEFORE
currentPhase: normalizedResult === 'pass' ? 'released' : 'voided'

// AFTER
status: normalizedResult === 'pass' ? 'released' : 'voided'
```

---

### 5. `src/routes/spu/manufacturing/reagent-filling/cooling-queue/+page.server.ts`

**Line ~13 — Query:**
```typescript
// BEFORE
CartridgeRecord.find({ currentPhase: { $in: ['sealed', 'inspected', 'reagent_filled'] } })

// AFTER
CartridgeRecord.find({ status: { $in: ['sealed', 'inspected', 'reagent_filled'] } })
```

---

### 6. `src/routes/spu/cartridge-admin/+page.server.ts`

**Line ~28 — Filter query:**
```typescript
// BEFORE
if (lifecycleStage) query.currentPhase = lifecycleStage

// AFTER
if (lifecycleStage) query.status = lifecycleStage
```

**Line ~42 — Sort field mapping:**
```typescript
// BEFORE
'currentLifecycleStage': 'currentPhase'

// AFTER
'currentLifecycleStage': 'status'
```

**Line ~74 — Display:**
```typescript
// BEFORE
currentLifecycleStage: c.currentPhase ?? 'unknown'

// AFTER
currentLifecycleStage: c.status ?? 'unknown'
```

**Line ~79 — Logic check:**
```typescript
// BEFORE
c.currentPhase === 'backing'

// AFTER
c.status === 'backing'
```

---

### 7. `src/routes/spu/cartridge-admin/storage/+page.server.ts`

**Line ~22 — Query (BUG FIX INCLUDED):**
```typescript
// BEFORE (contains bug: 'qc_complete' is invalid)
CartridgeRecord.find({
    currentPhase: { $in: ['qc_complete', 'assay_loaded'] },
    'storage.storedAt': { $exists: false }
})

// AFTER (fix: replace invalid values with correct phases)
CartridgeRecord.find({
    status: { $in: ['released', 'linked'] },
    'storage.storedAt': { $exists: false }
})
```
**Note:** `qc_complete` → `released` (cartridges that passed QC). `assay_loaded` → `linked` (cartridges with assay loaded, ready for testing).

**Line ~96 — Update:**
```typescript
// BEFORE
currentPhase: 'stored'

// AFTER
status: 'stored'
```

Also remove the duplicate `status: 'stored'` if one already exists on the same line (the audit showed both `currentPhase` and `status` being set — after migration only `status` is needed).

---

### 8. `src/routes/spu/cartridge-admin/filled/+page.server.ts`

**Line ~21 — Query:**
```typescript
// BEFORE
CartridgeRecord.find({ currentPhase: { $in: ['sealed', 'cured', 'stored', 'released'] } })

// AFTER
CartridgeRecord.find({ status: { $in: ['sealed', 'cured', 'stored', 'released'] } })
```

**Line ~45 — Display:**
```typescript
// BEFORE
currentLifecycleStage: c.currentPhase ?? 'unknown'

// AFTER
currentLifecycleStage: c.status ?? 'unknown'
```

---

### 9. `src/routes/spu/cartridge-admin/failures/+page.server.ts`

**Line ~44 — Display:**
```typescript
// BEFORE
currentLifecycleStage: c.currentPhase ?? 'unknown'

// AFTER
currentLifecycleStage: c.status ?? 'unknown'
```

---

### 10. `src/routes/spu/cartridge-admin/statistics/+page.server.ts`

**Line ~20 — Select projection:**
```typescript
// BEFORE
currentPhase: 1

// AFTER
status: 1
```

**Line ~40 — Phase array (used for progression tracking):**
```typescript
// No rename needed — this is a display array, not a field reference
// But the code that reads c.currentPhase from results needs updating:
```

**Line ~44 — Query logic:**
```typescript
// BEFORE
c.currentPhase

// AFTER
c.status
```

**Lines ~48, ~52, ~53 — Status group checks:**
```typescript
// BEFORE
['stored', 'released', 'shipped'].includes(c.currentPhase)
['reagent_filled', 'inspected', 'sealed', 'cured'].includes(c.currentPhase)

// AFTER
['stored', 'released', 'shipped'].includes(c.status)
['reagent_filled', 'inspected', 'sealed', 'cured'].includes(c.status)
```

**Line ~75 — Specific phase check:**
```typescript
// BEFORE
c.currentPhase === 'wax_qc'

// AFTER
c.status === 'wax_qc'
```

---

### 11. `src/routes/api/agent/operations/quality/trends/+server.ts`

**Line ~15 — Aggregation pipeline:**
```typescript
// BEFORE
{ $group: { _id: '$currentPhase', count: { $sum: 1 } } }

// AFTER
{ $group: { _id: '$status', count: { $sum: 1 } } }
```

---

## Phase Value Mapping Summary

| Old (`currentPhase`) | New (`status`) | Notes |
|---|---|---|
| `backing` | `backing` | No change |
| `wax_filled` | `wax_filled` | No change |
| `wax_qc` | `wax_qc` | No change |
| `wax_stored` | `wax_stored` | No change |
| `reagent_filled` | `reagent_filled` | No change |
| `inspected` | `inspected` | No change |
| `sealed` | `sealed` | No change |
| `cured` | `cured` | No change |
| `stored` | `stored` | No change |
| `released` | `released` | No change |
| `shipped` | `shipped` | No change |
| `assay_loaded` | **`linked`** | **Renamed** — maps to legacy "ready for testing" |
| `testing` | **`underway`** | **Renamed** — maps to legacy "test in progress" |
| `completed` | `completed` | No change |
| `voided` | `voided` | No change |
| _(new)_ | `cancelled` | Added from legacy — test finished without data |
| _(new)_ | `scrapped` | Added from legacy — disposed, never tested |
| _(new)_ | `packeted` | Added from legacy — for migrated data |
| _(new)_ | `transferred` | Added from legacy — for migrated data |
| _(new)_ | `refrigerated` | Added from legacy — for migrated data |
| _(new)_ | `received` | Added from legacy — for migrated data |

**Only 2 values actually change:** `assay_loaded` → `linked`, `testing` → `underway`.

---

## MongoDB Data Migration

After deploying the code changes, run a one-time migration to rename the field on existing documents:

```javascript
// Run in MongoDB shell or migration script
db.cartridge_records.updateMany(
    { currentPhase: { $exists: true } },
    [{ $set: { status: '$currentPhase' } }, { $unset: 'currentPhase' }]
);

// Also remap the two renamed values
db.cartridge_records.updateMany(
    { status: 'assay_loaded' },
    { $set: { status: 'linked' } }
);
db.cartridge_records.updateMany(
    { status: 'testing' },
    { $set: { status: 'underway' } }
);
```

---

## Svelte Component Changes

Search ALL `.svelte` files for references to `currentPhase`, `currentLifecycleStage`, `assay_loaded`, or `testing` (the phase string). Update display labels if any UI shows these values to users.

Key areas to check:
- Cartridge admin tables/filters that show lifecycle stage
- Manufacturing dashboards
- Statistics/charts that group by phase
- Any dropdown/select that lists phases

---

## Testing Checklist

After making all changes:
- [ ] `npm run check` passes
- [ ] `npm run build` succeeds
- [ ] All contract tests pass (`npm run test:contracts`)
- [ ] Cartridge creation via wax-filling sets `status: 'backing'` (not `currentPhase`)
- [ ] QC rejection sets `status: 'voided'`
- [ ] Assay loading sets `status: 'linked'` (not `assay_loaded`)
- [ ] Cartridge admin page filters by `status` correctly
- [ ] Statistics page aggregates by `status` correctly
- [ ] Storage page query uses corrected values (no `qc_complete`)
- [ ] Run MongoDB data migration script on staging/production
- [ ] Verify existing cartridge_records documents have `status` field
- [ ] Verify no documents still have `currentPhase` field

---

## Impact on Other Systems

| System | Impact | Changes Needed |
|---|---|---|
| **Research App** | None — will be built against unified schema | Uses `status` natively |
| **Lambda Middleware** | None — already uses `status` field on cartridge documents | No changes |
| **Firmware** | None — doesn't read field names, only response JSON | No changes |
| **MongoDB Indexes** | Drop `currentPhase` indexes, `status` indexes already defined | Run index rebuild |
| **Seed Scripts** | Update any CartridgeRecord seeds to use `status` | Check `scripts/seed.ts` |

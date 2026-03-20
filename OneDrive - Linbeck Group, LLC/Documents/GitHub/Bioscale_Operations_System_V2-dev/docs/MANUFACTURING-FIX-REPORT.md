# Manufacturing Flow Audit & Fix Report

**Branch:** `nick-merge-v2`  
**Date:** 2026-03-12  
**Build Status:** ✅ Passing  
**Commits:**
- `65a5151` — Main data shape / action name fixes (14 files)
- `8141514` — Missing API route and service type file (2 files)

---

## Executive Summary

After the branch merge, **all manufacturing workflow pages** had broken data contracts between `+page.server.ts` and `+page.svelte` components. The core pattern was: server files were returning legacy data shapes (from a different schema version or a different data model approach) while the Svelte components expected a new, detailed run-state shape. Action names also didn't match, and several files were missing entirely.

**Total files changed: 16**

---

## Files Changed

### 1. `src/lib/server/db/schema.ts`
**Why:** The `wax-filling/+page.svelte` and `wax-filling/equipment/+page.svelte` import `DeckRecord`, `CoolingTrayRecord`, and `RejectionReasonCode` types from this file, but these types were missing.

**Fix:** Added three type interfaces:
- `DeckRecord` — Consumable type='deck' serialized shape
- `CoolingTrayRecord` — Consumable type='cooling_tray' serialized shape  
- `RejectionReasonCode` — ManufacturingSettings.rejectionReasonCodes entry

---

### 2. `src/lib/server/db/models/reagent-batch-record.ts`
**Why:** Model was too restrictive for the new multi-stage workflow and top-seal scanning features.

**Changes:**
- Expanded `status` enum to include all UI workflow stages: `'Setup'`, `'Loading'`, `'Running'`, `'Inspection'`, `'Top Sealing'`, `'Storage'`, `'Completed'`, `'Aborted'`, `'Cancelled'` (in addition to legacy lowercase values)
- Added `topSealBatchId`, `storageLocation`, `storedAt` fields to `cartridgesFilled` subdocuments
- Added `sealBatches` array for per-batch top seal tracking (supports multiple batches per run)
- Added `shippingLotId` and `testResult: 'testing'` to `qcRelease` subdocument

---

### 3. `src/routes/spu/manufacturing/wax-filling/+layout.server.ts`
**Why:** Always returned `hasActiveRun: false` for all robots in `dashboardState`.

**Fix:** Now queries `WaxFillingRun` for actual active runs and builds accurate `dashboardState` per robot.

---

### 4. `src/routes/spu/manufacturing/wax-filling/+page.server.ts` ⭐ CRITICAL
**Why:** Server was returning `{runs: [...], assayTypes: [...]}` (a list of all runs) but the Svelte component expected a robot-specific run state object.

**Before:**
```typescript
return { runs: runs.map(...), assayTypes: assayTypes.map(...) };
// Actions: create, start, complete, abort, addCartridge, waxQcInspect, waxStore
```

**After:**
```typescript
return {
  robotId,           // from ?robot= URL param
  loadError,         // null or error message
  robotBlocked,      // { process: 'reagent', runId } if blocked
  runState: {        // active run state for this robot
    hasActiveRun, runId, stage, runStartTime, runEndTime,
    deckId, waxSourceLot, coolingTrayId, plannedCartridgeCount
  },
  settings: {        // from ManufacturingSettings.waxFilling
    runDurationMin, removeDeckWarningMin, coolingWarningMin,
    deckLockoutMin, incubatorTempC, heaterTempC
  },
  tubeData,          // active incubator tube
  ovenLots,          // completed runs ready/waiting in oven
  rejectionCodes,    // from settings.rejectionReasonCodes
  qcCartridges,      // CartridgeRecords for this run
  storageCartridges  // cartridges in wax_stored phase
};
// Actions: confirmSetup, recordWaxPrep, loadDeck, startRun,
//          confirmDeckRemoved, confirmCooling, completeQC,
//          cancelRun, abortRun, rejectCartridge, recordBatchStorage, completeRun
```

Key fixes:
- Reads `?robot=` URL param (falls back to first robot from layout)
- Maps DB status ('running', 'setup', etc.) to UI stage strings ('Running', 'Setup', etc.)
- Checks if robot is blocked by active reagent run

---

### 5. `src/routes/spu/manufacturing/wax-filling/equipment/+page.server.ts` ⭐ CRITICAL
**Why:** Server returned `{equipment: [{id, name, type, status, currentTemperature}]}` but Svelte expected decks, trays, placement data, run history, etc.

**Before:**
```typescript
return { equipment: [{id, name, type, status, currentTemperature, targetTemperature}] };
// Actions: (none meaningful)
```

**After:**
```typescript
return {
  decks: DeckRecord[],           // Consumables type='deck'
  trays: CoolingTrayRecord[],    // Consumables type='cooling_tray'
  rejectionCodes: RejectionReasonCode[],
  isAdmin: boolean,
  equipmentList: [{equipmentId, name, equipmentType, status, currentTemperatureC}],
  placements: [],                // future: equipment location assignments
  activeWaxRuns: [{runId, robotId, deckId, coolingTrayId, status}],
  activeReagentRuns: [{runId, robotId, deckId, status}],
  waxRunHistory: [{runId, robotId, deckId, ...}],
  reagentRunHistory: [{runId, robotId, ...}]
};
// Actions: updateDeckStatus, updateTrayStatus, addRejectionCode,
//          editRejectionCode, removeRejectionCode
```

---

### 6. `src/routes/spu/manufacturing/wax-filling/oven-queue/+page.server.ts` ⭐ CRITICAL
**Why:** Server returned `{queue: [{runId, robotName, ...}]}` but Svelte expected `{lots: OvenLot[], minOvenTimeMin, isAdmin}`.

**Before:**
```typescript
return {
  queue: [{runId, robotName, assayTypeName, enteredOvenAt, remainingMinutes, cartridgeCount, ovenName}]
};
```

**After:**
```typescript
return {
  lots: [{ lotId, configId, ovenEntryTime, readyAt, minutesRemaining, ready }],
  minOvenTimeMin: number,
  isAdmin: boolean
};
// Actions: adminOverride
```

---

### 7. `src/routes/spu/manufacturing/wax-filling/settings/+page.server.ts`
**Why:** Wrong field name (`ovenDurationMinutes` instead of `minOvenTimeMin`), null values where numbers expected, missing `rejectionReasons` field, missing `createReason`, `updateReason`, `deleteReason` actions.

**Key fixes:**
- `ovenDurationMinutes` → `minOvenTimeMin` (critical name mismatch)
- All settings fields now have non-null defaults
- Added `rejectionReasons` field
- Added `createReason`, `updateReason`, `deleteReason` actions

---

### 8. `src/routes/spu/manufacturing/reagent-filling/+layout.server.ts`
**Why:** Same issue as wax-filling layout — always returned `hasActiveRun: false`.

**Fix:** Now queries `ReagentBatchRecord` for actual active runs.

---

### 9. `src/routes/spu/manufacturing/reagent-filling/+page.server.ts` ⭐ CRITICAL
**Why:** Didn't read `?robot=` URL param to filter by robot, `create` action should be `createRun`, and 15+ actions were completely missing.

**Key fixes:**
- Reads `?robot=` URL param and filters active run by robot
- Renamed `create` → `createRun`
- Added all missing actions:
  - `createRun`, `confirmSetup`, `recordReagentPrep`, `loadDeck`, `startRun`
  - `completeRunFilling`, `completeInspectionBatch`, `completeInspection`
  - `createTopSealBatch`, `scanCartridgeForSeal`, `completeSealBatch`
  - `transitionToStorage`, `recordBatchStorage`, `completeRun`
  - `cancelRun`, `abortRun`, `resetToLoading`, `forceAdvanceStage`
- Returns `currentSealBatch` (in-progress top seal batch)
- Checks if robot is blocked by active wax filling run

---

### 10. `src/routes/spu/manufacturing/reagent-filling/cooling-queue/+page.server.ts`
**Why:** Returned `{queue: [...], cartridges: [{id, barcode, lotNumber, ...}]}` but Svelte only uses `data.cartridges` with completely different fields.

**Before (cartridge shape):**
```typescript
{ id, barcode, lotNumber, coolingStartedAt, coolingRequiredMin, isReady }
```

**After (cartridge shape):**
```typescript
{ cartridgeId, waxRunId, qcTimestamp, coolingElapsedMin, minutesRemaining, isReady }
```

---

### 11. `src/routes/spu/manufacturing/reagent-filling/settings/+page.server.ts`
**Why:** Action named `update` but Svelte form calls `updateSettings`. Form fields `fillTime` and `coolingTime` didn't match server reading `minCoolingTimeMin` and `fillTimePerCartridgeMin`. Missing 7 actions.

**Key fixes:**
- `update` → `updateSettings`
- Server now reads `fillTime` and `coolingTime` from form (maps to DB fields)
- Added: `createAssayType`, `updateAssayType`, `toggleReagentActive`, `updateReagentName`
- Added: `createReason`, `updateReason`, `deleteReason`

---

### 12. `src/routes/spu/manufacturing/opentrons/history/+page.server.ts` ⭐ CREATED
**Why:** File was completely missing. The history Svelte page had no server-side data loader.

**Created with full features:**
- Paginated results (20 per page)
- Filter by process type (wax/reagent), robotId, operatorId, status, assayTypeId, search
- Sortable by any column
- Combines wax (`WaxFillingRun`) and reagent (`ReagentBatchRecord`) runs
- Summary statistics (totalRuns, completedRuns, abortedRuns, successRate, avgDurationMinutes, totalCartridges)
- Filter option lists (robots, operators, assayTypes)

---

### 13. `src/routes/spu/manufacturing/top-seal-cutting/+page.server.ts` ⭐ CRITICAL
**Why:** Returned `{sessions: [{id, status, startedAt, ...}]}` but Svelte expected `{rolls: Roll[], recentCuts: CutRecord[]}`. Actions `recordCut` and `retireRoll` were missing.

**Before:**
```typescript
return { sessions: [{id, status, startedAt, completedAt, operatorName, cartridgeCount, ...}] };
// Actions: registerRoll (broken - missing initialLengthFt from form), recordUsage (wrong name)
```

**After:**
```typescript
return {
  rolls: [{ rollId, barcode, initialLengthFt, remainingLengthFt, status, createdBy, createdAt, updatedAt }],
  recentCuts: [{ id, rollId, quantityCut, lengthPerCutFt, totalLengthUsedFt, operatorId, notes, createdAt }]
};
// Actions: registerRoll (fixed), recordCut (new), retireRoll (new)
```

`totalLengthUsedFt` computed from `usageLog.remainingBefore - remainingAfter` (no schema change needed).

---

### 14. `src/routes/spu/manufacturing/qa-qc/+page.server.ts` ⭐ CRITICAL
**Why:** Returned `{inspections: [...]}` of individual CartridgeRecord entries, but Svelte expected `{releases: Release[], filter: string}` representing QA/QC release batches tied to reagent runs.

**Before:**
```typescript
return { inspections: [{id, cartridgeId, lotId, status, result, inspectedAt, inspectorName, notes}] };
// Actions: release
```

**After:**
```typescript
return {
  releases: [{ id, shippingLotId, reagentRunId, qaqcCartridgeIds, testResult, testedBy, testedAt, notes, createdAt }],
  filter: string
};
// Actions: create, startTesting, recordResult
```

Releases are derived from `ReagentBatchRecord.qcRelease` subdocuments.

---

### 15. `src/routes/api/opentrons/history/[runId]/+server.ts` ⭐ CREATED
**Why:** The history page Svelte calls `fetch('/api/opentrons/history/${run.runId}?type=${run.processType}')` when expanding a row, but this API endpoint didn't exist.

**Created GET handler** that returns `RunDetail`:
```typescript
{ cartridges, tubes, topSealBatches, abortReason, abortPhotoUrl, createdAt, startTime, endTime }
```
Handles both `type=wax` (from `WaxFillingRun` + `CartridgeRecord`) and `type=reagent` (from `ReagentBatchRecord`).

---

### 16. `src/lib/server/services/reagent-filling/robots.ts` ⭐ CREATED
**Why:** The reagent-filling `+layout.svelte` imports `type { ReagentRobotRunState }` from this file, but the file didn't exist.

**Created:** Type definition for `ReagentRobotRunState` interface used by the layout component.

---

## Mismatch Summary Table

| Page | Issue Type | Severity |
|------|-----------|----------|
| `wax-filling/` main | Wrong data shape + wrong action names | 🔴 Critical |
| `wax-filling/equipment` | Completely wrong data shape | 🔴 Critical |
| `wax-filling/oven-queue` | Wrong data shape | 🔴 Critical |
| `wax-filling/settings` | Wrong field names + missing actions | 🟡 High |
| `reagent-filling/` main | Wrong action names + 15 missing actions | 🔴 Critical |
| `reagent-filling/cooling-queue` | Wrong cartridge shape | 🔴 Critical |
| `reagent-filling/settings` | Wrong action name + missing actions | 🟡 High |
| `opentrons/history` | No server file at all | 🔴 Critical |
| `top-seal-cutting` | Wrong data shape + missing actions | 🔴 Critical |
| `qa-qc` | Wrong data shape + wrong actions | 🔴 Critical |
| `api/opentrons/history/[runId]` | API route missing entirely | 🔴 Critical |

---

## Test Instructions

### Wax Filling (`/spu/manufacturing/wax-filling?robot=<robotId>`)
1. Navigate with a valid `?robot=` param (get robotId from `/opentrons/devices`)
2. Page should show robot state: Idle (no active run) or the current stage
3. Click "Start Run" → confirmSetup action → stage transitions to Loading
4. Verify settings panel shows `runDurationMin`, `incubatorTempC`, `heaterTempC`, etc.
5. Progress through stages: Loading → Running → Awaiting Removal → QC → Storage

### Wax Filling Equipment (`/spu/manufacturing/wax-filling/equipment`)
1. Should show decks and cooling trays (from Consumables collection)
2. Test "Update Status" for a deck or tray
3. Admin users should see `Add Rejection Code` button

### Wax Filling Oven Queue (`/spu/manufacturing/wax-filling/oven-queue`)
1. Should show completed runs with oven entry times
2. `ready` status should compute based on `minOvenTimeMin` from settings
3. Admin override should work for admins

### Wax Filling Settings (`/spu/manufacturing/wax-filling/settings`)
1. `minOvenTimeMin`, `runDurationMin`, etc. should all show current values
2. Save a setting → `update` action should persist to ManufacturingSettings
3. Add/edit/delete rejection reasons

### Reagent Filling (`/spu/manufacturing/reagent-filling?robot=<robotId>`)
1. Navigate with `?robot=` param
2. If no active run: "Create Run" button → `createRun` action
3. Select assay type → `confirmSetup`
4. Reagent prep → `recordReagentPrep`
5. Deck loading → `loadDeck`
6. Start run → `startRun`
7. Complete filling → `completeRunFilling` → moves to Inspection
8. Inspect cartridges → `completeInspectionBatch` → moves to Top Sealing
9. Create seal batch → `createTopSealBatch`, scan → `scanCartridgeForSeal`, complete → `completeSealBatch`
10. Transition to storage → `transitionToStorage`
11. Record storage → `recordBatchStorage`
12. Complete run → `completeRun`

### Reagent Filling Cooling Queue (`/spu/manufacturing/reagent-filling/cooling-queue`)
1. Should show cartridges in `sealed`, `inspected`, or `reagent_filled` phase
2. `coolingElapsedMin` and `minutesRemaining` should compute from reagentFilling.fillDate

### Reagent Filling Settings (`/spu/manufacturing/reagent-filling/settings`)
1. Save settings → calls `updateSettings` (not `update`)
2. Form fields `fillTime` and `coolingTime` should save properly
3. Create/edit/delete assay types
4. Create/edit/delete rejection reasons

### Opentrons History (`/spu/manufacturing/opentrons/history`)
1. Should show combined wax + reagent run history
2. Filter by process type: All / Wax / Reagent
3. Filter by robot, operator, status, assay type
4. Click a row to expand → calls `/api/opentrons/history/<runId>?type=wax|reagent`
5. Expanded detail shows cartridges, tubes (reagent only), top seal batches

### Top Seal Cutting (`/spu/manufacturing/top-seal-cutting`)
1. Register a new roll → `registerRoll` action
2. Active rolls should show with remaining length progress bar
3. Record a cut → `recordCut` with quantity (strips)
4. Recent cuts table should show cuts from usageLog
5. Retire a roll → `retireRoll` action

### QA/QC (`/spu/manufacturing/qa-qc`)
1. Create a release: requires a completed reagent run ID and a shipping lot ID
2. `create` action should create `qcRelease` subdocument on the ReagentBatchRecord
3. `startTesting` assigns sample cartridge IDs
4. `recordResult` records pass/fail

---

## Remaining Issues Requiring Human Input

### 1. Stage Persistence for Legacy Wax Runs
Existing `WaxFillingRun` documents in the DB have lowercase status values (`'setup'`, `'running'`, etc.). The new code maps these to UI stages, but if someone is mid-run with a legacy status, the stage mapping function may map `'running'` correctly to `'Running'` but miss custom states. **Action needed:** Verify existing in-progress runs display correctly.

### 2. Wax Filling — `RejectionReasonCode` field discrepancy
The `ManufacturingSettings` schema stores `rejectionReasonCodes` but the settings page for wax-filling filters by `processType === 'wax'`. If rejection codes exist in the DB without a `processType` field, they won't appear in wax settings. **Action needed:** Check existing rejection codes and ensure they have correct `processType`.

### 3. Consumable `usageLog.totalLengthUsedFt` not persisted
The top-seal-cutting load reads `remainingBefore - remainingAfter` to compute `totalLengthUsedFt`, which is correct for existing records. New cuts from `recordCut` action store `remainingBefore` and `remainingAfter` (both persist correctly). ✅ No issue.

### 4. Reagent Filling `completeRunFilling` writes `reagentFilling.completedAt` to CartridgeRecord
The CartridgeRecord model doesn't have `reagentFilling.completedAt` — it has `reagentFilling.fillDate`. The cooling-queue server reads `reagentFilling.fillDate`. The `completeRunFilling` action writes `reagentFilling.fillDate: now` which is correct. ✅ No issue.

### 5. QA/QC — Legacy individual cartridge inspection flow
The old `qa-qc/+page.server.ts` had a `release` action that released individual cartridges via `CartridgeRecord.qaqcRelease`. This flow is now replaced with batch releases via `ReagentBatchRecord.qcRelease`. If operators were using the per-cartridge flow, they'll need to transition to the batch flow. **Action needed:** Confirm which QA/QC workflow is correct with the team.

### 6. Top Seal Cutting — Default roll length
The `registerRoll` action uses `settingsDoc?.general?.defaultRollLengthFt ?? 100` as the initial length. If the ManufacturingSettings `general.defaultRollLengthFt` is not set, rolls will be created with 100ft. **Action needed:** Set a default roll length in Manufacturing Settings for top seal cutting.

### 7. Opentrons History — combined pagination
When `processType` is 'all', results from both wax and reagent are fetched separately (with their own `skip/limit`), then merged and re-sorted. This means more data is fetched than shown per page. **This is a performance consideration** for large datasets but functionally correct.

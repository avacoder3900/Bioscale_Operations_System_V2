# PRD: Build Run, IPK Acknowledgment & Step-Level Scrap

## Overview
Add a Build Run workflow that generates a parts checklist when building X SPUs, an IPK (In-Process Kit) placement acknowledgment system for the assembly line, and a step-level discard/scrap action within Work Instructions. Inventory is ONLY deducted during WI assembly scanning — IPKs are acknowledgment-only.

## Background
- SPU assembly currently has no pre-build inventory check — operators discover shortages mid-assembly
- IPKs are physical buckets on the assembly line holding parts, but they have zero system representation
- No way to discard a damaged part during a WI step without retracting the entire scan
- No mechanism to initiate a batch build of X SPUs and track the run end-to-end
- See `docs/SPU-IPK-INVENTORY-AUDIT.md` for full gap analysis

## Key Decisions (Owner-Approved)
1. **IPKs acknowledge placement only** — NO inventory withdrawal at IPK stage
2. **Inventory deduction happens in Work Instructions** — the ONLY deduction point
3. **Discard/scrap is step-dependent** — only available on the WI step that requires the part; step stays open until replacement is scanned
4. **Build checklist gates assembly** — generated when operator requests X SPU builds; shows shortfalls

## Stories

### S1: BuildRun Model
**As a** developer, **I want** a BuildRun model in MongoDB **so that** the system can track batch SPU builds end-to-end.

**Acceptance Criteria:**
- New collection `build_runs` with Mongoose model
- Fields:
  - `_id`: nanoid string
  - `runNumber`: String, auto-generated (e.g., `BR-YYYYMMDD-XXXX`), unique
  - `quantity`: Number (how many SPUs to build)
  - `status`: enum `['checklist', 'ipk_loading', 'assembling', 'completed', 'cancelled']`
  - `batchId`: String (optional, reference to Batch)
  - `checklist[]`: Array of checklist line items (see S2)
  - `ipkAcknowledgments[]`: Array of IPK placement records (see S6)
  - `spuIds`: [String] — SPUs created in this run
  - `assemblySessionIds`: [String] — assembly sessions for this run
  - `createdBy`: { _id, username }
  - `createdAt`, `completedAt`: Date
- Indexes: `runNumber` (unique), `status`, `createdAt`
- `_id` uses `generateId()` (nanoid)
- AuditLog entry on creation

**Technical Notes:**
- File: `src/lib/server/db/models/build-run.ts`
- Export from `src/lib/server/db/models/index.ts`
- No sacred middleware — BuildRun is operational (Tier 2)

### S2: Build Checklist Generation
**As an** operator, **I want** to enter "Build X SPUs" and see a checklist of all parts needed with inventory availability **so that** I know if I have enough stock before starting.

**Acceptance Criteria:**
- New route: `POST /api/build-run/create`
  - Input: `quantity` (number of SPUs)
  - Fetches all BomItem records where `bomType === 'spu'` and `isActive === true`
  - For each BOM item, looks up `PartDefinition` by `partNumber` to get live `inventoryCount`
  - Generates checklist:
    ```
    checklist: [{
      partDefinitionId, partNumber, partName,
      quantityPerUnit,                        // From BomItem
      totalRequired: quantityPerUnit × quantity,
      currentInventory,                       // Live from PartDefinition
      shortfall: max(0, totalRequired - currentInventory),
      verified: false
    }]
    ```
  - Creates BuildRun with `status: 'checklist'`
  - Returns BuildRun with checklist
- Checklist displays:
  - Part number, part name, qty per unit, total needed, in stock, shortfall
  - Visual indicator: checkmark if sufficient, warning if shortfall
  - Total shortfall summary at bottom
- Permission: `assembly:write`
- AuditLog entry on creation

**Technical Notes:**
- Route: `src/routes/api/build-run/+server.ts`
- Always use `await connectDB()` before queries
- Serialize with `JSON.parse(JSON.stringify(...))`

### S3: Build Checklist Verification & Gate
**As an** operator, **I want** to verify the checklist and have the system block me if there's a shortfall **so that** I don't start a build I can't finish.

**Acceptance Criteria:**
- Route: `POST /api/build-run/[runId]/verify`
  - Re-checks live inventory at verification time (not stale snapshot)
  - If ANY line has `shortfall > 0`: returns `{ canProceed: false, shortfalls: [...] }`
  - If all lines have `shortfall === 0`:
    - Sets each checklist item `verified: true`, `verifiedBy`, `verifiedAt`
    - Updates BuildRun `status: 'ipk_loading'`
    - Returns `{ canProceed: true }`
- Operator cannot advance to IPK loading or assembly while shortfalls exist
- Checklist re-verification can be triggered any time (inventory may change between checks)
- Permission: `assembly:write`

### S4: Build Run → Assembly Session Linkage
**As a** developer, **I want** assembly sessions and SPUs linked to their build run **so that** DHR traceability includes the build context.

**Acceptance Criteria:**
- Add `buildRunId` field to AssemblySession model (optional String)
- Add `buildRunId` field to SPU model (optional String)
- When starting assembly from a build run context:
  - Set `assemblySession.buildRunId = buildRunId`
  - Set `spu.buildRunId = buildRunId`
  - Push `spuId` to `buildRun.spuIds[]`
  - Push `sessionId` to `buildRun.assemblySessionIds[]`
- When all SPUs in the run are assembled, set BuildRun `status: 'completed'`, `completedAt: new Date()`

**Technical Notes:**
- Modify: `src/lib/server/db/models/assembly-session.ts` (add field)
- Modify: `src/lib/server/db/models/spu.ts` (add field — schema only, NOT sacred middleware change)
- Modify: `src/routes/assembly/[sessionId]/+page.server.ts` (link on session start)

### S5: Step-Level Discard/Scrap Action
**As an** operator, **I want** to discard a damaged part during a WI step and scan a replacement **so that** I can continue assembly without retracting the entire scan.

**Acceptance Criteria:**
- New form action `discardPart` in `assembly/[sessionId]/+page.server.ts`
- Only available when operator is on a step that has `partRequirements[]`
- Input:
  - `partDefinitionId`: which part is being discarded
  - `reason`: required String (why the part is being scrapped)
  - `stepNumber`: current WI step number
- Behavior:
  1. Validate operator is on a step that requires this part
  2. Look up PartDefinition, get current `inventoryCount`
  3. Deduct: `PartDefinition.updateOne({ $inc: { inventoryCount: -withdrawQty } })`
  4. Create InventoryTransaction:
     ```
     {
       transactionType: 'scrap',
       quantity: -withdrawQty,
       previousQuantity, newQuantity,
       reason: 'Scrapped during assembly step ${stepNumber}: ${reason}',
       performedBy: operator.username
     }
     ```
  5. Log in AssemblySession.stepRecords[]:
     ```
     discardedParts: [{
       partDefinitionId, partNumber, partName,
       reason, quantity: withdrawQty,
       discardedAt: Date,
       discardedBy: { _id, username },
       replacementScanned: false
     }]
     ```
  6. Step remains **incomplete** — does NOT advance `currentStepIndex`
  7. Return `{ success: true, discarded: true, awaitingReplacement: true }`
- After discard, operator scans replacement part via existing `scanPart` action
  - On successful replacement scan, update `discardedParts[].replacementScanned = true`
  - Step completes normally
- If insufficient inventory for replacement: `scanPart` fails with `{ error: 'Insufficient inventory' }`
- Permission: `assembly:write`
- AuditLog entry with action `'assembly_scrap'`

**Technical Notes:**
- Add `discardedParts[]` subdocument to AssemblySession stepRecords schema
- Reuse existing InventoryTransaction model (type 'scrap' already in enum)
- Existing `scanPart` action does not need modification — it already handles deduction + step completion

### S6: InProcessKit Model
**As a** developer, **I want** an IPK model in MongoDB **so that** the system can track physical IPK buckets on the assembly line.

**Acceptance Criteria:**
- New collection `in_process_kits` with Mongoose model
- Fields:
  - `_id`: nanoid string
  - `ipkBarcode`: String, unique, auto-generated (e.g., `IPK-000001`)
  - `ipkLabel`: String (human-readable name, e.g., "IPK-A: Heater Assembly")
  - `linePosition`: String (where on the assembly line, e.g., "Station 1, Slot A")
  - `status`: enum `['empty', 'loaded', 'in_use', 'completed']`
  - `assignedParts[]`: Array of parts this IPK should contain:
    ```
    { partDefinitionId, partNumber, partName, expectedQuantity }
    ```
  - `placementAcknowledgments[]`: Array of load events:
    ```
    {
      acknowledgedAt: Date,
      acknowledgedBy: { _id, username },
      buildRunId: String,
      notes: String
    }
    ```
  - `createdBy`: { _id, username }
  - `createdAt`: Date
- Indexes: `ipkBarcode` (unique), `status`
- Use GeneratedBarcode pattern for `ipkBarcode` generation (prefix: `'IPK'`)
- No sacred middleware — IPK is operational (Tier 2)

**Technical Notes:**
- File: `src/lib/server/db/models/in-process-kit.ts`
- Export from `src/lib/server/db/models/index.ts`
- IPKs are reusable — they persist between builds, only the acknowledgments change

### S7: IPK Placement Acknowledgment
**As an** operator, **I want** to scan/acknowledge that IPKs are loaded on the line for a build run **so that** the system confirms the assembly line is staged.

**Acceptance Criteria:**
- Route: `POST /api/build-run/[runId]/acknowledge-ipk`
  - Input: `ipkId` (which IPK is being acknowledged)
  - Validates BuildRun exists and `status` is `'ipk_loading'` or `'assembling'`
  - Validates IPK exists
  - Pushes to `buildRun.ipkAcknowledgments[]`:
    ```
    { ipkId, acknowledgedAt: new Date(), acknowledgedBy: { _id, username } }
    ```
  - Updates IPK `status: 'loaded'`
  - Does **NOT** deduct inventory
  - Returns `{ success: true }`
- When all expected IPKs are acknowledged, BuildRun can transition to `status: 'assembling'`
- Permission: `assembly:write`
- AuditLog entry with action `'ipk_acknowledged'`

**Technical Notes:**
- Route: `src/routes/api/build-run/[runId]/acknowledge-ipk/+server.ts`
- IPK acknowledgment is purely informational — no inventory side effects

### S8: Build Run Completion & Cancellation
**As an** operator, **I want** to complete or cancel a build run **so that** the run is properly closed out.

**Acceptance Criteria:**
- Route: `POST /api/build-run/[runId]/complete`
  - Validates all SPUs in `spuIds` have `assemblyStatus === 'completed'`
  - Sets BuildRun `status: 'completed'`, `completedAt: new Date()`
  - Sets all associated IPKs `status: 'completed'` then `'empty'` (ready for next run)
  - AuditLog entry
- Route: `POST /api/build-run/[runId]/cancel`
  - Input: `reason` (required)
  - Sets BuildRun `status: 'cancelled'`
  - Does NOT void SPUs that are already assembled
  - Does NOT reverse any inventory transactions (those happened during WI)
  - Resets associated IPKs to `status: 'empty'`
  - AuditLog entry with cancellation reason
- Partial completion: If only 3 of 5 SPUs are built, operator can complete the run with `spuIds` reflecting actual count
- Permission: `assembly:write`

## Implementation Order

```
Phase 1 — Build Checklist + Scrap (enables core workflow)
  S1: BuildRun model
  S2: Checklist generation
  S3: Checklist verification gate
  S4: Build Run ↔ Assembly linkage
  S5: Step-level discard/scrap

Phase 2 — IPK Acknowledgment (adds line organization)
  S6: InProcessKit model
  S7: IPK placement acknowledgment
  S8: Build run completion/cancellation
```

## Out of Scope (Future Work)
- FIFO lot enforcement during WI scanning
- Expiration date blocking during scanning
- Part validation (right part for right step)
- Unified barcode router (part vs. lot vs. IPK vs. SPU)
- Per-lot remaining quantity tracking on ReceivingLot
- Label printer integration for IPK barcodes
- Live inventory updates on checklist (currently re-check on verify)

## Models Summary

| Model | Collection | Tier | New/Modified |
|-------|-----------|------|-------------|
| BuildRun | `build_runs` | Tier 2 (Operational) | New |
| InProcessKit | `in_process_kits` | Tier 2 (Operational) | New |
| AssemblySession | `assembly_sessions` | Tier 2 (Operational) | Modified (+buildRunId) |
| SPU | `spus` | Tier 1 (Sacred) | Modified (+buildRunId, schema only) |
| InventoryTransaction | `inventory_transactions` | Tier 3 (Immutable) | Unchanged (type 'scrap' already exists) |

## Routes Summary

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/build-run` | POST | Create build run + generate checklist |
| `/api/build-run/[runId]` | GET | Get build run with checklist and status |
| `/api/build-run/[runId]/verify` | POST | Re-check inventory, gate for proceeding |
| `/api/build-run/[runId]/acknowledge-ipk` | POST | Record IPK placement (no deduction) |
| `/api/build-run/[runId]/complete` | POST | Close out build run |
| `/api/build-run/[runId]/cancel` | POST | Cancel build run with reason |
| `assembly/[sessionId]` (action: discardPart) | POST | Step-level scrap during assembly |

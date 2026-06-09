# Scanner Automation Plan — Deep Automation of Barcode Scanning into BIMS Manufacturing Workflows

**Status:** Planning / Phase 0 (Audit)  
**Date:** 2026-05-07  
**Scope:** Barcode scanning as the primary input device for floor operations, eliminating keyboard typing and manual confirmation steps.

---

## Executive Summary

The scanner bridges via Python daemon (`scripts/scanner-bridge.py`) on the Lab Mac, posting decoded barcodes to BIMS. Current usage is minimal: operators manually request scans on the test page and must then navigate UI to complete workflows. This plan automates that last mile—scan events directly trigger state transitions, advance cartridges through stages, decrement inventory, and execute predefined workflows without clicking.

**Key insight:** Scanner triggers today are _enqueued_ by the UI (in `ScannerTrigger` docs) and consumed by the daemon. We flip this: the daemon posts barcode data; BIMS parses the barcode format and automatically routes it to the correct workflow without operator clicks.

---

## 1. Current State Audit

### 1.1 Bridge Architecture

**File:** `scripts/scanner-bridge.py`

- **Host:** Lab Mac (USB-connected Waveshare GM-class barcode scanner)
- **Protocol:** Python threads polling BIMS every 500ms for trigger commands
- **Heartbeat:** Every 10s to `/api/agent/scanner/event` with `serialOpen` status
- **Error handling:** Strips fixed ACK (`0x02 0x00 0x00 0x01 0x00 0x33 0x31`); waits 3s per scan, recently increased to 10s

**Environment variables:**
```
SCANNER_DEVICE_ID       = "lab-mac-scanner-1" (logical name)
SCANNER_SERIAL_PORT     = (required, e.g., /dev/tty.usbmodem14101)
BAUD                    = 9600
SCAN_TIMEOUT_S          = 10 (recently increased from 5)
HEARTBEAT_INTERVAL_S    = 10
BIMS_BASE_URL           = (required)
BIMS_AGENT_API_KEY      = (required, shared with mocreo/openclaw)
```

### 1.2 Data Models

**`ScannerEvent`** (`src/lib/server/db/models/scanner-event.ts`)
```typescript
_id: string                    // generateId()
deviceId: string              // "lab-mac-scanner-1"
eventType: enum               // 'scan' | 'heartbeat' | 'error' | 'trigger_consumed'
barcode?: string              // decoded text from scanner
rawPayload?: string           // raw bytes (hex)
source: enum                  // 'test' | 'wax_filling' | 'reagent_filling' | 'manual' | 'unknown'
contextRef?: string           // e.g., cartridgeId, runId
errorMessage?: string         // if eventType='error'
metadata?: Mixed              // { triggerId?, serialOpen?, ... }
receivedAt: Date              // creation timestamp
```

**`ScannerTrigger`** (`src/lib/server/db/models/scanner-trigger.ts`)
```typescript
_id: string
deviceId: string
requestedBy: string           // userId
requestedByUsername: string
source: enum                  // 'test' | 'wax_filling' | 'reagent_filling' | 'manual'
contextRef?: string           // what to scan for
requestedAt: Date
consumedAt?: Date             // null until daemon claims it
```

### 1.3 Barcode Models

**`BarcodeSheetBatch`** — Tracks printed labels
```typescript
_id: string (batch ID, e.g., "2026-04-batch-001")
sheetsUsed: number
labelsPerSheet: number
totalLabels: number
barcodeIds: [string]          // UUIDs (v4) of each barcode printed
status: enum                  // 'printed' | 'partially_used' | 'fully_consumed'
labelsUsed: number            // incremented as CartridgeRecords are created
```

**`BarcodeInventory`** — Supply management
```typescript
_id: "default"
avery94102SheetsOnHand: number
alertThreshold: number        // default 5
lastCountedAt: Date
lastCountedBy: { _id, username }
```

**`GeneratedBarcode`** — Counter for PART-XXXXXX, CART-XXXXXX sequences
```typescript
prefix: string                // 'PART' or 'CART'
sequence: number              // atomic counter
type: string                  // 'part' or 'cartridge'
```

### 1.4 Services

**`barcode-generator.ts`**
- `generateBarcode(prefix, type)` → "PART-000001"
- `generatePartBarcode()`, `generateCartridgeBarcode()`
- `mintCartridgeBarcodes(count)` → [uuid, uuid, ...] with collision checks

**`barcode-consumption.ts`**
- `updateBarcodeConsumption(newCartridgeIds)` — increments `labelsUsed` in batches, updates status

### 1.5 Current Scan Triggers in the System

**Locations where operators initiate scans today:**

1. **Test page** (`/manufacturing/opentron-control/scanner-test`)
   - Manual "Fire Trigger" button → `POST /api/scanner/trigger`
   - Polls `/api/scanner/events` for results
   - No automation; operator reads barcode and must manually navigate next step

2. **Cartridge induction** (likely in `/manufacturing/cv/*` routes)
   - May have a scan button to induct cartridge by barcode
   - Current: likely manual text input or manual scan then form submission

3. **Inventory consumption** (likely in work-instruction pages)
   - When parts are used, operator may scan a barcode
   - Current: unclear if fully wired; may require manual part lookup

4. **Equipment tracking** (cooling trays, decks)
   - Barcode printed on tray/deck; may scan to check out / check in
   - Current: probably not automated; requires manual nav to equipment page

### 1.6 API Routes

**Browser → BIMS (authenticated by user session + permission):**
- `GET /api/scanner/events?deviceId=...&since=...&limit=50` — fetch recent events
- `POST /api/scanner/trigger` — enqueue a scan request
  ```json
  { "deviceId": "lab-mac-scanner-1", "source": "wax_filling", "contextRef": "runId" }
  ```

**Daemon → BIMS (authenticated by AGENT_API_KEY):**
- `POST /api/agent/scanner/event` — post scan/heartbeat/error
- `POST /api/agent/scanner/triggers` — claim pending triggers
  ```json
  { "deviceId": "lab-mac-scanner-1", "max": 5 }
  ```

---

## 2. Pain Points & Automation Opportunities

### 2.1 Current Friction

| Workflow | Today's Steps | Friction |
|----------|---------------|----------|
| Cartridge induction | Scan barcode → Wait for result → Click "Confirm" button → Navigate to next page | 4 clicks; 2-3 page navigations |
| Start wax run after deck scan | Scan deck barcode → Manually select lot → Click "Start" → Scan wax cartridges individually | Multiple scans; lot lookup is manual |
| Mark cartridges QC-passed | Scan each cartridge → Click "Passed" → Move to storage | Per-cartridge click |
| Decrement inventory by part usage | Manually select part → Click decrement → Confirm | No barcode integration |
| Equipment check-in (tray/deck) | Scan barcode → Manually find equipment in UI → Click check-in | 2-step manual nav |

### 2.2 Automation Opportunities

1. **Auto-induct on cartridge barcode scan** (zero-click)
   - Scan cartridge → BIMS checks if barcode exists in `CartridgeRecord`
   - If not exists: create pending induction record, show flash notification
   - If exists: show cartridge details (lot, filling history, current stage)

2. **Auto-advance cartridges through stages on contextual scan**
   - Scan cartridge + contextual barcode (e.g., QC-PASS sticker, STORAGE location)
   - Barcode format: `QC-PASS-XXXXXX` → auto-transition to QC Passed
   - Barcode format: `STORAGE-LOC-FRIDGE-001` → auto-assign storage + transition

3. **Auto-decrement inventory on part scan**
   - Scan part barcode → BIMS looks up part in inventory
   - Part already associated with a run in `CartridgeRecord.partConsumptions`?
   - If not: auto-create consumption transaction, decrement count

4. **Scan-to-workflow chaining**
   - Scan WI barcode (e.g., `WI-01-BATCH-XXXXX`) → launch pre-filling checklist
   - Scan backing lot → auto-check lot against BOM
   - Scan wax tube → auto-record source lot
   - Zero clicking; purely barcode-driven

5. **Batch operations via multi-cart scan**
   - Operator scans a series of cartridge barcodes in rapid succession
   - BIMS batches them into a single state transition (e.g., all 24 → "QC Passed")
   - Reduces per-cartridge confirmation to one "batch commit" action

---

## 3. Proposed Workflow Enhancements

### 3.1 Auto-Induct on Cartridge Scan (No Manual Confirmation)

**Precondition:** Cartridges are printed but not yet inducted into BIMS.

**Flow:**
1. Operator scans a cartridge barcode (UUID format, e.g., `5da7b3c5-4cba-4fe4-93b1-c17ad61efbbf`)
2. BIMS receives event with `barcode: "5da7b3c5-..."` and `source: "wax_filling"` (or inferred from context)
3. Handler checks `CartridgeRecord.findOne({ _id: barcode })`
   - If not found: create `CartridgeRecord` with `_id = barcode`, `status: "pending_induction"`, `inductedAt: now`
   - Show operator: "Cartridge inducted" with lot assignment UI (pre-select default lot if unique)
4. If lot is unique and valid, auto-confirm lot and proceed to next step (assembly)

**Implementation:**
- New field in `CartridgeRecord`: `autoInductedAt: Date` (distinct from `inductedAt`)
- New route: `POST /api/scanner/auto-induct` (no auth needed; uses device auth)
- Handler: parse barcode format, validate UUID, create record, return { success, cartridgeId, nextAction }

### 3.2 Auto-Advance Run Stages on Contextual Scan

**Precondition:** A cartridge is in a known stage (e.g., cooling, ready for QC).

**Barcode Format Convention:**
- `CART-XXXXXX` — standard cartridge barcode (already assigned stage via run context)
- `QC-PASS-XXXXXX` — contextual sticker barcode → transition to "QC Passed"
- `QC-FAIL-XXXXXX` — contextual sticker barcode → transition to "QC Failed" (open CAPA modal)
- `STORAGE-FRIDGE-001` — location barcode → auto-assign storage location + transition

**Flow (QC example):**
1. Operator scans `QC-PASS-5da7b3c5` (cartridge barcode on a "PASS" sticker)
2. BIMS extracts action from prefix (`QC-PASS`)
3. Handler looks up `CartridgeRecord` by barcode suffix, checks current stage
4. If stage == "QC Inspection" and action == "QC-PASS": 
   - Update `qcStatus: "passed"`, `qcAt: now`, `qcBy: { device: "scanner-1", ... }`
   - Auto-transition to "Storage" stage
   - Show "Passed → Moving to storage" flash
5. Operator is never blocked; next cartridge is ready to scan

**Storage example:**
1. Scan location barcode `STORAGE-FRIDGE-001`
2. BIMS extracts location ID `fridge-001`
3. All cartridges in the current "batch" (recent QC-passed) auto-assign to that location
4. Transition all to "Stored"

**Implementation:**
- New field in `CartridgeRecord`: `qcScanSource?: string` (e.g., "sticker", "scanner-test-page")
- Extend barcode parser service: `parseContextualBarcode(barcode: string) → { action, reference, metadata }`
- Routes: `POST /api/scanner/parse`, `POST /api/scanner/auto-advance`

### 3.3 Scan-to-Decrement Inventory

**Precondition:** Operator assembles cartridges using parts from inventory.

**Flow:**
1. In the assembly workstation, operator scans a part barcode (e.g., `PART-000042`)
2. BIMS receives event with `source: "wax_filling"` and `contextRef: <runId>`
3. Handler looks up part in `PartMaster`, then in `CartridgeRecord` consumption records for the active run
4. If part is already assigned to the run: skip (already counted)
5. If new: create `consumption` transaction, decrement `PartMaster.available`, show "Part added to run"

**Consumption model (proposal):**
```typescript
// In CartridgeRecord.partConsumptions (new field)
partConsumptions: [{
  partId: string,
  barcode: string,
  scannedAt: Date,
  scannedBy: { deviceId: string, ... },
  quantity: number = 1
}]
```

**Implementation:**
- Add field to `WaxFillingRun` and `ReagentBatchRecord`: `scannedParts: [{ partId, barcode, scannedAt, ... }]`
- New service: `validatePartScanForRun(partBarcode, runId) → { valid, partId, message }`
- Route: `POST /api/scanner/part-consumption`

### 3.4 Scanner Trigger Configuration UI (`/admin/scanner-triggers`)

**Problem:** `ScannerTrigger` model exists, but there's no admin UI to configure what triggers do.

**Proposal:** New admin page at `/admin/scanner-triggers` for managing rules

**Features:**
- List all active scanner devices (e.g., "lab-mac-scanner-1")
- For each device, display a **rules table**:
  - Barcode pattern (regex, e.g., `^CART-[A-F0-9]{8}$`)
  - Action (enum: `auto_induct`, `auto_advance`, `decrement_inventory`, `check_in_equipment`, `custom_webhook`)
  - Source context (enum: `wax_filling`, `reagent_filling`, `assembly`, `storage`)
  - Enabled: checkbox
  - Test: run pattern against sample barcode

**Rules model (proposal):**
```typescript
ScannerRule = {
  _id: string,
  deviceId: string,
  name: string,                // e.g., "Cartridge QC Pass"
  barcodePattern: string,      // regex
  action: enum,
  actionConfig: Mixed,         // { transition: "qc_passed", ... }
  source: enum,
  enabled: boolean,
  createdBy: { _id, username },
  createdAt: Date,
  lastModifiedAt: Date
}
```

**Routes:**
- `GET /admin/scanner-triggers` — list rules per device
- `POST /admin/scanner-triggers` — create rule
- `PATCH /admin/scanner-triggers/[ruleId]` — update rule
- `DELETE /admin/scanner-triggers/[ruleId]` — disable/delete rule
- `POST /admin/scanner-triggers/test` — test barcode against rule patterns

### 3.5 Scanner Offline Behavior & Buffering

**Current state:** Heartbeat every 10s; if no heartbeat for 60s, scanner marked offline on test page.

**Proposal: Buffering & Retry**

When Lab Mac bridge loses network connection:
1. **Local buffer:** Scanner continues reading barcodes into a local queue (SQLite or file)
2. **Reconnect logic:** When connection is restored, bridge replays buffered events to BIMS
3. **Dedup:** BIMS checks `ScannerEvent.findOne({ deviceId, barcode, receivedAt: { $gte: t-5s } })` to avoid double-posts
4. **Notification:** Operator sees "Scanner offline — X events queued" in UI; once synced, shows "Synced"

**Implementation:**
- Extend `scanner-bridge.py`: add `eventQueue: deque` in memory (or SQLite for persistence)
- On network error, queue event locally; on reconnect, replay queue with exponential backoff
- New fields in `ScannerEvent`: `replayedFrom?: Date` (if buffered)
- New admin endpoint: `GET /admin/scanner/[deviceId]/buffer-status` — show pending events

### 3.6 Operator Feedback Loop (LED Blink + Beep + Toast)

**Current state:** No visual/auditory feedback when scan is recognized; operator must check test page.

**Proposal: Immediate In-Page Feedback**

1. **Visual:** 
   - Green flash on navbar when scan is detected
   - Inline notification with barcode text and action (e.g., "Cartridge inducted: 5da7b3c5...")
   - Auto-dismiss after 3s or on next scan

2. **Auditory:** 
   - Success beep (80 dB, 500ms) when barcode is recognized and action queued
   - Error beep (triple chirp) if barcode invalid or action failed
   - Toggle in preferences: `/settings` → "Scanner beep: [on/off]"

3. **Device LED:**
   - Waveshare scanner has built-in LED; bridge can command LED blink on success
   - Requires firmware check (GM-class supports LED via serial command)

**Implementation:**
- New service: `scannerFeedback(deviceId, status: 'success'|'error') → ScannerFeedbackEvent`
- Bridge: on success, send LED-blink command to scanner
- Frontend: subscribe to `/api/scanner/feedback?deviceId=...` via SSE, show toast

---

## 4. Phased Rollout & Acceptance Criteria

### Phase 0: Foundation (Week 1-2)

**Goal:** Hardened barcode parsing, rules engine, admin console

**Deliverables:**
1. Add `ScannerRule` model and admin page (`/admin/scanner-triggers`)
2. Implement barcode parser service (regex matching, contextual extraction)
3. Unit tests for parser against sample barcodes
4. Add `autoInductedAt` field to `CartridgeRecord`
5. Spike: test-run scanner bridge on Lab Mac with fake events

**Acceptance Criteria:**
- Admin can create/edit/delete rules without errors
- Parser correctly extracts action and reference from 10 sample barcodes
- No orphan ScannerEvent records (all log to DB successfully)
- Barcode pattern validation is enforced (no invalid regex)

### Phase 1: Auto-Induct (Week 3-4)

**Goal:** Cartridges induct themselves when scanned

**Deliverables:**
1. New route: `POST /api/scanner/auto-induct`
2. Handler: parse barcode, check `CartridgeRecord` uniqueness, create record
3. UI: flash notification "Cartridge inducted" with lot assignment
4. Integration test: scan cartridge barcode, verify record created
5. Manual test: operator scans 5 cartridges on lab machine, all induct

**Acceptance Criteria:**
- Scanning a valid cartridge barcode creates a `CartridgeRecord` in < 500ms
- Barcode must be a UUID (enforce in validation)
- Duplicate barcode scan is idempotent (returns existing record, no duplicate)
- Test coverage: ≥ 80% of handler code
- Audit log shows scan + creation with timestamp

### Phase 2: Auto-Advance on Contextual Scan (Week 5-6)

**Goal:** Cartridges transition stages based on contextual sticker barcodes

**Deliverables:**
1. Design contextual barcode format (e.g., `QC-PASS-[cartridgeId]`)
2. Implement barcode parser for contextual patterns
3. Routes: `POST /api/scanner/parse`, `POST /api/scanner/auto-advance`
4. QC workflow: scan `QC-PASS-xxxxx` → auto-transition to passed
5. Storage workflow: scan location code → auto-assign location + transition
6. Operator manual test: scan QC-pass sticker for 10 cartridges, all transition

**Acceptance Criteria:**
- Contextual barcode is parsed correctly in < 300ms
- Valid cartridge in QC stage + valid QC-PASS barcode → transition succeeds
- Invalid barcode or wrong stage → error shown, no state change
- Audit log records who initiated auto-advance (device: scanner-1)
- Batch commit of 24 cartridges < 2s

### Phase 3: Scan-to-Decrement Inventory (Week 7-8)

**Goal:** Parts consumed during assembly automatically decrement

**Deliverables:**
1. Add `partConsumptions: []` field to `WaxFillingRun` / `ReagentBatchRecord`
2. New service: `validatePartScanForRun(partBarcode, runId)`
3. Route: `POST /api/scanner/part-consumption`
4. Integration with existing work-instruction UI (embed scanner trigger button)
5. Manual test: scan 5 different parts during wax assembly, inventory decrements

**Acceptance Criteria:**
- Valid part barcode + active run → consumption created, inventory decremented
- Duplicate part scan → idempotent (not double-decremented)
- Missing part or invalid barcode → error, no inventory change
- Consumption audit trail: barcode, timestamp, scanned-by device
- Inventory transaction created for each part

### Phase 4: Operator Feedback (Week 9)

**Goal:** Operator hears/sees confirmation when scan is successful

**Deliverables:**
1. Extend bridge: on successful parse, send LED-blink command to scanner
2. Frontend: subscribe to feedback events, show toast
3. Settings page: toggle "Scanner beep" on/off
4. Beep audio: success.mp3 (500ms) + error triple-chirp
5. Manual test: scan barcode, confirm LED blinks + beep sounds

**Acceptance Criteria:**
- Scanner LED blinks < 200ms after scan is processed
- Beep plays only if barcode valid and user has beep enabled
- Frontend toast appears < 500ms after beep
- Feedback events dedup on deviceId + barcode within 2s window
- Volume control for beep in settings (0-100%)

### Phase 5: Buffering & Offline Resilience (Week 10)

**Goal:** Scanner queues events during network outages, replays on reconnect

**Deliverables:**
1. Modify bridge: local SQLite queue for buffered events
2. Replay logic: on reconnect, POST queued events in chronological order
3. Dedup: BIMS checks for existing event before inserting
4. Admin page: `/admin/scanner/[deviceId]/buffer-status` shows queued events
5. Manual test: unplug network, scan 10 barcodes, reconnect, verify all posted

**Acceptance Criteria:**
- Bridge buffers events into local queue when network is down
- Replay is atomic per-event (all-or-nothing POST)
- No duplicate events in DB after replay (dedup works)
- Buffer persists across bridge restart (use SQLite, not in-memory)
- Admin can manually clear buffer if needed

### Phase 6: Batch Multi-Cartridge Transitions (Week 11-12)

**Goal:** Scan multiple cartridges in succession, batch-commit them all

**Deliverables:**
1. Batch collection logic: same contextual prefix + 5s window → collect into batch
2. Route: `POST /api/scanner/batch-commit` → transition all cartridges at once
3. UI: show batch preview before commit
4. Manual test: scan 24 cartridges with QC-PASS stickers, all transition in one operation
5. Audit log: one record per batch with all cartridgeIds

**Acceptance Criteria:**
- Batch timeout: 5s of inactivity → auto-commit batch
- Manual commit button: < 1s to process batch of 24 cartridges
- Audit trail shows batch ID + all cartridgeIds + timestamp
- Rollback: if any cartridge fails, entire batch rolls back to pre-commit state
- No orphaned cartridges in intermediate states

---

## 5. Success Metrics

- **Reduction in manual clicks:** From 5 clicks per cartridge to 1 barcode scan
- **Operator time per cartridge:** From 45s to 10s
- **Error rate:** < 0.5% (barcode misparsed or action failed)
- **Scanner uptime:** ≥ 99.5% (including offline buffering)
- **Audit coverage:** 100% of scans logged with deviceId, timestamp, action, outcome

---

## 6. Future Directions & Notes

- **Command mode QRs:** Per memory, Lab Mac may need Command Mode + USB Virtual Port QRs for some scenarios. Clarify if standard cartridge UUIDs suffice or if special format needed.
- **Equipment PDF bundle:** Reference `project_equipment_pdfs_folder` in memory for datasheets.
- **Robot arm integration:** Once robot arm (wax filling) is integrated, auto-advance logic should be robot-agnostic; reuse contextual barcode patterns.
- **Analytics:** Track scan success rate, average time per cartridge, error categories for continuous improvement.
- **Mobile app:** Extend scanner logic to mobile UI for operators on the floor (future phase).

# Opentrons Integration Plan — Tight Coupling of Robot Operations into BIMS Manufacturing Workflows

**Status:** Planning / Phase 0 (Audit)  
**Date:** 2026-05-07  
**Scope:** Opentrons OT-2 robots as first-class BIMS assets, with full operator context inside BIMS (no context-switching to Opentrons App).

---

## Executive Summary

Operators currently use the Opentrons App (standalone desktop client) to manage robot runs, then return to BIMS to record results. This plan integrates robot operations deeply into BIMS: pre-run protocol selection, mid-run status polling, post-run result capture, and error handling all happen in the same UI. By phase 4, operators never leave BIMS to manage a robot run.

**Key insight:** BIMS already has protocol/run routes (`/opentrons/*`), but they're read-only mirrors of the Opentrons API. We extend them to be bidirectional: BIMS sends protocols and parameters to robots, polls status, and pulls completion data automatically.

---

## 1. Current State Audit

### 1.1 Opentrons Router Structure

**File structure:** `src/routes/opentrons/`

The current routes include devices, labware, protocols, and runs. Routes are mostly read-only mirrors of the robot API. Key routes:
- `/opentrons/devices` — List robots with health status
- `/opentrons/runs/new` — Create run (shows protocol details but doesn't start it)
- `/opentrons/runs/[runId]` — View run progress (read-only)

All routes are unauthenticated by robot credentials; BIMS has direct HTTP access to robot IP:port.

### 1.2 Opentrons Robot Model

**File:** `src/lib/server/db/models/opentrons-robot.ts`

The model stores robot metadata:
- Network: ip, port, robotSide
- Hardware: firmwareVersion, apiVersion, robotModel, robotSerial
- Status: lastHealthOk, lastHealthAt
- Embedded protocols: each has opentronsProtocolId, parametersSchema, analysisStatus, labwareDefinitions
- Recent health snapshots: firmware, pipettes, modules, response time

### 1.3 Dual-Identity Issue: OpentronsRobot vs Equipment

Per memory `project_bims_architecture_snapshot`, there are two robot records that can drift:
1. **OpentronsRobot** — Opentrons-specific fields
2. **Equipment** (type: 'robot') — Generic equipment fields

This misalignment creates sync bugs and unclear source of truth. Consolidation is proposed in Phase 5.

### 1.4 Wax/Reagent Filling Runs Reference Robots

Both `WaxFillingRun` and `ReagentBatchRecord` have a `robot: { _id, name }` field and a `robotReleasedAt` timestamp that marks when the OT-2 finishes its work.

The split point is critical:
- **Wax:** Setup → Loading → Running → (OT-2 finishes) → Awaiting Removal → QC → Storage
- **Reagent:** Setup → Loading → Running → (OT-2 finishes) → Inspection → Top Sealing → Storage

After the OT-2 finishes, the robot is free for the next run, but post-processing continues on the cooling/sealing workstations.

### 1.5 Current Routes Behavior

- `/opentrons/devices` — Displays robots but no run management
- `/opentrons/runs/new` — Shows protocol/analysis but doesn't actually start the run
- `/opentrons/runs/[runId]` — Read-only view of robot status
- **Missing:** No route to POST `/api/opentrons/[robotId]/run/start`
- **Missing:** No protocol versioning or approval workflow
- **Missing:** No result capture after run completes

### 1.6 What's Missing

1. **No API route to start a run** — operator must use Opentrons App or curl
2. **No run-result capture** — BIMS never pulls log/summary from robot after run completes
3. **No error handling** — if robot crashes, BIMS doesn't know; no CAPA raised
4. **No protocol parameter binding** — parameters not pre-populated from wax/reagent run context
5. **No run-lifecycle state machine** — unclear who transitions between stages
6. **No dual-run locking** — two operators might start runs on same robot

---

## 2. Hardware-Software Boundaries (Today vs Ideal)

### 2.1 Current State

| Component | Today |
|-----------|-------|
| **OT-2 firmware** | Opentrons-provided, runs protocols natively |
| **OT-2 API** | Exposes `/protocols`, `/runs`, `/health` endpoints |
| **Lab Mac bridge** | None (Opentrons App connects directly) |
| **BIMS** | Reads-only mirrors of robot state |
| **Opentrons App** | Operator's main control center |

### 2.2 Proposed Ideal (Phase 3-4)

| Component | Change |
|-----------|--------|
| **OT-2 firmware** | None |
| **OT-2 API** | None |
| **Lab Mac bridge** | Optional relay for firewall/auth |
| **BIMS** | **Becomes primary control**: send protocols, start runs, poll status |
| **Opentrons App** | Demoted to fallback/monitor-only |

**Key principle:** BIMS is the source of truth for manufacturing intent. The robot is the source of truth for execution state. BIMS polls frequently and stays synchronized.

---

## 3. Workflow Integration Points

### 3.1 Pre-Run: Protocol Selection & Reservation

**Proposed flow:**
1. Operator creates a WaxFillingRun (setup → loading stage)
2. BIMS auto-selects protocol based on fill type + cartridge count
3. BIMS reserves the robot (no other run can start for 1 hour)
4. BIMS pre-fills protocol parameters from run context (wax temp, fill volume, deck positions)
5. Operator clicks [Start Run] → BIMS POSTs protocol + parameters to robot API
6. Robot API returns run ID; BIMS stores it in WaxFillingRun.robotRunId
7. UI transitions to "Running" stage, polling robot every 5s

**Implementation:**
- New service: `selectProtocolForRun(runType, cartridgeCount, fillParams) → protocolId`
- New route: `POST /api/opentrons/[robotId]/run/start`
- New fields in run models: `robotRunId`, `protocolVersionUsed`, `boundParameters`

### 3.2 Mid-Run: Status Polling & Live Updates

**Proposed flow:**
1. BIMS polls robot `/api/runs/[runId]` every 5s during "Running" stage
2. Caches result in `WaxFillingRun.robotStatus`
3. UI displays: current command #N of M, estimated time remaining, temperature gauges
4. If robot errors (e.g., pipette crash), BIMS detects and raises BimsAnomaly
5. Operator can abort or retry (if error is transient)

**Implementation:**
- New cron job: `poll-robot-status` every 5s during manufacturing
- New service: `detectRobotError(robotStatus) → BimsAnomaly | null`
- Frontend: SSE or WebSocket for real-time status updates

### 3.3 Post-Run: Result Capture & Completion

**Proposed flow:**
1. Robot completes (state: 'succeeded')
2. BIMS polls and detects success
3. BIMS fetches run log: `GET /api/runs/[runId]/logs`
4. Writes logs to WaxFillingRun.robotLog
5. Auto-transitions to "Awaiting Removal" (wax) or "Inspection" (reagent)
6. Operator sees "Run completed. Deck removal required." modal
7. Operator scans deck barcode or clicks "Deck Removed" → proceeds to QC/Storage

**Benefit:** Eliminates manual "run is done" confirmation; BIMS knows immediately.

**Implementation:**
- Extend status polling: on success, fetch logs + write to robotLog
- Auto-transition logic in WaxFillingRun.update() or via RunStateMachine service

### 3.4 Error Handling: Robot Crash → CAPA

**Proposed flow:**
1. Mid-run, robot enters 'error' state (pipette stuck, deck collision, etc.)
2. BIMS polls and detects error
3. BIMS creates BimsAnomaly with type: "robot_run_failure"
4. QA dashboard shows alert
5. Operator can: Investigate → Resume Run, or Abort Run + Create CAPA
6. BIMS records decision in WaxFillingRun.abortReason + AuditLog

**Implementation:**
- Extend BimsAnomaly model with robot-specific fields
- New route: `POST /api/opentrons/[robotId]/run/[runId]/abort`
- New route: `POST /api/opentrons/[robotId]/run/[runId]/resume`

---

## 4. Run Lifecycle State Machine

### 4.1 Proposed States (Wax Filling)

```
[Pending]
    ↓ (operator clicks "Start Run")
[Protocol Selected]
    ↓ (BIMS validates + POSTs to robot API)
[Robot Waiting]
    ↓ (operator loads deck + confirms)
[Loaded]
    ↓ (BIMS POSTs /run/start to robot)
[Running]
    ├→ (on success) [Robot Complete]
    │              ↓ (auto-transition)
    │              [Awaiting Removal]
    │              ↓ (operator scans/confirms)
    │              [Cooling]
    │              ↓ (timer expires)
    │              [QC]
    │              ├→ [QC Passed] → [Storage] → [Complete]
    │              └→ [QC Failed] → [Aborted]
    │
    └→ (on error) [Robot Error]
                   ├→ [Resumable] (operator clicks "Resume")
                   │   ↓
                   │   [Running]
                   │
                   └→ [Aborted] (operator clicks "Abort" or timeout)
```

**Invariants:**
- Robot is locked from "Protocol Selected" until "Robot Complete"
- After "Robot Complete", robot is freed (even if post-processing continues)
- Terminal states: Aborted, Complete

### 4.2 State Transition Rules

| From | To | Trigger | Who | Preconditions |
|-----|----|---------|----|---|
| Protocol Selected | Robot Waiting | BIMS POSTs `/run/start` to robot | System | Deck validated; protocol uploaded |
| Robot Waiting | Loaded | Operator clicks "Confirm Loaded" | Operator | Manual confirmation |
| Loaded | Running | BIMS POSTs `/run/[runId]/start` | System | Robot ready |
| Running | Robot Complete | Robot state polls to 'succeeded' | System | Robot completed |
| Robot Complete | Awaiting Removal | Auto-transition + BIMS pulls logs | System | No manual action |
| Running | Robot Error | Robot state polls to 'error' | System | Error detected |
| Robot Error | Running | Operator clicks "Resume" | Operator | If transient |
| Running | Aborted | Operator clicks "Abort" | Operator | Graceful shutdown |

### 4.3 Implementation: RunStateMachine Service

```typescript
class RunStateMachine {
  async transitionWaxFillingRun(
    runId: string,
    action: 'select_protocol' | 'confirm_loaded' | 'start_robot' | 'resume' | 'abort',
    userId: string
  ): Promise<{ success: boolean, newStatus: string, error?: string }> {
    // Lookup current state
    // Check if action is allowed from current state
    // Execute action (POST to robot API, fetch logs, etc.)
    // Write audit log
    // Return new status
  }
}
```

---

## 5. Protocol Management & Versioning

### 5.1 Today's State

- Protocols are embedded in OpentronsRobot.protocols[]
- No version history; old versions are lost if updated
- No binding between protocol parameters and run context

### 5.2 Proposed: Protocol as First-Class Asset

**New collection:** `OpentronsProtocol`

```typescript
{
  _id: string,                  // e.g., "proto-wax-fill-24-v2"
  name: string,
  type: enum,                   // 'wax_fill' | 'reagent_fill' | 'custom'
  version: string,              // semantic: "2.1.3"
  parametersSchema: JSONSchema, // JSON schema for run parameters
  defaultParameters: Mixed,
  createdBy: { _id, username },
  approvedBy?: { _id, username },
  approvedAt?: Date,            // QA sign-off required before production
  protocolFile: Binary,         // actual .py/.json file
  tags: [string]                // e.g., ["production", "wax", "v2.1"]
}
```

### 5.3 Protocol Binding to Runs

**New fields in WaxFillingRun/ReagentBatchRecord:**

```typescript
protocolVersionUsed: string     // "2.1.3"
boundParameters: {
  cartridgeCount: number,
  waxTemp: number,
  fillVolume: number,
  deckLayout: { column1, column2, column3 }
}
parameterValidationResult: {
  isValid: boolean,
  errors: [string],
  checkedAt: Date
}
```

### 5.4 Routes for Protocol Management

**Admin:**
- `GET /admin/opentrons/protocols` — list protocols
- `POST /admin/opentrons/protocols` — upload + version
- `PATCH /admin/opentrons/protocols/[protocolId]` — update
- `POST /admin/opentrons/protocols/[protocolId]/approve` — QA sign-off

**Manufacturing:**
- `GET /api/opentrons/[robotId]/protocols/compatible` — list compatible protocols
- `POST /api/opentrons/[robotId]/run/validate-parameters` — check if parameters valid

---

## 6. Dual-Identity Consolidation (Phase 5)

### 6.1 The Problem

Robot state is split between OpentronsRobot and Equipment (type: 'robot'), causing:
- Sync bugs when one is updated without the other
- Unclear source of truth
- Duplicate queries

### 6.2 Proposed: Single `Robot` Model

Create unified `Robot` model with:
- Identity: name, type (ot2, robot_arm), barcode, serial
- Network: ip, port, url
- Status: available, running, maintenance, offline, retired
- Operational: isActive, lastHealthOk, currentRunId, reservedUntil
- Protocols: embedded or referenced
- Audit: registeredAt, registeredBy, maintenanceSchedule, retiredAt

**Migration:**
1. Phase 1: Introduce new model alongside old ones
2. Phase 2: Dual-write (every update writes to both)
3. Phase 3: Cutover to new model
4. Phase 4: Archive old collections

---

## 7. Phased Rollout & Acceptance Criteria

### Phase 0: Foundation (Week 1-2)

**Goal:** Infrastructure for robot polling, protocol management, state machine

**Deliverables:**
1. Implement `RunStateMachine` service
2. Create `OpentronsProtocol` model + admin page
3. Add `robotRunId`, `protocolVersionUsed`, `boundParameters` fields
4. Spike: test polling robot APIs
5. Create cron job stub

**Acceptance Criteria:**
- State machine correctly rejects invalid transitions
- Protocol model stores parametersSchema as JSON Schema
- Admin can upload protocol + approve
- Test fixtures for mock robot responses exist

### Phase 1: Protocol Selection & Reservation (Week 3-4)

**Goal:** BIMS auto-selects protocol and reserves robot

**Deliverables:**
1. Service: `selectProtocolForRun(runType, cartridgeCount) → protocolId`
2. Route: `POST /api/opentrons/[robotId]/reserve`
3. UI: "Protocol selected: v2.1.3. [Start Run]"
4. Integration test: wax run → protocol auto-selected

**Acceptance Criteria:**
- Protocol selection is deterministic
- Robot reservation is exclusive (no concurrent runs)
- Parameters match run context

### Phase 2: Run Start & Polling (Week 5-6)

**Goal:** BIMS starts run, polls status every 5s

**Deliverables:**
1. Route: `POST /api/opentrons/[robotId]/run/start`
2. Cron: `poll-robot-status` every 5s
3. UI: real-time progress (command #N/M, ETA)
4. Manual test: operator starts wax run, sees live progress

**Acceptance Criteria:**
- Protocol uploads < 2s
- Run starts < 1s after protocol ready
- Status polling resilient (retry + backoff)
- UI updates < 500ms after poll

### Phase 3: Result Capture (Week 7-8)

**Goal:** When robot finishes, pull logs + auto-transition

**Deliverables:**
1. Extend polling: on success, fetch `/runs/[runId]/logs`
2. Auto-transition to post-OT-2 stage
3. Release robot for next run
4. UI: auto-show "Deck Removal Required" modal

**Acceptance Criteria:**
- Logs captured < 5s after robot finishes
- Auto-transition < 1s
- Robot released for reuse immediately

### Phase 4: Error Detection & CAPA (Week 9-10)

**Goal:** Detect robot errors, raise anomalies, support CAPA

**Deliverables:**
1. Detect `robotStatus.state == 'error'`
2. Create `BimsAnomaly` with full context
3. UI modal: "Run Failed. [Resume] [Abort] [Investigate]"
4. Support pause/resume/abort via robot API
5. Manual test: simulate robot error, verify anomaly

**Acceptance Criteria:**
- Error detected < 10s
- BimsAnomaly created with full context
- Operator can resume/abort with audit trail
- CAPA created on abort request

### Phase 5: Model Consolidation (Week 11-12)

**Goal:** Merge OpentronsRobot + Equipment into single Robot model

**Deliverables:**
1. Create unified `Robot` model
2. Dual-write: updates to old models also write to new
3. Migrate reads to new model
4. Verify no state divergence for 1 week

**Acceptance Criteria:**
- No divergence during dual-write
- All tests pass with new model
- No performance regression
- Rollback plan ready

### Phase 6: Operator Feedback & Safety (Week 13-14)

**Goal:** Real-time telemetry + pre-flight checks prevent unsafe transitions

**Deliverables:**
1. Pre-flight checks: "Deck clear? Oven ready?"
2. Live telemetry: pipette position, temps, modules
3. Red banner if robot offline during run
4. Manual test: try to start with invalid state, verify blocked

**Acceptance Criteria:**
- Pre-flight checks prevent 100% of unsafe attempts
- Operator sees clear error messages
- Real-time telemetry < 500ms latency
- No race conditions on rapid clicks

---

## 8. Success Metrics

- **Operator context-switching:** From 2 tools (BIMS + Opentrons App) to 1 (BIMS)
- **Error detection latency:** From operator-manual to < 10s automated
- **Audit coverage:** 100% of robot actions logged
- **CAPA rate:** Track systematic error capture

---

## 9. Future: Robot Arm Support

Design protocol/run APIs to be robot-agnostic using adapter pattern:

```typescript
interface RobotRunControl {
  startRun(protocol, parameters): Promise<runId>
  getStatus(runId): Promise<status>
  pauseRun(runId): Promise<void>
  abortRun(runId): Promise<void>
  getLogs(runId): Promise<logs>
}

class OT2RunController implements RobotRunControl { ... }
class RobotArmRunController implements RobotRunControl { ... }
```

This allows BIMS to treat any robot uniformly, enabling future robot arm integration without refactoring the state machine or workflows.

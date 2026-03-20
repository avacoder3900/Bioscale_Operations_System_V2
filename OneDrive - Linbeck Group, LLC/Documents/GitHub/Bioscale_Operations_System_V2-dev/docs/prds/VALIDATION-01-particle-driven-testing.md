# VALIDATION-01: Particle-Driven SPU Validation Testing

## Overview
Enable the BIMS to trigger validation tests (magnetometer, spectrophotometer, thermocouple) on SPU devices via the Particle Cloud API, receive results back, and display pass/fail with configurable acceptance criteria.

## Current State
- **404 on magnetometer test session** — `[sessionId]/+page.server.ts` is missing (no server load function)
- Validation pages exist but are disconnected from actual hardware
- `ValidationSession` and `GeneratedBarcode` models exist in DB
- `particle.ts` has `listDevices`, `getDevice`, `pingDevice`, `renameDevice` — but NO function calling or variable reading
- Particle access token is stored in `Integration` collection but may expire (OAuth, 60-min lifetime)
- No webhook endpoint for Particle events
- No test criteria/thresholds defined in the system

## Infrastructure Needed

### 1. Particle API Layer (New Functions in `particle.ts`)

| Function | Particle API | Purpose |
|----------|-------------|---------|
| `callFunction(deviceId, functionName, arg)` | `POST /v1/devices/:id/:fn` | Trigger a test on the device |
| `getVariable(deviceId, variableName)` | `GET /v1/devices/:id/:var` | Read test result from device |
| `getDeviceInfo(deviceId)` | `GET /v1/devices/:id` | List available functions & variables on a device |
| `subscribeToEvents(deviceId, eventPrefix)` | `GET /v1/devices/:id/events/:prefix` (SSE) | Real-time event stream from device |

**Token refresh**: The current `particleFetch()` needs automatic token refresh when it gets a 401. The refresh token is stored in the Integration doc.

### 2. Webhook Endpoint for Test Results

**Route**: `POST /api/particle/webhook` (already exists but needs expansion)

**Flow**:
```
Device runs test → publishes event (e.g., "mag_test_complete") →
Particle Cloud → webhook POST to BIMS → BIMS stores result → updates ValidationSession
```

**Webhook payload** (from Particle):
```json
{
  "event": "mag_test_complete",
  "data": "{\"magX\":1.23,\"magY\":4.56,\"magZ\":7.89,\"temp\":25.3}",
  "coreid": "0a10aced202194944a0719d4",
  "published_at": "2026-03-05T20:00:00Z"
}
```

**Webhook must**:
- Validate request is from Particle (shared secret or IP allowlist)
- Parse JSON data from the `data` string field
- Match `coreid` → SPU via `particleLink.particleDeviceId`
- Find active `ValidationSession` for that SPU
- Store raw data in `ValidationResult`
- Run pass/fail evaluation against criteria
- Update `ValidationSession` status

### 3. Test Criteria System (New Model)

**`TestCriteria` model** — defines what pass/fail means for each test type:

```typescript
{
  _id: string,
  testType: 'magnetometer' | 'spectrophotometer' | 'thermocouple',
  name: string,           // e.g., "Magnetometer Field Strength"
  version: number,        // criteria versioning for audit trail
  criteria: [
    {
      parameter: string,  // e.g., "magX", "magY", "magZ"
      unit: string,       // e.g., "mT", "nm", "°C"
      min: number | null,
      max: number | null,
      target: number | null,
      tolerance: number | null,  // ± from target
      required: boolean
    }
  ],
  active: boolean,
  createdBy: string,
  createdAt: Date,
  updatedAt: Date
}
```

**Admin page**: `/spu/validation/criteria` — CRUD for test criteria (admin-only)

### 4. Validation Flow (End-to-End)

```
┌─────────────────────────────────────────────────────────────┐
│  BIMS (Browser)                                              │
│                                                              │
│  1. Operator selects SPU → clicks "Start Mag Test"           │
│  2. BIMS calls server action                                 │
│     └→ server: callFunction(deviceId, "runMagTest", "")      │
│  3. UI shows "Test Running..." with spinner                  │
│  4. Device runs test (~5-30 seconds)                         │
│                                                              │
│  TWO PATHS FOR RESULTS:                                      │
│                                                              │
│  Path A (Webhook - preferred):                               │
│  5a. Device publishes event → Particle → webhook → DB        │
│  6a. Browser polls /api/validation/status/:sessionId         │
│      OR uses Server-Sent Events for real-time update         │
│  7a. Results appear, pass/fail evaluated                     │
│                                                              │
│  Path B (Polling - fallback):                                │
│  5b. Browser polls getVariable(deviceId, "testResult")       │
│      every 2 seconds until result available                  │
│  6b. Server stores result + evaluates criteria               │
│  7b. Results appear, pass/fail evaluated                     │
└─────────────────────────────────────────────────────────────┘
```

### 5. Updated Models

**`ValidationSession`** (update existing):
```typescript
{
  _id: string,
  type: 'mag' | 'spectro' | 'thermo',
  status: 'pending' | 'running' | 'completed' | 'failed' | 'timed_out',
  spuId: string,                    // ← NEW: link to SPU
  particleDeviceId: string,         // ← NEW: which device ran the test
  testCriteriaId: string,           // ← NEW: which criteria version was used
  startedAt: Date,
  completedAt: Date | null,
  userId: string,
  generatedBarcodeId: string,
  rawData: Record<string, any>,     // ← NEW: raw device output
  results: [{
    parameter: string,
    value: number,
    unit: string,
    min: number | null,
    max: number | null,
    passed: boolean
  }],
  overallPassed: boolean | null,    // ← NEW: computed from all criteria
  notes: string,
  timeoutSeconds: number            // ← NEW: configurable per test type
}
```

**`ValidationResult`** — may not be needed separately if results live on the session. Evaluate during implementation.

### 6. SPU Detail Page Integration

On each SPU's detail page, add a **Validation History** section:
- Shows all validation sessions for that SPU
- Latest result prominently displayed (green ✓ / red ✗)
- Link to full session detail
- "Run Test" button (only if SPU's Particle device is online)

### 7. Device Online Status

Before allowing a test to start:
- Ping the device via `pingDevice()`
- Show online/offline status next to the test button
- If offline: disable button, show "Device offline" message
- If online: show last seen timestamp + signal strength (if available)

---

## Stories

### Phase 1: Fix What's Broken + Infrastructure

#### VAL-01-S1: Fix Magnetometer 404
- Add missing `src/routes/spu/validation/magnetometer/[sessionId]/+page.server.ts`
- Load session data, result data, user info
- Match pattern from existing working pages (spectro/thermo)

#### VAL-01-S2: Particle Function Calling
- Add `callFunction(deviceId, functionName, arg)` to `particle.ts`
- Add `getVariable(deviceId, variableName)` to `particle.ts`
- Add `getDeviceInfo(deviceId)` to `particle.ts` (returns functions + variables list)
- Add automatic token refresh on 401 in `particleFetch()`

#### VAL-01-S3: Particle Webhook Expansion
- Expand `POST /api/particle/webhook` to handle test result events
- Parse event data JSON
- Match `coreid` → SPU
- Find active validation session
- Store raw data + individual parameter results
- Evaluate pass/fail against criteria
- Update session status

#### VAL-01-S4: Test Criteria Model + Admin Page
- Create `TestCriteria` mongoose model
- Seed default criteria for magnetometer (placeholder values — team defines real thresholds later)
- Admin page at `/spu/validation/criteria`: list, create, edit, version history
- Criteria are immutable once used in a session (create new version instead)

### Phase 2: Test Execution Flow

#### VAL-01-S5: Start Test from BIMS
- Update magnetometer page: select SPU → call `callFunction` to trigger test
- Show device online status before starting
- Create `ValidationSession` with status `running`
- UI: spinner + "Test in progress..." message
- Timeout: configurable (default 60 seconds), auto-fail if no result

#### VAL-01-S6: Results Display + Pass/Fail
- After webhook delivers result (or polling detects it):
- Show each parameter: name, value, unit, min/max range, pass/fail badge
- Overall result: green PASS or red FAIL banner
- Raw data expandable for debugging
- Store `testCriteriaId` on session for audit trail (which version of criteria was used)

#### VAL-01-S7: SPU Detail Validation History
- Add "Validation" section to SPU detail page
- Show latest test result (pass/fail badge + date)
- Table of all sessions: date, type, result, operator
- "Run Test" button if device is online
- Badge on SPU dashboard cards showing validation status

### Phase 3: Polish + Other Test Types

#### VAL-01-S8: Spectrophotometer Test Flow
- Same pattern as magnetometer but with spectro-specific criteria
- Different Particle function name + event prefix
- Different result parameters (wavelength, intensity, etc.)

#### VAL-01-S9: Thermocouple Test Flow
- Same pattern but with temperature-specific criteria
- Temperature range validation
- Multi-point calibration check

#### VAL-01-S10: Validation Dashboard
- `/spu/validation` overview page upgrade:
- Stats cards: total tests today, pass rate, devices tested
- Filter by test type, date range, operator
- Export results as CSV

---

## Open Questions for Alejandro

1. **What Particle functions are currently exposed on the BT-M01 firmware?** (e.g., `runMagTest`, `runSpectroTest`?) — I need the exact function names and expected arguments
2. **What event names does the device publish when a test completes?** (e.g., `mag_result`, `test_complete`?) — needed for webhook routing
3. **What variables does the device expose?** (e.g., `magX`, `magY`, `lastTestResult`?) — needed for polling fallback
4. **What are the actual acceptance criteria thresholds?** (ranges for magnetometer, spectro, thermocouple) — we can seed placeholders and update later
5. **Test duration** — how long does each test type take? (seconds? minutes?)
6. **Can one device run multiple test types**, or does each SPU only run one type of test?
7. **Particle token refresh** — is there a refresh token stored, or does the user need to re-authenticate when the token expires?

## Technical Notes
- Particle access tokens expire every 60 minutes (OAuth). Need refresh flow or long-lived token.
- Webhook URL must be publicly accessible (Vercel handles this).
- Particle webhook must be configured in Particle Console → Integrations → Webhook.
- Consider using Particle SSE instead of polling for real-time results (better UX, less load).
- All test results are immutable once stored (audit requirement for CLSI compliance).

## Out of Scope (Future)
- Batch testing (run same test on multiple SPUs sequentially)
- Automated test scheduling (cron-based)
- Test result trending/analytics over time
- Firmware update from BIMS
- Multi-device simultaneous testing

# VALIDATION-02: Magnetometer Validation Dashboard

## Overview
Rebuild the magnetometer validation page as an SPU-organized dashboard that reads test results from Particle devices via `getVariable()`, stores every result as an immutable `ValidationSession`, and provides full test history per SPU with auto-polling.

## Architecture
- **Data source:** `getVariable(deviceId, 'magnet_validation')` via Particle Cloud API
- **Storage:** `validation_sessions` collection (append-only, never overwrite)
- **No webhooks, no firmware changes, no Particle.publish() usage**
- **Detection of new tests:** Compare timestamp in filename (e.g., `/validation/magnet-1772655738.txt`) to last stored session

## Data Format (from device)
The `magnet_validation` variable returns a tab-delimited string:
```
/validation/magnet-{TIMESTAMP}.txt
         Channel A           Channel B           Channel C
Well   T     X      Y      Z     T     X      Y      Z     T     X     Y      Z
1    45.9  -209.0  -93.0  4164  45.8  -51.0  -120.0  4292  46.1  5.0  -24.0  4200
2    42.8  -87.0  -141.0  4324  44.1   15.0  -138.0  4364  45.6  37.0  -13.0  4252
...
```
- 5 wells, 3 channels (A/B/C), 4 values each (T, X, Y, Z)
- **Z values are the pass/fail metric** (default range: 3900-4500, editable)
- Timestamp in filename identifies unique test runs

## Existing Code
- `src/lib/server/particle.ts` — has `getVariable(deviceId, variableName)` and `callFunction(deviceId, fn, arg)`
- `src/routes/spu/validation/magnetometer/+page.server.ts` — current page with `startTest`, `readFromDevice`, `updateCriteria` actions
- `src/routes/spu/validation/magnetometer/+page.svelte` — current UI with SPU selector, criteria editor, recent sessions list
- `src/routes/spu/validation/magnetometer/[sessionId]/+page.server.ts` — session detail with `readResults` action
- `src/routes/spu/validation/magnetometer/[sessionId]/+page.svelte` — Z-value table, pass/fail display
- `src/lib/server/db/models/validation-session.ts` — model with fields: `type, status, spuId, spuUdi, particleDeviceId, rawData, magResults, overallPassed, failureReasons, criteriaUsed`
- Pass/fail criteria stored in `integrations` collection (`type: 'mag_criteria'`, fields: `minZ`, `maxZ`)

## Stories

### VAL-02-S1: SPU Dashboard View (Main Page Rewrite)
**File:** `src/routes/spu/validation/magnetometer/+page.svelte` and `+page.server.ts`

Replace the current page with an SPU-organized dashboard:
- Load all SPUs that have `particleLink.particleDeviceId`
- For each SPU, find the most recent `ValidationSession` (type: 'mag', spuId matches)
- Display as a grid/list of SPU cards showing:
  - SPU UDI (e.g., `BT-M01-0000-0210`)
  - Latest test status: ✅ PASS / ❌ FAIL / ⚪ UNTESTED
  - Date of last test
  - Number of total tests run
- Cards sorted: FAIL first, then UNTESTED, then PASS
- Click any card → navigate to `/spu/validation/magnetometer/[spuId]` (history page)
- Keep the editable criteria section (minZ/maxZ) at the top
- Keep stats cards (total tests, passed, failed)

**Server load function should:**
```typescript
// 1. Get all SPUs with particle links
// 2. Get the latest ValidationSession per SPU (aggregate: group by spuId, sort by createdAt desc, take first)
// 3. Get criteria from Integration collection
// 4. Return: spus[] with latestTest info, criteria, stats
```

### VAL-02-S2: SPU Test History Page
**New file:** `src/routes/spu/validation/magnetometer/spu/[spuId]/+page.server.ts` and `+page.svelte`

Full test history for a single SPU:
- Header: SPU UDI, current status, device online/offline indicator
- "Read Latest from Device" button — reads `magnet_validation`, creates new ValidationSession if timestamp differs from last stored
- "Run Test on Device" button — calls `run_test` function on the device
- Chronological list of all ValidationSessions for this SPU (newest first)
- Each entry shows: date, pass/fail badge, summary (e.g., "5/5 wells passed" or "2 failures")
- Click any entry → navigate to existing `[sessionId]` detail page

**Server load function should:**
```typescript
// 1. Find SPU by ID, get particleDeviceId
// 2. Find all ValidationSessions for this SPU, sorted by createdAt desc
// 3. Return: spu info, sessions[], criteria
```

**Actions:**
- `readLatest` — reads `magnet_validation` from device, compares timestamp to last stored session. If new: parse, evaluate, store new session. If same: return message "No new test data."
- `runTest` — calls `run_test` on device, creates session with status 'running'

### VAL-02-S3: Auto-Poll Mode
**File:** `src/routes/spu/validation/magnetometer/spu/[spuId]/+page.svelte` (client-side)

Add "Start Monitoring" toggle on the SPU history page:
- When enabled: client-side JS calls `/api/validation/poll/[spuId]` every 5 seconds
- API endpoint reads `magnet_validation` from device, checks if timestamp is new
- If new data: auto-creates ValidationSession, returns results, page updates reactively
- If same data: returns `{ noNewData: true }`
- Visual indicator: pulsing green dot when monitoring is active
- Auto-stop after 5 minutes of no new data (with option to restart)
- Stop button to manually disable

**New API route:** `src/routes/api/validation/poll/[spuId]/+server.ts`
```typescript
// GET handler:
// 1. Find SPU, get particleDeviceId
// 2. Read magnet_validation from device
// 3. Extract timestamp from filename
// 4. Compare to latest stored ValidationSession for this SPU
// 5. If new: parse, evaluate against criteria, store, return { newSession: true, sessionId, passed }
// 6. If same: return { newSession: false }
```

### VAL-02-S4: Timestamp-Based Dedup
**File:** `src/lib/server/particle-validation.ts` (new shared module)

Extract shared logic into a reusable module:
- `parseMagValidation(raw: string)` — parse tab-delimited data into structured wells array
- `extractTimestamp(raw: string)` — extract timestamp from filename (`/validation/magnet-{TS}.txt`)
- `evaluateCriteria(wells, minZ, maxZ)` — return `{ overallPassed, failureReasons }`
- `readAndStoreIfNew(spuId, particleDeviceId)` — full flow: read variable, check timestamp, store if new

The timestamp comparison prevents duplicate sessions:
- Each ValidationSession stores `deviceTimestamp` (extracted from filename)
- Before creating a new session, check if one already exists with that exact timestamp for that SPU
- If exists → skip (return existing session)
- If not → create new session

### VAL-02-S5: Session Detail Page Update
**File:** `src/routes/spu/validation/magnetometer/[sessionId]/+page.svelte`

Update the existing session detail page:
- Add "Back to SPU History" link (in addition to existing "Back to Magnetometer Tests")
- Show which criteria version was used for this test (minZ/maxZ at time of evaluation)
- Show device timestamp from filename
- Keep existing: Z-value table, pass/fail colors, failure details, raw data expandable, session info

---

## Implementation Notes

### Dedup Strategy
The `magnet_validation` variable on the device gets overwritten each time a new test runs. The filename includes a Unix timestamp:
- `/validation/magnet-1772655738.txt`
- This number is unique per test run
- Store as `deviceTimestamp` on ValidationSession
- Unique index on `{ spuId, deviceTimestamp, type: 'mag' }` prevents duplicates

### Particle API Rate Limits
- Particle Cloud API: ~10 requests/second per access token
- Auto-poll at 5-second intervals for a single device is well within limits
- If monitoring multiple devices simultaneously, stagger the requests

### Existing parseMagValidation Function
Already exists in both `+page.server.ts` files — extract into shared module (S4) to avoid duplication.

## File Structure After Implementation
```
src/routes/spu/validation/magnetometer/
├── +page.server.ts          ← SPU dashboard (S1)
├── +page.svelte              ← SPU card grid (S1)
├── spu/
│   └── [spuId]/
│       ├── +page.server.ts   ← SPU history + actions (S2)
│       └── +page.svelte      ← History list + monitoring (S2, S3)
├── [sessionId]/
│   ├── +page.server.ts       ← Session detail (S5, existing)
│   └── +page.svelte          ← Z-value table (S5, existing)
src/routes/api/validation/
└── poll/
    └── [spuId]/
        └── +server.ts        ← Auto-poll endpoint (S3)
src/lib/server/
└── particle-validation.ts    ← Shared parse/evaluate/dedup (S4)
```

## Priority Order
1. **S4** — Shared module (unblocks everything, dedup logic)
2. **S1** — SPU dashboard (main page rewrite)
3. **S2** — SPU history page (drill-in)
4. **S5** — Session detail update (small)
5. **S3** — Auto-poll (polish)

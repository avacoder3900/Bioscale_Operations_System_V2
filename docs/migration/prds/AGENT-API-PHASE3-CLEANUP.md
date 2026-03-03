# AGENT-API-PHASE3 — P3 Cleanup & Hardening

## Overview
**Domain:** Agent API Model Cleanup & Validation Hardening
**Priority:** P3
**Dependencies:** Phase 1 & Phase 2 complete
**Files Modified:** `src/lib/server/db/models/agent-query.ts`, `src/lib/server/db/models/schema-metadata.ts`, `src/routes/api/agent/approvals/+server.ts`

---

## Story CLEAN-01: Rename sqlTemplate to mongoQuery, tableName to collectionName

### Description
The AgentQuery and SchemaMetadata models still use Postgres-era field names. Rename them to MongoDB-appropriate names.

### Changes

#### AgentQuery Model (`src/lib/server/db/models/agent-query.ts`)
- `sqlTemplate` → `mongoQuery` (type: Mixed, stores base MongoDB filter object)
- Add `collectionName` field (String, required for new queries)
- Keep `sqlTemplate` as deprecated alias for backward compatibility reading

#### SchemaMetadata Model (`src/lib/server/db/models/schema-metadata.ts`)
- `tableName` → `collectionName`
- Keep `tableName` as virtual getter for backward compatibility

#### Agent Root Endpoint (`src/routes/api/agent/+server.ts`)
- Update schema action response to use `collectionName`

#### Query Endpoint (`src/routes/api/agent/query/+server.ts`)
- Read from `collectionName` field (already done in Phase 1 SEC-05)

### Acceptance Criteria
- New field names used in all new code
- Existing seeded data still works
- Contract tests pass

---

## Story CLEAN-02: Fix Approvals PATCH Enum Validation

### Description
The PATCH `/api/agent/approvals` endpoint accepts any string for the `action` field without validation. Add validation against the model's enum.

### Current Problem
```typescript
// No validation — any action string is accepted
if (action === 'approved') { ... }
else if (action === 'rejected') { ... }
// But 'foobar' silently succeeds with no status change
```

### Implementation
1. Validate `action` against allowed enum: `['requested', 'reviewed', 'approved', 'rejected', 'escalated', 'cancelled', 'commented']`
2. Return 400 with `{ success: false, error: 'Invalid action. Must be one of: ...' }` for invalid values

### Acceptance Criteria
- Invalid action values return 400
- Valid actions still work correctly
- Contract tests pass

---

## Story CLEAN-03: Add Finalization Check on Already-Approved Requests

### Description
The approvals PATCH endpoint allows re-approving already-approved/rejected/cancelled requests. Add a guard to prevent status changes on terminal-state requests.

### Current Problem
```typescript
// No guard — can approve an already-rejected request
const doc = await ApprovalRequest.findByIdAndUpdate(approvalId, update, { new: true });
```

### Implementation
1. Fetch the approval request first with `findById()`
2. Check if status is terminal: `approved`, `rejected`, `cancelled`, `expired`
3. If terminal, return 400: `{ success: false, error: 'Cannot modify approval in terminal state: <status>' }`
4. Only then apply the update

### Acceptance Criteria
- Cannot change status of approved/rejected/cancelled/expired requests
- Attempting to modify terminal requests returns 400
- The `commented` action is still allowed on terminal requests (appends to history without status change)
- Contract tests pass

# AGENT-API-PHASE1 — P0 Security & P1 Infrastructure

## Overview
**Domain:** Agent API Security Hardening & Infrastructure
**Priority:** P0 (Security), P1 (Infrastructure)
**Dependencies:** All agent API endpoints exist as stubs or partial implementations
**Files Modified:** All files in `src/routes/api/agent/`, new `src/lib/server/api-auth.ts`

---

## Story SEC-01: Extract requireApiKey() into Shared Middleware

### Description
Every agent API file duplicates a `requireApiKey()` function. Extract it into a shared module at `src/lib/server/api-auth.ts` with timing-safe comparison using `crypto.timingSafeEqual`.

### Current Problem
- 15+ copies of `requireApiKey()` duplicated across agent API files
- Simple `===` string comparison is vulnerable to timing attacks
- No shared module for API auth

### Implementation
1. Create `src/lib/server/api-auth.ts` with:
   - `requireAgentApiKey(request: Request): void` — throws 401 if invalid
   - Uses `crypto.timingSafeEqual` for comparison
   - Accepts headers: `x-api-key`, `x-agent-api-key`, `authorization: Bearer`
2. Update ALL agent API files to import from shared module
3. Remove all inline `requireApiKey()` functions

### Acceptance Criteria
- Single source of truth for API key validation
- Timing-safe comparison prevents key extraction via timing attacks
- All existing contract tests still pass

---

## Story SEC-02: Fix NoSQL Injection in /query POST

### Description
The `/api/agent/query` POST endpoint passes user-supplied `parameters` directly into `collection.find(filter)` with no sanitization. An attacker can inject MongoDB operators (`$gt`, `$regex`, `$where`) to extract data from any collection.

### Current Problem
```typescript
// VULNERABLE: user controls both keys and values
const filter: any = {};
if (parameters) {
    for (const [key, value] of Object.entries(parameters)) {
        filter[key] = value; // { "$gt": "" } extracts all docs
    }
}
const results = await collection.find(filter).limit(maxRows).toArray();
```

### Implementation
1. **Whitelist collections** — only allow queries against known safe collections:
   ```
   kanban_tasks, kanban_projects, customers, equipment, equipment_locations,
   documents, part_definitions, bom_items, spus, production_runs, lot_records,
   shipping_lots, shipping_packages, test_results, audit_log
   ```
2. **Sanitize parameters** — strip any key starting with `$` or containing `.` (prevents operator injection and path traversal)
3. **Validate parameter values** — only allow string, number, boolean primitives (reject objects/arrays that could contain operators)
4. **Add query execution AuditLog entry** (covered in SEC-03)

### Acceptance Criteria
- `{ "$gt": "" }` in parameters is rejected
- Unknown collection names are rejected with 400
- Only primitive filter values accepted
- Existing query tests still pass

---

## Story SEC-03: Add AuditLog to ALL Mutating Endpoints

### Description
All mutating agent API endpoints (POST/PATCH) must create AuditLog entries. Currently zero audit logging exists in the agent API.

### Mutating Endpoints
1. `POST /api/agent/approvals` — create approval request
2. `PATCH /api/agent/approvals` — update approval status
3. `POST /api/agent/messages` — send message
4. `PATCH /api/agent/messages` — update message status
5. `POST /api/agent/query` — execute query (read, but should log execution)
6. `POST /api/agent/query/seed` — seed query data

### AuditLog Format
```typescript
await AuditLog.create({
    _id: generateId(),
    tableName: 'approval_requests', // or 'agent_messages', etc.
    recordId: record._id,
    action: 'INSERT', // or 'UPDATE'
    newData: { /* relevant fields */ },
    changedAt: new Date(),
    changedBy: 'agent-api',
    reason: 'Agent API operation'
});
```

### Acceptance Criteria
- Every POST/PATCH in agent API creates an AuditLog entry
- AuditLog includes tableName, recordId, action, changedBy, timestamp

---

## Story SEC-04: Standardize Response Envelopes

### Description
Standardize ALL agent API responses to use `{ success: true, data: {...} }` envelope. Currently some endpoints use this, others return raw data.

### Inconsistent Endpoints (need fixing)
| Endpoint | Current Response | Target |
|----------|-----------------|--------|
| `GET /api/agent` (health) | `{ status, timestamp, version }` | `{ success: true, data: { status, timestamp, version } }` |
| `GET /api/agent` (schema) | `{ collections: [...] }` | `{ success: true, data: { collections: [...] } }` |
| `GET /api/agent/approvals` | `{ approvals, pagination }` | `{ success: true, data: { approvals, pagination } }` |
| `POST /api/agent/approvals` | `{ id, status }` | `{ success: true, data: { id, status } }` |
| `PATCH /api/agent/approvals` | `{ id, status }` | `{ success: true, data: { id, status } }` |
| `GET /api/agent/messages` | `{ success, messages, pagination }` | `{ success: true, data: { messages, pagination } }` |
| `POST /api/agent/messages` | `{ id, status }` | `{ success: true, data: { id, status } }` |
| `PATCH /api/agent/messages` | `{ id, status }` | `{ success: true, data: { id, status } }` |
| `GET /api/agent/query` | `{ queries }` | `{ success: true, data: { queries } }` |
| `POST /api/agent/query` | `{ queryId, queryName, ... }` | `{ success: true, data: { queryId, queryName, ... } }` |
| `GET /api/agent/dependencies` | `{ dependencies }` | `{ success: true, data: { dependencies } }` |
| `GET /api/agent/operations` | raw metrics | `{ success: true, data: { ... } }` |

### Already Correct
- All stub endpoints (`alerts`, `context`, `dashboard`, etc.) already use `{ success: true, data: {} }`
- `health/+server.ts`, `system/+server.ts`, `schema/+server.ts` stubs are correct

### Error Envelope
```typescript
{ success: false, error: 'Error message' }
```

### Acceptance Criteria
- Every agent API response uses `{ success, data }` or `{ success, error }` envelope
- Contract tests updated if needed

---

## Story SEC-05: Replace SQL Template Parser with MongoDB Query Structure

### Description
The query POST endpoint parses `sqlTemplate` field using regex `FROM\s+(\w+)` — a Postgres remnant. Replace with a proper `mongoQuery` field structure on the AgentQuery model.

### Current Problem
```typescript
const template = query.sqlTemplate || '';
const collectionMatch = template.match(/FROM\s+(\w+)/i);
```

### Implementation
1. In `query/+server.ts`, read from `query.collectionName` (or fall back to `query.sqlTemplate` regex for backward compat)
2. Use `query.mongoQuery` if available for the base filter, merge with user parameters
3. This is a transitional change — Phase 3 will rename the model fields

### Acceptance Criteria
- Query execution uses `collectionName` directly when available
- Falls back to sqlTemplate parsing for legacy data
- Existing tests pass

# DOMAIN-11-AGENT-API — AI Agent Integration & Admin APIs

## Overview
**Domain:** Agent Queries, Schema Metadata, Messaging, Operations API, Approvals, System Dependencies
**Dependencies:** Auth, all other domains (this domain reads from everything)
**MongoDB Collections:** `agent_queries`, `schema_metadata`, `agent_messages`, `routing_patterns`, `approval_requests`, `system_dependencies`, `audit_log`
**Test File:** `tests/contracts/11-agent-api.test.ts` (16 tests)
**Contract Registry Sections:** API Routes (agent/*), Admin APIs

---

## Story AGENT-01: Health, Schema & System Endpoints

### Description
Implement the core agent API endpoints — health check, schema introspection, and system status.

### Routes Covered
- `GET/POST /api/agent/health` — health check
- `GET /api/agent/schema` — schema metadata (requires API key)
- `GET /api/agent/system` — system status (requires API key)

### Contract References
**GET /api/agent/health returns:**
```typescript
{ success: true, data: { status: string, ... } }
```

**GET /api/agent/schema returns:**
```typescript
{ success: true, data: { tables: SchemaMetadata[], ... } }
```

**GET /api/agent/system returns:**
```typescript
{ success: true, data: { ... system info ... } }
```

### MongoDB Models Used
- `SchemaMetadata` — `SchemaMetadata.find()` for schema introspection
- `SystemDependency` — for system info

### Auth Notes
- Agent APIs use `X-API-Key` header authentication, NOT session cookies
- API key is validated against env var `AGENT_API_KEY`

### Acceptance Criteria
- Tests 1-3 in `11-agent-api.test.ts` pass (health, schema, system)

---

## Story AGENT-02: Messages & Query Engine

### Description
Implement agent messaging and the natural language query engine.

### Routes Covered
- `GET /api/agent/messages` — list messages (requires userId param)
- `POST /api/agent/messages` — send message
- `GET /api/agent/query` — requires API key
- `POST /api/agent/query/seed` — seed query data

### Contract References
**GET /api/agent/messages returns:**
```typescript
// Without userId: { success: false, error: '...' } (400)
// With userId: { success: true, data: { messages: AgentMessage[] } }
```

### MongoDB Models Used
- `AgentMessage` — CRUD. Fields: `fromUserId`, `toUserId`, `messageType`, `subject`, `content`, `priority`, `status`, etc.
- `AgentQuery` — query templates for natural language query engine
- `RoutingPattern` — routing rules for message delivery

### Acceptance Criteria
- Tests 4-5, 15-16 in `11-agent-api.test.ts` pass (messages without userId returns 400, messages with userId returns data, query requires API key, query/seed endpoint)

---

## Story AGENT-03: Operations Dashboard & Domain APIs

### Description
Implement the operations API endpoints that provide cross-domain summary data for the agent.

### Routes Covered
- `GET /api/agent/operations/dashboard` — operations dashboard
- `GET /api/agent/operations/context` — operational context
- `GET /api/agent/operations/kanban/board-snapshot` — kanban board snapshot
- `GET /api/agent/operations/equipment` — equipment summary
- `GET /api/agent/operations/inventory` — inventory summary
- `GET /api/agent/operations/projects` — project summary
- `GET /api/agent/operations/documents` — document summary
- `GET /api/agent/operations/alerts` — system alerts
- `GET /api/agent/operations/quality/trends` — quality trends

### Contract References
All operations endpoints return:
```typescript
{ success: true, data: { ... domain-specific summary ... } }
```

### MongoDB Models Used
This story queries across ALL collections to build summary views:
- `KanbanTask`, `KanbanProject` — board snapshot
- `Equipment` — equipment summary
- `PartDefinition`, `BomItem`, `InventoryTransaction` — inventory
- `Document`, `WorkInstruction` — documents
- Various aggregations for alerts and trends

### MongoDB-Specific Notes
- These are read-only aggregation queries across multiple collections
- Old code used SQL joins extensively — new code uses separate Mongoose queries or `$lookup` aggregation
- Dashboard: combine recent activity from audit_log, task counts, inventory alerts, equipment status

### Acceptance Criteria
- Tests 6-14 in `11-agent-api.test.ts` pass (dashboard, context, kanban, equipment, inventory, projects, documents, alerts, quality trends)

---

## Story AGENT-04: Approvals & Admin APIs

### Description
Implement the approval workflow system and admin utility APIs.

### Routes Covered
- `/api/agent/approval/*` — approval request CRUD
- `POST /admin/add-schema-permission` — add schema permission
- `POST /admin/create-schema-table` — create schema table
- `POST /admin/seed-schema` — seed schema metadata
- `POST /api/admin/fix-permissions` — fix permission issues
- `GET /admin/agent-activity` — (already built in AUTH-07, verify integration)

### Contract References
Approval request structure:
```typescript
{
  _id: string, requesterId: string, changeTitle: string, changeDescription: string,
  changeType: 'code' | 'configuration' | 'infrastructure' | 'process' | 'documentation' | 'database',
  priority: 'low' | 'normal' | 'high' | 'urgent' | 'emergency',
  status: 'pending' | 'in_review' | 'approved' | 'rejected' | 'cancelled' | 'expired',
  history: { _id: string, stakeholderId: string, action: string, comments?: string, timestamp: Date }[]
}
```

### MongoDB Models Used
- `ApprovalRequest` — with **embedded** `history[]`
- `SchemaMetadata` — for admin schema operations
- `User`, `Role` — for permission fixes

### MongoDB-Specific Notes
- Approval history is embedded: `approvalRequest.history[]`
- Old code: `ApprovalRequest` + `ApprovalHistory` — merged
- Admin APIs are utility endpoints — may need special auth handling

### Acceptance Criteria
- Approval CRUD works
- Admin utility APIs function
- All 16 tests in `11-agent-api.test.ts` pass

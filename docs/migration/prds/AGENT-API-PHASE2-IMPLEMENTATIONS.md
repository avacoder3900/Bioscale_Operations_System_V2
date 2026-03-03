# AGENT-API-PHASE2 — P2 Stub Implementations

## Overview
**Domain:** Agent API Operations Endpoints
**Priority:** P2
**Dependencies:** Phase 1 complete (shared auth, response envelopes, audit logging)
**Files Modified:** All `src/routes/api/agent/operations/` stubs, `query/seed`, `schema`

---

## Story IMPL-01: Board Snapshot Endpoint

### Description
Implement `GET /api/agent/operations/kanban/board-snapshot` to return the full kanban board state — columns with tasks, assignee data, and transition history.

### Route
`GET /api/agent/operations/kanban/board-snapshot`

### Implementation
1. Query `KanbanProject.find({ isActive: true })` for project list
2. Query `KanbanTask.find({ archived: { $ne: true } })` for active tasks
3. Group tasks by `status` column: `backlog`, `ready`, `wip`, `waiting`, `done`
4. Include assignee data, project info, priority, due dates
5. Include recent activity log entries per task (last 5)

### Response Shape
```typescript
{
    success: true,
    data: {
        projects: [{ id, name, color }],
        columns: [
            { status: 'backlog', tasks: [{ id, title, status, priority, assignee, project, dueDate, tags, activityLog }] },
            ...
        ],
        summary: { total, byStatus: { backlog: N, ready: N, ... } }
    }
}
```

### Models Used
- `KanbanTask`, `KanbanProject`

### Acceptance Criteria
- Returns board state grouped by column
- Includes project info and assignee details
- Contract test passes

---

## Story IMPL-02: Dashboard Endpoint

### Description
Implement `GET /api/agent/operations/dashboard` to return a cross-domain operations dashboard with recent activity, task counts, equipment status, and inventory alerts.

### Route
`GET /api/agent/operations/dashboard`

### Implementation
Query across multiple collections in parallel:
1. `KanbanTask` — count by status, recent tasks
2. `Equipment` — count by status (active/maintenance/offline)
3. `PartDefinition` — low stock alerts (inventoryCount <= 0 for active parts)
4. `ProductionRun` — active runs count
5. `AuditLog` — 10 most recent entries
6. `ApprovalRequest` — pending approvals count

### Response Shape
```typescript
{
    success: true,
    data: {
        tasks: { total, byStatus: {...}, recent: [...] },
        equipment: { total, byStatus: {...} },
        inventory: { lowStockCount, totalParts },
        production: { activeRuns },
        recentActivity: [...],
        pendingApprovals: N
    }
}
```

### Models Used
- `KanbanTask`, `Equipment`, `PartDefinition`, `ProductionRun`, `AuditLog`, `ApprovalRequest`

### Acceptance Criteria
- Returns cross-domain summary
- All counts are accurate
- Contract test passes

---

## Story IMPL-03: Context Endpoint

### Description
Implement `GET /api/agent/operations/context` to return operational context for agent decision-making — active projects, current user activity, system health signals.

### Route
`GET /api/agent/operations/context`

### Implementation
1. `KanbanProject.find({ isActive: true })` — active projects
2. `KanbanTask.find({ status: 'wip' })` — work in progress
3. `Equipment.find({ status: { $ne: 'active' } })` — equipment needing attention
4. `ApprovalRequest.find({ status: 'pending' })` — pending decisions
5. `AgentMessage.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(10)` — undelivered messages

### Response Shape
```typescript
{
    success: true,
    data: {
        activeProjects: [...],
        workInProgress: [...],
        equipmentAlerts: [...],
        pendingApprovals: [...],
        pendingMessages: [...]
    }
}
```

### Models Used
- `KanbanProject`, `KanbanTask`, `Equipment`, `ApprovalRequest`, `AgentMessage`

### Acceptance Criteria
- Returns actionable operational context
- Contract test passes

---

## Story IMPL-04: Equipment Endpoint

### Description
Implement `GET /api/agent/operations/equipment` to return equipment status summary.

### Route
`GET /api/agent/operations/equipment`

### Implementation
1. Query `Equipment.find().lean()` — all equipment
2. Query `EquipmentLocation.find().lean()` — all locations
3. Return grouped by type and status

### Response Shape
```typescript
{
    success: true,
    data: {
        equipment: [{ id, name, type, location, status, temperatureC, lastReadAt }],
        locations: [{ id, name }],
        summary: { total, active, maintenance, offline }
    }
}
```

### Models Used
- `Equipment`, `EquipmentLocation`

### Acceptance Criteria
- Returns all equipment with status
- Contract test passes

---

## Story IMPL-05: Inventory Endpoint

### Description
Implement `GET /api/agent/operations/inventory` to return inventory summary.

### Route
`GET /api/agent/operations/inventory`

### Implementation
1. Query `PartDefinition.find({ isActive: true }).lean()`
2. Calculate low stock: parts where `inventoryCount <= 0`
3. Query `BomItem.countDocuments()` for BOM stats

### Response Shape
```typescript
{
    success: true,
    data: {
        parts: [{ id, partNumber, name, category, inventoryCount, unitOfMeasure }],
        summary: { totalParts, lowStockCount, categories: [...] },
        bomItemCount: N
    }
}
```

### Models Used
- `PartDefinition`, `BomItem`

### Acceptance Criteria
- Returns inventory with low stock alerts
- Contract test passes

---

## Story IMPL-06: Documents Endpoint

### Description
Implement `GET /api/agent/operations/documents` to return document status summary.

### Route
`GET /api/agent/operations/documents`

### Implementation
1. Query `Document.find().select('_id documentNumber title category status currentRevision createdAt').lean()`
2. Query `WorkInstruction.find().select('_id title isActive currentVersion createdAt').lean()`

### Response Shape
```typescript
{
    success: true,
    data: {
        documents: [{ id, documentNumber, title, category, status, currentRevision }],
        workInstructions: [{ id, title, isActive, currentVersion }],
        summary: { totalDocs, byStatus: {...}, totalWorkInstructions }
    }
}
```

### Models Used
- `Document`, `WorkInstruction`

### Acceptance Criteria
- Returns document and work instruction summaries
- Contract test passes

---

## Story IMPL-07: Projects Endpoint

### Description
Implement `GET /api/agent/operations/projects` to return project summary with task counts.

### Route
`GET /api/agent/operations/projects`

### Implementation
1. Query `KanbanProject.find().lean()`
2. Aggregate `KanbanTask` by project to get task counts per status

### Response Shape
```typescript
{
    success: true,
    data: {
        projects: [{
            id, name, color, isActive,
            taskCounts: { total, backlog, ready, wip, waiting, done }
        }]
    }
}
```

### Models Used
- `KanbanProject`, `KanbanTask`

### Acceptance Criteria
- Returns projects with task count breakdown
- Contract test passes

---

## Story IMPL-08: Alerts Endpoint

### Description
Implement `GET /api/agent/operations/alerts` to return system alerts — low stock, equipment issues, overdue tasks, pending approvals.

### Route
`GET /api/agent/operations/alerts`

### Implementation
Generate alerts from multiple sources:
1. Low stock parts (`inventoryCount <= 0` on active PartDefinitions)
2. Equipment offline/maintenance
3. Overdue kanban tasks (dueDate < now, status != done)
4. Pending approvals older than 24h
5. Failed messages

### Response Shape
```typescript
{
    success: true,
    data: {
        alerts: [{
            type: 'low_stock' | 'equipment_issue' | 'overdue_task' | 'pending_approval' | 'failed_message',
            severity: 'info' | 'warning' | 'critical',
            message: string,
            entityId: string,
            entityType: string,
            createdAt: string
        }],
        summary: { total, bySeverity: { info, warning, critical } }
    }
}
```

### Models Used
- `PartDefinition`, `Equipment`, `KanbanTask`, `ApprovalRequest`, `AgentMessage`

### Acceptance Criteria
- Returns alerts from multiple sources
- Alerts sorted by severity (critical first)
- Contract test passes

---

## Story IMPL-09: Quality Trends Endpoint

### Description
Implement `GET /api/agent/operations/quality/trends` to return quality metrics and trends.

### Route
`GET /api/agent/operations/quality/trends`

### Implementation
1. Aggregate `TestResult` by status for pass/fail rates
2. Aggregate `CartridgeRecord` by phase for pipeline throughput
3. Get recent `WaxFillingRun` completion rates

### Response Shape
```typescript
{
    success: true,
    data: {
        testResults: { total, passed, failed, passRate },
        cartridgePipeline: { byPhase: {...} },
        recentTrends: [{ date, passRate, volume }]
    }
}
```

### Models Used
- `TestResult`, `CartridgeRecord`, `WaxFillingRun`

### Acceptance Criteria
- Returns quality metrics with trend data
- Contract test passes

---

## Story IMPL-10: Schema & Query Seed Endpoints

### Description
Implement real schema metadata listing and query seed functionality.

### Routes
- `GET /api/agent/schema` (standalone) — return real schema metadata
- `POST /api/agent/query/seed` — seed AgentQuery and SchemaMetadata collections

### Implementation

#### Schema (GET)
Query `SchemaMetadata.find().lean()` and return all collection metadata.

#### Query Seed (POST)
1. Upsert `SchemaMetadata` entries for all 53 collections with businessName, businessPurpose, businessDomain
2. Upsert `AgentQuery` entries for common queries (inventory check, production status, quality metrics, etc.)
3. Return count of seeded records

### Response Shape
```typescript
// Schema
{ success: true, data: { collections: [...] } }

// Seed
{ success: true, data: { schemaMetadata: N, agentQueries: N } }
```

### Models Used
- `SchemaMetadata`, `AgentQuery`

### Acceptance Criteria
- Schema returns real collection metadata
- Seed creates/updates metadata entries
- Contract tests pass

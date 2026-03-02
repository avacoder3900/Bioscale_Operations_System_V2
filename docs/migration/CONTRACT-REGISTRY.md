# CONTRACT-REGISTRY.md — Bioscale Operations System

> **Purpose:** Complete data contract between UI and server layers. Used by coding agents to rebuild the server layer with MongoDB. Agents will NOT read the old Postgres/Drizzle code — only this document.
>
> **Generated:** 2026-02-27

---

# Table of Contents

1. [Layout Data (inherited by all routes)](#layout-data)
2. [Auth Routes](#auth-routes)
3. [Document Control Routes](#document-control-routes)
4. [Kanban Routes](#kanban-routes)
5. [Opentrons Lab Routes](#opentrons-lab-routes)
6. [SPU Core Routes](#spu-core-routes)
7. [SPU Admin Routes](#spu-admin-routes)
8. [SPU Assay Routes](#spu-assay-routes)
9. [SPU Assembly Routes](#spu-assembly-routes)
10. [SPU Batch Routes](#spu-batch-routes)
11. [SPU BOM Routes](#spu-bom-routes)
12. [SPU Cartridge Admin Routes](#spu-cartridge-admin-routes)
13. [SPU Cartridge Routes](#spu-cartridge-routes)
14. [SPU Customer Routes](#spu-customer-routes)
15. [SPU Device Routes](#spu-device-routes)
16. [SPU Document Routes](#spu-document-routes)
17. [SPU Equipment Routes](#spu-equipment-routes)
18. [SPU Inventory Routes](#spu-inventory-routes)
19. [SPU Manufacturing Routes](#spu-manufacturing-routes)
20. [SPU Parts Routes](#spu-parts-routes)
21. [SPU Shipping Routes](#spu-shipping-routes)
22. [SPU Test Results Routes](#spu-test-results-routes)
23. [SPU Validation Routes](#spu-validation-routes)
24. [API Routes (Server Endpoints)](#api-routes)
25. [Shared Server Utilities](#shared-server-utilities)

---

# Layout Data

## Root Layout: `src/routes/+layout.server.ts`
No root layout.server.ts exists — auth is handled by hooks.server.ts which populates `locals.user` and `locals.session`.

## SPU Layout: `src/routes/spu/+layout.server.ts`
**Inherited by ALL `/spu/*` routes.**

```typescript
{
  user: User // locals.user object (id, username, etc.)
  canAccessDocuments: boolean
  canAccessInventory: boolean
  canAccessCartridges: boolean
  canAccessAssays: boolean
  canAccessDevices: boolean
  canAccessTestResults: boolean
  canAccessAdmin: boolean
  isBoxConnected: boolean
  particleStatus: 'connected' | 'stale' | 'disconnected'
}
```

## Documents Layout: `src/routes/documents/+layout.server.ts`
**Inherited by ALL `/documents/*` routes.**
```typescript
{
  user: User
  permissions: {
    canRead: boolean
    canWrite: boolean
    canApprove: boolean
    canTrain: boolean
  }
}
```

## Kanban Layout: `src/routes/kanban/+layout.server.ts`
**Inherited by ALL `/kanban/*` routes.**
```typescript
{
  user: User
  projects: {
    id: string
    name: string
    description: string | null
    color: string
    isActive: boolean
    sortOrder: number
    createdBy: string | null
  }[]
  users: { id: string, username: string }[]
}
```

## Opentrons Layout: `src/routes/opentrons/+layout.server.ts`
**Inherited by ALL `/opentrons/*` routes.**
```typescript
{
  user: { id: string, username: string }
}
```

## SPU Admin Layout: `src/routes/spu/admin/+layout.server.ts`
**Inherited by ALL `/spu/admin/*` routes.**
```typescript
{
  canManageUsers: boolean
  canManageRoles: boolean
}
```

## SPU Cartridge Admin Layout: `src/routes/spu/cartridge-admin/+layout.server.ts`
**Inherited by ALL `/spu/cartridge-admin/*` routes.**
```typescript
{
  user: User
}
```

## SPU Documents Layout: `src/routes/spu/documents/+layout.server.ts`
**Inherited by ALL `/spu/documents/*` routes.**
```typescript
{
  user: User
  permissions: {
    canReadInstructions: boolean
    canWriteInstructions: boolean
    canApproveInstructions: boolean
    canReadDocuments: boolean
    canWriteDocuments: boolean
    canReadProductionRuns: boolean
  }
}
```

## SPU Manufacturing Layout: `src/routes/spu/manufacturing/+layout.server.ts`
**Inherited by ALL `/spu/manufacturing/*` routes.**
```typescript
{
  user: User
  isAdmin: boolean
  processConfigs: {
    configId: string
    processName: string
    processType: string
  }[]
}
```

## SPU Manufacturing Reagent Filling Layout: `src/routes/spu/manufacturing/reagent-filling/+layout.server.ts`
**Inherited by ALL `/spu/manufacturing/reagent-filling/*` routes.**
```typescript
{
  user: User
  robots: {
    robotId: string
    name: string
    description: string | null
    isActive: boolean
    sortOrder: number
  }[]
  dashboardState: {
    robotId: string
    name: string
    description: string | null
    hasActiveRun: boolean
    runId: string | null
    stage: string | null
    assayTypeName: string | null
    runStartTime: string | null
    runEndTime: string | null
    cartridgeCount: number
    postRobotRuns: {
      runId: string
      stage: string
      assayTypeName: string | null
      cartridgeCount: number | null
      runStartTime: string | null
      runEndTime: string | null
    }[]
  }[]
}
```

## SPU Manufacturing Wax Filling Layout: `src/routes/spu/manufacturing/wax-filling/+layout.server.ts`
**Inherited by ALL `/spu/manufacturing/wax-filling/*` routes.**
```typescript
{
  user: User
  robots: {
    robotId: string
    name: string
    description: string | null
    isActive: boolean
    sortOrder: number
  }[]
  dashboardState: {
    robotId: string
    name: string
    description: string | null
    hasActiveRun: boolean
    runId: string | null
    stage: string | null
    assayTypeName: string | null
    runStartTime: string | null
    runEndTime: string | null
    cartridgeCount: number
    postRobotRuns: {
      runId: string
      stage: string
      assayTypeName: string | null
      cartridgeCount: number | null
      runStartTime: string | null
      runEndTime: string | null
    }[]
  }[]
}
```

---

# Auth Routes

---

## Route: /login

**File:** `src/routes/login/+page.server.ts`

### Load Function Returns
```typescript
{} // empty object; redirects to /spu if already logged in
```

### Form Actions
**default**
- Accepts: `{ username: string, password: string }`
- Returns on success: `redirect(302, '/spu')`
- Returns on failure: `fail(400, { error: string })`
- Side effects: Creates session, sets session cookie, updates lastLoginAt

---

## Route: /logout

**File:** `src/routes/logout/+page.server.ts`

### Load Function Returns
Redirects to `/` immediately.

### Form Actions
**default**
- Accepts: nothing
- Returns: `redirect(302, '/login')`
- Side effects: Invalidates session, deletes session cookie

---

## Route: /invite/accept

**File:** `src/routes/invite/accept/+page.server.ts`

### Load Function Returns
```typescript
{
  invite: {
    id: string
    email: string
    roleId: string | null
    token: string
    // ... other invite fields from validateToken()
  } | null
  error: string | null
}
```

### Form Actions
**register**
- Accepts: `{ token: string, username: string, password: string, confirmPassword: string }`
- Returns on success: `redirect(302, '/spu')`
- Returns on failure: `fail(400, { error: string })`
- Side effects: Creates user account, assigns role from invite, creates session, auto-login

---

## Route: /demo/lucia

**File:** `src/routes/demo/lucia/+page.server.ts`

### Load Function Returns
```typescript
{
  user: User // requires login, redirects to /demo/lucia/login if not authenticated
}
```

### Form Actions
**logout**
- Returns: `redirect(302, '/demo/lucia/login')`
- Side effects: Invalidates session, deletes session cookie

---

## Route: /demo/lucia/login

**File:** `src/routes/demo/lucia/login/+page.server.ts`

### Load Function Returns
```typescript
{} // redirects to /demo/lucia if already logged in
```

### Form Actions
**login**
- Accepts: `{ username: string, password: string }`
- Returns on success: `redirect(302, '/demo/lucia')`
- Returns on failure: `fail(400, { message: string })`

**register**
- Accepts: `{ username: string, password: string }`
- Returns on success: `redirect(302, '/demo/lucia')`
- Returns on failure: `fail(400, { message: string })` or `fail(500, { message: string })`
- Side effects: Creates new user with hashed password, creates session

---

## Route: /admin/agent-activity

**File:** `src/routes/admin/agent-activity/+page.server.ts`

### Load Function Returns
```typescript
{
  auditEntries: {
    id: string
    tableName: string
    recordId: string
    action: string
    oldData: Record<string, unknown> | null
    newData: Record<string, unknown> | null
    changedAt: Date
    changedBy: string
  }[]
  pagination: {
    page: number
    limit: number // fixed at 50
    total: number
    hasNext: boolean
    hasPrev: boolean
  }
  stats: {
    totalActionsToday: number
    mostCommonAction: string
    mostCommonActionCount: number
    lastActiveTime: Date | null
  }
  filters: {
    actionTypes: string[]
    currentAction: string | null
    currentDateFrom: string | null
    currentDateTo: string | null
  }
}
```
**Query params:** `action`, `dateFrom`, `dateTo`, `page`

---

# Document Control Routes

---

## Route: /documents

**File:** `src/routes/documents/+page.server.ts`

### Layout Data (inherited)
From documents layout: `{ user, permissions: { canRead, canWrite, canApprove, canTrain } }`

### Load Function Returns
```typescript
{
  documents: {
    id: string
    documentNumber: string
    title: string
    category: string | null
    currentRevision: number
    status: string
    effectiveDate: Date | null
    ownerId: string | null
    ownerUsername: string | null
    createdAt: Date
  }[]
  categories: string[]
  selectedCategory: string | null
}
```
**Query params:** `category`

---

## Route: /documents/new

**File:** `src/routes/documents/new/+page.server.ts`

### Load Function Returns
```typescript
{} // empty, just permission check
```

### Form Actions
**default**
- Accepts: `{ documentNumber: string, title: string, category?: string, content: string }`
- Returns on success: `redirect(303, '/documents/[newId]')`
- Returns on failure: `fail(400, { error: string, documentNumber, title, category, content })`
- Side effects: Creates document record + initial revision, audit log

---

## Route: /documents/approvals

**File:** `src/routes/documents/approvals/+page.server.ts`

### Load Function Returns
```typescript
{
  pendingRevisions: {
    revisionId: string
    revision: number
    changeDescription: string | null
    submittedAt: Date
    submittedById: string | null
    submittedByUsername: string | null
    documentId: string
    documentNumber: string
    title: string
    category: string | null
  }[]
}
```

---

## Route: /documents/training

**File:** `src/routes/documents/training/+page.server.ts`

### Load Function Returns
```typescript
{
  completedTraining: {
    trainingId: string
    trainedAt: Date
    notes: string | null
    revisionId: string
    revision: number
    documentId: string
    documentNumber: string
    documentTitle: string
    documentCategory: string | null
    trainerUsername: string | null
  }[]
  pendingTraining: {
    documentId: string
    documentNumber: string
    title: string
    category: string | null
    currentRevision: number
    status: string
    effectiveDate: Date | null
    revisionId: string
    revisionContent: string | null
    revisionChangeDescription: string | null
  }[]
}
```

---

## Route: /documents/[id]

**File:** `src/routes/documents/[id]/+page.server.ts`

### Load Function Returns
```typescript
{
  document: {
    id: string
    documentNumber: string
    title: string
    category: string | null
    currentRevision: number
    status: string
    effectiveDate: Date | null
    retiredDate: Date | null
    ownerId: string | null
    ownerUsername: string | null
    createdAt: Date
    updatedAt: Date
  }
  revisions: {
    id: string
    revision: number
    content: string | null
    changeDescription: string | null
    status: string
    createdAt: Date
    createdBy: string | null  // username
    approvedAt: Date | null
  }[]
  userTraining: {
    id: string
    documentRevisionId: string
    trainedAt: Date
    revision: number
  }[]
}
```

---

## Route: /documents/[id]/approve

**File:** `src/routes/documents/[id]/approve/+page.server.ts`

### Load Function Returns
```typescript
{
  document: {
    id: string
    documentNumber: string
    title: string
    category: string | null
    status: string
    ownerId: string | null
    ownerUsername: string | null
  }
  revision: {
    id: string
    revision: number
    content: string | null
    changeDescription: string | null
    status: string
    createdAt: Date
    createdByUsername: string | null
  }
}
```

### Form Actions
**default**
- Accepts: `{ decision: 'approve' | 'reject', comments?: string, password: string, meaning: string }`
- Returns on success: `redirect(303, '/documents/[id]')`
- Side effects: Updates revision status, creates electronic signature, audit log. If approved, updates document status/currentRevision.

---

## Route: /documents/[id]/revise

**File:** `src/routes/documents/[id]/revise/+page.server.ts`

### Load Function Returns
```typescript
{
  document: {
    id: string
    documentNumber: string
    title: string
    category: string | null
    currentRevision: number
    status: string
    ownerId: string | null
    ownerUsername: string | null
  }
  latestContent: string | null
}
```

### Form Actions
**default**
- Accepts: `{ content: string, changeDescription?: string }`
- Returns on success: `redirect(303, '/documents/[id]')`
- Side effects: Creates new revision with status 'pending_approval', audit log

---

## Route: /documents/[id]/train

**File:** `src/routes/documents/[id]/train/+page.server.ts`

### Load Function Returns
```typescript
{
  document: {
    id: string
    documentNumber: string
    title: string
    category: string | null
    currentRevision: number
    status: string
  }
  revision: {
    id: string
    revision: number
    content: string | null
    changeDescription: string | null
  }
}
```

### Form Actions
**default**
- Accepts: `{ notes?: string, password: string, meaning: string }`
- Returns on success: `redirect(303, '/documents/[id]')`
- Side effects: Creates training record, electronic signature, audit log

---

# Kanban Routes

---

## Route: /kanban

**File:** `src/routes/kanban/+page.server.ts`

### Layout Data (inherited)
From kanban layout: `{ user, projects, users }`

### Load Function Returns
```typescript
{
  tasks: {
    id: string
    title: string
    description: string | null
    status: 'backlog' | 'ready' | 'wip' | 'waiting' | 'done'
    priority: 'high' | 'medium' | 'low'
    taskLength: 'short' | 'medium' | 'long'
    projectId: string | null
    assignedTo: string | null
    dueDate: Date | null
    sortOrder: number
    waitingReason: string | null
    waitingOn: string | null
    createdAt: Date
    statusChangedAt: Date | null
    source: string | null
    assigneeName: string | null
    projectName: string | null
    projectColor: string | null
    tags: { id: string, name: string, color: string }[]
    daysInStatus: number
  }[]
}
```

### Form Actions
**create**
- Accepts: `{ title: string, description?: string, status?: string, priority?: string, taskLength?: string, projectId?: string, assignedTo?: string, dueDate?: string }`
- Returns: `{ success: true }` or `fail(400, { error: string })`
- Side effects: Creates kanban task, audit log

**move**
- Accepts: `{ taskId: string, newStatus: string, sortOrder?: string, waitingReason?: string, waitingOn?: string }`
- Returns: `{ success: true }` or `fail(400, { error: string })`
- Side effects: Moves task to new status, logs action

**delete**
- Accepts: `{ taskId: string }`
- Returns: `{ success: true }` or `fail(400, { error: string })`
- Side effects: Deletes task, audit log

---

## Route: /kanban/archived

**File:** `src/routes/kanban/archived/+page.server.ts`

### Load Function Returns
```typescript
{
  tasks: ArchivedTask[] // from getArchivedTasks() service
}
```

### Form Actions
**archiveDone**
- Accepts: nothing
- Returns: `{ success: true, count: number }`
- Side effects: Archives all done tasks

---

## Route: /kanban/list

**File:** `src/routes/kanban/list/+page.server.ts`

### Load Function Returns
```typescript
{
  tasks: {
    id: string
    title: string
    description: string | null
    status: string
    priority: string
    taskLength: string
    projectId: string | null
    assignedTo: string | null
    dueDate: Date | null
    waitingReason: string | null
    waitingOn: string | null
    createdAt: Date
    statusChangedAt: Date | null
    assigneeName: string | null
    projectName: string | null
    projectColor: string | null
    tags: { id: string, name: string, color: string }[]
  }[]
}
```
**Query params:** `project`, `status`, `priority`, `assignee`

---

## Route: /kanban/projects

**File:** `src/routes/kanban/projects/+page.server.ts`

### Load Function Returns
```typescript
{
  allProjects: {
    id: string
    name: string
    description: string | null
    color: string
    isActive: boolean
    sortOrder: number
    createdBy: string | null
  }[]
}
```

### Form Actions
**create**
- Accepts: `{ name: string, description?: string, color?: string }`
- Returns: `{ success: true }` or `fail(400, { error: string })`

**update**
- Accepts: `{ projectId: string, name: string, description?: string, color?: string }`
- Returns: `{ success: true }` or `fail(400, { error: string })`

**toggleActive**
- Accepts: `{ projectId: string }`
- Returns: `{ success: true }` or `fail(400, { error: string })`

---

## Route: /kanban/task/[taskId]

**File:** `src/routes/kanban/task/[taskId]/+page.server.ts`

### Load Function Returns
```typescript
{
  task: {
    id: string
    title: string
    description: string | null
    status: string
    priority: string
    taskLength: string
    projectId: string | null
    assignedTo: string | null
    dueDate: Date | null
    sortOrder: number
    waitingReason: string | null
    waitingOn: string | null
    createdAt: Date
    statusChangedAt: Date | null
    source: string | null
    assigneeName: string | null
    projectName: string | null
    projectColor: string | null
    tags: { id: string, name: string, color: string }[]
  }
  comments: {
    id: string
    content: string
    createdAt: Date
    userId: string
    username: string
  }[]
  projects: { id: string, name: string, color: string, isActive: boolean, sortOrder: number }[]
  allTags: { id: string, name: string, color: string }[]
  taskTags: { id: string, name: string, color: string }[]
  activityLog: {
    id: string
    action: string
    details: Record<string, unknown> | null
    createdAt: Date
    userId: string
    username: string
  }[]
}
```

### Form Actions
**update**
- Accepts: `{ title: string, description?: string, priority: string, taskLength: string, projectId?: string, assignedTo?: string, dueDate?: string, waitingReason?: string, waitingOn?: string }`

**move**
- Accepts: `{ newStatus: string }`

**addComment**
- Accepts: `{ content: string }`

**addTag**
- Accepts: `{ tagId: string }`

**removeTag**
- Accepts: `{ tagId: string }`

**createTag**
- Accepts: `{ name: string, color?: string }`

---

# Opentrons Lab Routes

---

## Route: /opentrons

**File:** `src/routes/opentrons/+page.server.ts`

### Layout Data (inherited)
From opentrons layout: `{ user: { id, username } }`

### Load Function Returns
```typescript
{
  robots: {
    robotId: string
    name: string
    ip: string
    lastHealthOk: boolean
  }[]
  protocolRecords: {
    id: string
    robotId: string
    opentronsProtocolId: string
    protocolName: string | null
    protocolType: string | null
    analysisStatus: string | null
    pipettesRequired: unknown
    labwareDefinitions: unknown
    parametersSchema: unknown
    updatedAt: string // ISO
  }[]
}
```

---

## Route: /opentrons/devices

**File:** `src/routes/opentrons/devices/+page.server.ts`

### Load Function Returns
```typescript
{
  robots: {
    robotId: string
    name: string
    ip: string
    port: number
    robotSide: string | null
    robotModel: string
    robotSerial: string | null
    isActive: boolean
    lastHealthOk: boolean
    lastHealthAt: string | null // ISO
    source: string
  }[]
}
```

---

## Route: /opentrons/devices/[robotId]

**File:** `src/routes/opentrons/devices/[robotId]/+page.server.ts`

### Load Function Returns
```typescript
{
  robot: {
    robotId: string
    name: string
    ip: string
    port: number
    robotSide: string | null
    robotModel: string
    robotSerial: string | null
    isActive: boolean
    lastHealthOk: boolean
    lastHealthAt: string | null
    firmwareVersion: string | null
    apiVersion: string | null
    source: string
  }
  robotOffline: boolean
  info: {
    health: {
      name: string
      api_version: string
      fw_version: string
      system_version: string
      robot_serial: string
      robot_model: string
    } | null
    pipettes: {
      mount: 'left' | 'right'
      name: string
      model: string
      id: string
      // ... OT2Pipette fields
    }[]
    modules: unknown[]
  } | null
  calibration: {
    status: string
    labware: unknown[]
    pipetteOffsets: unknown[]
    tipLengths: unknown[]
  } | null
  recentRuns: {
    id: string
    status: string
    protocolId: string | null
    createdAt: string
    completedAt: string | null
  }[] | null
}
```

---

## Route: /opentrons/labware

**File:** `src/routes/opentrons/labware/+page.server.ts`

### Load Function Returns
```typescript
{
  labware: {
    loadName: string
    displayName: string
    category: string // 'Tip Rack' | 'Well Plate' | 'Reservoir' | 'Tube Rack' | 'Adapter' | 'Trash' | 'Other'
    count: number
  }[]
  robots: {
    robotId: string
    name: string
    ip: string
    lastHealthOk: boolean
  }[]
}
```

---

## Route: /opentrons/protocols/[robotId]/[protocolId]

**File:** `src/routes/opentrons/protocols/[robotId]/[protocolId]/+page.server.ts`

### Load Function Returns
```typescript
{
  robotId: string
  protocolId: string
  robotName: string
  robotOffline: boolean
  protocol: {
    id: string
    createdAt: string
    protocolType: string
    metadata: Record<string, unknown>
    robotType: string
    files: unknown[]
    analysisStatus: string
  } | null
  dbRecord: {
    protocolName: string | null
    protocolType: string | null
    analysisStatus: string | null
    parametersSchema: unknown
    labwareDefinitions: unknown
    pipettesRequired: unknown
    updatedAt: string
  } | null
  analysis: {
    id: string
    status: string
    result: string
    pipettes: unknown[]
    labware: unknown[]
    modules: unknown[]
    liquids: unknown[]
    commands: unknown[]
    runTimeParameters: unknown[]
  } | null
}
```

---

## Route: /opentrons/runs/[runId]

**File:** `src/routes/opentrons/runs/[runId]/+page.server.ts`

### Load Function Returns
```typescript
{
  robotId: string
  robotName: string
  run: {
    id: string
    status: string
    current: boolean
    protocolId: string | null
    createdAt: string
    startedAt: string | null
    completedAt: string | null
    errors: unknown[]
    pipettes: unknown[]
    labware: unknown[]
    modules: unknown[]
    liquids: unknown[]
    runTimeParameters: unknown[]
    actions: unknown[]
  }
}
```
**Query params:** `robotId` (required)

---

## Route: /opentrons/runs/new

**File:** `src/routes/opentrons/runs/new/+page.server.ts`

### Load Function Returns
```typescript
{
  preselectedRobotId: string | null
  preselectedProtocolId: string | null
  robots: {
    robotId: string
    name: string
    ip: string
    lastHealthOk: boolean
  }[]
  protocol: {
    id: string
    metadata: Record<string, unknown>
    robotType: string
    files: unknown[]
    analysisStatus: string
  } | null
  analysis: {
    pipettes: unknown[]
    labware: unknown[]
    modules: unknown[]
    commands: unknown[]
    runTimeParameters: unknown[]
  } | null
}
```
**Query params:** `robotId`, `protocolId`

---

# SPU Core Routes

---

## Route: /spu

**File:** `src/routes/spu/+page.server.ts`

### Layout Data (inherited)
From SPU layout: `{ user, canAccessDocuments, canAccessInventory, canAccessCartridges, canAccessAssays, canAccessDevices, canAccessTestResults, canAccessAdmin, isBoxConnected, particleStatus }`

### Load Function Returns
```typescript
{
  spus: {
    id: string
    udi: string
    status: string
    deviceState: string
    owner: string | null
    ownerNotes: string | null
    batchId: string | null
    batchNumber: string | null
    createdAt: Date
    createdByUsername: string | null
    assignmentType: string | null
    assignmentCustomerId: string | null
    customerName: string | null
    qcStatus: string
    qcDocumentUrl: string | null
    assemblyStatus: string
  }[]
  batches: { id: string, batchNumber: string }[]
  bomSummary: {
    totalItems: number
    activeItems: number
    totalCost: string
    expiringWithin30Days: number
    lastSyncAt: Date | null
    lastSyncStatus: string | null
    lastSyncError: string | null
  }
  expiringItems: { partNumber: string, name: string, expirationDate: Date }[]
  syncErrorDetail: {
    message: string
    failedRows?: string[]
    columnIssues?: string[]
    timestamp: string
  } | null
  costBreakdown: {
    materialSubtotal: number
    laborSubtotal: number
    lineItems: {
      partId: string | null
      partName: string
      materialCost: number
      laborCost: number
    }[]
    totalCost: number
  } | null
  activeRuns: {
    id: string
    runNumber: string
    status: string
    quantity: number
    workInstructionId: string
    workInstructionTitle: string
    completedUnits: number
  }[]
  stateCounts: Record<string, number>
  stateFilter: string | null
  fieldHints: { batchRecommended: boolean, ownerRecommended: boolean }
  fleetSummary: FleetSummary | null // from getFleetSummary()
  activeCustomers: { id: string, name: string, customerType: string }[]
}
```
**Query params:** `state`

### Form Actions
**create**
- Accepts: `{ serialNumber: string, batchId?: string }`
- Returns: `{ success: true }` or `fail(400, { error: string })`
- Side effects: Creates SPU with generated UDI, audit log

**register**
- Accepts: `{ udi: string, deviceState: string, owner?: string, ownerNotes?: string, batchId?: string }`
- Returns: `{ success: true, spuId: string }` or `fail(400, { error: string })`
- Side effects: Creates SPU record, audit log

**updateState**
- Accepts: `{ spuId: string, deviceState: string, owner?: string, ownerNotes?: string }`
- Returns: `{ success: true }` or `fail(400, { error: string })`
- Side effects: Updates SPU state, audit log

**bulkUpdateState**
- Accepts: `{ spuIds: string (comma-separated), deviceState: string }`
- Returns: `{ success: true, updatedCount: number }` or `fail(400, { error: string })`

**assignSpu**
- Accepts: `{ spuId: string, assignmentType: 'rnd' | 'manufacturing' | 'customer', customerId?: string }`
- Returns: `{ assignSuccess: true }` or `fail(400/500, { assignError: string })`

**retrySync**
- Accepts: nothing
- Returns: `{ syncSuccess: true, syncMessage: string }` or `fail(500, { syncError: string })`
- Side effects: Triggers Box.com BOM sync

---

## Route: /spu/[spuId]

**File:** `src/routes/spu/[spuId]/+page.server.ts`

### Load Function Returns
```typescript
{
  spu: {
    // Full SPU record from DB (all columns)
    id: string
    udi: string
    status: string
    deviceState: string
    owner: string | null
    ownerNotes: string | null
    batchId: string | null
    createdBy: string | null
    createdAt: Date
    updatedAt: Date
    assignmentType: string | null
    assignmentCustomerId: string | null
    qcStatus: string
    qcDocumentUrl: string | null
    assemblyStatus: string
    assemblySignatureId: string | null
    // ... all other spu columns
  }
  batch: {
    id: string
    batchNumber: string
    // ... all batch columns
  } | null
  createdByName: string | null
  assignmentCustomerName: string | null
  activeCustomers: { id: string, name: string }[]
  particleLink: {
    id: string
    spuId: string
    particleDeviceId: string
    linkedAt: Date
    // ... all particleLink columns
  } | null
  particleDevice: {
    // Full particleDevice record
    id: string
    deviceId: string
    name: string | null
    linkedSpuId: string | null
    lastSyncAt: Date | null
    // ... all particleDevice columns
  } | null
  parts: {
    id: string
    partNumber: string
    partName: string
    partId: string
    lotNumber: string | null
    lotId: string | null
    quantityUsed: number
    recordedAt: Date
    recordedByName: string
    source: 'assembly' | 'usage'
  }[]
  sessions: {
    id: string
    startedAt: Date
    completedAt: Date | null
    status: string
    operatorId: string
    operatorName: string
  }[]
  signatures: {
    id: string
    entityType: string
    meaning: string
    signedAt: Date
    userId: string
    userName: string
  }[]
  assemblySignature: {
    id: string
    entityType: string
    meaning: string
    signedAt: Date
    userId: string
    userName: string
    // ... all electronicSignature columns
  } | null
  assemblyStatusHistory: {
    id: string
    from: string | null
    to: string
    changedBy: string
    changedAt: Date
  }[]
  auditTrail: {
    id: string
    action: string
    oldData: Record<string, unknown> | null
    newData: Record<string, unknown> | null
    changedBy: string // username or 'System'
    changedAt: Date
  }[]
}
```

### Form Actions
**updateState**
- Accepts: `{ deviceState: string, owner?: string, ownerNotes?: string }`
- Side effects: Updates SPU state, audit log

**linkParticle**
- Accepts: `{ particleDeviceId: string }`
- Side effects: Links Particle device to SPU

**unlinkParticle**
- Accepts: nothing
- Side effects: Unlinks Particle device from SPU

**pingDevice**
- Accepts: nothing
- Side effects: Pings linked Particle device

**pushUpdate**
- Accepts: `{ configJson: string }`
- Side effects: Pushes config to Particle device

**assignSpu**
- Accepts: `{ assignmentType: string, customerId?: string }`

**updateAssemblyStatus**
- Accepts: `{ assemblyStatus: string, password?: string, meaning?: string }`
- Side effects: Updates assembly status, optionally creates electronic signature

---

# SPU Admin Routes

---

## Route: /spu/admin

**File:** `src/routes/spu/admin/+page.server.ts`

### Load Function Returns
Redirects to `/spu/admin/users`

---

## Route: /spu/admin/users

**File:** `src/routes/spu/admin/users/+page.server.ts`

### Load Function Returns
```typescript
{
  users: {
    id: string
    username: string
    email: string | null
    firstName: string | null
    lastName: string | null
    phone: string | null
    isActive: boolean
    lastLoginAt: Date | null
    createdAt: Date
    roles: { id: string, name: string }[]
  }[]
  roles: { id: string, name: string, description: string | null }[]
}
```
**Query params:** `search`, `role`, `active`

### Form Actions
**createUser** - `{ username, password, email?, firstName?, lastName?, roleIds[] }`
**updateProfile** - `{ userId, firstName?, lastName?, email?, phone? }`
**deactivateUser** - `{ userId }`
**reactivateUser** - `{ userId }`
**resetPassword** - `{ userId, newPassword }`
**assignRole** - `{ userId, roleId }`
**removeRole** - `{ userId, roleId }`
**sendInvite** - `{ email, roleId? }`

---

## Route: /spu/admin/invites

**File:** `src/routes/spu/admin/invites/+page.server.ts`

### Load Function Returns
```typescript
{
  invites: {
    id: string
    email: string
    roleId: string | null
    token: string
    status: string
    expiresAt: string // ISO
    acceptedAt: string | null // ISO
    createdAt: string // ISO
    createdBy: string | null
  }[]
  roles: { id: string, name: string, description: string | null }[]
}
```

### Form Actions
**sendInvite** - `{ email: string, roleId?: string }` → `{ success: true, inviteUrl: string }`
**revokeInvite** - `{ inviteId: string }`

---

## Route: /spu/admin/roles

**File:** `src/routes/spu/admin/roles/+page.server.ts`

### Load Function Returns
```typescript
{
  roles: { id: string, name: string, description: string | null }[]
  permissionGroups: {
    group: string
    permissions: { id: string, name: string, description: string | null }[]
  }[]
  selectedRole: {
    id: string
    name: string
    description: string | null
    permissions: { id: string, name: string }[]
  } | null
}
```
**Query params:** `roleId`

### Form Actions
**createRole** - `{ name, description? }`
**updateRole** - `{ roleId, name?, description? }`
**deleteRole** - `{ roleId }`
**setPermissions** - `{ roleId, permissionIds[] }`

---

# SPU Assay Routes

---

## Route: /spu/assays

**File:** `src/routes/spu/assays/+page.server.ts`

### Load Function Returns
```typescript
{
  assays: {
    id: string
    name: string
    skuCode: string | null
    version: number
    status: string
    description: string | null
    createdAt: Date
    updatedAt: Date
    // ... from assay service
  }[]
}
```

---

## Route: /spu/assays/new

**File:** `src/routes/spu/assays/new/+page.server.ts`

### Load Function Returns
```typescript
{} // permission check only
```

### Form Actions
**default**
- Accepts: `{ name, skuCode?, description?, ...assay configuration fields }`
- Returns: `redirect(303, '/spu/assays/[newId]')`

---

## Route: /spu/assays/[assayId]

**File:** `src/routes/spu/assays/[assayId]/+page.server.ts`

### Load Function Returns
```typescript
{
  assay: {
    id: string
    name: string
    skuCode: string | null
    version: number
    status: string
    description: string | null
    configuration: Record<string, unknown>
    createdAt: Date
    updatedAt: Date
  }
  versions: {
    version: number
    createdAt: Date
    changes: string | null
  }[]
}
```

---

## Route: /spu/assays/[assayId]/edit

**File:** `src/routes/spu/assays/[assayId]/edit/+page.server.ts`

### Load Function Returns
```typescript
{
  assay: { /* same as detail */ }
}
```

### Form Actions
**default** - Updates assay configuration
- Accepts: `{ name, skuCode?, description?, ...configuration fields }`

---

## Route: /spu/assays/[assayId]/assign

**File:** `src/routes/spu/assays/[assayId]/assign/+page.server.ts`

### Load Function Returns
```typescript
{
  assay: { id: string, name: string, skuCode: string | null }
  // available cartridges/devices for assignment
}
```

### Form Actions
**default** - Assigns assay to cartridge(s)

---

## Route: /spu/assays/import

**File:** `src/routes/spu/assays/import/+page.server.ts`

### Load Function Returns
```typescript
{} // permission check only
```

### Form Actions
**default** - Imports assay from file upload

---

# SPU Assembly Routes

---

## Route: /spu/assembly

**File:** `src/routes/spu/assembly/+page.server.ts`

### Load Function Returns
```typescript
{
  activeSessions: {
    id: string
    spuId: string
    spuUdi: string
    status: string
    startedAt: Date
    operatorName: string
    partsScanned: number
    totalParts: number
  }[]
  recentCompleted: {
    id: string
    spuId: string
    spuUdi: string
    completedAt: Date
    operatorName: string
  }[]
  spus: { id: string, udi: string }[] // available for assembly
}
```

### Form Actions
**start** - `{ spuId: string }` → redirect to session page

---

## Route: /spu/assembly/[sessionId]

**File:** `src/routes/spu/assembly/[sessionId]/+page.server.ts`

### Load Function Returns
```typescript
{
  session: {
    id: string
    spuId: string
    spuUdi: string
    status: string
    startedAt: Date
    completedAt: Date | null
    userId: string
    operatorName: string
  }
  parts: {
    id: string
    partDefinitionId: string
    partNumber: string
    partName: string
    lotNumber: string | null
    scannedAt: Date | null
    isScanned: boolean
    isRequired: boolean
  }[]
  partDefinitions: {
    id: string
    partNumber: string
    name: string
    // ... part definition fields
  }[]
}
```

### Form Actions
**scan** - `{ barcode: string }` — scans a part for the assembly session
**complete** - completes the assembly session
**abort** - aborts the assembly session

---

## Route: /spu/assembly/complete

**File:** `src/routes/spu/assembly/complete/+page.server.ts`

### Load Function Returns
```typescript
{
  recentSessions: {
    id: string
    spuId: string
    spuUdi: string
    completedAt: Date
    operatorName: string
    partsCount: number
  }[]
}
```

---

# SPU Batch Routes

---

## Route: /spu/batches

**File:** `src/routes/spu/batches/+page.server.ts`

### Load Function Returns
```typescript
{
  batches: {
    id: string
    batchNumber: string
    status: string
    createdAt: Date
    spuCount: number
  }[]
}
```

### Form Actions
**create** - `{ batchNumber: string }` → creates a new batch

---

## Route: /spu/batches/[batchId]

**File:** `src/routes/spu/batches/[batchId]/+page.server.ts`

### Load Function Returns
```typescript
{
  batch: {
    id: string
    batchNumber: string
    status: string
    createdAt: Date
    // ... all batch columns
  }
  spus: {
    id: string
    udi: string
    status: string
    deviceState: string
    createdAt: Date
  }[]
}
```

---

# SPU BOM Routes

---

## Route: /spu/bom

**File:** `src/routes/spu/bom/+page.server.ts`

### Load Function Returns
```typescript
{
  items: {
    id: string
    partNumber: string
    name: string
    description: string | null
    unitCost: number | null
    quantity: number | null
    supplier: string | null
    category: string | null
    isActive: boolean
    expirationDate: Date | null
    folderId: string | null
    folderName: string | null
    createdAt: Date
    updatedAt: Date
  }[]
  folders: { id: string, name: string }[]
}
```

---

## Route: /spu/bom/[bomId]

**File:** `src/routes/spu/bom/[bomId]/+page.server.ts`

### Load Function Returns
```typescript
{
  item: {
    id: string
    partNumber: string
    name: string
    description: string | null
    unitCost: number | null
    quantity: number | null
    supplier: string | null
    category: string | null
    isActive: boolean
    expirationDate: Date | null
    folderId: string | null
    // ... all bomItem columns
  }
}
```

### Form Actions
**update** - updates BOM item fields
**delete** - deletes BOM item

---

## Route: /spu/bom/folders

**File:** `src/routes/spu/bom/folders/+page.server.ts`

### Load Function Returns
```typescript
{
  folders: {
    id: string
    name: string
    itemCount: number
  }[]
}
```

### Form Actions
**create** - `{ name: string }`
**rename** - `{ folderId: string, name: string }`
**delete** - `{ folderId: string }`

---

## Route: /spu/bom/settings

**File:** `src/routes/spu/bom/settings/+page.server.ts`

### Load Function Returns
```typescript
{
  boxIntegration: {
    id: string
    accessToken: string | null
    refreshToken: string | null
    lastSyncAt: Date | null
    lastSyncStatus: string | null
    lastSyncError: string | null
    syncIntervalMinutes: number | null
    folderId: string | null
    spreadsheetId: string | null
  } | null
}
```

---

## Route: /spu/bom/settings/mapping

**File:** `src/routes/spu/bom/settings/mapping/+page.server.ts`

### Load Function Returns
```typescript
{
  columnMapping: Record<string, string> | null
  availableColumns: string[]
}
```

---

# SPU Cartridge Admin Routes

---

## Route: /spu/cartridge-admin/failures

**File:** `src/routes/spu/cartridge-admin/failures/+page.server.ts`

### Load Function Returns
```typescript
{
  failures: {
    // from cartridge-admin service queries
    id: string
    cartridgeId: string
    serialNumber: string
    failureType: string
    failedAt: Date
    notes: string | null
    // ...
  }[]
}
```

---

## Route: /spu/cartridge-admin/filled

**File:** `src/routes/spu/cartridge-admin/filled/+page.server.ts`

### Load Function Returns
```typescript
{
  cartridges: {
    // recently filled cartridges from dashboard service
  }[]
}
```

---

## Route: /spu/cartridge-admin/release

**File:** `src/routes/spu/cartridge-admin/release/+page.server.ts`

### Load Function Returns
```typescript
{
  // QA/QC release data from qaqc-release service
  pendingRelease: {
    id: string
    lotNumber: string
    cartridgeCount: number
    status: string
  }[]
}
```

---

## Route: /spu/cartridge-admin/sku-management

**File:** `src/routes/spu/cartridge-admin/sku-management/+page.server.ts`

### Load Function Returns
```typescript
{
  skus: {
    id: string
    code: string
    name: string
    description: string | null
    isActive: boolean
  }[]
}
```

---

## Route: /spu/cartridge-admin/statistics

**File:** `src/routes/spu/cartridge-admin/statistics/+page.server.ts`

### Load Function Returns
```typescript
{
  stats: {
    // from statistics service
    totalCartridges: number
    byStatus: Record<string, number>
    byAssayType: Record<string, number>
    // ...
  }
}
```

---

## Route: /spu/cartridge-admin/storage

**File:** `src/routes/spu/cartridge-admin/storage/+page.server.ts`

### Load Function Returns
```typescript
{
  // from storage-scanning service
  storageLocations: {
    id: string
    name: string
    cartridgeCount: number
  }[]
}
```

---

# SPU Cartridge Routes

---

## Route: /spu/cartridge-dashboard

**File:** `src/routes/spu/cartridge-dashboard/+page.server.ts`

### Load Function Returns
```typescript
{
  // Dashboard summary data
  stats: {
    total: number
    byStatus: Record<string, number>
    recentActivity: unknown[]
  }
}
```

---

## Route: /spu/cartridges

**File:** `src/routes/spu/cartridges/+page.server.ts`

### Load Function Returns
```typescript
{
  cartridges: {
    id: string
    serialNumber: string
    status: string
    assayTypeId: string | null
    assayTypeName: string | null
    lotNumber: string | null
    createdAt: Date
    // ... cartridge fields
  }[]
}
```

---

## Route: /spu/cartridges/[cartridgeId]

**File:** `src/routes/spu/cartridges/[cartridgeId]/+page.server.ts`

### Load Function Returns
```typescript
{
  cartridge: {
    id: string
    serialNumber: string
    status: string
    assayTypeId: string | null
    assayTypeName: string | null
    lotNumber: string | null
    // ... all cartridge fields
    history: {
      action: string
      timestamp: Date
      userId: string | null
      details: Record<string, unknown> | null
    }[]
  }
}
```

---

## Route: /spu/cartridges/analysis

**File:** `src/routes/spu/cartridges/analysis/+page.server.ts`

### Load Function Returns
```typescript
{
  // from cartridge-analysis service
  analyses: unknown[]
}
```

---

## Route: /spu/cartridges/groups

**File:** `src/routes/spu/cartridges/groups/+page.server.ts`

### Load Function Returns
```typescript
{
  groups: {
    id: string
    name: string
    cartridgeCount: number
    // from cartridge-group service
  }[]
}
```

---

# SPU Customer Routes

---

## Route: /spu/customers

**File:** `src/routes/spu/customers/+page.server.ts`

### Load Function Returns
```typescript
{
  customers: {
    id: string
    name: string
    customerType: string
    status: string
    contactEmail: string | null
    contactPhone: string | null
    createdAt: Date
    spuCount: number
  }[]
}
```

### Form Actions
**create** - `{ name, customerType, contactEmail?, contactPhone?, address?, notes? }`

---

## Route: /spu/customers/[id]

**File:** `src/routes/spu/customers/[id]/+page.server.ts`

### Load Function Returns
```typescript
{
  customer: {
    id: string
    name: string
    customerType: string
    status: string
    contactEmail: string | null
    contactPhone: string | null
    address: string | null
    notes: string | null
    createdAt: Date
    updatedAt: Date
  }
  assignedSpus: {
    id: string
    udi: string
    deviceState: string
    assignmentType: string
  }[]
  customerNotes: {
    id: string
    content: string
    createdAt: Date
    createdByUsername: string
  }[]
}
```

### Form Actions
**update** - `{ name, customerType, contactEmail?, contactPhone?, address?, notes? }`
**addNote** - `{ content: string }`
**deactivate** / **reactivate**

---

# SPU Device Routes

---

## Route: /spu/devices

**File:** `src/routes/spu/devices/+page.server.ts`

### Load Function Returns
```typescript
{
  devices: {
    id: string
    deviceId: string
    name: string | null
    platform: string | null
    linkedSpuId: string | null
    linkedSpuUdi: string | null
    lastSyncAt: Date | null
    isOnline: boolean
    firmwareVersion: string | null
    // ... particle device fields
  }[]
}
```

---

## Route: /spu/devices/[deviceId]

**File:** `src/routes/spu/devices/[deviceId]/+page.server.ts`

### Load Function Returns
```typescript
{
  device: {
    id: string
    deviceId: string
    name: string | null
    platform: string | null
    linkedSpuId: string | null
    linkedSpuUdi: string | null
    lastSyncAt: Date | null
    isOnline: boolean
    firmwareVersion: string | null
    lastHeard: Date | null
    variables: Record<string, unknown> | null
    functions: string[] | null
    // ... all particleDevice columns
  }
  spu: { id: string, udi: string } | null
  sensorReadings: {
    id: string
    variable: string
    value: number
    timestamp: Date
  }[]
}
```

---

# SPU Document Routes

---

## Route: /spu/documents

**File:** `src/routes/spu/documents/+page.server.ts`

### Load Function Returns
Redirects or returns navigation structure for documents subsection.

---

## Route: /spu/documents/box

**File:** `src/routes/spu/documents/box/+page.server.ts`

### Load Function Returns
```typescript
{
  isConnected: boolean
  files: {
    id: string
    name: string
    type: string
    size: number
    modifiedAt: string
  }[]
}
```

---

## Route: /spu/documents/build-logs

**File:** `src/routes/spu/documents/build-logs/+page.server.ts`

### Load Function Returns
```typescript
{
  buildLogs: {
    id: string
    runNumber: string
    workInstructionTitle: string
    status: string
    startedAt: Date
    completedAt: Date | null
    operatorName: string
    // ... production run fields
  }[]
}
```

---

## Route: /spu/documents/instructions

**File:** `src/routes/spu/documents/instructions/+page.server.ts`

### Load Function Returns
```typescript
{
  instructions: {
    id: string
    title: string
    documentNumber: string
    version: number
    status: string
    category: string | null
    createdAt: Date
    updatedAt: Date
  }[]
}
```

### Form Actions
**create** - `{ title, documentNumber, category?, content }`

---

## Route: /spu/documents/instructions/[id]

**File:** `src/routes/spu/documents/instructions/[id]/+page.server.ts`

### Load Function Returns
```typescript
{
  instruction: {
    id: string
    title: string
    documentNumber: string
    version: number
    status: string
    category: string | null
    content: string | null
    steps: {
      id: string
      stepNumber: number
      title: string
      description: string
      fields: unknown[]
    }[]
    createdAt: Date
    updatedAt: Date
  }
  runs: {
    id: string
    runNumber: string
    status: string
    startedAt: Date
    completedAt: Date | null
    operatorName: string
  }[]
}
```

---

## Route: /spu/documents/instructions/[id]/fields

**File:** `src/routes/spu/documents/instructions/[id]/fields/+page.server.ts`

### Load Function Returns
```typescript
{
  instruction: { id: string, title: string }
  fields: {
    id: string
    stepId: string
    fieldName: string
    fieldType: string
    isRequired: boolean
    options: string[] | null
    defaultValue: string | null
  }[]
}
```

---

## Route: /spu/documents/instructions/[id]/run/[runId]

**File:** `src/routes/spu/documents/instructions/[id]/run/[runId]/+page.server.ts`

### Load Function Returns
```typescript
{
  instruction: { id: string, title: string, steps: Step[] }
  run: {
    id: string
    runNumber: string
    status: string
    startedAt: Date
    completedAt: Date | null
    quantity: number
    operatorName: string
    units: {
      id: string
      unitNumber: number
      status: string
      stepData: Record<string, unknown>
    }[]
  }
}
```

### Form Actions
Various step completion, unit completion, run completion actions

---

## Route: /spu/documents/repository

**File:** `src/routes/spu/documents/repository/+page.server.ts`

### Load Function Returns
```typescript
{
  documents: {
    id: string
    title: string
    fileName: string
    fileType: string
    fileSize: number
    category: string | null
    uploadedAt: Date
    uploadedByUsername: string
    url: string
  }[]
}
```

---

## Route: /spu/documents/upload

**File:** `src/routes/spu/documents/upload/+page.server.ts`

### Load Function Returns
```typescript
{} // permission check only
```

### Form Actions
**default** - file upload with `{ file: File, title?: string, category?: string }`

---

# SPU Equipment Routes

---

## Route: /spu/equipment/activity

**File:** `src/routes/spu/equipment/activity/+page.server.ts`

### Load Function Returns
```typescript
{
  activities: {
    id: string
    equipmentId: string
    equipmentName: string
    activityType: string
    description: string | null
    performedAt: Date
    performedByUsername: string
    notes: string | null
  }[]
}
```

---

## Route: /spu/equipment/decks-trays

**File:** `src/routes/spu/equipment/decks-trays/+page.server.ts`

### Load Function Returns
```typescript
{
  decks: {
    id: string
    name: string
    description: string | null
    status: string
    slots: number
  }[]
  trays: {
    id: string
    name: string
    description: string | null
    status: string
    deckId: string | null
    deckName: string | null
  }[]
}
```

---

## Route: /spu/equipment/decks-trays/deck

**File:** `src/routes/spu/equipment/decks-trays/deck/+page.server.ts`

### Form Actions
**create** / **update** / **delete** for deck management

---

## Route: /spu/equipment/decks-trays/tray

**File:** `src/routes/spu/equipment/decks-trays/tray/+page.server.ts`

### Form Actions
**create** / **update** / **delete** for tray management

---

## Route: /spu/equipment/detail

**File:** `src/routes/spu/equipment/detail/+page.server.ts`

### Load Function Returns
```typescript
{
  equipment: {
    id: string
    name: string
    type: string
    serialNumber: string | null
    status: string
    location: string | null
    lastMaintenanceAt: Date | null
    nextMaintenanceAt: Date | null
    notes: string | null
  }[]
}
```

---

## Route: /spu/equipment/fridges-ovens

**File:** `src/routes/spu/equipment/fridges-ovens/+page.server.ts`

### Load Function Returns
```typescript
{
  equipment: {
    id: string
    name: string
    type: 'fridge' | 'oven'
    currentTemperature: number | null
    targetTemperature: number | null
    status: string
    lastReadingAt: Date | null
  }[]
}
```

---

## Route: /spu/equipment/temperature-probes

**File:** `src/routes/spu/equipment/temperature-probes/+page.server.ts`

### Load Function Returns
```typescript
{
  probes: {
    id: string
    name: string
    deviceId: string | null
    currentTemperature: number | null
    lastReadingAt: Date | null
    status: string
    linkedEquipmentId: string | null
    linkedEquipmentName: string | null
  }[]
}
```

---

# SPU Inventory Routes

---

## Route: /spu/inventory/transactions

**File:** `src/routes/spu/inventory/transactions/+page.server.ts`

### Load Function Returns
```typescript
{
  transactions: {
    id: string
    partId: string
    partNumber: string
    partName: string
    transactionType: 'receive' | 'consume' | 'adjust' | 'return'
    quantity: number
    lotNumber: string | null
    notes: string | null
    createdAt: Date
    createdByUsername: string
    isRetracted: boolean
  }[]
  parts: { id: string, partNumber: string, name: string }[]
}
```

### Form Actions
**create** - `{ partId, transactionType, quantity, lotNumber?, notes? }`
**retract** - `{ transactionId, reason }`

---

# SPU Manufacturing Routes

---

## Route: /spu/manufacturing

**File:** `src/routes/spu/manufacturing/+page.server.ts`

### Layout Data (inherited)
From manufacturing layout: `{ user, isAdmin, processConfigs }`

### Load Function Returns
Redirects or returns manufacturing dashboard data.

---

## Route: /spu/manufacturing/inventory

**File:** `src/routes/spu/manufacturing/inventory/+page.server.ts`

### Load Function Returns
```typescript
{
  materials: {
    id: string
    name: string
    partNumber: string | null
    currentStock: number
    unit: string
    reorderPoint: number | null
    category: string | null
  }[]
}
```

---

## Route: /spu/manufacturing/laser-cutting

**File:** `src/routes/spu/manufacturing/laser-cutting/+page.server.ts`

### Load Function Returns
```typescript
{
  sessions: {
    id: string
    status: string
    startedAt: Date
    completedAt: Date | null
    operatorName: string
    sheetCount: number
    // ... laser cutting session fields
  }[]
}
```

### Form Actions
**start** - starts a new laser cutting session
**complete** - completes a session
**abort** - aborts a session

---

## Route: /spu/manufacturing/lots/[lotId]

**File:** `src/routes/spu/manufacturing/lots/[lotId]/+page.server.ts`

### Load Function Returns
```typescript
{
  lot: {
    id: string
    lotNumber: string
    partId: string
    partNumber: string
    partName: string
    status: string
    quantity: number
    receivedAt: Date
    expirationDate: Date | null
    // ... all lot columns
  }
  steps: {
    id: string
    stepName: string
    status: string
    completedAt: Date | null
    completedByUsername: string | null
    notes: string | null
  }[]
  usageHistory: {
    spuId: string
    spuUdi: string
    quantityUsed: number
    recordedAt: Date
  }[]
}
```

---

## Route: /spu/manufacturing/opentrons

**File:** `src/routes/spu/manufacturing/opentrons/+page.server.ts`

### Load Function Returns
```typescript
{
  robots: {
    robotId: string
    name: string
    ip: string
    lastHealthOk: boolean
  }[]
  recentRuns: {
    id: string
    robotId: string
    robotName: string
    protocolName: string | null
    status: string
    startedAt: Date | null
    completedAt: Date | null
  }[]
}
```

---

## Route: /spu/manufacturing/opentrons/history

**File:** `src/routes/spu/manufacturing/opentrons/history/+page.server.ts`

### Load Function Returns
```typescript
{
  completedRuns: {
    id: string
    robotId: string
    robotName: string
    protocolName: string | null
    status: string
    startedAt: Date
    completedAt: Date
    duration: number // ms
  }[]
}
```

---

## Route: /spu/manufacturing/qa-qc

**File:** `src/routes/spu/manufacturing/qa-qc/+page.server.ts`

### Load Function Returns
```typescript
{
  inspections: {
    id: string
    cartridgeId: string | null
    lotId: string | null
    status: string
    result: 'pass' | 'fail' | null
    inspectedAt: Date | null
    inspectorName: string | null
    notes: string | null
  }[]
}
```

---

## Route: /spu/manufacturing/reagent-filling

**File:** `src/routes/spu/manufacturing/reagent-filling/+page.server.ts`

### Layout Data (inherited)
From reagent-filling layout: `{ user, robots, dashboardState }`

### Load Function Returns
```typescript
{
  runs: {
    id: string
    robotId: string
    robotName: string
    status: string
    stage: string
    assayTypeId: string | null
    assayTypeName: string | null
    cartridgeCount: number | null
    startTime: Date | null
    endTime: Date | null
    createdAt: Date
  }[]
  assayTypes: {
    id: string
    name: string
    skuCode: string | null
  }[]
}
```

### Form Actions
**create** - `{ robotId: string, assayTypeId: string }`
- Returns: redirect to the new run page
- Side effects: Creates reagent filling run, audit log

---

## Route: /spu/manufacturing/reagent-filling/cooling-queue

**File:** `src/routes/spu/manufacturing/reagent-filling/cooling-queue/+page.server.ts`

### Load Function Returns
```typescript
{
  queue: {
    runId: string
    robotName: string
    assayTypeName: string | null
    enteredCoolingAt: Date
    requiredCoolingMinutes: number
    remainingMinutes: number
    cartridgeCount: number | null
  }[]
}
```

---

## Route: /spu/manufacturing/reagent-filling/settings

**File:** `src/routes/spu/manufacturing/reagent-filling/settings/+page.server.ts`

### Load Function Returns
```typescript
{
  settings: {
    coolingDurationMinutes: number
    defaultRobotId: string | null
    // ... other reagent filling settings
  }
  robots: { robotId: string, name: string }[]
}
```

### Form Actions
**update** - updates settings

---

## Route: /spu/manufacturing/top-seal-cutting

**File:** `src/routes/spu/manufacturing/top-seal-cutting/+page.server.ts`

### Load Function Returns
```typescript
{
  sessions: {
    id: string
    status: string
    startedAt: Date
    completedAt: Date | null
    operatorName: string
    cartridgeCount: number
  }[]
}
```

### Form Actions
Session management (start, complete, abort)

---

## Route: /spu/manufacturing/wax-filling

**File:** `src/routes/spu/manufacturing/wax-filling/+page.server.ts`

### Layout Data (inherited)
From wax-filling layout: `{ user, robots, dashboardState }`

### Load Function Returns
```typescript
{
  runs: {
    id: string
    robotId: string
    robotName: string
    status: string
    stage: string
    assayTypeId: string | null
    assayTypeName: string | null
    cartridgeCount: number | null
    startTime: Date | null
    endTime: Date | null
    createdAt: Date
  }[]
  assayTypes: { id: string, name: string, skuCode: string | null }[]
}
```

### Form Actions
**create** - `{ robotId: string, assayTypeId: string }`

---

## Route: /spu/manufacturing/wax-filling/equipment

**File:** `src/routes/spu/manufacturing/wax-filling/equipment/+page.server.ts`

### Load Function Returns
```typescript
{
  equipment: {
    id: string
    name: string
    type: string
    status: string
    currentTemperature: number | null
    targetTemperature: number | null
  }[]
}
```

---

## Route: /spu/manufacturing/wax-filling/oven-queue

**File:** `src/routes/spu/manufacturing/wax-filling/oven-queue/+page.server.ts`

### Load Function Returns
```typescript
{
  queue: {
    runId: string
    robotName: string
    assayTypeName: string | null
    enteredOvenAt: Date
    requiredOvenMinutes: number
    remainingMinutes: number
    cartridgeCount: number | null
    ovenName: string | null
  }[]
}
```

---

## Route: /spu/manufacturing/wax-filling/settings

**File:** `src/routes/spu/manufacturing/wax-filling/settings/+page.server.ts`

### Load Function Returns
```typescript
{
  settings: {
    ovenDurationMinutes: number
    defaultRobotId: string | null
    // ... other wax filling settings
  }
  robots: { robotId: string, name: string }[]
}
```

### Form Actions
**update** - updates settings

---

## Route: /spu/manufacturing/wi-01

**File:** `src/routes/spu/manufacturing/wi-01/+page.server.ts`

### Load Function Returns
```typescript
{
  // Work instruction 01 specific data
  runs: {
    id: string
    runNumber: string
    status: string
    startedAt: Date
    completedAt: Date | null
    operatorName: string
    quantity: number
    completedUnits: number
  }[]
}
```

### Form Actions
**startRun** - `{ quantity: number }` → creates production run

---

## Route: /spu/manufacturing/wi-01/steps

**File:** `src/routes/spu/manufacturing/wi-01/steps/+page.server.ts`

### Load Function Returns
```typescript
{
  steps: {
    stepNumber: number
    title: string
    description: string
    fields: {
      name: string
      type: string
      required: boolean
      options?: string[]
    }[]
  }[]
}
```

---

## Route: /spu/manufacturing/wi-02

**File:** `src/routes/spu/manufacturing/wi-02/+page.server.ts`

Similar structure to wi-01.

---

## Route: /spu/manufacturing/wi-02/steps

**File:** `src/routes/spu/manufacturing/wi-02/steps/+page.server.ts`

Similar structure to wi-01/steps.

---

# SPU Parts Routes

---

## Route: /spu/parts

**File:** `src/routes/spu/parts/+page.server.ts`

### Load Function Returns
```typescript
{
  parts: {
    id: string
    partNumber: string
    name: string
    description: string | null
    category: string | null
    currentStock: number
    unit: string
    reorderPoint: number | null
    isActive: boolean
    createdAt: Date
  }[]
}
```

### Form Actions
**create** - `{ partNumber, name, description?, category?, unit?, reorderPoint? }`

---

## Route: /spu/parts/[partId]

**File:** `src/routes/spu/parts/[partId]/+page.server.ts`

### Load Function Returns
```typescript
{
  part: {
    id: string
    partNumber: string
    name: string
    description: string | null
    category: string | null
    currentStock: number
    unit: string
    reorderPoint: number | null
    isActive: boolean
    createdAt: Date
    updatedAt: Date
  }
  lots: {
    id: string
    lotNumber: string
    quantity: number
    receivedAt: Date
    expirationDate: Date | null
    status: string
  }[]
  transactions: {
    id: string
    transactionType: string
    quantity: number
    lotNumber: string | null
    notes: string | null
    createdAt: Date
    createdByUsername: string
  }[]
}
```

### Form Actions
**update** - updates part definition
**receiveLot** - `{ lotNumber, quantity, expirationDate? }`

---

# SPU Shipping Routes

---

## Route: /spu/shipping

**File:** `src/routes/spu/shipping/+page.server.ts`

### Load Function Returns
```typescript
{
  shipments: {
    id: string
    trackingNumber: string | null
    carrier: string | null
    status: string
    destination: string | null
    shippedAt: Date | null
    deliveredAt: Date | null
    customerId: string | null
    customerName: string | null
    items: {
      spuId: string
      spuUdi: string
    }[]
    createdAt: Date
  }[]
  customers: { id: string, name: string }[]
  availableSpus: { id: string, udi: string }[]
}
```

### Form Actions
**create** - `{ customerId?, carrier?, trackingNumber?, destination?, spuIds[] }`
**updateStatus** - `{ shipmentId, status }`

---

# SPU Test Results Routes

---

## Route: /spu/test-results

**File:** `src/routes/spu/test-results/+page.server.ts`

### Load Function Returns
```typescript
{
  results: {
    id: string
    testType: string
    status: string
    result: 'pass' | 'fail' | null
    cartridgeId: string | null
    cartridgeSerialNumber: string | null
    testedAt: Date | null
    testedByUsername: string | null
    notes: string | null
    createdAt: Date
  }[]
}
```

---

## Route: /spu/test-results/[resultId]

**File:** `src/routes/spu/test-results/[resultId]/+page.server.ts`

### Load Function Returns
```typescript
{
  result: {
    id: string
    testType: string
    status: string
    result: 'pass' | 'fail' | null
    cartridgeId: string | null
    cartridgeSerialNumber: string | null
    rawData: Record<string, unknown> | null
    processedData: Record<string, unknown> | null
    testedAt: Date | null
    testedByUsername: string | null
    notes: string | null
    createdAt: Date
  }
}
```

---

# SPU Validation Routes

---

## Route: /spu/validation

**File:** `src/routes/spu/validation/+page.server.ts`

### Load Function Returns
Navigation/landing page for validation instruments.

---

## Route: /spu/validation/magnetometer

**File:** `src/routes/spu/validation/magnetometer/+page.server.ts`

### Load Function Returns
```typescript
{
  recentSessions: {
    id: string
    status: string
    startedAt: string | null // ISO
    completedAt: string | null // ISO
    createdAt: string // ISO
    barcode: string | null
    username: string | null
  }[]
  stats: {
    total: number
    passed: number
    failed: number
    inProgress: number
  }
}
```

### Form Actions
**start**
- Accepts: nothing (uses locals.user)
- Returns: `redirect(303, '/spu/validation/magnetometer/[sessionId]')`
- Side effects: Generates validation barcode, creates session

---

## Route: /spu/validation/magnetometer/[sessionId]

**File:** `src/routes/spu/validation/magnetometer/[sessionId]/+page.server.ts`

### Load Function Returns
```typescript
{
  session: {
    id: string
    type: string // 'mag'
    status: string
    startedAt: string | null
    completedAt: string | null
    createdAt: string
    barcode: string | null
    barcodeType: string | null
    username: string | null
  }
  result: {
    id: string
    testType: string
    rawData: Record<string, unknown> | null
    processedData: Record<string, unknown> | null
    passed: boolean | null
    notes: string | null
    createdAt: string
  } | null
}
```

---

## Route: /spu/validation/magnetometer/history

**File:** `src/routes/spu/validation/magnetometer/history/+page.server.ts`

### Load Function Returns
```typescript
{
  sessions: {
    id: string
    status: string
    passed: boolean | null
    startedAt: string | null
    completedAt: string | null
    createdAt: string
    barcode: string | null
    username: string | null
    avgMagnitude: number | null
  }[]
  stats: {
    total: number
    passed: number
    failed: number
  }
  filters: {
    status: string | null
    from: string | null
    to: string | null
  }
}
```
**Query params:** `status`, `from`, `to`

---

## Route: /spu/validation/spectrophotometer

**File:** `src/routes/spu/validation/spectrophotometer/+page.server.ts`

### Load Function Returns
```typescript
{
  recentSessions: {
    id: string
    status: string
    startedAt: string | null
    completedAt: string | null
    createdAt: string
    barcode: string | null
    username: string | null
  }[]
  stats: {
    total: number
    passed: number
    failed: number
    inProgress: number
  }
}
```

### Form Actions
**start** → `redirect(303, '/spu/validation/spectrophotometer/[sessionId]')`

---

## Route: /spu/validation/spectrophotometer/[sessionId]

**File:** `src/routes/spu/validation/spectrophotometer/[sessionId]/+page.server.ts`

### Load Function Returns
```typescript
{
  session: {
    id: string
    type: string // 'spec'
    status: string
    startedAt: string | null
    completedAt: string | null
    createdAt: string
    barcode: string | null
    barcodeType: string | null
    username: string | null
  }
  result: {
    id: string
    testType: string
    rawData: Record<string, unknown> | null
    processedData: Record<string, unknown> | null
    passed: boolean | null
    notes: string | null
    createdAt: string
  } | null
}
```

---

## Route: /spu/validation/spectrophotometer/history

**File:** `src/routes/spu/validation/spectrophotometer/history/+page.server.ts`

### Load Function Returns
```typescript
{
  sessions: {
    id: string
    status: string
    startedAt: string | null
    completedAt: string | null
    createdAt: string
    barcode: string | null
    username: string | null
    passed: boolean | null
    peakWavelength: number | null
    peakAbsorbance: number | null
  }[]
  stats: {
    total: number
    passed: number
    failed: number
  }
  filters: {
    status: string | null
    startDate: string | null
    endDate: string | null
  }
}
```
**Query params:** `status`, `startDate`, `endDate`

---

## Route: /spu/validation/thermocouple

**File:** `src/routes/spu/validation/thermocouple/+page.server.ts`

### Load Function Returns
```typescript
{
  recentSessions: {
    id: string
    status: string
    barcode: string | null
    createdAt: string // ISO
    config: {
      durationSeconds: number
      intervalSeconds: number
      minTemp: number
      maxTemp: number
    } | null
  }[]
}
```

### Form Actions
**configure**
- Accepts: `{ durationSeconds: number, interval: number, minTemp: number, maxTemp: number }`
- Returns: `redirect(302, '/spu/validation/thermocouple/[sessionId]')`
- Side effects: Generates barcode, creates session, stores config in validation_result, audit log

---

## Route: /spu/validation/thermocouple/[sessionId]

**File:** `src/routes/spu/validation/thermocouple/[sessionId]/+page.server.ts`

### Load Function Returns
```typescript
{
  session: {
    id: string
    type: string // 'thermo'
    status: string
    startedAt: string | null
    completedAt: string | null
    createdAt: string
    barcode: string | null
    barcodeType: string | null
    username: string | null
  }
  result: {
    id: string
    testType: string
    rawData: Record<string, unknown> | null
    processedData: Record<string, unknown> | null
    passed: boolean | null
    notes: string | null
    createdAt: string
  } | null
}
```

---

## Route: /spu/validation/thermocouple/history

**File:** `src/routes/spu/validation/thermocouple/history/+page.server.ts`

### Load Function Returns
```typescript
{
  sessions: {
    id: string
    status: string
    passed: boolean | null
    startedAt: string | null
    completedAt: string | null
    createdAt: string
    barcode: string | null
    username: string | null
    minTemp: number | null
    maxTemp: number | null
    avgTemp: number | null
  }[]
  stats: {
    total: number
    passed: number
    failed: number
  }
  filters: {
    status: string | null
    from: string | null
    to: string | null
  }
}
```
**Query params:** `status`, `from`, `to`

---

## Route: /spu/particle/settings

**File:** `src/routes/spu/particle/settings/+page.server.ts`

### Load Function Returns
```typescript
{
  config: {
    id: string
    accessToken: string | null
    isActive: boolean
    syncIntervalMinutes: number | null
    lastSyncAt: Date | null
    lastSyncError: string | null
  } | null
  devices: {
    id: string
    deviceId: string
    name: string | null
    isOnline: boolean
    linkedSpuId: string | null
  }[]
}
```

### Form Actions
**saveConfig** - `{ accessToken, syncIntervalMinutes }`
**sync** - triggers manual Particle sync
**disconnect** - removes Particle integration

---

# API Routes

The following API endpoints exist as `+server.ts` files. Client-side `.svelte` files may `fetch()` these directly.

## Admin APIs
- `POST /admin/add-schema-permission` — adds schema permission
- `POST /admin/create-schema-table` — creates schema table
- `POST /admin/seed-schema` — seeds schema metadata
- `POST /api/admin/fix-permissions` — fixes permission issues

## Agent APIs (`/api/agent/*`)
These are used by the AI agent integration, not by the UI directly:
- `GET/POST /api/agent/health`
- `GET/POST /api/agent/messages` — agent messaging
- `GET/POST /api/agent/query` — natural language DB queries
- `GET /api/agent/schema` — schema introspection
- `GET /api/agent/system` — system status
- `/api/agent/approval/*` — approval workflows
- `/api/agent/operations/*` — operations dashboards, alerts, audit, equipment, inventory, kanban, maintenance, projects, quality, reports, workflows

## BOM API
- `GET /api/bom/search` — search BOM items

## Box.com Integration
- `GET /api/box/auth` — initiates OAuth
- `GET /api/box/callback` — OAuth callback
- `GET /api/box/files/[fileId]` — download file
- `POST /api/box/upload` — upload file

## Cron
- `POST /api/cron/archive-done-tasks` — archives completed kanban tasks

## Inventory
- `GET /api/inventory/transactions` — list transactions
- `POST /api/inventory/transactions/[transactionId]/retract` — retract transaction

## Kanban
- `POST /api/kanban/move` — move task (used by drag-and-drop)

## Location
- `POST /api/location/resolve` — resolve location barcode

## Opentrons Lab
- `GET /api/opentrons-lab/robots` — list robots
- `GET /api/opentrons-lab/robots/[id]` — robot detail
- Various sub-routes for calibration, health, home, identify, lights, protocols, runs, actions, state

## Opentrons History
- `GET /api/opentrons/history/[runId]` — historical run data

## Validation
- `POST /api/validation/magnetometer` — submit magnetometer results
- `POST /api/validation/spectrophotometer` — submit spectrophotometer results
- `POST /api/validation/thermocouple` — submit thermocouple results

## SPU-specific APIs
- `GET /spu/assays/[assayId]/versions` — assay version history
- `GET /spu/assays/export` — export assays
- `GET /spu/cartridges/export` — export cartridges CSV
- `POST /spu/cartridges/scan` — scan cartridge barcode
- `GET /spu/documents/instructions/check-inventory` — check inventory for instruction

---

# Shared Server Utilities

## `src/lib/server/auth.ts`
- `generateSessionToken()` → string
- `createSession(token, userId)` → Session
- `validateSessionToken(token)` → { session, user } | null
- `invalidateSession(sessionId)` → void
- `setSessionTokenCookie(event, token, expiresAt)` → void
- `deleteSessionTokenCookie(event)` → void

## `src/lib/server/auth/permissions.ts`
- `requirePermission(user, permission)` → void (throws 403)
- `hasPermission(user, permission)` → boolean
- `generateId()` → string (nanoid)
- `logAudit({ userId, action, entityType, entityId, previousValue?, newValue? })` → void

## `src/lib/server/auth/agent.ts`
- `getAgentUserId()` → string | null

## `src/lib/server/auth/admin-override.ts`
- Admin override utilities

## `src/lib/server/db/index.ts`
- Exports `db` (Drizzle PostgreSQL client)

## `src/lib/server/db/schema.ts`
- Exports all Drizzle table definitions (spu, batch, user, session, etc.)
- Also exports type definitions (KanbanTaskStatus, KanbanPriority, KanbanTaskLength, etc.)

## `src/lib/server/services/`

### User & Role Management
- **user-management.ts** — `listUsers()`, `createUser()`, `updateUserProfile()`, `deactivateUser()`, `reactivateUser()`, `resetPassword()`, `assignRole()`, `removeRole()`
- **role-management.ts** — `listRoles()`, `getRoleDetail()`, `createRole()`, `updateRole()`, `deleteRole()`, `bulkSetPermissions()`, `listAllPermissions()`
- **invite.ts** — `createInvite()`, `validateToken()`, `acceptInvite()`, `listInvites()`, `revokeInvite()`

### Assay
- **assay.ts** — CRUD for assay types
- **assay-export.ts** — Export assay data

### BOM
- **bom-sync.ts** — `syncBomFromBox()`, `getBomSyncErrorDetail()`
- **bom-cost.ts** — BOM cost calculations
- **bom-labor.ts** — `getBomCostBreakdown()`
- **bom-parser.ts** — Parse BOM spreadsheets
- **bom-compliance.ts** — Compliance checks

### Cartridge
- **cartridge.ts** — Core cartridge CRUD
- **cartridge-admin/dashboard.ts** — Admin dashboard queries
- **cartridge-admin/lot-linking.ts** — Link cartridges to lots
- **cartridge-admin/qaqc-release.ts** — QA/QC release workflows
- **cartridge-admin/queries.ts** — Shared cartridge admin queries
- **cartridge-admin/statistics.ts** — Statistical summaries
- **cartridge-admin/storage-scanning.ts** — Storage location scanning
- **cartridge-analysis.ts** — Analysis data
- **cartridge-bom.ts** — Cartridge BOM mapping
- **cartridge-export.ts** — CSV export
- **cartridge-firmware-bridge.ts** — Firmware communication
- **cartridge-group.ts** — Cartridge grouping
- **cartridge-seed.ts** — Seed data

### Customer
- **customer.ts** — `listCustomers()`, customer CRUD
- **customer-notes.ts** — Customer notes

### Documents
- **document-classifier.ts** — Auto-classify documents
- **document-extractor.ts** — Extract document content
- **work-instruction-parser.ts** — Parse work instructions
- **work-instruction-version.ts** — Version management

### Equipment
- **equipment.ts** — Equipment CRUD and queries

### Fleet & Firmware
- **fleet.ts** — `getFleetSummary()`, `assignSPU()`
- **firmware-device.ts** — Firmware device management

### Inventory
- **inventory-transaction.ts** — Transaction management
- **production-run-inventory.ts** — Production run inventory
- **storage-location.ts** — Storage location management

### Kanban
- **kanban.ts** — `moveTask()`, `getTagsForTasks()`, `logAction()`, `getTaskById()`, `getComments()`, `addComment()`, `getTags()`, `getTaskTags()`, `addTagToTask()`, `removeTagFromTask()`, `getActionLog()`, `archiveDoneTasks()`, `getArchivedTasks()`

### Manufacturing
- **manufacturing/deck-tray.ts** — Deck/tray management
- **manufacturing/fill-history.ts** — Fill history queries
- **manufacturing/inventory-stub.ts** — Manufacturing inventory stubs
- **manufacturing/laser-cut.ts** — Laser cutting operations
- **manufacturing/lot.ts** — Manufacturing lot management
- **manufacturing/lot-step-entry.ts** — Lot step tracking
- **manufacturing/material-inventory.ts** — Material inventory
- **manufacturing/process-config.ts** — `listAll()` process configs
- **manufacturing/process-step.ts** — Process step management
- **manufacturing/qa-qc.ts** — QA/QC operations
- **manufacturing/robot-exclusivity.ts** — Robot locking/exclusivity
- **manufacturing/run-history.ts** — Run history
- **manufacturing/top-seal.ts** — Top seal cutting

### Opentrons
- **opentrons/completed-runs.ts** — Query completed runs
- **opentrons/protocol-manager.ts** — `listProtocolRecords()`, `getProtocolFromRobot()`, `getProtocolAnalysis()`, `getProtocolRecordByOT2Id()`
- **opentrons/robot-info.ts** — `getRobotFullInfo()`, `getCalibrationReport()`
- **opentrons/robot-registry.ts** — `listRobots()`, `getRobot()`
- **opentrons/run-monitor.ts** — `listRunsOnRobot()`, `getRunDetail()`

### Production
- **production-run.ts** — Production run management
- **production-run-inventory.ts** — Inventory during production

### Reagent Filling
- **reagent-filling/assay-types.ts** — Assay type queries
- **reagent-filling/cooling-queue.ts** — Cooling queue management
- **reagent-filling/inspection.ts** — Inspection workflows
- **reagent-filling/robots.ts** — `listRobots()`, `getDashboardState()`
- **reagent-filling/run.ts** — Run management
- **reagent-filling/settings.ts** — Settings CRUD
- **reagent-filling/storage.ts** — Storage management
- **reagent-filling/top-sealing.ts** — Top sealing operations

### Shipping
- **shipping.ts** — Shipment CRUD

### Test Results
- **test-result.ts** — Test result queries

### Validation
- **validation/barcode-generator.ts** — `generateValidationBarcode(type)` → `{ id, barcode }`
- **validation/magnetometer/db-import.ts** — Import magnetometer data
- **validation/magnetometer/interpreter.ts** — Interpret magnetometer results
- **validation/magnetometer/parser.ts** — Parse magnetometer data
- **validation/spectrophotometer/complete-test.ts** — Complete spectrophotometer test
- **validation/spectrophotometer/interpreter.ts** — Interpret results
- **validation/thermocouple/interpreter.ts** — Interpret thermocouple results

### Wax Filling
- **wax-filling/equipment.ts** — Equipment management
- **wax-filling/incubator-tube.ts** — Incubator tube tracking
- **wax-filling/oven-queue.ts** — Oven queue management
- **wax-filling/qc.ts** — QC operations
- **wax-filling/robots.ts** — `listRobots()`, `getDashboardState()`
- **wax-filling/run.ts** — Run management
- **wax-filling/settings.ts** — Settings CRUD
- **wax-filling/storage.ts** — Storage management

### Other
- **barcode-parser.ts** — Parse various barcode formats
- **change-approval.ts** — Change approval workflows
- **message-templates.ts** — Message templates
- **particle-sync.ts** — `pushDeviceUpdate()`, `unlinkDevice()`
- **rejection-reasons.ts** — Rejection reason management
- **agent-communication.ts** — Agent messaging
- **agent/audit.ts** — Agent audit queries
- **agent/query-engine.ts** — Natural language query engine
- **api/agent-response.ts** — Agent API response helpers
- **api/operations-helpers.ts** — Operations API helpers

## `src/lib/server/integrations/`

### Box.com
- **box/client.ts** — Box API client
- **box/config.ts** — Box configuration
- **box/access-validator.ts** — Token validation
- **box/index.ts** — Barrel export

### MOCREO
- **mocreo.ts** — Temperature sensor integration

### Opentrons
- **opentrons/client.ts** — HTTP client for Opentrons robots
- **opentrons/config.ts** — Robot configuration
- **opentrons/types.ts** — TypeScript types (OT2Protocol, OT2Run, OT2Pipette, etc.)
- **opentrons/index.ts** — Barrel export

### Particle
- **particle/client.ts** — Particle.io API client
- **particle/config.ts** — Particle configuration
- **particle/index.ts** — `pingDevice()` and barrel export

### Supabase Storage
- **supabase-storage.ts** — File storage operations

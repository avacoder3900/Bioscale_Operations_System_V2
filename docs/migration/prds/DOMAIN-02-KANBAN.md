# DOMAIN-02-KANBAN — Task Management Board

## Overview
**Domain:** Kanban Board & Project Management
**Dependencies:** Auth (AUTH-01 through AUTH-06 must be complete)
**MongoDB Collections:** `kanban_tasks`, `kanban_projects`, `audit_log`
**Test File:** `tests/contracts/02-kanban.test.ts` (5 tests)
**Contract Registry Sections:** Kanban Routes, Kanban Layout, API Routes (kanban/move, cron/archive-done-tasks)

---

## Story KB-01: Projects CRUD

### Description
Implement kanban project management — list, create, update, toggle active status.

### Routes Covered
- `GET /kanban/projects` — list all projects

### Contract References
**GET /kanban/projects returns:**
```typescript
{
  allProjects: {
    id: string, name: string, description: string | null, color: string,
    isActive: boolean, sortOrder: number, createdBy: string | null
  }[]
}
```

**Form Actions:**
- `create` — `{ name: string, description?: string, color?: string }`
- `update` — `{ projectId: string, name: string, description?: string, color?: string }`
- `toggleActive` — `{ projectId: string }`

### MongoDB Models Used
- `KanbanProject` — `KanbanProject.find().sort({ sortOrder: 1 })`

### Acceptance Criteria
- Test 3 in `02-kanban.test.ts` passes (GET /kanban/projects returns projects)
- CRUD operations work via form actions

---

## Story KB-02: Board View & Task CRUD

### Description
Implement the main kanban board page — loads all active tasks grouped by status, supports creating tasks, moving tasks (drag-and-drop), and deleting tasks.

### Routes Covered
- `GET /kanban` — board view with all tasks
- `POST /kanban` (actions: create, move, delete)
- `POST /api/kanban/move` — API endpoint for drag-and-drop moves

### Contract References
**GET /kanban returns (from layout + page):**
```typescript
{
  // From layout:
  user: User
  projects: { id: string, name: string, description: string | null, color: string, isActive: boolean, sortOrder: number, createdBy: string | null }[]
  users: { id: string, username: string }[]
  // From page:
  tasks: {
    id: string, title: string, description: string | null,
    status: 'backlog' | 'ready' | 'wip' | 'waiting' | 'done',
    priority: 'high' | 'medium' | 'low',
    taskLength: 'short' | 'medium' | 'long',
    projectId: string | null, assignedTo: string | null,
    dueDate: Date | null, sortOrder: number,
    waitingReason: string | null, waitingOn: string | null,
    createdAt: Date, statusChangedAt: Date | null, source: string | null,
    assigneeName: string | null, projectName: string | null, projectColor: string | null,
    tags: { id: string, name: string, color: string }[],
    daysInStatus: number
  }[]
}
```

**POST /api/kanban/move:**
- Accepts: `{ taskId: string, newStatus: string, sortOrder?: number }`
- Returns: `{ success: true }` or error

### MongoDB Models Used
- `KanbanTask` — `KanbanTask.find({ archived: false }).sort({ sortOrder: 1 })`
- `KanbanProject` — for layout data
- `User` — for layout users list

### MongoDB-Specific Notes
- Old code joined `KanbanTask` → `User` (for assignee name) and `KanbanTask` → `KanbanProject` (for project name/color). New code: these are **denormalized** in the task document as `assignee: { _id, username }` and `project: { _id, name, color }`
- Tags were a junction table (`KanbanTaskTag` + `KanbanTag`). Now embedded as string array in task. The contract expects `tags: { id, name, color }[]` — need to maintain a tags reference or embed full tag objects
- `daysInStatus` is computed: `Math.floor((Date.now() - statusChangedAt) / 86400000)`
- Moving a task: update `status`, `statusChangedAt`, `sortOrder`, push to `activityLog[]`

### Acceptance Criteria
- Tests 1, 5 in `02-kanban.test.ts` pass (board data with projects/users, move API endpoint)
- Tasks load with denormalized project/assignee data
- Create/move/delete actions work

---

## Story KB-03: Task Detail, Comments, Tags & Activity

### Description
Implement the task detail page with comments, tags, and activity log.

### Routes Covered
- `GET /kanban/task/[taskId]` — task detail
- Form actions: `update`, `move`, `addComment`, `addTag`, `removeTag`, `createTag`

### Contract References
**GET /kanban/task/[taskId] returns:**
```typescript
{
  task: {
    id: string, title: string, description: string | null, status: string,
    priority: string, taskLength: string, projectId: string | null,
    assignedTo: string | null, dueDate: Date | null, sortOrder: number,
    waitingReason: string | null, waitingOn: string | null,
    createdAt: Date, statusChangedAt: Date | null, source: string | null,
    assigneeName: string | null, projectName: string | null, projectColor: string | null,
    tags: { id: string, name: string, color: string }[]
  }
  comments: { id: string, content: string, createdAt: Date, userId: string, username: string }[]
  projects: { id: string, name: string, color: string, isActive: boolean, sortOrder: number }[]
  allTags: { id: string, name: string, color: string }[]
  taskTags: { id: string, name: string, color: string }[]
  activityLog: { id: string, action: string, details: Record<string, unknown> | null, createdAt: Date, userId: string, username: string }[]
}
```

### MongoDB Models Used
- `KanbanTask` — single document contains task + embedded comments + embedded activityLog + embedded tags
- `KanbanProject` — for projects dropdown

### MongoDB-Specific Notes
- Comments, activity log, and tags are all **embedded** in the task document
- Adding a comment: `KanbanTask.findByIdAndUpdate(taskId, { $push: { comments: { ... } } })`
- Old code had separate `KanbanComment`, `KanbanActionLog`, `KanbanTag`, `KanbanTaskTag` collections — all eliminated
- Tags need a separate mechanism for "allTags" — either maintain a separate small `kanban_tags` collection or aggregate distinct tags across all tasks

### Acceptance Criteria
- Task detail page loads with all data
- Comments can be added
- Tags can be added/removed/created
- Activity log displays correctly

---

## Story KB-04: List View, Archived Tasks & Cron

### Description
Implement list view with filters, archived tasks view, and the cron endpoint for archiving done tasks.

### Routes Covered
- `GET /kanban/list` — filterable list view
- `GET /kanban/archived` — archived tasks
- `POST /kanban/archived` (action: archiveDone)
- `POST /api/cron/archive-done-tasks` — cron endpoint

### Contract References
**GET /kanban/list returns:**
```typescript
{
  tasks: {
    id: string, title: string, description: string | null, status: string,
    priority: string, taskLength: string, projectId: string | null,
    assignedTo: string | null, dueDate: Date | null,
    waitingReason: string | null, waitingOn: string | null,
    createdAt: Date, statusChangedAt: Date | null,
    assigneeName: string | null, projectName: string | null, projectColor: string | null,
    tags: { id: string, name: string, color: string }[]
  }[]
}
```
Query params: `project`, `status`, `priority`, `assignee`

**GET /kanban/archived returns:**
```typescript
{ tasks: ArchivedTask[] }
```

### MongoDB Models Used
- `KanbanTask` — filtered queries, archive operations

### MongoDB-Specific Notes
- List view filters: `KanbanTask.find({ archived: false, ...(project && { 'project._id': project }), ...(status && { status }) })`
- Archive: `KanbanTask.updateMany({ status: 'done', archived: false }, { $set: { archived: true, archivedAt: new Date() } })`
- Archived view: `KanbanTask.find({ archived: true }).sort({ archivedAt: -1 })`

### Acceptance Criteria
- Tests 2, 4 in `02-kanban.test.ts` pass (list view, archived tasks)
- Filters work on list view
- Archive action moves done tasks to archived
- Cron endpoint archives done tasks

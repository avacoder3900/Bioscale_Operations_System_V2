# MongoDB Schema Redesign: Full Report

## Why This Document Exists

When your codebase was migrated from PostgreSQL (relational) to MongoDB (document), every Postgres table was converted 1:1 into a MongoDB collection. The schema shapes were preserved. The queries were rewritten from Drizzle ORM to Mongoose. The frontend was left unchanged.

This produced a system that has the **disadvantages of both databases and the advantages of neither.** You lost Postgres's referential integrity, automatic joins, and ACID transactions. You gained nothing from MongoDB's document embedding, flexible schemas, or single-query reads.

This report explains — with concrete examples from your codebase — what went wrong, what should change, and why each change follows document database best practices.

---

## Table of Contents

1. [The Fundamental Philosophy Difference](#1-the-fundamental-philosophy-difference)
2. [What Went Wrong in the Migration](#2-what-went-wrong-in-the-migration)
3. [The Six Systemic Issues](#3-the-six-systemic-issues)
4. [The Redesign: Domain by Domain](#4-the-redesign-domain-by-domain)
5. [Cross-Cutting Concerns](#5-cross-cutting-concerns)
6. [Migration Strategy](#6-migration-strategy)
7. [Decisions Needed](#7-decisions-needed)

---

## 1. The Fundamental Philosophy Difference

### How Relational Databases Think

A relational database stores **facts exactly once** and reconstructs views through JOINs.

Imagine you're building a library system. In Postgres, you'd have:

```
books table:        id, title, author_id
authors table:      id, name, bio
book_tags table:    book_id, tag_id      ← junction table
tags table:         id, name
reviews table:      id, book_id, user_id, text, rating
```

To display a book page, the database JOINs these tables together in milliseconds:

```sql
SELECT b.title, a.name, array_agg(t.name), array_agg(r.text)
FROM books b
JOIN authors a ON b.author_id = a.id
JOIN book_tags bt ON bt.book_id = b.id
JOIN tags t ON bt.tag_id = t.id
JOIN reviews r ON r.book_id = b.id
WHERE b.id = '123'
GROUP BY b.id, a.name;
```

One query. The database engine optimizes the join plan. Foreign keys guarantee that `author_id` always points to a real author. If you delete an author, the database either blocks it (referential integrity) or cascades the delete to their books.

**The tradeoff:** The data model is designed around *eliminating redundancy*, not around *how you read it*. Every read requires reassembling scattered data.

### How Document Databases Think

A document database stores **data the way you read it.** Instead of scattering a book across 5 tables, you store the entire book as one document:

```json
{
  "_id": "book-123",
  "title": "The Great Gatsby",
  "author": {
    "_id": "author-456",
    "name": "F. Scott Fitzgerald"
  },
  "tags": ["classic", "american", "fiction"],
  "reviews": [
    {
      "userId": "user-789",
      "username": "JakeR",
      "text": "Masterpiece",
      "rating": 5,
      "createdAt": "2026-01-15"
    }
  ]
}
```

To display the book page: **one query, one document, done.** No joins. No reassembly. The data is already in the shape the UI needs.

**The tradeoff:** The author's name is stored inside every book they wrote. If F. Scott Fitzgerald's estate legally changes his name, you'd need to update every book document that references him. But name changes are *rare*. Book page views are *constant*. Document databases optimize for the common case.

### The Key Insight

> **Relational databases normalize data to eliminate redundancy. Document databases denormalize data to eliminate joins.**

Neither is "better." They're different tools for different access patterns. The mistake is using a document database but still organizing data as if it were relational.

---

## 2. What Went Wrong in the Migration

### What Was Done

Every Postgres table became a MongoDB collection with the same shape:

```
PostgreSQL                    MongoDB (current)
─────────────                 ─────────────────
kanban_tasks table      →     KanbanTask collection
kanban_comments table   →     KanbanComment collection
kanban_task_tags table  →     KanbanTaskTag collection
kanban_tags table       →     KanbanTag collection
kanban_action_log table →     KanbanActionLog collection
```

The relationships are still modeled the same way — foreign key references between separate collections:

```typescript
// Current: task references project via projectId (relational pattern)
const task = await KanbanTask.findOne({ _id: taskId }).lean();
const project = await KanbanProject.findOne({ _id: task.projectId }).lean();
const comments = await KanbanComment.find({ taskId: task._id }).lean();
const tagLinks = await KanbanTaskTag.find({ taskId: task._id }).lean();
const tags = await KanbanTag.find({ _id: { $in: tagLinks.map(tl => tl.tagId) } }).lean();
```

**Five queries to display one task.** In Postgres, this was one query with JOINs. In MongoDB, there are no JOINs. So the code manually does what the Postgres engine used to do — but worse, because:

1. **Each query is a separate network round-trip** to the database
2. **There's no query optimizer** coordinating them
3. **There are no foreign keys** guaranteeing the references are valid
4. **There are no transactions** guaranteeing the operations are atomic

### What Should Have Been Done

In MongoDB, the task document should **contain** its comments, tags, and project info:

```typescript
// Correct document approach: one query returns everything
const task = await KanbanTask.findOne({ _id: taskId }).lean();
// task.comments = [...], task.tags = [...], task.project = { name, color }
// Done. One query.
```

### The Result: Worst of Both Worlds

| Feature | Postgres (before) | MongoDB (current) | MongoDB (proper) |
|---------|-------------------|-------------------|------------------|
| Joins | Automatic, optimized | Manual, N+1 queries | Not needed (embedded) |
| Referential integrity | Foreign keys enforced | Nothing enforced | Managed by schema design |
| Transactions | Automatic per-request | Zero in codebase | Explicit where needed |
| Query count per page | 1 (with JOINs) | 3-5 (manual joins) | 1 (embedded document) |
| Data redundancy | None | None | Controlled duplication |

---

## 3. The Six Systemic Issues

### Issue 1: `_id` vs `id` — The Universal Breakage

**Severity: 🔴 Critical — actively breaking the UI right now**

In Postgres/Drizzle, every row had an `id` field. The frontend references `.id` everywhere — **474 times** across your Svelte templates.

In Mongoose, the primary key is `_id`. When you call `.lean()` to get a plain JavaScript object, Mongoose strips out its virtual getters — including the `id` virtual that normally aliases `_id`. So:

```typescript
// Mongoose document (full object with virtuals):
const doc = await KanbanProject.findOne({ _id: 'abc' });
console.log(doc.id);   // "abc" ✅ (virtual getter works)
console.log(doc._id);  // "abc" ✅

// Lean object (plain JS, no virtuals):
const doc = await KanbanProject.findOne({ _id: 'abc' }).lean();
console.log(doc.id);   // undefined ❌ (no virtual!)
console.log(doc._id);  // "abc" ✅
```

**Your codebase calls `.lean()` 415 times.** Every one of those returns objects without `.id`.

#### How This Broke the Kanban Board

Here's the exact chain of failure:

**Step 1:** The layout server loads projects with `.lean()`:
```typescript
// src/routes/kanban/+layout.server.ts
const projects = await KanbanProject.find({ isActive: true })
  .sort({ sortOrder: 1 })
  .lean();  // ← returns objects with _id but NOT id
return { projects };
```

**Step 2:** The page template reads `proj.id` (which is `undefined`):
```typescript
// src/routes/kanban/+page.svelte
for (const proj of sortedProjects) {
  groups.push({
    id: proj.id,        // ← undefined for ALL projects
    name: proj.name,
    color: proj.color,
    tasks: byProject.get(proj.id) ?? []  // ← byProject.get(undefined) = nothing
  });
}
```

**Step 3:** The keyed `#each` loop uses `group.id` as the key:
```svelte
{#each projectGroups as group (group.id ?? '__none')}
```

Since `group.id` is `undefined` for ALL projects, `undefined ?? '__none'` = `'__none'` for ALL of them. Svelte uses keys to track which DOM elements correspond to which data items. When every item has the same key, Svelte can't tell them apart — it renders one, or they overwrite each other.

**This is exactly what you saw:** projects replacing each other, the create button disappearing, elements becoming unclickable.

**Step 4:** Task matching also fails:
```typescript
const key = task.projectId;  // e.g., "proj-abc123" (from MongoDB _id)
byProject.set(key, []);      // Map has real project IDs as keys

// But then:
tasks: byProject.get(proj.id) ?? []  // proj.id = undefined, never matches
```

Every project shows 0 tasks, even if they have tasks assigned.

#### The Scale of This Problem

Some routes **did** fix this manually:
```typescript
// src/routes/spu/+page.server.ts (fixed)
const spus = spuAll.map((s) => ({
  id: s._id,  // ← explicitly mapping _id to id
  ...s,
}));
```

But most routes — including the kanban layout, projects page, list page, and many SPU subroutes — pass raw `.lean()` results without mapping. **There is no consistency.**

Additionally, **41 queries** use `.select('id username')`, which in Mongoose tries to select a field literally called `id` (not `_id`). These queries return objects missing the identifier:

```typescript
// Broken:
const users = await User.find({}).select('id username').lean();
// Returns: [{ username: 'jacob' }]  ← no id or _id!

// Should be:
const users = await User.find({}).select('_id username').lean();
// Returns: [{ _id: 'user-123', username: 'jacob' }]
```

---

### Issue 2: Silent Query Failures

**Severity: 🔴 Critical — data operations silently doing nothing**

Some queries were translated from Drizzle using `{ id: value }` instead of `{ _id: value }`. In Mongoose, this searches for a field called `id` in the MongoDB document — which doesn't exist. The query matches nothing and returns silently.

**Confirmed example — Work Instructions cannot be deleted:**

```typescript
// src/routes/spu/documents/instructions/+page.server.ts, line 91
await WorkInstruction.deleteOne({ id });
```

This passes `{ id: 'wi-abc123' }` to MongoDB, which looks for a document where a field called `id` equals `'wi-abc123'`. Since the documents only have `_id`, this matches nothing. The delete silently succeeds (no error) with `deletedCount: 0`.

**The user clicks "delete," the UI refreshes, and the work instruction is still there.** But there's no error message — the operation "succeeded."

Similarly on line 80:
```typescript
const steps = await WorkInstructionStep.find({ workInstructionVersionId: version.id })
  .select('id').lean() as { id: string }[];
```

`version.id` is `undefined` (lean object, no virtual). So this queries `{ workInstructionVersionId: undefined }`, which in MongoDB matches documents where `workInstructionVersionId` doesn't exist or is null. It might return the wrong data or nothing.

Then on lines 83-85:
```typescript
StepFieldDefinition.deleteMany({ stepId: step.id }),
StepPartRequirement.deleteMany({ stepId: step.id }),
StepToolRequirement.deleteMany({ stepId: step.id })
```

`step.id` is `undefined` (from the `.select('id').lean()` above). So `{ stepId: undefined }` → matches nothing → cascade delete silently deletes nothing → orphaned records remain in the database forever.

**This is a data integrity crisis hiding behind silent successes.**

---

### Issue 3: Junction Tables as Separate Collections

**Severity: 🟠 Design flaw — causes N+1 queries and unnecessary complexity**

In relational databases, many-to-many relationships require a "junction table" (also called a join table or bridge table). For example, to link tasks to tags:

```
PostgreSQL:
kanban_tasks:     id, title, ...
kanban_tags:      id, name, color
kanban_task_tags: task_id, tag_id   ← junction table
```

This was necessary because Postgres rows can't contain arrays of references. The junction table is the only way to model many-to-many.

**MongoDB doesn't have this limitation.** Documents can contain arrays:

```json
{
  "_id": "task-123",
  "title": "Fix login bug",
  "tags": ["urgent", "frontend", "auth"]
}
```

But your codebase still has these junction-table collections:

| Junction Collection | Parent | Child | Should Be |
|--------------------|--------|-------|-----------|
| `KanbanTaskTag` | KanbanTask | KanbanTag | `tags: string[]` in task |
| `UserRole` | User | Role | `roles: [{ roleId, roleName, permissions }]` in user |
| `RolePermission` | Role | Permission | `permissions: string[]` in role |
| `BomPartLink` | BomItem | PartDefinition | `partLinks: [{ partDefId, type }]` in BOM item |
| `PackageCartridge` | ShippingPackage | Cartridge | `cartridges: [{ id, addedAt }]` in package |
| `StepPartRequirement` | WorkInstructionStep | PartDefinition | embedded array in step |
| `StepToolRequirement` | WorkInstructionStep | Tool | embedded array in step |

#### Example: Loading Tags for a Task

**Current approach (relational pattern in MongoDB):**
```typescript
// Step 1: Get the task
const task = await KanbanTask.findOne({ _id: taskId }).lean();

// Step 2: Get tag links from junction table
const tagLinks = await KanbanTaskTag.find({ taskId }).lean();

// Step 3: Get actual tag data
const tagIds = tagLinks.map(tl => tl.tagId);
const tags = await KanbanTag.find({ _id: { $in: tagIds } }).lean();

// Three queries for one piece of information
```

**Proper document approach:**
```typescript
// Task document already contains tags
const task = await KanbanTask.findOne({ _id: taskId }).lean();
// task.tags = ["urgent", "frontend", "auth"]
// Done. One query.
```

#### Example: Checking User Permissions

**Current approach (4 queries per request):**
```typescript
// src/lib/server/auth/permissions.ts
const userRoles = await UserRole.find({ userId }).lean();           // Query 1
const roleIds = userRoles.map(ur => ur.roleId);
const rolePerms = await RolePermission.find({                       // Query 2
  roleId: { $in: roleIds }
}).lean();
const permIds = rolePerms.map(rp => rp.permissionId);
const permissions = await Permission.find({                          // Query 3
  _id: { $in: permIds }
}).lean();
// Plus the initial user lookup                                     // Query 4
```

This runs **on every single request** (permission checks are in middleware). Four database round-trips before any actual work happens.

**Proper document approach (1 query):**
```typescript
const user = await User.findOne({ _id: userId }).lean();
// user.roles = [
//   {
//     roleId: "role-admin",
//     roleName: "Admin",
//     permissions: ["kanban:read", "kanban:write", "kanban:admin"]
//   }
// ]
const hasPermission = user.roles.some(r =>
  r.permissions.includes('kanban:write')
);
// One query. The user document already contains everything.
```

**Why this works in MongoDB:** Permissions are small strings. A user might have 3-5 roles with 20-50 permissions total. That's maybe 2KB of data embedded in the user document. It changes rarely (role assignments are weekly/monthly events). But it's *read* on every single request. Embedding eliminates 3 queries per request × thousands of requests per day.

---

### Issue 4: Zero Transactions

**Severity: 🟠 Data integrity risk — HIPAA concern**

In PostgreSQL, every request is implicitly wrapped in a transaction. If your code does:

```sql
INSERT INTO kanban_tasks (id, title) VALUES ('task-1', 'Fix bug');
INSERT INTO audit_log (entity_id, action) VALUES ('task-1', 'created');
```

And the second INSERT fails (network error, constraint violation, anything), the first INSERT is **automatically rolled back.** The database guarantees that either both happen or neither happens. This is called "atomicity."

**MongoDB has no automatic transactions.** Each `await Model.create(...)` is an independent operation. Here's what your kanban task creation looks like:

```typescript
// src/routes/kanban/+page.server.ts
await KanbanTask.create({ ... });         // Operation 1: create task ✅
await logAudit({ ... });                   // Operation 2: audit log  ❌ (fails)
await logAction(taskId, 'task_created');   // Operation 3: action log (never runs)
```

If operation 2 fails, you have a task with no audit trail. In a HIPAA environment, this means you can't prove who created the task or when.

**Where this matters most in your codebase:**

| Operation | What Could Partially Fail | Consequence |
|-----------|--------------------------|-------------|
| Task creation | Task created, audit log missing | No HIPAA trail |
| Assembly step completion | Step marked complete, inventory not deducted | Inventory drift |
| Cartridge phase transition | Wax record updated, reagent record not created | Lost cartridge |
| SPU status change | SPU updated, electronic signature missing | Compliance gap |
| BOM import | Some items created, others failed | Partial BOM |

**The fix:** Wrap multi-document operations in MongoDB transactions:

```typescript
const session = await mongoose.startSession();
try {
  await session.withTransaction(async () => {
    await KanbanTask.create([taskData], { session });
    await AuditLog.create([auditData], { session });
    await KanbanActionLog.create([actionData], { session });
  });
  // All three succeeded atomically
} finally {
  session.endSession();
}
```

If any operation inside `withTransaction` fails, all operations are rolled back. This is the MongoDB equivalent of Postgres's implicit transactions.

---

### Issue 5: No Referential Integrity

**Severity: 🟡 Silent corruption over time**

In Postgres, foreign keys prevent invalid references:

```sql
-- This would FAIL in Postgres if project "proj-999" doesn't exist:
INSERT INTO kanban_tasks (project_id) VALUES ('proj-999');
-- ERROR: insert or update violates foreign key constraint
```

MongoDB has no foreign keys. This means:

1. **You can create a task pointing to a non-existent project.** The task renders with `projectName: null` and `projectColor: null`.

2. **You can delete a project without touching its tasks.** All tasks assigned to that project now have orphaned `projectId` references. They won't appear on the board (no matching project group) but they still exist in the database.

3. **You can delete a user whose ID is referenced in hundreds of documents** — audit logs, assembly records, task assignments, comments. All those `createdBy`, `assignedTo`, `performedBy` fields now point to nothing.

**In your current codebase, there's one explicit cascade delete attempt:**

```typescript
// src/routes/spu/documents/instructions/+page.server.ts
// Trying to delete a work instruction and all its children:
const versions = await WorkInstructionVersion.find({ workInstructionId: id }).lean();
for (const version of versions) {
  const steps = await WorkInstructionStep.find({
    workInstructionVersionId: version.id  // ← undefined (Issue 1!)
  }).select('id').lean();

  for (const step of steps) {
    await Promise.all([
      StepFieldDefinition.deleteMany({ stepId: step.id }),  // ← undefined
      StepPartRequirement.deleteMany({ stepId: step.id }),  // ← undefined
      StepToolRequirement.deleteMany({ stepId: step.id })   // ← undefined
    ]);
  }
  await WorkInstructionStep.deleteMany({ workInstructionVersionId: version.id }); // ← undefined
}
await WorkInstructionVersion.deleteMany({ workInstructionId: id });
await WorkInstruction.deleteOne({ id });  // ← queries { id } not { _id }
```

Every single delete in this cascade is broken due to Issues 1 and 2. The work instruction survives. Its children survive. **Orphaned data accumulates silently.**

**How the redesign fixes this:** When data is embedded (comments inside tasks, steps inside work instructions), deleting the parent automatically deletes the children — they're part of the same document. No cascade logic needed. No orphans possible.

---

### Issue 6: 110 Flat Collections

**Severity: 🟡 Architectural — prevents MongoDB from being useful**

Your database has 110 collections. A well-designed MongoDB schema for the same domain would have 28-32. The difference is the number of relationships modeled as separate collections vs. embedded documents.

#### Example: Work Instructions — 8 Collections → 1 Document

**Current structure (8 separate collections):**

```
WorkInstruction          → has many → WorkInstructionVersion
WorkInstructionVersion   → has many → WorkInstructionStep
WorkInstructionStep      → has many → StepPartRequirement
WorkInstructionStep      → has many → StepToolRequirement
WorkInstructionStep      → has many → StepFieldDefinition
                         (plus: WorkInstructions legacy, StepFieldRecord)
```

To display one work instruction, the code queries **6 collections**:

```typescript
// Pseudocode of what happens to render a work instruction
const wi = await WorkInstruction.findOne({ _id: id });
const versions = await WorkInstructionVersion.find({ workInstructionId: id });
const latestVersion = versions[versions.length - 1];
const steps = await WorkInstructionStep.find({ workInstructionVersionId: latestVersion._id });
const partReqs = await StepPartRequirement.find({ stepId: { $in: steps.map(s => s._id) } });
const toolReqs = await StepToolRequirement.find({ stepId: { $in: steps.map(s => s._id) } });
const fieldDefs = await StepFieldDefinition.find({ stepId: { $in: steps.map(s => s._id) } });
// 7 queries, then manual stitching in JavaScript
```

**Proper document structure (1 document):**

```json
{
  "_id": "wi-001",
  "documentNumber": "WI-2026-001",
  "title": "SPU Assembly - Standard Build",
  "status": "active",
  "currentVersion": 3,

  "versions": [
    {
      "_id": "ver-001",
      "version": 1,
      "changeNotes": "Initial release",
      "steps": [
        {
          "_id": "step-001",
          "stepNumber": 1,
          "title": "Install PCB Board",
          "content": "Place the PCB board into the housing...",
          "requiresScan": true,
          "scanPrompt": "Scan PCB barcode",

          "partRequirements": [
            { "partNumber": "PCB-100", "quantity": 1, "notes": "Rev C or later" }
          ],
          "toolRequirements": [
            { "toolNumber": "T-001", "toolName": "Torque Driver", "calibrationRequired": true }
          ],
          "fieldDefinitions": [
            {
              "_id": "field-001",
              "fieldName": "pcb_barcode",
              "fieldLabel": "PCB Barcode",
              "fieldType": "barcode_scan",
              "isRequired": true
            }
          ]
        },
        {
          "_id": "step-002",
          "stepNumber": 2,
          "title": "Connect Ribbon Cable",
          "content": "Route the ribbon cable through the channel..."
        }
      ]
    }
  ]
}
```

**To display this work instruction: one query.**

```typescript
const wi = await WorkInstruction.findOne({ _id: 'wi-001' }).lean();
// Everything is already there. Steps, requirements, field definitions.
// No joins. No stitching. No N+1 queries.
```

#### Why Embedding Works Here

The "should I embed or reference?" decision comes down to three questions:

| Question | Answer for WI Steps | Implication |
|----------|-------------------|-------------|
| Is this data always accessed with its parent? | Yes — you never view a step without its WI | Embed |
| Can this array grow unbounded? | No — a WI has 5-30 steps, each with < 10 requirements | Embed (safely under 16MB) |
| Does this data need independent queries? | No — you never search "all steps across all WIs" | Embed |

When all three answers point to "embed," you embed. When any answer points to "reference," you keep it separate.

#### Counter-Example: Audit Logs — Keep Separate

```
Question: Is audit data always accessed with its parent?
Answer: No — you view audit logs in a dedicated admin page, filtered by date/user/action.

Question: Can this array grow unbounded?
Answer: Yes — every action generates a log entry. Over months, millions of entries.

Question: Does this data need independent queries?
Answer: Yes — "show me all actions by user X in the last 24 hours" across all entities.
```

All three answers say "reference." Audit logs stay as a separate collection.

---

## 4. The Redesign: Domain by Domain

### 4.1 Auth & Access Control (8 → 4 collections)

**Current:**
```
User ←→ UserRole ←→ Role ←→ RolePermission ←→ Permission
         junction              junction
User → CommunicationPreference
```

**Problem:** Permission checking requires 4 queries per request (user → user roles → role permissions → permissions). This runs on EVERY authenticated request.

**Redesigned `users` document:**

```json
{
  "_id": "user-jacob",
  "username": "jacob",
  "passwordHash": "$2b$...",
  "firstName": "Jacob",
  "lastName": "Quick",
  "email": "jacob@brevitest.com",
  "isActive": true,

  "roles": [
    {
      "roleId": "role-admin",
      "roleName": "Admin",
      "assignedAt": "2026-02-10T00:00:00Z",
      "assignedBy": "user-javier",
      "permissions": [
        "kanban:read", "kanban:write", "kanban:admin",
        "spu:read", "spu:write",
        "manufacturing:read", "manufacturing:write"
      ]
    }
  ],

  "communicationPreferences": [
    {
      "channel": "telegram",
      "frequency": "real_time",
      "urgencyThreshold": "normal",
      "isActive": true
    }
  ]
}
```

**Why embed roles and permissions?**

- **Access pattern:** Every request needs user + permissions. That's the #1 read path in the entire app.
- **Size:** A user has 1-5 roles, each with 10-20 permissions. Total: maybe 1KB of embedded data.
- **Change frequency:** Roles change monthly at most. The denormalized `roleName` and `permissions` rarely need updating.
- **The payoff:** Permission checking goes from 4 queries → 1 query. Multiply by every request, every user, every day.

**What stays separate:**
- `sessions` — High-churn, TTL-indexed. Embedding would mean constant user doc updates.
- `roles` — Reference catalog. When you edit a role definition, update the role doc AND batch-update all users with that role.
- `invite_tokens` — Independent lifecycle, low volume.

**Eliminated:** `Permission`, `UserRole`, `RolePermission`, `CommunicationPreference` (4 collections gone)

---

### 4.2 Kanban Board (8 → 2 collections)

**Current:**
```
KanbanProject
KanbanTask → projectId, assignedTo
KanbanComment → taskId
KanbanTag
KanbanTaskTag → taskId, tagId (junction)
KanbanActionLog → taskId
KanbanTaskProposal
KanbanBoardEvent
```

**Problem:** The board page loads ALL tasks, then needs project names/colors, tag names, and comment counts. This requires querying 5+ collections and stitching in JavaScript.

**Redesigned `kanban_tasks` document:**

```json
{
  "_id": "task-abc123",
  "title": "Fix login page timeout",
  "description": "Users report being logged out after 5 minutes...",
  "status": "wip",
  "priority": "high",
  "taskLength": "medium",
  "sortOrder": 3,

  "project": {
    "_id": "proj-ops",
    "name": "Misc Operations and Supporting Tasks",
    "color": "#ff00ff"
  },

  "assignee": {
    "_id": "user-jacob",
    "username": "jacob"
  },

  "tags": ["frontend", "auth", "urgent"],

  "dueDate": "2026-03-01",

  "statusChangedAt": "2026-02-26T14:30:00Z",
  "backlogDate": "2026-02-20T10:00:00Z",
  "readyDate": "2026-02-22T09:00:00Z",
  "wipDate": "2026-02-26T14:30:00Z",
  "waitingReason": null,
  "waitingOn": null,

  "comments": [
    {
      "_id": "comment-1",
      "content": "Looks like the session TTL is set to 5 minutes in prod",
      "createdAt": "2026-02-26T15:00:00Z",
      "createdBy": { "_id": "user-jacob", "username": "jacob" }
    },
    {
      "_id": "comment-2",
      "content": "Fixed — increased to 24 hours. Deploy pending.",
      "createdAt": "2026-02-26T16:30:00Z",
      "createdBy": { "_id": "user-javier", "username": "javier" }
    }
  ],

  "activityLog": [
    { "action": "task_created", "createdAt": "2026-02-20T10:00:00Z", "createdBy": "user-jacob" },
    { "action": "status_changed", "details": { "from": "backlog", "to": "ready" }, "createdAt": "2026-02-22T09:00:00Z" },
    { "action": "status_changed", "details": { "from": "ready", "to": "wip" }, "createdAt": "2026-02-26T14:30:00Z" }
  ],

  "archived": false,
  "source": "manual",
  "createdAt": "2026-02-20T10:00:00Z",
  "createdBy": "user-jacob"
}
```

**Why embed comments, tags, and activity?**

| Data | Size | Accessed With Task? | Needs Independent Query? | Decision |
|------|------|--------------------|-----------------------|----------|
| Comments | 5-50 per task | Yes (task detail page) | No | Embed |
| Tags | 1-10 strings | Yes (board + detail) | Rarely (filter by tag) | Embed as strings |
| Activity log | 10-100 entries | Yes (task detail) | No | Embed |
| Project info | 3 fields | Yes (every board render) | Yes (project list page) | Denormalize (copy name+color) |
| Assignee | 2 fields | Yes (every board render) | Yes (user list) | Denormalize (copy username) |

**Why denormalize project name/color?**

The board page renders ALL active tasks grouped by project. Currently it does:

```typescript
// Current: 2 queries + JavaScript stitching
const tasks = await KanbanTask.find({ archived: false }).lean();
const projects = await KanbanProject.find({ isActive: true }).lean();
// Then in Svelte: manually match tasks to projects by ID
```

With denormalized project info in each task:

```typescript
// Redesigned: 1 query, data already grouped
const tasks = await KanbanTask.find({ archived: false }).lean();
// Each task already has task.project.name and task.project.color
// Svelte can group immediately — no second query, no matching
```

**"But what if a project name changes?"**

Project names change very rarely (maybe once a quarter). When it happens:

```typescript
await KanbanTask.updateMany(
  { 'project._id': projectId },
  { $set: { 'project.name': newName, 'project.color': newColor } }
);
```

One bulk update. This is the document database tradeoff: optimize for the 10,000 reads by accepting occasional batch updates on the rare write.

**Eliminated collections:** `KanbanComment`, `KanbanTag`, `KanbanTaskTag`, `KanbanActionLog`, `KanbanBoardEvent`, `KanbanTaskProposal` (6 collections gone)

---

### 4.3 Work Instructions (8 → 1 collection)

Already detailed in Issue 6 above. The entire tree collapses into one document:

```
WorkInstruction
  └── versions[]
        └── steps[]
              ├── partRequirements[]
              ├── toolRequirements[]
              └── fieldDefinitions[]
```

**Size analysis:** A complex work instruction with 3 versions × 20 steps × 5 requirements each = ~300 embedded objects. At ~200 bytes each, that's ~60KB. Well under MongoDB's 16MB limit.

**⚠️ One exception:** If steps contain `imageData` (base64-encoded images), each image could be 500KB-2MB. A 20-step WI with images could hit 10-40MB — exceeding the 16MB limit. In that case, store images in GridFS or an object store and reference by URL.

**Eliminated:** 7 collections → embedded in 1

---

### 4.4 SPU & Assembly (8 → 3 collections)

**Current:**
```
Spu → batchId, assignmentCustomerId
SpuPart → spuId, partDefinitionId
ParticleLink → spuId
AssemblySession → spuId
AssemblyStepRecord → assemblySessionId
StepFieldRecord → assemblyStepRecordId
ElectronicSignature → entityId
Batch
```

**Redesigned `spus` document:**

```json
{
  "_id": "spu-001",
  "udi": "BRV-2026-001234",
  "status": "active",
  "deviceState": "testing",
  "assemblyStatus": "completed",

  "batch": {
    "_id": "batch-10",
    "batchNumber": "B-2026-010"
  },

  "assignmentCustomer": {
    "_id": "cust-acme",
    "name": "Acme Health Labs"
  },

  "parts": [
    {
      "_id": "part-rec-1",
      "partDefinitionId": "pd-pcb100",
      "partNumber": "PCB-100",
      "partName": "Main PCB Board",
      "lotNumber": "LOT-2026-A",
      "scannedAt": "2026-02-15T10:30:00Z",
      "scannedBy": "user-andres",
      "isReplaced": false
    },
    {
      "_id": "part-rec-2",
      "partDefinitionId": "pd-housing",
      "partNumber": "HSG-200",
      "partName": "Device Housing",
      "lotNumber": "LOT-2026-B",
      "scannedAt": "2026-02-15T10:35:00Z",
      "scannedBy": "user-andres",
      "isReplaced": false
    }
  ],

  "particleLink": {
    "particleSerial": "P004-ABC123",
    "particleDeviceId": "e00fce68...",
    "linkedAt": "2026-02-15T11:00:00Z",
    "linkedBy": "user-andres"
  }
}
```

**Why embed parts in SPU?** An SPU has 10-30 parts. They're always displayed on the SPU detail page. They're never queried independently ("find all SPUs that used lot LOT-2026-A" — this is a valid query, but it works fine with `{ 'parts.lotNumber': 'LOT-2026-A' }` on an indexed field).

**Why embed ParticleLink?** It's a 1:1 relationship. An SPU has exactly one particle link. Embedding it eliminates a separate collection and a join.

**Why keep AssemblySession separate?** Assembly sessions are actively written to during the build process (operator is stepping through, recording field values). They have their own lifecycle (in_progress → paused → completed). Embedding them in the SPU would mean frequent updates to a potentially large SPU document.

**Redesigned `assembly_sessions` document:**

```json
{
  "_id": "session-001",
  "spuId": "spu-001",
  "userId": "user-andres",
  "status": "completed",
  "currentStepIndex": 5,
  "startedAt": "2026-02-15T10:00:00Z",
  "completedAt": "2026-02-15T11:30:00Z",

  "stepRecords": [
    {
      "_id": "step-rec-1",
      "workInstructionStepId": "step-001",
      "scannedLotNumber": "LOT-2026-A",
      "scannedPartNumber": "PCB-100",
      "completedAt": "2026-02-15T10:15:00Z",
      "completedBy": "user-andres",

      "fieldRecords": [
        {
          "stepFieldDefinitionId": "field-001",
          "fieldValue": "PCB-100-LOT2026A-SN0042",
          "rawBarcodeData": "PCB-100-LOT2026A-SN0042",
          "scannedAt": "2026-02-15T10:12:00Z",
          "capturedBy": "user-andres"
        }
      ]
    }
  ]
}
```

**Why embed stepRecords and fieldRecords in the session?** The assembly UI loads the session + all its step records + all field records in one go. An operator stepping through a build needs all this data on one screen. Embedding means one query loads the entire build state. A session has ~20 steps × ~5 fields = ~100 embedded records — tiny.

**Eliminated:** `SpuPart` (→ embedded in SPU), `ParticleLink` (→ embedded in SPU), `AssemblyStepRecord` (→ embedded in session), `StepFieldRecord` (→ embedded in step records)

---

### 4.5 Manufacturing Pipeline — The Cartridge Lifecycle (20+ → 7 collections)

This is the most complex domain. A cartridge moves through a pipeline:

```
Laser Cut Sheets → Backing Lot → Wax Filling → Reagent Filling → Top Seal → QC → Storage → Shipping
```

In the current schema, each phase has its own collection:
- `WaxCartridgeRecord` — the cartridge during wax filling
- `ReagentCartridgeRecord` — the same cartridge during reagent filling
- `PackageCartridge` — the same cartridge during shipping

**This is like having three different medical records for the same patient at three different hospitals.** Each record knows about its own phase but not the others. To see the full cartridge history, you query three collections and stitch manually.

**The document approach: one document per cartridge, tracking its entire lifecycle:**

```json
{
  "_id": "cart-A1-LOT2026",
  "currentStatus": "In Storage",

  "wax": {
    "runId": "wax-run-042",
    "backedLotId": "lot-015",
    "ovenEntryTime": "2026-02-20T08:00:00Z",
    "deckPosition": 3,
    "qcStatus": "Accepted",
    "qcTimestamp": "2026-02-20T12:00:00Z",
    "storageLocation": "Shelf A",
    "storageTimestamp": "2026-02-20T13:00:00Z"
  },

  "reagent": {
    "runId": "reagent-run-018",
    "assayTypeId": "assay-cortisol",
    "deckPosition": 5,
    "inspectionStatus": "Accepted",
    "reagentFillDate": "2026-02-21T09:00:00Z",
    "expirationDate": "2026-05-21T09:00:00Z",
    "topSealBatchId": "ts-batch-007",
    "topSealTimestamp": "2026-02-21T10:30:00Z"
  },

  "storage": {
    "locationId": "fridge-2",
    "containerBarcode": "TRAY-2026-015",
    "fridgeId": "equip-fridge2",
    "timestamp": "2026-02-21T11:00:00Z",
    "operatorId": "user-alejandro"
  },

  "shipping": null,

  "createdAt": "2026-02-20T08:00:00Z",
  "updatedAt": "2026-02-21T11:00:00Z"
}
```

**Why this is better:**

1. **Full traceability in one query.** "What happened to cartridge A1?" → one document has the complete answer.
2. **Status is authoritative.** `currentStatus` is a single field, not scattered across three collections where you need to check which one has the latest record.
3. **Phase transitions are updates, not creates.** Moving a cartridge to reagent filling is `$set: { reagent: { ... } }` on an existing document, not creating a new record in a different collection.
4. **No orphans.** If a cartridge never reaches reagent filling, its `reagent` field is null. There's no empty row in a `ReagentCartridgeRecord` table.

**Also embedded in this redesign:**
- `ReagentTubeRecord` → embedded in `reagent_filling_runs` (6-12 tubes per run, always viewed together)
- `TopSealBatch` → embedded in `reagent_filling_runs` (1:1 relationship)
- `ReagentDefinition` + `ReagentSubComponent` → embedded in `assay_types` (< 20 reagents per assay, always viewed together)
- `ProcessStep` → embedded in `process_configurations`
- All three settings singletons (`WaxFillingSettings`, `ReagentFillingSettings`, `ManufacturingSettings`) + `RejectionReasonCode` → merged into one `manufacturing_settings` document

---

### 4.6 Equipment & Consumables (15 → 5 collections)

**Key embedding: Opentrons protocols → embedded in robot document:**

```json
{
  "_id": "robot-ot2-left",
  "name": "OT-2 Left",
  "ip": "192.168.1.100",
  "port": 31950,
  "isActive": true,
  "firmwareVersion": "7.1.0",

  "protocols": [
    {
      "_id": "proto-001",
      "opentronsProtocolId": "abc-123",
      "protocolName": "Cortisol Reagent Fill v3",
      "protocolType": "python",
      "analysisStatus": "completed",
      "uploadedBy": "user-andres",
      "createdAt": "2026-02-10T00:00:00Z"
    }
  ]
}
```

**Why:** A robot has 5-50 protocols. You always view protocols in the context of their robot. Embedding saves a join on the robot detail page.

**Key consolidation: Consumables**

Instead of 6 separate collections (`IncubatorTube`, `IncubatorTubeUsage`, `TopSealRoll`, `TopSealCutRecord`, `DeckRecord`, `CoolingTrayRecord`), use one `consumables` collection with a `type` discriminator:

```json
{
  "_id": "tube-001",
  "type": "incubator_tube",
  "status": "Active",
  "initialVolumeUl": 2000,
  "remainingVolumeUl": 1460,

  "usageLog": [
    {
      "runId": "wax-run-042",
      "volumeChanged": -540,
      "operatorId": "user-andres",
      "createdAt": "2026-02-20T08:00:00Z"
    }
  ]
}
```

**Why:** Tubes, rolls, decks, and trays all follow the same pattern: a resource with a current state and a usage history. One collection with a type field is cleaner than 6 near-identical collections. The usage log is embedded because it's bounded (a tube is used ~20-50 times before depletion).

---

### 4.7 BOM & Inventory (6 → 3 collections)

**Key embedding: version history and part links inside BOM item:**

```json
{
  "_id": "bom-pcb100",
  "partNumber": "PCB-100",
  "name": "Main PCB Board",
  "category": "electronic",
  "quantityPerUnit": 1,
  "inventoryCount": 150,
  "minimumStockLevel": 50,

  "partLinks": [
    {
      "partDefinitionId": "pd-pcb100",
      "partNumber": "PCB-100",
      "linkType": "primary",
      "createdAt": "2026-01-15T00:00:00Z"
    }
  ],

  "versionHistory": [
    {
      "version": 1,
      "changeType": "create",
      "newValues": { "name": "Main PCB Board", "unitCost": "12.50" },
      "changedBy": "user-javier",
      "changedAt": "2026-01-15T00:00:00Z"
    },
    {
      "version": 2,
      "changeType": "update",
      "previousValues": { "unitCost": "12.50" },
      "newValues": { "unitCost": "14.00" },
      "changedBy": "user-jacob",
      "changedAt": "2026-02-01T00:00:00Z",
      "changeReason": "Supplier price increase"
    }
  ]
}
```

**Why embed version history?** A BOM item has < 20 versions over its lifetime. Version history is only viewed on the BOM detail page. Embedding keeps the complete change trail with the item.

**What stays separate:**
- `part_definitions` — Referenced from many places (SPU, BOM, work instructions, inventory). Needs independent querying and filtering.
- `inventory_transactions` — Append-only audit trail. Grows unbounded. Never embed unbounded data.

---

### 4.8 Shipping (4 → 2 collections)

**QA/QC releases embedded in shipping lot:**

```json
{
  "_id": "lot-2026-015",
  "assayType": { "_id": "assay-cortisol", "name": "Cortisol" },
  "customer": { "_id": "cust-acme", "name": "Acme Health Labs" },
  "status": "released",
  "cartridgeCount": 48,

  "qaqcReleases": [
    {
      "_id": "qaqc-001",
      "reagentRunId": "reagent-run-018",
      "testResult": "pass",
      "testedBy": "user-andres",
      "testedAt": "2026-02-22T14:00:00Z"
    }
  ]
}
```

**Cartridge list embedded in shipping package:**

```json
{
  "_id": "pkg-001",
  "barcode": "PKG-2026-001",
  "customer": { "_id": "cust-acme", "name": "Acme Health Labs" },
  "trackingNumber": "1Z999AA10123456784",
  "status": "shipped",

  "cartridges": [
    { "cartridgeId": "cart-A1-LOT2026", "addedAt": "2026-02-23T09:00:00Z" },
    { "cartridgeId": "cart-A2-LOT2026", "addedAt": "2026-02-23T09:01:00Z" }
  ]
}
```

**Why embed?** A shipping lot has 1-5 QA/QC releases. A package has < 100 cartridges. Both are always viewed together. Both are bounded. Classic embed.

---

## 5. Cross-Cutting Concerns

### 5.1 The `_id` / `id` Global Fix

Every server load function that calls `.lean()` needs to add `id` to the result. The cleanest approach:

```typescript
// src/lib/server/db/index.ts — add this helper
export function withId<T extends { _id: string }>(doc: T): T & { id: string } {
  return { ...doc, id: doc._id };
}

export function withIds<T extends { _id: string }>(docs: T[]): (T & { id: string })[] {
  return docs.map(d => ({ ...d, id: d._id }));
}
```

Then in every server load:

```typescript
// Before (broken):
const projects = await KanbanProject.find({}).lean();
return { projects };

// After (fixed):
const projects = await KanbanProject.find({}).lean();
return { projects: withIds(projects) };
```

This is a mechanical fix — every `.lean()` result that goes to the frontend gets wrapped in `withId` or `withIds`.

### 5.2 Denormalization Update Strategy

When denormalized data changes (rare), batch-update all documents:

```typescript
// User changes their username (rare event)
async function updateUsername(userId: string, newUsername: string) {
  const session = await mongoose.startSession();
  await session.withTransaction(async () => {
    // Update the user document
    await User.updateOne({ _id: userId }, { $set: { username: newUsername } }, { session });

    // Update denormalized copies in other collections
    await KanbanTask.updateMany(
      { 'assignee._id': userId },
      { $set: { 'assignee.username': newUsername } },
      { session }
    );
    await KanbanTask.updateMany(
      { 'comments.createdBy._id': userId },
      { $set: { 'comments.$[c].createdBy.username': newUsername } },
      { session, arrayFilters: [{ 'c.createdBy._id': userId }] }
    );
    // ... other collections with denormalized username
  });
  session.endSession();
}
```

**When to denormalize vs. reference:**

| Data | Changes How Often? | Read How Often? | Decision |
|------|--------------------|-----------------|----------|
| Username | Yearly | Every page render | Denormalize |
| Project name/color | Quarterly | Every board render | Denormalize |
| Assay type name | Rarely | Every manufacturing page | Denormalize |
| Customer name | Monthly | Order/shipping pages | Denormalize |
| Equipment temperature | Every 5 minutes | Equipment dashboard | Reference (changes too often) |

**Rule of thumb:** If read-to-write ratio is > 100:1, denormalize. If < 10:1, reference.

### 5.3 Indexing Strategy

Indexes in MongoDB serve the same purpose as in Postgres — they speed up queries. But the *fields* you index change when you embed:

```typescript
// Current (separate collections):
// Need index on KanbanTask.projectId to filter by project
// Need index on KanbanTaskTag.taskId to find tags for a task
// Need index on KanbanComment.taskId to find comments for a task

// Redesigned (embedded):
// Index on KanbanTask.project._id — filter by project
// Index on KanbanTask.tags — filter by tag name
// No index needed for comments — they're inside the task document
```

**Key indexes for the redesigned schema:**

```typescript
// kanban_tasks
kanbanTaskSchema.index({ 'project._id': 1, status: 1, archived: 1 });
kanbanTaskSchema.index({ 'assignee._id': 1, status: 1 });
kanbanTaskSchema.index({ tags: 1 });  // multikey index on array
kanbanTaskSchema.index({ archived: 1, archivedAt: -1 });

// cartridge_records
cartridgeRecordSchema.index({ currentStatus: 1 });
cartridgeRecordSchema.index({ 'storage.locationId': 1 });
cartridgeRecordSchema.index({ 'reagent.assayTypeId': 1 });

// spus
spuSchema.index({ udi: 1 }, { unique: true });
spuSchema.index({ 'batch._id': 1, status: 1 });
spuSchema.index({ 'parts.lotNumber': 1 });  // find SPUs by part lot
```

### 5.4 Transactions — Where Required

**Every operation that writes to multiple collections needs a transaction.** This is the MongoDB equivalent of the implicit Postgres transaction behavior you used to have.

Priority operations for transaction wrapping:

| Operation | Collections Involved | HIPAA? |
|-----------|---------------------|--------|
| Assembly step completion | assembly_sessions + inventory_transactions + spus | Yes |
| Cartridge phase transition | cartridge_records + [run collection] + audit_log | Yes |
| SPU status change | spus + audit_log + electronic_signatures | Yes |
| Task creation | kanban_tasks + audit_log | No, but good practice |
| User role assignment | users + audit_log | Yes |

For operations that only write to ONE collection (like adding a comment to a task — it's now an embedded `$push`), no transaction is needed. This is another benefit of embedding: fewer multi-document operations means fewer transactions needed.

---

## 6. Migration Strategy

### Phase 1: Critical Fixes (Days 1-2) — Stop the Bleeding

These changes fix active bugs without restructuring the schema:

1. **Add `withId`/`withIds` helpers** and wrap all `.lean()` results going to the frontend
2. **Find and fix all `{ id: }` queries** → change to `{ _id: }` queries
3. **Fix all `.select('id ...')` calls** → change to `.select('_id ...')`
4. **Add transactions** to the most critical HIPAA operations (assembly, inventory)

### Phase 2: Schema Redesign (Domain by Domain)

Each domain can be migrated independently. Suggested order:

| Order | Domain | Why This Order |
|-------|--------|---------------|
| 1 | Kanban | Smallest domain, most visible bug, fastest win |
| 2 | Auth | Highest performance impact (every request) |
| 3 | Work Instructions | Deepest nesting, biggest collection reduction |
| 4 | SPU & Assembly | Core business logic |
| 5 | Manufacturing Pipeline | Most complex, biggest change |
| 6 | Everything else | Equipment, BOM, shipping, etc. |

For each domain:

1. **Write the new Mongoose models** (new schema shapes)
2. **Write a migration script** that reads old collections and writes to new collections
3. **Update all server load functions** (queries)
4. **Update all form actions** (writes)
5. **Run migration script** on test data
6. **Validate** — compare old vs. new query results
7. **Switch** — update imports, drop old collections

### Phase 3: Cleanup

- Drop empty/old collections
- Remove unused junction table models
- Update indexes
- Performance testing

---

## 7. Decisions Needed

Before implementation, I need your input on five things:

### 1. SpectroReading Size
**Question:** How many spectro readings does a typical test result have?
- If < 500: embed in `test_results` document
- If > 1000: keep as separate collection (could hit 16MB limit)

### 2. Cartridge Lifecycle Queries
**Question:** How do you primarily query cartridges?
- **Option A — "Show me everything about cartridge X"** (cartridge-centric) → unified lifecycle document ✅
- **Option B — "Show me all cartridges in wax run 042"** (phase-centric) → keep phase-specific collections
- **Option C — Both** → unified document with indexes on `wax.runId`, `reagent.runId`, etc.

### 3. Manufacturing Material Transaction History
**Question:** Do HIPAA regulations require immutable transaction records for manufacturing materials?
- If yes: keep `manufacturing_material_transactions` as a separate append-only collection
- If no: embed recent transactions in the material document, archive old ones

### 4. Work Instruction Step Images
**Question:** How large are step images (the `imageData` base64 field)?
- If < 100KB each: safe to embed in the WI document
- If > 500KB each: store in GridFS or S3, reference by URL

### 5. Equipment Event Log Retention
**Question:** Do you need full equipment event history, or just recent events?
- **Full history**: keep `equipment_event_log` as separate collection
- **Recent only (30-90 days)**: embed last N events in equipment document, TTL the rest

---

## Summary

| Metric | Current | After Redesign |
|--------|---------|---------------|
| **Collections** | 110 | ~28-32 |
| **Queries per kanban board load** | 5+ | 1-2 |
| **Queries per permission check** | 4 | 1 |
| **Queries per work instruction load** | 7 | 1 |
| **Junction table collections** | 7 | 0 |
| **Transactions in codebase** | 0 | All HIPAA operations |
| **Orphan risk** | High (no FK, no cascade) | Low (embedded data) |
| **Frontend `.id` references** | 474 (most broken) | All working |

The underlying principle: **store data the way you read it.** If a page shows a task with its comments, tags, project name, and activity log — put all of that in one document. If a work instruction is always viewed as a tree of versions→steps→requirements — store it as a tree. If a cartridge moves through a pipeline — track the whole pipeline in one document.

This isn't just about fixing bugs. It's about making MongoDB actually work like MongoDB.

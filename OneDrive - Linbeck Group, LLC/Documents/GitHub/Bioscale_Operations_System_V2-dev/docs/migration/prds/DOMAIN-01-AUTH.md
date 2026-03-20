# DOMAIN-01-AUTH — Authentication, Users, Roles & Sessions

## Overview
**Domain:** Auth & User Management
**Dependencies:** None — this is the foundation. Every other domain depends on this.
**MongoDB Collections:** `users` (Sacred Tier 1), `sessions`, `roles`, `invite_tokens`, `audit_log`, `electronic_signatures`
**Test File:** `tests/contracts/01-auth.test.ts` (9 tests)
**Contract Registry Sections:** Layout Data, Auth Routes, SPU Admin Routes

## Shared Server Utilities to Rebuild
These must be created as part of this domain — other domains import them:

- `src/lib/server/db/index.ts` — Mongoose connection (replaces Drizzle `db` export)
- `src/lib/server/db/models/` — All Mongoose model definitions (User, Session, Role, InviteToken, AuditLog, ElectronicSignature)
- `src/lib/server/auth.ts` — `generateSessionToken()`, `createSession(token, userId)`, `validateSessionToken(token)`, `invalidateSession(sessionId)`, `setSessionTokenCookie(event, token, expiresAt)`, `deleteSessionTokenCookie(event)`
- `src/lib/server/auth/permissions.ts` — `requirePermission(user, permission)`, `hasPermission(user, permission)`, `generateId()` (nanoid), `logAudit()`
- `src/lib/server/auth/agent.ts` — `getAgentUserId()`
- `src/lib/server/auth/admin-override.ts` — Admin override utilities

---

## Story AUTH-01: Database Connection & Mongoose Models

### Description
Set up the Mongoose connection and define all Mongoose models for the entire application. This is the data layer foundation.

### Routes Covered
None directly — this is infrastructure.

### What to Build
1. `src/lib/server/db/connection.ts` — Mongoose connection using `MONGODB_URI` env var
2. `src/lib/server/db/index.ts` — Barrel export of connection + all models
3. Mongoose models for ALL collections (not just auth). Define every model from the schema spec:
   - Tier 1 (Sacred): `User`, `CartridgeRecord`, `Spu`, `AssayDefinition`, `ReagentBatchRecord`
   - Tier 2 (Operational): `Session`, `Role`, `InviteToken`, `KanbanProject`, `KanbanTask`, `Customer`, `Equipment`, `EquipmentLocation`, `OpentronsRobot`, `WorkInstruction`, `Document`, `DocumentRepository`, `File`, `AssemblySession`, `Batch`, `ProductionRun`, `GeneratedBarcode`, `ValidationSession`, `WaxFillingRun`, `ProcessConfiguration`, `ManufacturingSettings`, `LaserCutBatch`, `ManufacturingMaterial`, `Consumable`, `BomItem`, `PartDefinition`, `BomColumnMapping`, `CartridgeGroup`, `LabCartridge`, `FirmwareDevice`, `FirmwareCartridge`, `TestResult`, `ShippingLot`, `ShippingPackage`, `Integration`, `ParticleDevice`, `AgentQuery`, `SchemaMetadata`, `AgentMessage`, `RoutingPattern`, `ApprovalRequest`, `SystemDependency`
   - Tier 3 (Immutable): `AuditLog`, `ElectronicSignature`, `InventoryTransaction`, `DeviceEvent`, `ManufacturingMaterialTransaction`
4. Add indexes as specified in the schema spec
5. Add Mongoose middleware on Tier 3 collections to block `updateOne`, `updateMany`, `deleteOne`, `deleteMany`
6. Add Mongoose middleware on Sacred documents to block mutations after `finalizedAt` is set

### MongoDB-Specific Notes
- All `_id` fields use `string` (nanoid), not ObjectId. Configure `_id: { type: String, default: () => generateId() }`
- TTL index on `sessions.expiresAt` for auto-expiry
- Sacred document middleware: check `finalizedAt` before any update — reject if set

### Acceptance Criteria
- All models compile without TypeScript errors
- Connection establishes successfully to MongoDB
- Indexes are created
- Tier 3 middleware blocks updates/deletes (unit test)
- Sacred document middleware blocks post-finalization mutations (unit test)

---

## Story AUTH-02: Session Middleware (hooks.server.ts)

### Description
Implement `hooks.server.ts` — the SvelteKit request handler that runs before every page load. It reads the session cookie, validates it against MongoDB, and populates `locals.user` and `locals.session`.

### Routes Covered
ALL routes (this is global middleware)

### Contract References
Every route depends on `locals.user` being populated. The User object shape:
```typescript
{
  id: string
  username: string
  email: string | null
  firstName: string | null
  lastName: string | null
  phone: string | null
  isActive: boolean
  lastLoginAt: Date | null
  roles: { roleId: string, roleName: string, permissions: string[] }[]
}
```

### MongoDB Models Used
- `Session` — lookup by session token, check `expiresAt`
- `User` — lookup by `_id` from session's `userId`, project relevant fields

### What to Build
1. `src/hooks.server.ts` — Read `auth-session` cookie → `Session.findById(token)` → check expiry → `User.findById(session.userId)` → populate `locals.user` and `locals.session`
2. If no valid session, `locals.user = null`, `locals.session = null`
3. Protected routes (everything under `/spu/*`, `/documents/*`, `/kanban/*`, `/opentrons/*`, `/admin/*`) redirect to `/login` if `!locals.user`

### MongoDB-Specific Notes
- Old code: `db.select().from(sessionTable).where(eq(sessionTable.id, token))` with a join to users
- New code: `Session.findById(token)` then `User.findById(session.userId).select('-passwordHash')`
- Two queries instead of one join — acceptable at this scale

### Acceptance Criteria
- Tests 1, 4 in `01-auth.test.ts` pass (login page loads, /spu without auth redirects)
- `locals.user` is populated on authenticated requests
- `locals.user` is null on unauthenticated requests
- Session expiry is enforced

---

## Story AUTH-03: Login/Logout Flow

### Description
Implement login and logout routes with session management.

### Routes Covered
- `POST /login` — authenticate user, create session, set cookie
- `GET /logout` — invalidate session, clear cookie
- `GET /login` — render login page (redirect if already logged in)

### Contract References
**POST /login:**
- Accepts: `{ username: string, password: string }` (form-encoded)
- Success: `redirect(302, '/spu')` + sets `auth-session` cookie
- Failure: `fail(400, { error: string })`

**GET /logout:**
- Clears session from DB, deletes cookie
- Redirects to `/login`

### MongoDB Models Used
- `User` — `User.findOne({ username })`, verify password with bcrypt/argon2
- `Session` — `Session.create({ _id: token, userId, expiresAt })` on login, `Session.deleteOne({ _id: sessionId })` on logout

### What to Build
1. `src/routes/login/+page.server.ts` — load (redirect if authed), default action (authenticate)
2. `src/routes/logout/+page.server.ts` — load (invalidate + redirect)
3. `src/lib/server/auth.ts` — full implementation of all auth utilities

### Acceptance Criteria
- Tests 1-5 in `01-auth.test.ts` pass (login page, bad creds, valid creds + cookie, no-auth redirect, logout clears session)

---

## Story AUTH-04: User Management (Admin CRUD)

### Description
Implement the admin user management pages — list users, create users, update profiles, assign/remove roles, deactivate/reactivate, reset passwords.

### Routes Covered
- `GET /spu/admin` — redirects to `/spu/admin/users`
- `GET /spu/admin/users` — list users with roles
- Form actions on `/spu/admin/users`: `createUser`, `updateProfile`, `deactivateUser`, `reactivateUser`, `resetPassword`, `assignRole`, `removeRole`, `sendInvite`

### Contract References
**GET /spu/admin/users returns:**
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

### MongoDB Models Used
- `User` — CRUD operations. Sacred document — never delete, only deactivate
- `Role` — list for dropdowns

### MongoDB-Specific Notes
- Old code used junction tables (`UserRole`, `RolePermission`, `Permission`). New code: roles are embedded in user document as `roles: [{ roleId, roleName, permissions[] }]`
- When assigning a role: read from `Role` collection, push to `user.roles[]` AND append to `user.roleHistory[]`
- When removing a role: pull from `user.roles[]` AND set `revokedAt` on matching `user.roleHistory[]` entry
- **Sacred document handling:** Users are never deleted. `deactivateUser` sets `isActive: false` and `deactivatedAt`. No `finalizedAt` — users use deactivation pattern instead.

### Acceptance Criteria
- Tests 6-8 in `01-auth.test.ts` pass (admin/users returns users+roles, admin/roles returns roles, admin page loads)
- User CRUD operations work via form actions
- Role assignment updates both `roles[]` and `roleHistory[]`

---

## Story AUTH-05: Roles, Permissions & Invites

### Description
Implement role management and invite token flow.

### Routes Covered
- `GET /spu/admin/roles` — list roles with permissions
- Form actions: `createRole`, `updateRole`, `deleteRole`, `setPermissions`
- `GET /spu/admin/invites` — list invites
- Form actions: `sendInvite`, `revokeInvite`
- `GET /invite/accept` — accept invite page
- `POST /invite/accept` (action: register) — create account from invite

### Contract References
**GET /spu/admin/roles returns:**
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

**GET /spu/admin/invites returns:**
```typescript
{
  invites: {
    id: string, email: string, roleId: string | null, token: string,
    status: string, expiresAt: string, acceptedAt: string | null,
    createdAt: string, createdBy: string | null
  }[]
  roles: { id: string, name: string, description: string | null }[]
}
```

### MongoDB Models Used
- `Role` — CRUD, permission management
- `InviteToken` — create, validate, accept
- `User` — create on invite acceptance

### MongoDB-Specific Notes
- Permissions are stored as string arrays in `roles.permissions[]` (e.g., `["kanban:read", "kanban:write"]`)
- Old code had `Permission` and `RolePermission` junction tables — eliminated
- When a role's permissions change, batch-update all users with that role using `User.updateMany()` with array filters
- Permission groups are derived from the permission string prefix (e.g., "kanban" from "kanban:read")

### Acceptance Criteria
- Test 9 in `01-auth.test.ts` passes (invites page returns invites)
- Role CRUD works
- Permission changes propagate to users
- Invite flow: create → accept → user created with correct role

---

## Story AUTH-06: Layout Data & Permission Checks

### Description
Implement all layout.server.ts files that provide inherited data to child routes. These are the permission gates.

### Routes Covered
- `src/routes/spu/+layout.server.ts` — SPU layout (all `/spu/*` routes)
- `src/routes/spu/admin/+layout.server.ts` — Admin layout
- `src/routes/documents/+layout.server.ts` — Documents layout
- `src/routes/kanban/+layout.server.ts` — Kanban layout
- `src/routes/opentrons/+layout.server.ts` — Opentrons layout
- `src/routes/spu/documents/+layout.server.ts` — SPU Documents layout
- `src/routes/spu/manufacturing/+layout.server.ts` — Manufacturing layout
- `src/routes/spu/cartridge-admin/+layout.server.ts` — Cartridge Admin layout
- `src/routes/spu/manufacturing/reagent-filling/+layout.server.ts` — Reagent filling layout
- `src/routes/spu/manufacturing/wax-filling/+layout.server.ts` — Wax filling layout

### Contract References
**SPU Layout returns:**
```typescript
{
  user: User
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

**Kanban Layout returns:**
```typescript
{
  user: User
  projects: { id: string, name: string, description: string | null, color: string, isActive: boolean, sortOrder: number, createdBy: string | null }[]
  users: { id: string, username: string }[]
}
```

**Documents Layout returns:**
```typescript
{
  user: User
  permissions: { canRead: boolean, canWrite: boolean, canApprove: boolean, canTrain: boolean }
}
```

### MongoDB Models Used
- `User` — from `locals.user` (already loaded by hooks.server.ts)
- `KanbanProject` — for kanban layout
- `Integration` — for Box/Particle status checks
- `Role` — permission derivation

### MongoDB-Specific Notes
- Permission checks use `hasPermission(user, 'kanban:read')` — checks `user.roles[].permissions[]` array
- No joins needed — permissions are already embedded in the user document
- Manufacturing layouts need robot data — `OpentronsRobot.find({ isActive: true })`

### Acceptance Criteria
- All layout data shapes match contract registry
- Protected routes redirect unauthenticated users
- Permission-based access controls work correctly
- Layout data is inherited by child routes

---

## Story AUTH-07: Demo Routes & Agent Activity

### Description
Implement demo auth routes and admin agent activity page.

### Routes Covered
- `GET /demo/lucia` — demo page (requires auth)
- `POST /demo/lucia` (action: logout)
- `GET /demo/lucia/login` — demo login page
- `POST /demo/lucia/login` (actions: login, register)
- `GET /admin/agent-activity` — audit log viewer

### Contract References
**GET /admin/agent-activity returns:**
```typescript
{
  auditEntries: {
    id: string, tableName: string, recordId: string, action: string,
    oldData: Record<string, unknown> | null, newData: Record<string, unknown> | null,
    changedAt: Date, changedBy: string
  }[]
  pagination: { page: number, limit: number, total: number, hasNext: boolean, hasPrev: boolean }
  stats: { totalActionsToday: number, mostCommonAction: string, mostCommonActionCount: number, lastActiveTime: Date | null }
  filters: { actionTypes: string[], currentAction: string | null, currentDateFrom: string | null, currentDateTo: string | null }
}
```

### MongoDB Models Used
- `AuditLog` — query with pagination, filtering, aggregation for stats
- `User`, `Session` — for demo auth

### MongoDB-Specific Notes
- Audit log aggregation: `AuditLog.aggregate([{ $match: ... }, { $group: ... }])` for stats
- Pagination: `AuditLog.find().sort({ changedAt: -1 }).skip().limit()`

### Acceptance Criteria
- Demo routes function (login, logout, register)
- Agent activity page loads with pagination and filtering
- Audit entries display correctly

# SEC-01 — Auth Core Fixes

## Overview
**Domain:** Security — Core auth system bugs
**Dependencies:** None
**Priority:** Critical — blocks all other SEC PRDs

Fix foundational permission system bugs that affect the entire app. These are the broken plumbing that makes the rest of the permission enforcement unreliable.

---

## Story SEC-01-01: Fix Manufacturing Layout try/catch

### Description
`src/routes/spu/manufacturing/+layout.server.ts` wraps `requirePermission()` in a try/catch block that logs the error but does NOT block access. This silently swallows the 403, making the entire manufacturing section (lots, laser cutting, inventory, consumables, top seal, opentrons history) accessible to every logged-in user regardless of permissions.

### What to Change
1. Open `src/routes/spu/manufacturing/+layout.server.ts`
2. Remove the try/catch around `requirePermission()` — let the error(403) propagate naturally
3. Keep the `hasPermission()` calls that compute UI flags (those are fine)

### Acceptance Criteria
- A user without `manufacturing:read` gets a 403 when navigating to any `/spu/manufacturing/*` route
- A user WITH `manufacturing:read` still loads the page normally
- UI permission flags (for conditional rendering) still work

---

## Story SEC-01-02: Fix testResults Permission String Typo

### Description
`src/routes/spu/test-results/[resultId]/+page.server.ts` checks for `testResults:read` and `testResults:write` (plural 's'), but the defined permissions in the seed script and admin roles page are `testResult:read` and `testResult:write` (singular). This means these permission checks **always fail** — nobody can access the test result detail page.

### What to Change
1. Open `src/routes/spu/test-results/[resultId]/+page.server.ts`
2. Replace all instances of `testResults:read` → `testResult:read`
3. Replace all instances of `testResults:write` → `testResult:write`
4. Also check for any `locals.user.roles?.some(...)` patterns in this file that reference the plural form

### Acceptance Criteria
- A user with `testResult:read` can load the test result detail page
- A user with `testResult:write` can perform mutations on the page
- No other references to `testResults:` (plural) remain in the codebase

---

## Story SEC-01-03: Replace roleName === 'admin' Hardcodes

### Description
Four files bypass the permission system by checking `role.roleName === 'admin'` directly. This is fragile (breaks if role is renamed) and invisible to the permission model (can't be managed via admin UI).

### Files to Change
1. `src/routes/spu/assembly/[sessionId]/+page.server.ts` — `locals.user.roles?.some(r => r.permissions?.includes('inventory:retract') || r.roleName === 'admin')`
2. `src/routes/spu/cartridges/[cartridgeId]/+page.server.ts` — two instances: `roleName === 'admin'` check
3. `src/routes/spu/test-results/[resultId]/+page.server.ts` — `roleName === 'admin'` check
4. `src/routes/spu/assays/[assayId]/+page.server.ts` — two instances: `roleName === 'admin'` check

### What to Change
Replace each `r.roleName === 'admin'` with `r.permissions?.includes('admin:full')`. This keeps the same behavior but routes it through the permission model.

**Pattern before:**
```typescript
locals.user.roles?.some(r => r.permissions?.includes('some:perm') || r.roleName === 'admin')
```

**Pattern after:**
```typescript
hasPermission(locals.user, 'some:perm') || hasPermission(locals.user, 'admin:full')
```

Import `hasPermission` from `$lib/server/permissions` if not already imported.

### Acceptance Criteria
- No remaining `roleName === 'admin'` or `roleName === "admin"` strings in `src/routes/`
- Admin users still have the same access they had before
- Non-admin users with the specific permission still have access

---

## Story SEC-01-04: Consolidate requireApiKey into Centralized Import

### Description
`src/lib/server/api-auth.ts` exports `requireAgentApiKey(request)` with timing-safe comparison. But 9 agent API endpoint files define their own local `requireApiKey()` function instead of importing the centralized version. One endpoint (`api/cron/archive-done-tasks`) uses inline comparison.

### Files to Change
1. `src/routes/api/agent/operations/kanban/tasks/+server.ts`
2. `src/routes/api/agent/operations/kanban/proposals/+server.ts`
3. `src/routes/api/agent/operations/kanban/proposals/[id]/+server.ts`
4. `src/routes/api/agent/operations/kanban/violations/+server.ts`
5. `src/routes/api/agent/operations/kanban/tasks/[id]/+server.ts`
6. `src/routes/api/agent/operations/kanban/tasks/[id]/transitions/+server.ts`
7. `src/routes/api/agent/operations/kanban/tasks/[id]/subtasks/+server.ts`
8. `src/routes/api/agent/operations/kanban/tasks/merge/+server.ts`
9. `src/routes/api/particle/webhook/+server.ts`
10. `src/routes/api/cron/archive-done-tasks/+server.ts`

### What to Change
In each file:
1. Remove the local `requireApiKey()` function definition
2. Add `import { requireAgentApiKey } from '$lib/server/api-auth';`
3. Replace calls to local `requireApiKey(request)` with `requireAgentApiKey(request)`
4. For the cron endpoint: replace inline comparison with `requireAgentApiKey(event.request)`

### Acceptance Criteria
- No local `requireApiKey` function definitions remain in any `+server.ts` file
- All API key checks use the centralized `requireAgentApiKey` from `$lib/server/api-auth`
- All agent/cron/webhook endpoints still return 401 for invalid/missing API keys

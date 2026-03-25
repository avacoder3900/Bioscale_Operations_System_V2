# SECURITY.md — Authentication, Authorization & Security Patterns

**This is a canonical document.** All agents and developers MUST read this before modifying any auth, permission, session, or user management code. AGENTS.md references this file.

---

## Authentication Architecture

### Session System
- **Library:** Custom implementation on `@oslojs/crypto` (SHA-256) + `@oslojs/encoding` (no Lucia)
- **Flow:** Login → generate random token → SHA-256 hash → store hash as session `_id` in MongoDB `sessions` collection → set `auth-session` cookie with raw token
- **Cookie:** `auth-session`, httpOnly, secure (in prod), sameSite: lax, 30-day expiry
- **Renewal:** Sessions within 15 days of expiry are auto-renewed to 30 days on each request
- **Validation:** `hooks.server.ts` runs on every request: reads cookie → hashes token → looks up session → loads fresh user (minus passwordHash) → sets `event.locals.user`

### Key Files
| File | Purpose |
|------|---------|
| `src/lib/server/auth.ts` | Session CRUD: create, validate, invalidate, cookie helpers |
| `src/lib/server/permissions.ts` | Permission checking utilities |
| `src/lib/server/api-auth.ts` | Agent API key validation (timing-safe) |
| `src/hooks.server.ts` | Request middleware: session validation, route protection |
| `src/routes/login/+page.server.ts` | Login form handler |
| `src/routes/logout/+page.server.ts` | Session invalidation |
| `src/routes/spu/admin/users/+page.server.ts` | User CRUD, role assignment |
| `src/routes/spu/admin/roles/+page.server.ts` | Role CRUD, permission management |

---

## Authorization Model

### Permission Strings
Permissions are flat strings in the format `resource:action`. There are 48 defined permissions across 20 resource groups:

```
admin:full, admin:users
user:read, user:write
role:read, role:write
kanban:read, kanban:write, kanban:admin
spu:read, spu:write, spu:admin
document:read, document:write, document:approve, document:train
inventory:read, inventory:write
cartridge:read, cartridge:write
cartridgeAdmin:read, cartridgeAdmin:write
assay:read, assay:write
device:read, device:write
testResult:read, testResult:write
manufacturing:read, manufacturing:write, manufacturing:admin
waxFilling:read, waxFilling:write
reagentFilling:read, reagentFilling:write
workInstruction:read, workInstruction:write, workInstruction:approve
documentRepo:read, documentRepo:write
productionRun:read, productionRun:write
shipping:read, shipping:write
customer:read, customer:write
equipment:read, equipment:write
```

### Roles
Users have a single role (enforced by `assignRole` which `$set` replaces the `roles[]` array). Three canonical roles:

| Role | Permissions | Use case |
|------|------------|----------|
| **Admin** | All 48 | System administrators |
| **Operator** | 9 (kanban:read, spu:read, manufacturing:read, waxFilling:read/write, reagentFilling:read/write, cartridge:read, inventory:read) | Manufacturing floor staff |
| **Viewer** | 7 (kanban:read, spu:read, document:read, inventory:read, cartridge:read, manufacturing:read, testResult:read) | Read-only stakeholders |

### Permission Storage
Permissions are **denormalized** into the user document at assignment time:
```
user.roles[0].permissions = ['kanban:read', 'spu:write', ...]
```
When a role's permissions are updated via the admin UI, the change propagates to all users with that role.

### Permission Checking Functions
```typescript
import { requirePermission, hasPermission, isAdmin } from '$lib/server/permissions';

// Throws error(403) if user lacks permission — use in load functions and actions
requirePermission(locals.user, 'resource:action');

// Returns boolean — use in layouts for UI flags
hasPermission(locals.user, 'resource:action');

// Checks admin:full or admin:users — use for admin-only operations
isAdmin(locals.user);
```

**IMPORTANT:** The first argument is `locals.user` (the user object), NOT `event`.

---

## Required Patterns for Server Files

### Every `+page.server.ts` load function MUST:
```typescript
export const load: PageServerLoad = async ({ locals }) => {
    requirePermission(locals.user, 'domain:read');  // Authorization
    await connectDB();                                // Database
    // ... query and return data
};
```

### Every form action MUST:
```typescript
export const actions: Actions = {
    mutate: async ({ request, locals }) => {
        requirePermission(locals.user, 'domain:write');  // Authorization
        await connectDB();                                // Database
        // ... validate input, perform mutation
        await AuditLog.create({ ... });                   // Audit trail
    }
};
```

### Every API endpoint (`+server.ts`) MUST have one of:
```typescript
// For user-facing APIs (session auth):
if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
requirePermission(locals.user, 'domain:action');

// For agent/service APIs (API key auth):
import { requireAgentApiKey } from '$lib/server/api-auth';
requireAgentApiKey(request);  // Throws error(401) if invalid
```

---

## Admin-Tier Operations

These operations require elevated permissions beyond normal `:write`:

| Operation | Required Permission | Why |
|-----------|-------------------|-----|
| Lock/unlock assay definitions | `manufacturing:admin` | Regulatory impact — controls what's production-ready |
| Sacred document corrections | `admin:full` | Modifying finalized compliance records |
| Audit log viewing | `admin:full` | Controlled access to audit trail |
| User management | `user:read` / `user:write` | Access control management |
| Role management | `role:read` / `role:write` | Permission structure changes |

---

## API Key Authentication

Agent API endpoints use a shared API key (`AGENT_API_KEY` env var):

```typescript
import { requireAgentApiKey } from '$lib/server/api-auth';
// Uses timing-safe comparison to prevent timing attacks
// Throws error(401) if key is missing or invalid
```

**Do NOT define local `requireApiKey()` functions.** Always import from `$lib/server/api-auth`.

---

## Security Anti-Patterns (DO NOT)

1. **Do NOT check `roleName` directly** — always use `hasPermission()` or `requirePermission()`
   ```typescript
   // BAD:  role.roleName === 'admin'
   // GOOD: hasPermission(locals.user, 'admin:full')
   ```

2. **Do NOT use `$push` on `roles[]`** — use `$set` to replace (single role per user)
   ```typescript
   // BAD:  $push: { roles: newRole }    // stacks roles
   // GOOD: $set: { roles: [newRole] }   // replaces
   ```

3. **Do NOT wrap `requirePermission()` in try/catch** — let the error(403) propagate
   ```typescript
   // BAD:  try { requirePermission(...) } catch(e) { /* swallowed */ }
   // GOOD: requirePermission(locals.user, 'domain:read');
   ```

4. **Do NOT use plural permission strings** — the canonical names are singular
   ```typescript
   // BAD:  'testResults:read'
   // GOOD: 'testResult:read'
   ```

5. **Do NOT leak error details to client**
   ```typescript
   // BAD:  return fail(500, { error: `Server error: ${err.message}` });
   // GOOD: return fail(500, { error: 'An unexpected error occurred' });
   ```

6. **Do NOT forget audit logging** — every mutation needs an AuditLog entry

---

## Known Issues (as of Mar 24, 2026)

| Issue | Severity | Status |
|-------|----------|--------|
| Deactivated users retain session access up to 30 days | HIGH | Open — `validateSessionToken` doesn't check `isActive` |
| No audit logging on admin user/role mutations | HIGH | Open — compliance gap |
| No login rate limiting | HIGH | Open — brute force possible |
| `removeRole` only revokes first roleHistory match | MEDIUM | Open — use `arrayFilters` |
| `deleteRole` doesn't stamp roleHistory revocation | MEDIUM | Open — audit trail gap |
| Login error leaks server details to client | MEDIUM | Open |
| No password strength validation | MEDIUM | Open |

---

## For the Research Webapp

The auth system is self-contained and portable. To share auth between apps:

### Files to copy
- `src/lib/server/auth.ts`
- `src/lib/server/permissions.ts`
- `src/lib/server/api-auth.ts`
- `src/hooks.server.ts`
- Models: `User`, `Session`, `Role`

### Shared database considerations
- Both apps point to the same MongoDB — sessions and users are shared
- Cookie domain must match for session sharing (same domain or shared parent domain)
- Permission strings can diverge between apps — the research app may define its own resource groups
- The `ALL_PERMISSIONS` list in the admin roles page and seed script must be the superset of both apps

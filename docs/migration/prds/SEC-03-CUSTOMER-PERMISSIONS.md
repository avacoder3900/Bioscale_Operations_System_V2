# SEC-03 — Customer Permission Enforcement

## Overview
**Domain:** Security — Customer routes
**Dependencies:** SEC-01
**Files:** 2 page server files

Customer list and detail pages only check `locals.user` (authenticated). No permission check at all. Any logged-in user can create customers, edit them, and add notes. The `customer:read` and `customer:write` permissions exist but are never checked.

---

## Story SEC-03-01: Add customer:read/write to Customer Routes

### Files to Change
1. `src/routes/spu/customers/+page.server.ts`
   - Load: add `requirePermission(locals.user, 'customer:read')`
   - All actions (create, etc.): add `requirePermission(locals.user, 'customer:write')`

2. `src/routes/spu/customers/[id]/+page.server.ts`
   - Load: add `requirePermission(locals.user, 'customer:read')`
   - All actions (update, addNote, etc.): add `requirePermission(locals.user, 'customer:write')`

### Acceptance Criteria
- A user without `customer:read` gets 403 on customer list and detail pages
- A user with `customer:read` but not `customer:write` can view but not modify
- A user with both can view and modify

# SEC-04 — Document Permission Enforcement

## Overview
**Domain:** Security — Document and work instruction routes
**Dependencies:** SEC-01
**Files:** ~8 page server files

Several document routes have no permission checks. The `document:read`, `document:write`, `document:train`, `workInstruction:read`, `workInstruction:write` permissions all exist but aren't consistently checked.

---

## Story SEC-04-01: Add document:read to Document Listing and Detail Loads

### Files to Change
1. `src/routes/documents/+page.server.ts` — load: add `requirePermission(locals.user, 'document:read')`
2. `src/routes/documents/[id]/+page.server.ts` — load: add `requirePermission(locals.user, 'document:read')`

### Acceptance Criteria
- Users without `document:read` get 403 on document listing and detail pages

---

## Story SEC-04-02: Add document:train to Training Page

### Files to Change
1. `src/routes/documents/[id]/train/+page.server.ts`
   - Load: add `requirePermission(locals.user, 'document:train')`
   - Action (record training / e-signature): add `requirePermission(locals.user, 'document:train')`

### Notes
The e-signature password verification in the action is correct and should remain — it's an additional identity confirmation, not a replacement for permission checking.

### Acceptance Criteria
- Users without `document:train` get 403 on the training page
- Users WITH `document:train` still need to provide their password for e-signature

---

## Story SEC-04-03: Add workInstruction Permissions to Instruction Routes

### Files to Change
1. `src/routes/spu/documents/instructions/+page.server.ts`
   - Load: add `requirePermission(locals.user, 'workInstruction:read')`
   - Create action: add `requirePermission(locals.user, 'workInstruction:write')`

2. `src/routes/spu/documents/instructions/[id]/+page.server.ts`
   - Load: add `requirePermission(locals.user, 'workInstruction:read')`
   - All actions: add `requirePermission(locals.user, 'workInstruction:write')`

3. `src/routes/spu/documents/instructions/[id]/fields/+page.server.ts`
   - Load: add `requirePermission(locals.user, 'workInstruction:read')`
   - All actions: add `requirePermission(locals.user, 'workInstruction:write')`

4. `src/routes/spu/documents/instructions/[id]/run/[runId]/+page.server.ts`
   - Load: add `requirePermission(locals.user, 'workInstruction:read')`

5. `src/routes/spu/documents/build-logs/+page.server.ts`
   - Load: add `requirePermission(locals.user, 'workInstruction:read')`

### Acceptance Criteria
- Users without `workInstruction:read` get 403 on all instruction and build log pages
- Users without `workInstruction:write` get 403 when trying to create or edit instructions

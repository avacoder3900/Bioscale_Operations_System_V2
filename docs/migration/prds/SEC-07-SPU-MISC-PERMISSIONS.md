# SEC-07 — SPU & Miscellaneous Permission Enforcement

## Overview
**Domain:** Security — Assays, receiving, build logs, Box integration, Particle settings
**Dependencies:** SEC-01
**Files:** ~8 page server files

Remaining routes that need permission checks but don't fall neatly into the other SEC PRDs.

---

## Story SEC-07-01: Add assay:read to Assay Detail/Assign Loads

### Files to Change
1. `src/routes/spu/assays/[assayId]/+page.server.ts`
   - Load: add `requirePermission(locals.user, 'assay:read')`
   - Actions (if any mutations exist without checks): add `requirePermission(locals.user, 'assay:write')`

2. `src/routes/spu/assays/[assayId]/assign/+page.server.ts`
   - Load: add `requirePermission(locals.user, 'assay:read')`
   - Actions: add `requirePermission(locals.user, 'assay:write')`

### Acceptance Criteria
- Users without `assay:read` get 403 on assay detail and assign pages

---

## Story SEC-07-02: Add Permission Checks to Receiving Routes

### Files to Change
1. `src/routes/spu/receiving/+page.server.ts`
   - Load: add `requirePermission(locals.user, 'inventory:read')`
   - Actions: add `requirePermission(locals.user, 'inventory:write')`

2. `src/routes/spu/receiving/new/+page.server.ts`
   - Load: add `requirePermission(locals.user, 'inventory:write')`
   - Actions: add `requirePermission(locals.user, 'inventory:write')`

### Notes
There is no dedicated `receiving:read/write` permission. Using `inventory:read/write` since receiving is part of the inventory workflow. A dedicated permission can be added later if needed.

### Acceptance Criteria
- Users without `inventory:read` get 403 on receiving list
- Users without `inventory:write` get 403 on create new receiving lot

---

## Story SEC-07-03: Add Permission Checks to Build Logs and Box Routes

### Files to Change
1. `src/routes/spu/documents/build-logs/+page.server.ts`
   - Load: add `requirePermission(locals.user, 'workInstruction:read')`

2. `src/routes/spu/documents/box/+page.server.ts`
   - Load: add `requirePermission(locals.user, 'documentRepo:read')`

### Acceptance Criteria
- Build logs page requires `workInstruction:read`
- Box folder browsing requires `documentRepo:read`

---

## Story SEC-07-04: Add Permission Checks to Particle Settings

### Files to Change
1. `src/routes/spu/particle/settings/+page.server.ts`
   - Verify load checks `spu:read` or `device:read`
   - Verify actions check `spu:write` or `device:write`
   - If already checked: no change needed (this file may already be covered)

### Acceptance Criteria
- Particle settings page has explicit permission checks on load and actions

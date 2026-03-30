# SEC-06 — Manufacturing Permission Enforcement

## Overview
**Domain:** Security — Manufacturing sub-routes and Opentrons pages
**Dependencies:** SEC-01 (manufacturing layout try/catch must be fixed first)
**Files:** ~8 page server files

After SEC-01-01 fixes the manufacturing layout, the layout's `requirePermission(locals.user, 'manufacturing:read')` will properly gate all child routes. But individual pages and their mutation actions still need explicit checks as defense-in-depth and for write-level gating.

---

## Story SEC-06-01: Add manufacturing:read to Sub-route Loads

### Files to Change
1. `src/routes/spu/manufacturing/+page.server.ts` — add `requirePermission(locals.user, 'manufacturing:read')`
2. `src/routes/spu/manufacturing/lots/[lotId]/+page.server.ts` — add `requirePermission(locals.user, 'manufacturing:read')`
3. `src/routes/spu/manufacturing/inventory/+page.server.ts` — add `requirePermission(locals.user, 'manufacturing:read')`
4. `src/routes/spu/manufacturing/consumables/+page.server.ts` — add `requirePermission(locals.user, 'manufacturing:read')`
5. `src/routes/spu/manufacturing/laser-cutting/+page.server.ts` — add `requirePermission(locals.user, 'manufacturing:read')`
6. `src/routes/spu/manufacturing/top-seal-cutting/+page.server.ts` — add `requirePermission(locals.user, 'manufacturing:read')`
7. `src/routes/spu/manufacturing/opentrons/history/+page.server.ts` — add `requirePermission(locals.user, 'manufacturing:read')`

### Acceptance Criteria
- Each manufacturing sub-page has its own `requirePermission` in the load function

---

## Story SEC-06-02: Add manufacturing:write to Mutation Actions

### Files to Change
1. `src/routes/spu/manufacturing/lots/[lotId]/+page.server.ts` — all actions: add `requirePermission(locals.user, 'manufacturing:write')`
2. `src/routes/spu/manufacturing/inventory/+page.server.ts` — all actions: add `requirePermission(locals.user, 'manufacturing:write')`
3. `src/routes/spu/manufacturing/laser-cutting/+page.server.ts` — all actions: add `requirePermission(locals.user, 'manufacturing:write')`
4. `src/routes/spu/manufacturing/consumables/+page.server.ts` — all actions: add `requirePermission(locals.user, 'manufacturing:write')`
5. `src/routes/spu/manufacturing/top-seal-cutting/+page.server.ts` — all actions: add `requirePermission(locals.user, 'manufacturing:write')`
6. `src/routes/spu/manufacturing/qa-qc/+page.server.ts` — mutation actions currently check `manufacturing:read` for writes. Change to `manufacturing:write`.

### Acceptance Criteria
- Users with `manufacturing:read` only can view but get 403 on mutations
- Users with `manufacturing:write` can perform all manufacturing operations
- QA/QC release actions correctly require `manufacturing:write` (not just `:read`)

---

## Story SEC-06-03: Add Permission Checks to Opentrons Page Routes

### Files to Change
1. `src/routes/opentrons/+page.server.ts` — add `requirePermission(locals.user, 'manufacturing:read')`
2. `src/routes/opentrons/devices/+page.server.ts` — add `requirePermission(locals.user, 'manufacturing:read')`
3. `src/routes/opentrons/devices/[robotId]/+page.server.ts` — add `requirePermission(locals.user, 'manufacturing:read')`
4. `src/routes/opentrons/devices/[robotId]/edit/+page.server.ts`
   - Load: add `requirePermission(locals.user, 'manufacturing:read')`
   - Actions: add `requirePermission(locals.user, 'manufacturing:write')`
5. `src/routes/opentrons/labware/+page.server.ts` — add `requirePermission(locals.user, 'manufacturing:read')`
6. `src/routes/opentrons/runs/new/+page.server.ts` — add `requirePermission(locals.user, 'manufacturing:write')`
7. `src/routes/opentrons/runs/[runId]/+page.server.ts` — add `requirePermission(locals.user, 'manufacturing:read')`
8. `src/routes/opentrons/protocols/[robotId]/[protocolId]/+page.server.ts` — add `requirePermission(locals.user, 'manufacturing:read')`

### Notes
The opentrons layout already checks `manufacturing:read`, but these page-level checks are defense-in-depth and cover the edit/write actions that the layout doesn't differentiate.

### Acceptance Criteria
- Opentrons robot edit form requires `manufacturing:write`
- Creating new runs requires `manufacturing:write`
- All opentrons pages individually check `manufacturing:read`

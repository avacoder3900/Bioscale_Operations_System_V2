# SEC-08 — Admin-Tier Access Controls

## Overview
**Domain:** Security — Elevated permission requirements for admin-only operations
**Dependencies:** SEC-01
**Files:** ~5 page server files

Certain operations have regulatory or business implications that warrant admin-level gating beyond normal `:write` permissions. This PRD elevates specific high-impact actions to require `admin:full` or `manufacturing:admin`.

---

## Story SEC-08-01: Assay Lock/Unlock Requires manufacturing:admin

### Description
Assay definitions are Sacred documents. Locking one means it's production-ready and validated. Unlocking pulls it back for revision. This has regulatory implications — an operator should not be able to unlock a validated assay without elevated authority.

### Files to Change
1. `src/routes/spu/assays/[assayId]/+page.server.ts`
   - `lock` action: change from `assay:write` to `requirePermission(locals.user, 'manufacturing:admin')`
   - `unlock` action: change from `assay:write` to `requirePermission(locals.user, 'manufacturing:admin')`
   - Other assay mutations (edit draft, toggleActive): keep as `assay:write`

### Acceptance Criteria
- Operators with `assay:write` can edit draft assays but NOT lock/unlock them
- Users with `manufacturing:admin` can lock and unlock assays
- Admin users (who have all permissions including `manufacturing:admin`) can lock/unlock

---

## Story SEC-08-02: Sacred Document Corrections Require admin:full

### Description
CartridgeRecords, SPUs, and ReagentBatchRecords are Sacred documents — immutable after finalization. The correction workflow allows appending corrections to the `corrections[]` array. This should require elevated authority since corrections to finalized documents are audit-sensitive.

### Files to Change
Search for all routes that push to `corrections[]` on Sacred models:
1. Any `CartridgeRecord` correction actions
2. Any `SPU` correction actions
3. Any `ReagentBatchRecord` correction actions
4. Any `AssayDefinition` correction actions

For each: add `requirePermission(locals.user, 'admin:full')` before the correction logic.

### Notes
- Normal mutations on UN-finalized Sacred documents should remain at their current permission level (`:write`)
- Only the **correction** action (modifying a finalized document) needs `admin:full`
- The correction should still be logged with the correcting user's identity in the corrections array

### Acceptance Criteria
- Corrections to finalized Sacred documents require `admin:full`
- Normal edits to non-finalized documents are unaffected
- Correction records still capture who made the correction

---

## Story SEC-08-03: Audit Log Page Requires admin:full

### Description
The agent activity / audit log page at `src/routes/admin/agent-activity/+page.server.ts` currently checks `if (!locals.user)` — any logged-in user can view audit logs. In a regulated environment, audit log access should be controlled.

### Files to Change
1. `src/routes/admin/agent-activity/+page.server.ts`
   - Load: add `requirePermission(locals.user, 'admin:full')`

### Acceptance Criteria
- Non-admin users get 403 when accessing the agent activity / audit page
- Admin users can view the page normally

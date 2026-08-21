# PERM-02 — Permission Registry + Additive Data Migration

**Status:** Approved — next after PERM-01
**Depends on:** PERM-01 merged
**Deploy risk:** none — every change is additive; nothing enforces the new strings yet.

## Goal
Create the single source of truth for the new vocabulary and put the new permissions onto the
live roles/users, while the app continues to run 100% on the old strings.

## Changes

### A. Registry in code (`src/lib/server/permissions.ts`)
```ts
export const PERMISSIONS = {
  membership: ['bims', 'research'],
  gates: ['admin:full', 'document:approve', 'kanban:promote',
          'manufacturing:release', 'sacred:correct', 'assay:lock'],
  // legacy: the 52 current strings, exported during migration for the roles UI,
  // removed in PERM-06
} as const;
```
- `hasPermission()` gains the scoped wildcard: `admin:full` + `bims` satisfies any BIMS check.
  (`research` is never satisfied by the wildcard.)
- `admin/roles` UI and `scripts/seed.ts` import this registry — the three drifted lists die.
- `setPermissions` action validates submitted strings against the registry (closes the
  arbitrary-string hole).

### B. Migration script `scripts/migrate-perm-02-additive.ts`
Idempotent, dry-run by default:
1. Admin role: add `bims` + the 6 gates (keep all existing strings).
2. Operator role: add `bims` (keep existing strings).
3. Viewer role: **unchanged** (retired in PERM-06; its two accounts are test users).
4. Research Admin / Researcher roles: **untouched** (R1).
5. Propagate via the same `updateMany` + arrayFilters pattern the roles UI uses.
6. Verify: print every active user with their post-migration string set.

### C. Seed + tests
- `seed.ts` seeds the new strings alongside legacy ones.
- Add a contract test: Operator user passes `bims`, fails every gate; Admin passes everything;
  Research Admin (no `bims`) fails `bims` and fails wildcard-expanded checks.

## Acceptance
- All 8 active Admins hold `bims` + 6 gates + legacy strings; zane holds `bims` + legacy.
- Research roles byte-identical to before.
- App behavior completely unchanged (verified: old checks still pass, `npm run test:contracts`).

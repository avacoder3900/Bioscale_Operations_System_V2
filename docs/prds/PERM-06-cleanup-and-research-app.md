# PERM-06 — Cleanup + Research App Membership

**Status:** Approved — final phase, after PERM-04/05 stable for 2+ weeks
**Deploy risk:** low (deletions of things nothing reads anymore) + one coordinated research-v2 change.

## A. BIMS cleanup
1. Strip all 52 legacy permission strings from Admin/Operator roles and user docs
   (migration script, dry-run first). Roles become:
   Admin = `[bims, admin:full, document:approve, kanban:promote, manufacturing:release, sacred:correct, assay:lock]`,
   Operator = `[bims]`.
2. Delete the Viewer role; deactivate `viewer1`, `Test Viewer 2`, and stale test accounts
   (`operator1`, `Test Operator 2` — keep `contracttest` for the test suite, as Admin).
3. Remove the `legacy` export from the registry; roles UI shows only the 8 real permissions.
4. Update SECURITY.md to describe the new model (it becomes the canonical doc again).
5. Remove `scripts/fix-user-roles.ts`, `fix-role-objectids.ts` (obsolete, and the former
   hard-deletes custom roles).

## B. Research app (`brevitest-research-v2` repo — separate deploy)
1. Add `research` to Researcher + Research Admin roles (additive migration in shared DB).
2. Grant `research` to any BIMS user who also uses the research app (zane; confirm list with Jacob).
3. research-v2 hooks: require `research` membership on every non-public route (mirror of BIMS
   PERM-03/04, shadow-mode optional given the tiny user count).
4. **Remove `admin:full` from the Research Admin role** once research-v2 checks its own
   admin string (e.g. `research:admin` or `user:manage`) — this closes the standing
   cross-app admin leak in BOTH directions (BIMS wildcard is already membership-scoped from
   PERM-02, so this is belt-and-braces).
5. Decide fate of the stale active `admin` (Research Admin) user — deactivate or hand to a real owner.

## Acceptance
- Role documents contain only registry strings; permission-matrix test green
- Research users: full research app, zero BIMS access; BIMS admins: no research access unless granted
- SECURITY.md matches reality; drifted-list problem structurally impossible (one registry)

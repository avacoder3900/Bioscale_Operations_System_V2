# PERM-04 — Enforcement Flip + Call-Site Sweep

**Status:** Approved — gated on PERM-03 exit criterion (≥7 clean shadow days, reviewed)
**Depends on:** PERM-03; current KB2 branch work merged (R4 — avoid rebase hell)
**Deploy risk:** medium — this is the flip. Rollback = set `PERMISSIONS_ENFORCE=false` (env) or revert.

## Goal
Turn on deny-by-default, then retire ~562 of the 568 `requirePermission` calls across 241 files.
The sweep happens AFTER the flip, so it is deleting redundant checks, never removing protection.

## Steps

### A. Flip
1. `PERMISSIONS_ENFORCE=true` — hooks now blocks: no session → login; no `bims` → 403 page;
   gate route without gate → 403. Session API endpoints return 401/403 JSON.
2. Watch shadow-log-turned-enforcement-log for 48h. Contract tests + manual smoke of each area.

### B. Install the 6 gates at their action sites (the only remaining in-file checks)
| Gate | Sites |
|---|---|
| `document:approve` | documents/[id]/approve actions; documents/approvals |
| `kanban:promote` | tier promotion/demotion actions (align with KB2 two-tier flow) |
| `manufacturing:release` | cart-mfg/qa-qc release actions; scrap disposition |
| `sacred:correct` | all Sacred-tier correction paths (users, cartridge records, SPU, assay) |
| `assay:lock` | assays/[assayId] lock/unlock (replaces `manufacturing:admin` there) |
| `admin:full` | admin/** (already via hooks map) + audit-log viewing |

### C. The sweep (file-by-file, mergeable in small batches)
For each of the 241 files: delete `requirePermission`/`hasPermission` calls that the front door
now covers; keep/replace only gate checks per table B. Update the ~18 `.svelte` files' flags
(`isAdmin`, `canEdit`, `canApprove`…) to derive from the new model. Remove the duplicated local
helpers (`requireAccessionPermission` ×3, CV helpers, `requirePolicyAdmin`), the `roleName ===`
checks, and the wax-filling bcrypt step-up (replaced by gate checks).

### D. Tests
Contract tests updated to the new model; add a permission-matrix test (Operator/Admin/Research
Admin/anon × representative routes) that runs in CI.

## Acceptance
- Every route denies without `bims` (spot-check with a research-role test account)
- The 6 gates deny Operator, allow Admin
- 23 formerly login-only mutation surfaces now require `bims` (auto) — CV/wi-*/reagent/wax verified
- `npm run check` baseline maintained; contract tests green

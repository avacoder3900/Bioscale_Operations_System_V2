# PERM-01 — Hot Security Fixes

**Status:** Approved — implementing now
**Branch:** `feat/perm-01-hot-fixes`
**Depends on:** nothing (independent of the rewrite; safe to merge alone)
**Deploy prerequisite:** `CRON_SECRET` must exist in Vercel env before this reaches production
(Vercel auto-sends `Authorization: Bearer $CRON_SECRET` on cron invocations when set).

Fixes the findings from the 2026-08-03 audit that are exploitable or corrupting today,
without changing the permission model. Every change is small and independently revertable.

## Changes

### A. Unauthenticated / under-authenticated endpoints
1. **DELETE `src/routes/api/mcp/health/+server.ts`** — leaks agent+MCP key lengths (brute-force
   oracle) + deploy metadata to anonymous callers. Its own comment says to remove once the
   connector works (it has since 2026-07-30).
2. **`src/routes/api/box/callback/+server.ts`** — anonymous caller could overwrite the org's Box
   OAuth tokens. Now: unauthenticated → redirect to `/login`; non-admin → 403. Audit log now
   always written (user guaranteed).
3. **`src/routes/api/agent/ask/health/+server.ts`** — computed `authenticated` but never
   rejected; leaked model config. Now: 401 without session.
4. **`src/routes/api/debug/env/+server.ts`** — leaked secret names/lengths + some plaintext
   values to any logged-in user. Now: admin-only.
5. **`src/routes/api/dev/{seed-test-inventory,test-data}/+server.ts`** — login-only dev
   utilities that can write to / sample production collections. Now: admin-only.
   **Deviation from audit:** `api/dev/validate-equipment` is left session-authed — despite its
   path it is the scan-time deck/oven validation used by the wax-filling floor workflow;
   admin-gating it would break operators mid-scan. It should be relocated out of `/api/dev/`
   in PERM-04.

### B. Cron fails closed
Remove the spoofable `user-agent: vercel-cron/*` fallback in the six `authenticate()` helpers
(`api/cron/archive-done-tasks`, `bims-anomaly-scan`, `cartridge-cleanup-reminder`,
`daily-digest` (already had no UA fallback — unchanged), `lib/server/services/mocreo-sync.ts`,
`lib/server/services/mocreo-heartbeat.ts`). Accepted auth after this change:
`Bearer CRON_SECRET` (when set) or the agent API key. An unset `CRON_SECRET` no longer
falls through to a forgeable header.

### C. Hardcoded passwords out of the repo
6. **`opentrons-clone/operator-login`** — `'opadmin'` literal → `env.OT_OPERATOR_PASSWORD`.
   Unset → action returns "not configured" (fail closed). Workflow otherwise unchanged.
7. **`manufacturing/cart-mfg/analysis/demo`** — `'processadmin'` literal →
   `env.TRAINING_UNLOCK_PASSWORD`. Same fail-closed behavior.
   (Full removal of both mechanisms happens in PERM-04/05; this just stops shipping secrets in git.)

### D. Role-management correctness
8. **`admin/users` `assignRole`** — `$push` → `$set: { roles: [newRole] }` per SECURITY.md
   (single role per user; `$push` created duplicates — observed live on user zane).
   `roleHistory` still appends. `removeRole` revocation matcher now handles absent-field subdocs.
9. **`scripts/fix-duplicate-roles.ts`** (new) — one-time dedupe of `roles[]` by roleId for
   affected users (zane). Dry-run by default; `--apply` to execute.
10. **`scripts/seed.ts`** — add missing `kanban:replenish` to the Admin list (drift vs roles UI).

### E. Broken error semantics
11. **3 layouts** (`manufacturing/cart-mfg`, `…/wax-filling`, `…/reagent-filling`) — remove the
    try/catch wrapping `requirePermission` that could silently swallow a 403. Plain call, as
    SECURITY.md mandates.
12. **`spu/work-instruction` `upload` action** — rethrow SvelteKit `error()` objects before the
    generic `catch` that was converting 403s into 500s.
13. **`api/spu/work-instruction/active`** — replace the ad-hoc non-timing-safe `===` key compare
    with a shared timing-safe helper (`isAgentApiKey()` added to `lib/server/api-auth.ts`).

## Explicitly NOT in scope
- Any vocabulary/model change (PERM-02+)
- MCP actor validation (PERM-05)
- Deleting the stale `admin` (Research Admin) user — shared with research-v2, handled in PERM-06
- `/api/cv/stations/[id]/token` and dev-route deeper rework — PERM-04

## Acceptance
- `npm run check` at or below current baseline (~10-11 errors)
- Anonymous requests to items A.1–A.5 return 401/403/redirect (or 404 for the deleted route)
- Cron endpoints reject UA-only requests
- Assigning a role twice in admin UI leaves exactly one `roles[]` entry
- Denied permission on the 3 layouts and WI upload returns 403, not 200/500

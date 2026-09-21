# PERM-03 — Deny-by-Default Hooks, Shadow Mode

**Status:** Approved — after PERM-02
**Depends on:** PERM-02 deployed (users carry `bims`)
**Deploy risk:** none — observes and logs; blocks nothing.

## Goal
Build the front-door enforcement in `hooks.server.ts` and run it in **log-only mode** for at
least one week, so every request that *would* be denied under the new model surfaces as a log
line instead of an outage.

## Design

### A. Route policy map (`src/lib/server/route-policy.ts`)
```ts
export const PUBLIC = ['/login', '/logout', '/invite'];
export const KEY_AUTHED_API = [/* /api/agent/**, /api/cron/**, /api/mcp/**, station+device webhooks */];
export const ADMIN_GATES: Record<string, string> = {
  '/documents/*/approve':            'document:approve',
  '/admin':                          'admin:full',        // users, roles, invites, notifications, ask-bims
  // kanban promote, lot release, scrap, sacred corrections, assay lock are ACTIONS not routes —
  // they keep in-file requirePermission(gate) calls; hooks covers page access.
};
```

### B. Shadow evaluator in `hooks.server.ts`
For every request, after session resolution:
1. Compute the new-model verdict: public? key-authed API? has `bims`? gate satisfied?
2. If verdict = DENY and the request currently succeeds → write one line to a `PermissionShadowLog`
   collection (TTL 30 days): path, method, username/key-type, reason.
3. Never block. Enforcement flag `PERMISSIONS_ENFORCE=false` until PERM-04.

### C. Review tooling
`scripts/report-shadow-denials.ts` — aggregates the log by caller × path so the flip decision
is data-driven. Expected legitimate findings to resolve before PERM-04: research-app users
touching BIMS, forgotten automation, any human missing `bims`.

## Acceptance
- Zero behavior change for all callers (contract tests green).
- Shadow log populating in production; report script runs.
- Exit criterion for PERM-04: 7 consecutive days where every logged denial is *intended*
  (i.e., things we WANT to start blocking), reviewed with Jacob.

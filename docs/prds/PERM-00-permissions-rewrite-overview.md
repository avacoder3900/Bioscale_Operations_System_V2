# PERM-00 — Permissions Rewrite: Overview & Target Model

**Status:** Approved (Jacob, 2026-08-03)
**Series:** PERM-00 (this doc) → PERM-01..06 (phases)
**Prereq reading:** SECURITY.md (current system), full audit in session memory `permissions-audit-2026-08-03`

---

## 1. Why

The permission system (`permissions.ts`, 48-string vocabulary, SECURITY.md) froze in March 2026.
The app has taken 1,600+ commits since. Result:

- 3 conflicting "all permissions" lists (roles UI: 49, seed: 48, code enforces: 52)
- 23 page files where **any logged-in user can mutate** (CV, reagent-filling, wi-01/02/03, wax-filling, opentrons-clone, equipment/robots)
- Permissions checked in code but unassignable in the UI (`cv:write`, `cv:admin`, `inventory:retract`); 7 grantable no-ops
- `admin:full` is not a wildcard — exact-match only
- One shared `AGENT_API_KEY` = the entire machine surface (74 endpoints + MCP's 53 tools), with
  admin authority granted via a caller-supplied `actor` username (impersonation hole)
- **Live cross-app privilege leak:** research-v2 shares the users/roles collections; the active
  "Research Admin" role carries `admin:full`, `cartridge:*`, `assay:*` — those users pass BIMS
  admin checks today, and BIMS admins pass research-v2 admin checks.

Live usage (verified in Atlas 2026-08-03): 8 active Admins, 1 real Operator (zane), test accounts
only for Viewer. The system is administering distinctions that don't exist.

## 2. Decision record (from design discussion with Jacob, 2026-08-03)

1. Collapse to **admin / not-admin** for humans. No read-only (Viewer) tier — it's dropped.
2. Per-app **membership permissions** because the user pool is shared with research-v2:
   `bims` = can do everything non-admin in BIMS; `research` = can do everything in research app.
3. **Admin-only activities (the 6 gates):** document approval, kanban tier-1→tier-2 promotion,
   QA lot release + scrap disposition, sacred-record corrections, assay lock/unlock,
   user/role/platform management (covered by `admin:full`).
   *Implementation note (2026-08-05):* the tier-promotion gate is the EXISTING
   `kanban:replenish`, not a new `kanban:promote` string — `transitionTask()` already refuses
   every tier crossing unless `allowTierCrossing` is set, and the only human path that sets it
   is `replenish.ts`, which requires `kanban:replenish`. Operators don't hold it; Admins do.
4. **Bots are permanent non-admins.** The shared Claude account / agent key gets exactly Operator
   capability. Machine surface: *propose, don't decide* — admin decisions happen only in the web
   UI with a real session.
5. **Attribution, not authentication, for MCP writes:** every write tool requires a validated
   `actor` (must match an active BIMS user). Missing/invalid → server rejects with an
   instruction to ask the human, forcing Claude to ask. One chat = one actor (ask once per
   conversation). Actor grants nothing; it is audit metadata only.
   Elicitation is NOT used (only Claude Code CLI supports it; Desktop/web/iOS don't).
6. Devices (scanners, OT-2 bridges, CV stations, Mocreo, Particle) get narrow per-fleet keys
   (later phase); they never carry permissions.

## 3. Target vocabulary (replaces all 52 current strings)

| Permission | Held by | Grants |
|---|---|---|
| `bims` | Operator, Admin, agent surface | All BIMS reads AND writes except admin gates |
| `research` | Research roles (enforced in research-v2, PERM-06) | Everything in research app |
| `admin:full` | Admin | Wildcard **within BIMS, only when `bims` is also held** |
| `document:approve` | Admin (delegable) | Document approval/rejection |
| `kanban:replenish` | Admin (delegable) | Tier 1 → Tier 2 commitment + demotion (the KB2 replenishment path) |
| `manufacturing:release` | Admin (delegable) | QA/QC lot release, scrap disposition |
| `sacred:correct` | Admin (delegable) | Corrections to finalized (Sacred-tier) records |
| `assay:lock` | Admin (delegable) | Assay definition lock/unlock |

Wildcard rule: `hasPermission(user, X)` returns true if user holds X, **or** holds both
`admin:full` and `bims` (for any BIMS-namespaced X). `admin:full` never implies `research`.
Research-v2's own strings (`experiment:*`, `user:manage`, plus its use of `cartridge:*`/
`assay:*`) are untouched by this project until PERM-06.

## 4. Enforcement architecture

One check at the front door (`hooks.server.ts`), deny-by-default:

```
authenticated? → has 'bims'? → route in ADMIN_GATE_MAP? require its gate → proceed
```

- Pages: covered entirely by hooks. Per-route `requirePermission` remains ONLY for the 6 gates.
- `/api/**`: session endpoints get the same hooks treatment; key-authenticated endpoints
  (agent/station/mcp/cron) keep their key checks and are scope-limited to non-admin.
- **Shadow mode first** (PERM-03): the hooks check runs log-only for ≥1 week before enforcement
  flips, so unknown callers surface as log lines, not outages.

## 5. Principals

| Principal | Auth | Capability |
|---|---|---|
| Human | Session cookie | Their role's permissions (`bims`, +gates for Admin) |
| Agent (Claude/MCP/agent API) | Shared key (per-person keys possible later) | Synthetic Operator: `bims`, never gates. Validated `actor` required on writes (attribution). |
| Device fleet | Per-fleet key (PERM-05) | Endpoint allowlist only, no permissions |
| Cron | `CRON_SECRET` bearer, fail-closed | Its own endpoints; writes attributed to reserved actor `system` |

## 6. Risk register (what could break, and the mitigation)

| # | Risk | Mitigation |
|---|---|---|
| R1 | research-v2 shares users/roles; overlapping strings (`admin:full`, `cartridge:*`, `assay:*`) | Never modify research roles; membership-scoped wildcard; research-v2 changes deferred to PERM-06 |
| R2 | Human lockout during migration | Additive-first (PERM-02): new strings added before anything enforces them; admins protected by wildcard; old strings retained until PERM-06 |
| R3 | Machine fleet breakage | Phase 1–4 require **zero device re-keying** (server-side scope only). `CRON_SECRET` must be set in Vercel *before* PERM-01 deploys. Automated writers use reserved actor `system`. Team heads-up: Claude will ask "who am I working with?" once per chat. |
| R4 | Conflict with in-flight KB2 branches | PERM-01/02 touch ~20 files disjoint from KB2 work; the big sweep (PERM-04) lands only after current KB2 work merges |
| R5 | Contract tests / seed assume old roles | Seed + tests updated in PERM-02/04; `contracttest` stays Admin |

## 7. Phases

| PRD | Scope | Deploy risk |
|---|---|---|
| PERM-01 | Hot security fixes (unauthenticated endpoints, hardcoded passwords, cron fail-closed, assignRole bug, swallowed 403s) | Low — prereq: `CRON_SECRET` set in Vercel |
| PERM-02 | Single permission registry in code; additive data migration (add `bims` + gates to roles) | None (additive) |
| PERM-03 | Hooks deny-by-default in **shadow (log-only) mode** | None (observes only) |
| PERM-04 | Flip enforcement; sweep 568 requirePermission calls / 241 files; retire per-route checks except gates | Medium — gated by ≥1 clean shadow week |
| PERM-05 | Machine surface: MCP actor validation + dual-identity audit logging; propose-don't-decide tool reclassification; per-fleet device keys | Medium — fleet keys rolled one at a time |
| PERM-06 | Cleanup: strip old strings, delete Viewer, deactivate stale accounts, `research` membership in research-v2 | Low |

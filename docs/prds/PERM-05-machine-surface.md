# PERM-05 — Machine Surface: Attribution, Propose-Don't-Decide, Fleet Keys

**Status:** Approved — can start in parallel with PERM-04's sweep
**Depends on:** PERM-01 (key hygiene), PERM-02 (registry)
**Deploy risk:** medium — behavior changes for Claude users and (last step) device fleets.

## A. Bots are non-admins (server-side scope)
- Agent-key and MCP-key authenticated calls are assigned a synthetic principal:
  `{ roles: [{ roleName: 'agent', permissions: ['bims'] }] }` — never any gate.
- Remove admin authority from the machine surface entirely:
  - `api/agent/operations/kanban/policy` PATCH, `templates` POST: the body-`actor` →
    `kanban:admin` lookup is DELETED as an authorization mechanism. These endpoints become
    propose-only or 403 for key callers.
  - MCP tools reclassified: `decide_approval_request`, `kanban_decide_proposal`,
    `kanban_set_policy`, `kanban_set_template`, `kanban_set_standing_target`, and tier-promotion
    execution are removed from the MCP tool registry (or return a standard
    "requires human approval in the BIMS web app — file a proposal instead" error).
    ~45 of 53 tools unchanged. Bots propose (`kanban_propose_changes`,
    `create_approval_request`); humans decide in the web UI.

## B. Mandatory validated attribution on writes
- Every mutating MCP tool + agent-API write endpoint requires `actor: string`.
- Server validates against active BIMS users (case-insensitive username match).
  Reserved actor `system` accepted only for cron-authenticated calls.
- Missing/invalid actor → structured error:
  `"This action requires attribution. Ask the person you're working with for their name, then retry with actor set."`
  This forces Claude to ask — works identically on Claude Code, Desktop, web, iOS (plain tool
  results; elicitation deliberately not used — CLI-only client support as of Aug 2026).
- One chat = one actor: MCP server instructions block tells Claude to establish the actor at
  session start and reuse it for the whole conversation.
- Actor NEVER grants authority (bots can't reach gates regardless of the name given).

## C. Dual-identity audit logging
Every machine-surface mutation's AuditLog entry records:
`{ keyIdentity: 'agent-shared' | 'mcp-shared' | 'station-<fleet>' | 'cron', reportedActor, via: 'mcp'|'agent-api'|... }`
Attribution is clearly labeled self-reported, distinct from authenticated identity.

## D. Per-fleet device keys (last, one fleet at a time)
- Extend the `STATION_AGENT_KEY` pattern: `SCANNER_KEY`, `OT2_BRIDGE_KEY`, `MOCREO_KEY`,
  `PARTICLE_WEBHOOK_KEY` — each valid only on its fleet's endpoints (allowlist in one module,
  replacing the six scattered compare implementations with one shared timing-safe helper).
- Rollout per fleet: add new key server-side (old shared key still accepted) → update device env
  → confirm traffic on new key → revoke old acceptance for that fleet's endpoints.
- `/api/mcp/k/[key]` (key-in-URL) deprecated after confirming the header-auth connector config
  works everywhere; `?key=` query param support removed.
- Rotate `AGENT_API_KEY` + `MCP_API_KEY` at the end (team offboarding hygiene baseline).

## Acceptance
- MCP write without actor → Claude asks, retries, succeeds; audit row has both identities
- Any admin-gated action attempted via key auth → 403 + proposal guidance
- Each fleet works on its own key; leaked scanner key cannot call `/api/agent/query`
- Team notified before actor requirement ships (expect the "who am I working with?" question)

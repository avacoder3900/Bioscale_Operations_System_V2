# BIMS MCP Server — `/api/mcp`

BIMS exposes a remote [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server at
**`https://<bims-host>/api/mcp`**, so Claude (Desktop app, claude.ai, Claude in Chrome, mobile,
Claude Code) can read and control BIMS in plain English — "what needs attention today?",
"move the wax-fill task to done", "create a subtask under X".

It supersedes the standalone `services/bims-mcp` prototype (which only ran on localhost). The MCP
endpoint now lives **inside the SvelteKit app**, so:

- it deploys automatically with every push (Vercel), at a public HTTPS URL — which is required,
  because Claude custom connectors dial in **from Anthropic's cloud**, never from your machine;
- every tool is a thin wrapper that calls the existing `/api/agent/**` REST endpoints internally
  with `AGENT_API_KEY`, so audit logging, collection allowlists, and validation remain enforced in
  one place (the REST handlers). No new database access paths.

## Files

| File | Purpose |
|---|---|
| `src/routes/api/mcp/+server.ts` | The Streamable-HTTP endpoint (stateless, per-request server) |
| `src/lib/server/mcp/bims-mcp.ts` | Tool definitions (the MCP ⇄ agent-API mapping) |
| `src/lib/server/mcp/auth.ts` | Connector key check (`MCP_API_KEY`, falls back to `AGENT_API_KEY`) |

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `AGENT_API_KEY` | yes (already set) | Used internally by tools to call `/api/agent/**` |
| `MCP_API_KEY` | recommended | The key connectors present. Set it distinct from `AGENT_API_KEY` so the connector credential can rotate independently of the robot/IoT fleet key. If unset, `AGENT_API_KEY` is accepted. |

Set `MCP_API_KEY` in the Vercel project env (Production) and redeploy.

## Connecting Claude clients

The endpoint accepts the key three ways: `Authorization: Bearer <key>`, `x-api-key: <key>`, or
`?key=<key>` in the URL. The query-param form exists because the claude.ai / Claude Desktop
custom-connector UI only accepts a URL (its only alternative is a full OAuth server, which we have
not built yet — see Future below).

### claude.ai / Claude Desktop / Claude mobile / Claude in Chrome (custom connector)

1. Settings → **Connectors** → **Add custom connector** (Team/Enterprise: an owner adds it under
   Organization settings → Connectors first).
2. URL: `https://<bims-host>/api/mcp?key=<MCP_API_KEY>`
3. Leave the OAuth fields empty → **Add**.
4. In a chat, enable the connector under the tools menu. Claude in Chrome uses the same
   connectors as your claude.ai account.

> The key is embedded in the URL, so treat the connector URL itself as a secret.

### Claude Code

```bash
claude mcp add --transport http bims https://<bims-host>/api/mcp --header "Authorization: Bearer <MCP_API_KEY>"
```

### Claude Desktop via mcp-remote (header-based alternative)

If you prefer not to embed the key in a URL, bridge through stdio with header auth in
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bims": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "https://<bims-host>/api/mcp",
        "--header", "Authorization: Bearer <MCP_API_KEY>"
      ]
    }
  }
}
```

### Local dev

Run the app (`npm run dev`) and point any client at `http://localhost:5173/api/mcp` with the same
key. Local URLs work for Claude Code and mcp-remote, but **not** for claude.ai custom connectors
(they connect from Anthropic's cloud).

## Tools (v1 surface)

Read-only: `list_collections`, `system_dependencies`, `list_saved_queries`, `run_saved_query`,
`operations_summary`, `operations_dashboard`, `operations_alerts`, `operations_context`,
`inventory_overview`, `equipment_overview`, `documents_overview`, `quality_trends`,
`get_spu_status`, `list_spus`, `kanban_board_snapshot`, `kanban_projects_overview`,
`kanban_task_transitions`, `kanban_list_violations`, `list_approvals`, `list_messages`,
`get_cartridge_photos`.

Mutating (all audit-logged server-side by the wrapped endpoints): `kanban_create_task`,
`kanban_update_task`, `kanban_create_subtasks`, `kanban_merge_tasks`, `kanban_propose_changes`,
`kanban_decide_proposal`, `kanban_report_violation`, `create_approval_request`,
`decide_approval_request`, `send_message`.

**Two-tier kanban (KB2)** — the full lifecycle runs through Claude: `kanban_capture` (all
creation; embeds the discovered-work stop-now test; replaces `kanban_create_task`),
`kanban_process` (sizing/classing at triage), `kanban_disposition` (icebox/decline/thaw),
`kanban_replenishment_status` + privileged `kanban_replenish` / `kanban_demote` /
`kanban_reorder_queue` (actor validated server-side against `kanban:replenish` — only humans
commit), `kanban_close_spike`, `kanban_flow_metrics` (no per-person stats by design),
`kanban_get_policy` / `kanban_set_policy` (`kanban:admin`), `kanban_standing_status` /
`kanban_set_standing_target` (supply targets, e.g. the cartridge build queue). Mutating tools
require `actor` = the username of the human driving the session; Claude is instructed to ask,
never guess. See `docs/prds/KB2-00-OVERVIEW.md` and `KB2-09-mcp-toolset.md`.

This replicates the full `/api/agent/**` machine surface except: `ask`/`transcribe` (session-cookie
routes serving the in-app widget, not machine agents) and the OT-2/scanner long-poll daemon queues
(not request/response shaped; the robot bridge keeps using them directly).

## Adding a tool

Add a `server.registerTool(...)` block in `src/lib/server/mcp/bims-mcp.ts` that calls the relevant
`/api/agent/**` endpoint via `callAgentApi`. If the capability doesn't exist as an agent endpoint
yet, build the endpoint first (with `requireAgentApiKey` + AuditLog), then wrap it — keep the MCP
layer thin.

## Future

- **OAuth**: the polished path for custom connectors is an OAuth 2.0 authorization server with
  dynamic client registration (the connector UI's Advanced settings). That removes the
  key-in-URL compromise and enables per-user identity. Deferred until needed.
- **Per-user tools**: today all MCP traffic acts as "the agent" (one shared key, `changedBy:
  'agent'`/`'mcp'`). Per-user attribution needs the OAuth path.

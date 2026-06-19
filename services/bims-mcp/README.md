# bims-mcp

An [MCP](https://modelcontextprotocol.io) server that exposes **read-only BIMS SPU status** to any
MCP client — Claude Code, Claude Desktop, or the Claude mobile app. Ask in plain English
("what's the status of SPU-X?") and Claude calls these tools instead of you clicking through BIMS.

It is a thin layer: each tool makes an authenticated HTTP call to the BIMS agent API
(`/api/agent/operations/spus`) using `AGENT_API_KEY`. No database access, no BIMS UI changes.

## Tools

| Tool | What it returns |
|------|-----------------|
| `get_spu_status` | One SPU by `spuId` / `udi` / `barcode`: lifecycle status, assembly/QC status, batch, customer, Particle device, and per-modality validation (magnetometer, thermocouple, lux, spectrophotometer). |
| `list_spus` | SPUs filtered by `status` / `batch` / `customer` (newest first, `limit` ≤ 100) plus a status breakdown. |

Both are **read-only**. Write actions (e.g. creating servicing tickets) are intentionally not included yet.

## Setup

```bash
npm install
cp .env.example .env      # then edit .env
npm run build
```

Set in `.env`:
- `BIMS_BASE_URL` — `http://localhost:5173` for local dev, or the deployed BIMS URL.
- `AGENT_API_KEY` — must match `AGENT_API_KEY` in the BIMS environment.

## Run

**Local (stdio)** — for Claude Code / Claude Desktop on this machine:
```bash
npm run dev          # or: npm start  (after build)
```

**Remote (HTTP)** — for phone access and shared use:
```bash
MCP_TRANSPORT=http MCP_BEARER_TOKEN=<long-random-secret> PORT=8787 npm start
# endpoint: POST http://<host>:8787/mcp   (Authorization: Bearer <token>)
# health:   GET  http://<host>:8787/healthz
```

## Register with a client

### Claude Code (local stdio)
Add to `.claude/settings.json` (or run `claude mcp add`):
```json
{
  "mcpServers": {
    "bims-spu": {
      "command": "node",
      "args": ["C:/Users/aleja/bims-mcp/dist/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "BIMS_BASE_URL": "http://localhost:5173",
        "AGENT_API_KEY": "<bims-agent-api-key>"
      }
    }
  }
}
```

### Claude Code / Desktop (remote HTTP)
```json
{
  "mcpServers": {
    "bims-spu": {
      "type": "http",
      "url": "https://<your-host>/mcp",
      "headers": { "Authorization": "Bearer <MCP_BEARER_TOKEN>" }
    }
  }
}
```

### Claude mobile app
Settings → Connectors → Add custom connector → paste the same `https://<your-host>/mcp` URL and bearer token.
(Requires the HTTP server to be deployed at a public HTTPS URL.)

## Deploy (remote)

The HTTP server is a long-running Express process, so a container host (e.g. **Fly.io**) fits better than
serverless. Set `BIMS_BASE_URL`, `AGENT_API_KEY`, `MCP_BEARER_TOKEN`, and `MCP_TRANSPORT=http` as secrets,
expose the port, and point it at the deployed BIMS URL.

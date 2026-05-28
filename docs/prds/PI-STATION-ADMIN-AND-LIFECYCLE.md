# PRD: Pi Capture Station — Admin, Lifecycle, and BIMS Integration (V2)

**Author:** Alejandro Valdez
**Date:** 2026-05-28
**Status:** Draft
**Priority:** P1 — completes the Pi capture station rollout by moving all provisioning, monitoring, and remote management into BIMS V2.
**Proposed branch:** `feature/pi-station-mgmt` (off `bims-capture-agent`)
**Related:**
- [`docs/prds/PI-CAPTURE-STATION.md`](PI-CAPTURE-STATION.md) — V1 PRD defining the hardware, Pi-side agent, and operator capture flow. Phases 1–4 (agent foundation, camera bridge, scanner reader) and Phase 5 (basic provisioning) are landed on the `bims-capture-agent` branch.
- [`services/bims-capture-agent/RUNBOOK.md`](../../services/bims-capture-agent/RUNBOOK.md) — current known-good setup procedure, including documented manual steps this PRD aims to eliminate.
- [`docs/prds/PI-CAPTURE-STATION-BOM.md`](PI-CAPTURE-STATION-BOM.md) — hardware bill of materials.

---

## 1. Problem Statement

V1 landed a working Pi capture station: an operator can pick a Pi in the `/capture` dropdown and stream video from it. But every step of the **lifecycle** — provisioning, monitoring, updating, retiring — still requires SSH access, browser DevTools, or direct MongoDB writes. Concretely:

| Lifecycle moment | Today |
|---|---|
| Register a new Pi with BIMS | Operator opens DevTools on `/capture`, hand-types a `fetch()` to `/api/cv/stations`, copies the returned `jwtSecret`, SSH'es to the Pi, appends `STATION_JWT_SECRET=...` to `/etc/bims/station.env`. |
| Know which Pis are online | Open SSH to each Pi and `systemctl status` — there's no list in BIMS. The `CaptureStation.status` field exists but is only set at registration; `lastSeenAt` never updates after that. |
| Spot a broken Pi | Operator selects the station, gets a blank video or a timeout, then notifies someone. No proactive alerting. |
| Update the agent | SSH in, `git pull`, `sudo systemctl restart bims-capture-agent`. Per-Pi, manual, error-prone. |
| Rename a Pi or move it to a new bench | Direct Mongo edit on `CaptureStation`. |
| Retire a Pi | Direct Mongo delete. |
| Recover from "operator says video doesn't work" | SSH in, restart the agent (per RUNBOOK §"video element renders, stream is black"), and the same fix is needed for every operator complaint. |

The friction is all in BIMS not knowing how to **manage** stations. This PRD closes those gaps so a new Pi goes from "factory-fresh" to "registered and streaming" in under 5 minutes with no DevTools, no MongoDB Compass, and no shell command for the operator who runs `setup-station.sh`.

---

## 2. What Exists Today (Status Inventory)

| Component | Status | Location | Note |
|---|---|---|---|
| `bims-capture-agent` Phase 1 (HTTP + WS auth) | ✅ Live | `services/bims-capture-agent/agent.py` | systemd-installed per RUNBOOK §6 |
| `bims-capture-agent` Phase 2 (WebRTC camera) | ✅ Live, with known reconnect-leak | `services/bims-capture-agent/camera.py` | After ~7 station-switches the singleton track can stop emitting RTP (RUNBOOK known issue). |
| `bims-capture-agent` Phase 3 (scanner events) | ✅ Live | `services/bims-capture-agent/scanner.py` | |
| `bims-capture-agent` Phase 4 (LED) | ❌ Not started | (would be `services/bims-capture-agent/led.py`) | Out of scope for THIS PRD. Tracked in V1 PRD. |
| `setup-station.sh` (Phase 1 of V1 PRD) | ✅ Partial | `services/bims-capture-agent/setup-station.sh` | Writes `/etc/bims/station.env` but stops short of self-registration (commented as "Phase 5 placeholder"). |
| `CaptureStation` Mongoose model | ✅ Live | `src/lib/server/db/models/capture-station.ts` | Has `jwtSecret`, `lastSeenAt`, `status`, `mode`, `currentOperator`, `capabilities`. |
| `POST /api/cv/stations` (register) | ✅ Live, but session-only auth | `src/routes/api/cv/stations/+server.ts` | Requires logged-in user with `cv:write`/`manufacturing:write`. No agent-key path. |
| `GET /api/cv/stations` (list) | ✅ Live | same file | |
| `GET /api/cv/stations/[id]` (read) | ✅ Live | `src/routes/api/cv/stations/[id]/+server.ts` | |
| `PATCH /api/cv/stations/[id]` | ✅ Live | same file | |
| `DELETE /api/cv/stations/[id]` | ✅ Live | same file | |
| `POST /api/cv/stations/[id]/lock` | ✅ Live | `src/routes/api/cv/stations/[id]/lock/+server.ts` | |
| `GET /api/cv/stations/[id]/token` (JWT mint) | ✅ Live | `src/routes/api/cv/stations/[id]/token/+server.ts` | |
| BIMS admin UI for stations | ❌ Does not exist | (would be `src/routes/cv/stations/`) | |
| Pi heartbeat sender | ❌ Does not exist | (would be in `agent.py`) | |
| BIMS health-status derivation | ❌ Does not exist | | `lastSeenAt` is only written at registration. |
| Pi-side `AGENT_API_KEY` precedent | ✅ Exists for scanner-bridge | `src/routes/api/agent/scanner/event/+server.ts` | Pattern: `x-agent-api-key` header validated against env var. |

---

## 3. Goals

1. **Self-registration**: a fresh Pi running `setup-station.sh` ends with a fully working `STATION_JWT_SECRET` in its env file, with zero browser interaction.
2. **Live status in BIMS**: every Pi has an authoritative `online | offline | degraded` status that reflects reality within 60 seconds of changing.
3. **Admin surface**: a logged-in admin can list, rename, retire, force-unlock, and (later) trigger updates on stations from the BIMS UI without touching SSH or MongoDB.
4. **Operator clarity**: when a Pi is offline or unhealthy, the `/capture` dropdown reflects that BEFORE the operator selects it — no more "I picked the station and nothing happened."
5. **One-button remote restart**: an admin can restart the agent on a Pi from the BIMS UI when the known WebRTC leak strikes.
6. **No regression**: existing `/capture` flow continues to work for already-registered Pis throughout the rollout.

---

## 4. Non-Goals

- Phase 4 LED control (still tracked in V1 PRD).
- Robot arm support (no V1 PRD scope yet).
- Multi-tenant BIMS instances or per-org station isolation.
- Replacing Tailscale with Cloudflare Tunnel. V1 PRD assumed Cloudflare; current production uses Tailscale Serve. THIS PRD stays Tailscale-first; Cloudflare Tunnel can layer on later for operators outside the tailnet.
- Pi-side hardening of the WebRTC reconnect leak. That's an `agent.py` fix that belongs in the V1 PRD's epic (it's listed in RUNBOOK §"Known failure modes"). Auto-restart-on-error here is a workaround, not a fix.
- Cross-station broadcasts (e.g., "scan on station A also locks cartridge on station B"). Out of scope.

---

## 5. Architecture

### 5.1 Where logic lives

```
┌───────────────────────────────────────────────────────────────────────┐
│  BIMS V2 (Vercel)                                                     │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │  NEW    /api/cv/stations/register       (Pi → BIMS, agent-key)  │  │
│  │  NEW    /api/cv/stations/[id]/heartbeat (Pi → BIMS, agent-key)  │  │
│  │  NEW    /api/cv/stations/[id]/command   (BIMS → Pi via WS,      │  │
│  │                                          admin-session)         │  │
│  │  NEW    /cv/stations            list page (admin)              │  │
│  │  NEW    /cv/stations/[id]       detail + actions               │  │
│  │  MOD    /capture                disable offline stations in     │  │
│  │                                   dropdown, surface status badges│  │
│  │  EXIST  /api/cv/stations CRUD (unchanged)                       │  │
│  └─────────────────────────────────────────────────────────────────┘  │
└────┬──────────────────────────────────────────────┬───────────────────┘
     │ HTTPS (agent → BIMS, via STATION_AGENT_KEY)  │ HTTPS admin sessions
     │                                              │
┌────┴────────────────────────────────────────────┐ │
│  Pi  bims-capture-agent                         │ │
│  ┌────────────────────────────────────────────┐ │ │
│  │  NEW   heartbeat timer (30 s)               │ │ │
│  │  NEW   self-register on first start         │ │ │
│  │  NEW   /command WS handler (restart, etc.) │ │ │
│  │  EXIST /health, /ws, camera, scanner       │ │ │
│  └────────────────────────────────────────────┘ │ │
│  setup-station.sh — NEW: also calls /register    │ │
└──────────────────────────────────────────────────┘ │
                                                     ▼
                              ┌──────────────────────────────────┐
                              │  Browser admin                   │
                              │   /cv/stations  /cv/stations/[id]│
                              └──────────────────────────────────┘
```

### 5.2 Auth model

Two distinct auth surfaces:

- **Agent → BIMS** (used by self-registration and heartbeat): the Pi presents a long-lived `STATION_AGENT_KEY` in the `x-station-agent-key` header. This key is a shared secret between BIMS (`process.env.STATION_AGENT_KEY`) and the Pi (`/etc/bims/station.env`). Single key for all Pis (operationally simple). Matches the existing `AGENT_API_KEY` precedent at `/api/agent/scanner/event/+server.ts`.

- **Admin → BIMS** (used by station CRUD, admin pages, remote command): standard BIMS cookie session + `cv:write` or `manufacturing:write` permission. No change from today.

- **Browser → Pi** (used by `/capture` WebSocket): per-station short-lived HS256 JWT minted by `GET /api/cv/stations/[id]/token`, signed with `jwtSecret`. Unchanged.

Why not reuse `AGENT_API_KEY`? Future-proofing — scanner-bridge and capture-station may want different rotation cadences. Cheap to keep them separate now.

### 5.3 State authority

| State | Authority | Synchronization mechanism |
|---|---|---|
| Station identity (`_id`, `name`, `hostname`, `capabilities`) | BIMS Mongo | Set by `/api/cv/stations/register` and `PATCH /api/cv/stations/[id]`. Pi reads only its own `STATION_ID` from env. |
| `jwtSecret` | BIMS Mongo (one-way to Pi) | Returned once at registration, persisted in `/etc/bims/station.env` as `STATION_JWT_SECRET`. |
| `lastSeenAt`, `agentVersion`, `status` | BIMS Mongo | Bumped by heartbeat. `status = stale_if(now - lastSeenAt > 90 s)` derived at read time + materialized periodically. |
| `currentOperator` (lock) | BIMS Mongo | Set by `POST /api/cv/stations/[id]/lock`. Pi has no view. |
| Agent runtime health | Pi (queried via heartbeat payload) | `camera_ok`, `scanner_ok`, agent uptime — same fields as `/health` already returns. |

---

## 6. Epics and User Stories

Each story is sized to fit in a single Claude Code agent run. Stories are tagged with epic prefix and a number; dependencies are explicit. Acceptance criteria are testable.

### Epic A — Foundations

#### Story A1 — Introduce `STATION_AGENT_KEY` auth helper

**Why:** Self-registration and heartbeat both need to authenticate as "an agent" without a user session. Establish the validation pattern in one place so both endpoints use the same code path.

**Files to touch:**
- NEW: `src/lib/server/auth/station-agent-key.ts` — exports `requireStationAgentKey(request: Request): void` that throws `error(401)` if header missing or doesn't match `process.env.STATION_AGENT_KEY`.
- MOD: `.env.example` (if it exists) — document the new env var.

**Acceptance:**
- Function rejects requests with missing header (401 with `{ error: "agent key required" }`).
- Function rejects requests with wrong header (401 with `{ error: "invalid agent key" }`).
- Function returns void on success.
- If `process.env.STATION_AGENT_KEY` is unset, function logs a warning and rejects all requests (fail-closed, with `{ error: "server misconfigured" }`).
- Unit test under `tests/server/auth/station-agent-key.test.ts` covers all three branches.

**Dependencies:** none.

---

#### Story A2 — Add `STATION_AGENT_KEY` to Vercel env + document local dev

**Why:** No code change works without the env var being set in deployment.

**Files to touch:**
- MOD: `services/bims-capture-agent/RUNBOOK.md` — add a "BIMS-side env vars" section noting `STATION_AGENT_KEY` needs to be set on Vercel and matched in each Pi's `/etc/bims/station.env`.
- MOD: `services/bims-capture-agent/setup-station.sh` — generate a placeholder line `STATION_AGENT_KEY=<paste BIMS-side value>` in the env file so the operator knows to fill it.
- (Vercel dashboard change — not a code change, but document.)

**Acceptance:**
- Updated RUNBOOK describes how to generate, set, and rotate the key.
- `setup-station.sh` includes the placeholder line in `/etc/bims/station.env` output.
- A Pi that has set `STATION_AGENT_KEY` and matches the BIMS-side value can successfully call any agent-key-gated endpoint added later in this PRD.

**Dependencies:** A1 (the auth helper must exist first so this story has something to point at).

---

### Epic B — Self-Registration

#### Story B1 — `POST /api/cv/stations/register` endpoint

**Why:** Replaces the manual DevTools `fetch()`. Idempotent registration callable by an agent key holder.

**Files to touch:**
- NEW: `src/routes/api/cv/stations/register/+server.ts`
- MOD: `src/lib/types/capture-station.ts` (if it exists, add `RegisterAgentRequest` / `RegisterAgentResponse` types).

**Spec:**
- Method: `POST`
- Auth: `requireStationAgentKey` (A1)
- Request body:
  ```json
  {
    "stationId": "<UUID from Pi's STATION_ID, optional — if present, BIMS uses it as _id>",
    "name": "<string>",
    "hostname": "<full Tailscale FQDN>",
    "capabilities": { "camera": true, "scanner": true, "led": false, "robotArm": false },
    "agentVersion": "<string>",
    "ipAddress": "<string, optional>"
  }
  ```
- Response (first-time): `201` `{ _id, jwtSecret }` — same shape as today's `POST /api/cv/stations` first-time path.
- Response (already registered, matched by `hostname`): `200` `{ _id, jwtSecret? }` — returns `jwtSecret` ONLY if the agent presents a `regenerateSecret: true` flag in body (admin-initiated rotation). Otherwise returns just `_id` (Pi keeps its existing secret).
- Same audit log behavior as existing register: `INSERT` on create, `UPDATE` on re-register with `reason: "agent-self-register"`.
- The audit log `changedBy` field is `"<station-agent-key>"` since there's no user session.

**Acceptance:**
- First call from a Pi creates a `CaptureStation` document with the expected fields, returns 201 with `_id` and `jwtSecret`.
- Second call from the same Pi (same hostname) returns 200 with `_id` and no `jwtSecret`.
- Call with `regenerateSecret: true` returns 201 with a fresh `jwtSecret`, replacing the old one (operationally rotates the secret).
- Missing/invalid agent key → 401.
- Missing required fields (`name`, `hostname`) → 400.
- Integration test: hit endpoint with a mocked agent key and verify all four branches.

**Dependencies:** A1.

---

#### Story B2 — `setup-station.sh` calls `/register` automatically

**Why:** Removes the manual DevTools step entirely.

**Files to touch:**
- MOD: `services/bims-capture-agent/setup-station.sh`

**Spec:**
After writing `/etc/bims/station.env` with `STATION_ID`, `STATION_TOKEN`, etc., the script also:
1. Reads `STATION_AGENT_KEY` from the env file (or prompts if missing).
2. POSTs to `${BIMS_URL}/api/cv/stations/register` with the body shape from B1, sending the `STATION_AGENT_KEY` in `x-station-agent-key` header.
3. On 201 response: appends `STATION_JWT_SECRET=<value>` to `/etc/bims/station.env`.
4. On 200 (already registered) response: prints "Station already registered with BIMS — keeping existing JWT secret" and does NOT touch the env file's `STATION_JWT_SECRET` line.
5. On error (4xx/5xx/network): prints the error, leaves the env file untouched, exits with non-zero (so the operator can fix and re-run).

Use `curl` (already on Pi OS) and `jq` (install via apt in the same script, mirroring how `uuid-runtime` is handled — see RUNBOOK §3.2). Or pure shell parsing if jq is unwelcome; jq is cleaner.

**Acceptance:**
- Fresh Pi running `sudo bash setup-station.sh` with a valid `STATION_AGENT_KEY` results in `/etc/bims/station.env` containing `STATION_JWT_SECRET=<base64 string>`.
- A `BIMS_URL` that's unreachable surfaces a clear error message and exits non-zero.
- A wrong `STATION_AGENT_KEY` surfaces "401 unauthorized — check STATION_AGENT_KEY".
- Re-running `setup-station.sh` on an already-registered Pi does NOT clobber `STATION_JWT_SECRET`.
- RUNBOOK Phase 4 ("Register the station with BIMS") collapses from a DevTools recipe to a single sentence: "Already done by `setup-station.sh` in Phase 3."

**Dependencies:** B1.

---

#### Story B3 — RUNBOOK update for self-registration

**Why:** Source of truth is the runbook. Once B1+B2 land, Phase 4 of the runbook is obsolete.

**Files to touch:**
- MOD: `services/bims-capture-agent/RUNBOOK.md`

**Spec:**
- Phase 4 ("Register the station with BIMS") rewrites: replace the DevTools `fetch()` recipe with "Phase 3 already did this via `setup-station.sh`. To confirm, `sudo grep STATION_JWT_SECRET /etc/bims/station.env` returns the line."
- Phase 4 also gets a "Manual re-registration" subsection that documents how to rotate the secret (`curl` with `regenerateSecret: true`).
- Phase 3.4 ("Run setup-station.sh") gets a new prompt: STATION_AGENT_KEY (paste from BIMS Vercel env settings).
- Known-failure-modes gets one new entry: "setup-station.sh fails at registration step — cause is one of (BIMS_URL unreachable, wrong STATION_AGENT_KEY, BIMS deploy on broken commit). Each has a one-line fix."

**Acceptance:**
- A new reader following the runbook end-to-end never has to open browser DevTools.
- The "manual rotation" subsection is testable: `curl -X POST -H "x-station-agent-key: $KEY" -d '{"regenerateSecret":true,...}'` works and the result is documented.

**Dependencies:** B1, B2.

---

### Epic C — Health Monitoring

#### Story C1 — Add heartbeat fields to `CaptureStation` model

**Why:** `lastSeenAt` exists but isn't bumped. Add an `agentReportedAt` field to distinguish operator-initiated `lastSeenAt` writes from agent heartbeats, plus a `health` subdocument mirroring the Pi's `/health` shape.

**Files to touch:**
- MOD: `src/lib/server/db/models/capture-station.ts`

**Spec:**
Add to the schema:
```typescript
agentReportedAt: Date,
health: {
  _id: false,
  cameraOk: Boolean,
  scannerOk: Boolean,
  ledOk: Boolean,
  uptimeS: Number,
  agentVersion: String
}
```
Make sure `_id: false` on the subdocument so it serializes cleanly (see CLAUDE.md pitfall list).

Bump the `status` enum: keep `online | offline | degraded`. Add comment explaining what each one means.

**Acceptance:**
- Schema accepts new fields without breaking existing documents (Mongoose strict mode allows missing fields).
- A Vitest model test inserts a station with the new fields and reads them back.
- `npm run check` passes.

**Dependencies:** none.

---

#### Story C2 — `POST /api/cv/stations/[id]/heartbeat` endpoint

**Why:** Pi periodically reports liveness + health.

**Files to touch:**
- NEW: `src/routes/api/cv/stations/[id]/heartbeat/+server.ts`

**Spec:**
- Method: `POST`
- Auth: `requireStationAgentKey` (A1)
- Body: `{ cameraOk, scannerOk, ledOk, uptimeS, agentVersion }` — same shape as `/health` returns from the Pi.
- Behavior:
  - Validates `params.id` exists in `CaptureStation`. 404 if not.
  - Updates `lastSeenAt`, `agentReportedAt` (both to `new Date()`), `health` subdocument, `agentVersion`.
  - Sets `status`:
    - `online` if cameraOk AND scannerOk
    - `degraded` if at least one of cameraOk/scannerOk is false (but Pi is reachable)
  - Returns `204 No Content`.
- Idempotent — repeated calls produce identical state. No audit log entry (would be too noisy at 30 s cadence).

**Acceptance:**
- Heartbeat from a known station updates `lastSeenAt`, `health`, and `status` as specified.
- Heartbeat for unknown `[id]` returns 404 without mutating state.
- Concurrent heartbeats (race) produce a consistent final state.
- Integration test covers success + 404 paths.

**Dependencies:** A1, C1.

---

#### Story C3 — Pi agent heartbeat timer

**Why:** Counterpart to C2. Send the heartbeat on a 30 s cadence.

**Files to touch:**
- MOD: `services/bims-capture-agent/agent.py`

**Spec:**
- Add an `asyncio` task started in `_on_startup` that loops every `HEARTBEAT_INTERVAL_S` (30 s by default; configurable via env var `HEARTBEAT_INTERVAL_S`).
- Each tick: POST to `${BIMS_URL}/api/cv/stations/${STATION_ID}/heartbeat` with body `{ cameraOk: camera_mod.is_available(), scannerOk: scanner_mod.is_available(), ledOk: False, uptimeS: int(time.monotonic() - _started_at), agentVersion: __version__ }`. Headers: `x-station-agent-key: $STATION_AGENT_KEY`.
- On network error: log at WARNING level with the URL + exception, do NOT crash. Next tick retries.
- On 4xx/5xx: log at WARNING level with the status code + body. Do NOT crash.
- Use `aiohttp` (already a dependency) for the POST.

**Acceptance:**
- Agent log shows a heartbeat-success line every 30 s after startup (`DEBUG` level — `INFO` would be too noisy).
- A heartbeat-failure (BIMS unreachable, key wrong) logs at WARNING but the agent continues running.
- Heartbeat task is cleaned up in `_on_cleanup`.
- Manual smoke test: stop the agent for 2 minutes; BIMS-side `lastSeenAt` is older than 60 s. Start the agent; within 30 s `lastSeenAt` is current.

**Dependencies:** C2.

---

#### Story C4 — `status` stale-derivation read-time

**Why:** `status` should reflect "haven't heard from this Pi in too long" without needing a background job.

**Files to touch:**
- MOD: `src/lib/server/db/models/capture-station.ts` — add a virtual or static method `deriveStatus(doc): 'online' | 'offline' | 'degraded'`.
- MOD: `src/routes/api/cv/stations/+server.ts` (GET) and `src/routes/api/cv/stations/[id]/+server.ts` (GET) — call the derive helper before returning.
- MOD: `src/routes/capture/+page.server.ts` — call it in the load function so the dropdown reflects reality.

**Spec:**
```typescript
const STALE_THRESHOLD_MS = 90_000; // 90 s = 3 missed heartbeats
function deriveStatus(doc): 'online' | 'offline' | 'degraded' {
  if (!doc.lastSeenAt) return 'offline';
  const ageMs = Date.now() - new Date(doc.lastSeenAt).getTime();
  if (ageMs > STALE_THRESHOLD_MS) return 'offline';
  return doc.status; // returns whatever heartbeat set ('online' or 'degraded')
}
```

The function is pure — does NOT write back. Materialization to Mongo is C5's job.

**Acceptance:**
- A station whose `lastSeenAt` is older than 90 s is returned as `offline` from GET endpoints, regardless of its stored `status`.
- A station with fresh `lastSeenAt` returns the stored `status`.
- `/capture` page only shows `online` stations in the dropdown (or shows all with badges — see Epic E).
- Vitest covers all three branches (stale, fresh-online, fresh-degraded).

**Dependencies:** C1, C2.

---

#### Story C5 — Periodic materialization of `status` to Mongo

**Why:** Read-time derivation (C4) is enough for live reads. But for analytics, alerting, and the admin list page filtering, we want the stale state persisted. Run a Vercel scheduled function or a tiny cron-style endpoint hit by an external scheduler.

**Files to touch:**
- NEW: `src/routes/api/cv/stations/sweep/+server.ts` — POST endpoint, auth via `STATION_AGENT_KEY` (reusing the existing key — see Open Question 13.1).
- (Vercel scheduled function config — `vercel.json` or platform UI.)

**Spec:**
- POST `/api/cv/stations/sweep` — iterates all stations, applies `deriveStatus`, writes back to Mongo only when status changes.
- Returns `{ scanned, mutated }` for visibility.
- Schedule: once a minute via Vercel cron, OR documented as "hit this from an external scheduler if Vercel cron isn't available on your plan."
- Logs at INFO when a station transitions (e.g., `station X transitioned online → offline`).

**Acceptance:**
- Manually POSTing the sweep endpoint updates stale stations to `offline` and writes an audit log entry (`action: 'UPDATE'`, `reason: 'health-sweep'`).
- Manual integration test: insert a station with `lastSeenAt = 5 minutes ago`, sweep, confirm status is now `offline`.
- Documented in RUNBOOK that this either runs on Vercel cron OR needs an external pinger.

**Dependencies:** C4. Open Question 13.1.

---

### Epic D — Admin UI

#### Story D1 — `/cv/stations` list page (read-only)

**Why:** First admin surface. Browsable table of every station.

**Files to touch:**
- NEW: `src/routes/cv/stations/+page.server.ts`
- NEW: `src/routes/cv/stations/+page.svelte`

**Spec:**
- Page guarded by `cv:write` or `manufacturing:write` permission.
- Load function: pull all `CaptureStation` documents, apply `deriveStatus` (C4), serialize, return.
- Table columns: name, hostname, status badge, agent version, last seen (relative time, e.g. "8 s ago"), camera ok, scanner ok, current operator, actions (link to detail page).
- Status badge: green dot for `online`, yellow for `degraded`, red for `offline`.
- Auto-refresh the table every 10 s (set-interval, fetch the same load endpoint).
- Empty state: "No capture stations registered. Provision one with services/bims-capture-agent/RUNBOOK.md."

**Acceptance:**
- Logged-in user with `cv:write` sees the page; without → 403.
- Page renders all stations with correct badges.
- 10 s auto-refresh works (verify by killing the agent on one Pi and watching the badge flip within ~90 s).
- Page passes `npm run check`.

**Dependencies:** C4.

---

#### Story D2 — `/cv/stations/[id]` detail page

**Why:** Where edits, force-unlocks, and (eventually) restart-agent actions live.

**Files to touch:**
- NEW: `src/routes/cv/stations/[id]/+page.server.ts`
- NEW: `src/routes/cv/stations/[id]/+page.svelte`

**Spec:**
- Page guarded by `cv:write`.
- Load function: single station + audit log entries for this station (last 50, descending).
- Display: all fields (name, hostname, ipAddress, location, agent version, capabilities, status, lastSeenAt, agentReportedAt, currentOperator).
- Form action `rename`: PATCH `/api/cv/stations/[id]` with `{ name, location }`.
- Form action `forceRelease`: DELETE `/api/cv/stations/[id]/lock` (admin override of operator lock — must surface to audit log with `reason: "admin-force-release"`).
- Form action `regenerateSecret`: POST `/api/cv/stations/register` with `{ ..., regenerateSecret: true }` — actually, this requires the agent key. Better: NEW endpoint `POST /api/cv/stations/[id]/rotate-secret` (session-auth, admin-only) that mints a new secret. Operator must SSH to Pi and update `STATION_JWT_SECRET` — surface a copyable string + the SSH command.
- Form action `delete`: DELETE `/api/cv/stations/[id]` with confirm step.

**Acceptance:**
- Rename persists to DB and shows in the list page after refresh.
- Force-release clears `currentOperator`, writes audit log.
- Regenerate-secret returns the new secret in the response, displayed once (not stored in any UI state after), with a "copy" button and an instruction block.
- Delete removes the station and surfaces a "are you sure" confirmation.
- All form actions write audit log entries.

**Dependencies:** C1, C4. Story D3 (new rotate-secret endpoint).

---

#### Story D3 — `POST /api/cv/stations/[id]/rotate-secret`

**Why:** Admin-initiated jwtSecret rotation, separated from the agent-self-register path.

**Files to touch:**
- NEW: `src/routes/api/cv/stations/[id]/rotate-secret/+server.ts`

**Spec:**
- Method: `POST`
- Auth: session + `cv:write`
- Behavior: mint a new HS256 secret (same `randomBytes(32).toString('base64')` as register), overwrite `jwtSecret` on the station, audit log entry, return `{ jwtSecret }`.

**Acceptance:**
- Authenticated admin → 200 with new secret.
- Unauthenticated → 401.
- Wrong permission → 403.
- Vitest integration test covers all three.

**Dependencies:** none.

---

#### Story D4 — Audit-log surface in detail page

**Why:** Most "what happened to this Pi?" questions are answered by looking at the audit log.

**Files to touch:**
- MOD: `src/routes/cv/stations/[id]/+page.server.ts` — pull `AuditLog.find({ tableName: 'capture_stations', recordId: params.id }).sort({ changedAt: -1 }).limit(50).lean()`.
- MOD: `src/routes/cv/stations/[id]/+page.svelte` — render the entries.

**Acceptance:**
- All admin actions in D2 show up in the detail page audit log.
- Self-registrations show up with `changedBy: "<station-agent-key>"` rendered as e.g. "(agent)".

**Dependencies:** D2.

---

### Epic E — Operator-Facing Polish

#### Story E1 — `/capture` dropdown shows status badges

**Why:** Operators don't pick stations that won't work.

**Files to touch:**
- MOD: `src/routes/capture/+page.server.ts` — return ALL stations, not just online ones. Include `status` and `currentOperator` in the payload.
- MOD: `src/routes/capture/+page.svelte` — render status next to each option, and DISABLE the option when status is `offline`.

**Spec:**
- Status decoration prefix the option label: `🟢 CV station test 1`, `🟡 ...`, `🔴 (offline) ...`.
- Offline options are `<option disabled>`.
- `currentOperator` (if not the current user) decorates the label: `🟢 CV station test 1 (in use by Maria)` and disables selection (same as today's 409 path, surfaced earlier).

**Acceptance:**
- Live test: stop the agent on a Pi; within 90 s, the option in `/capture` shows `🔴` and is disabled.
- Restarting the agent flips it back to `🟢` within 30 s.

**Dependencies:** C4.

---

#### Story E2 — `/capture` station-down banner

**Why:** Operator already had a station selected; it goes down mid-shift. Surface that BEFORE they try to capture.

**Files to touch:**
- MOD: `src/routes/capture/+page.svelte`

**Spec:**
- When the WebSocket closes unexpectedly OR a polling check of the Pi's `/health` fails, surface a yellow banner: "Station {name} went offline at {time}. Pick another station from the dropdown."
- Add a 30 s polling check that hits the station's `/health` (over Tailscale) — IF the operator currently has this station selected.

**Acceptance:**
- Killing the agent surfaces the banner within 30 s.
- Restarting the agent dismisses the banner automatically on next successful poll.

**Dependencies:** C3.

---

### Epic F — Remote Control

#### Story F1 — WebSocket `restart` command from BIMS → Pi

**Why:** "Operator says video is black" — known WebRTC reconnect leak workaround is `systemctl restart bims-capture-agent`. Make it one click.

**Files to touch:**
- MOD: `services/bims-capture-agent/agent.py` — add a WS command handler for `{ cmd: "admin_restart" }` that:
  - Verifies the JWT claim `admin: true` (or `operatorRole === "admin"`).
  - Logs the restart with the operator's claim.
  - Calls `os.execvp("systemctl", ["systemctl", "restart", "bims-capture-agent"])` OR `subprocess.run(["sudo", "systemctl", "restart", "bims-capture-agent"])`. The agent runs as `bims` so needs sudo-without-password for this specific command.
- MOD: `services/bims-capture-agent/bims-capture-agent.service` — N/A; the sudoers entry is separate.
- NEW: `services/bims-capture-agent/sudoers.d/bims-capture-agent` — `bims ALL=NOPASSWD: /bin/systemctl restart bims-capture-agent`. Installed by the setup script.

**Acceptance:**
- An admin-claim JWT can trigger restart via `wss://pi/ws { cmd: "admin_restart" }`.
- A non-admin JWT triggering restart returns `{ event: "error", code: "forbidden" }` and does NOT restart.
- After restart, systemd brings the agent back up within 5 s and the operator's existing WS will close — they need to re-select the station.

**Dependencies:** Existing JWT auth in agent.py. Token endpoint mod (F2) to include `admin: true` claim.

---

#### Story F2 — Token endpoint includes admin claim

**Files to touch:**
- MOD: `src/routes/api/cv/stations/[id]/token/+server.ts`

**Spec:**
- When the requesting user has `cv:admin` permission (or whatever role gates remote control — see Open Question 13.3), include `admin: true` in the JWT claims.

**Acceptance:**
- Admin users get tokens with the claim.
- Non-admin users get tokens without the claim.
- The Pi's `_ws_authenticate` returns the claim in `auth.claims` (it already does — no change there).

**Dependencies:** Open Question 13.3.

---

#### Story F3 — Admin "Restart agent" button on `/cv/stations/[id]`

**Files to touch:**
- MOD: `src/routes/cv/stations/[id]/+page.svelte`
- (Possibly) NEW: a small wrapper endpoint `POST /api/cv/stations/[id]/restart` that mints an admin token, opens a WS to the Pi, sends `{ cmd: "admin_restart" }`, closes. Avoids the operator browser needing to know how to do this.

**Spec:**
- Button only visible to `cv:admin` users.
- Click → POST to the wrapper endpoint → spinner → "Restart command sent" toast on success.
- After 10 s, the page auto-refreshes the heartbeat / uptime fields (uptime should reset to a low number).

**Acceptance:**
- Admin user can click the button and see the Pi restart in journalctl.
- Non-admin user doesn't see the button.
- The audit log records the restart.

**Dependencies:** F1, F2, D2.

---

### Epic G — Auto-Update (Future-Pinned)

**Note:** Scope-creep risk. Documenting here so it's tracked, but defer until Epics A–F land. Sketch only.

#### Story G1 — Pi-side update timer (sketch)

A systemd timer running `git pull && systemctl restart bims-capture-agent` once a day at 03:00 local time. Reports the active commit hash in the heartbeat (`agentVersion` becomes `0.1.0+<short-sha>`).

#### Story G2 — Admin UI shows version drift

Cross-reference each station's `agentVersion` against the latest commit on `bims-capture-agent` to flag drift.

---

## 7. Database Schema Changes

```typescript
// src/lib/server/db/models/capture-station.ts — additions only
agentReportedAt: Date,
health: {
  _id: false,
  cameraOk: Boolean,
  scannerOk: Boolean,
  ledOk: Boolean,
  uptimeS: Number,
  agentVersion: String
}
```

No migrations required — Mongoose accepts documents with missing fields by default. New fields populate as agents heartbeat in.

---

## 8. New / Modified API Endpoints

| Status | Method | Path | Auth | Purpose |
|---|---|---|---|---|
| NEW | POST | `/api/cv/stations/register` | agent key | Pi self-registration |
| NEW | POST | `/api/cv/stations/[id]/heartbeat` | agent key | Pi liveness + health report |
| NEW | POST | `/api/cv/stations/sweep` | agent key | scheduled stale-status materialization |
| NEW | POST | `/api/cv/stations/[id]/rotate-secret` | session, `cv:write` | admin rotates jwtSecret |
| NEW | POST | `/api/cv/stations/[id]/restart` | session, `cv:admin` | admin remote restart |
| MOD | GET | `/api/cv/stations` | session | now applies `deriveStatus` |
| MOD | GET | `/api/cv/stations/[id]` | session | now applies `deriveStatus` |
| MOD | GET | `/api/cv/stations/[id]/token` | session | now includes `admin: true` claim for admins |
| EXIST | POST | `/api/cv/stations` | session | unchanged — kept for backward compat |

---

## 9. Pi-side Changes

| File | Change |
|---|---|
| `agent.py` | Add heartbeat timer task (C3); add `admin_restart` WS command handler (F1). |
| `setup-station.sh` | Prompt for `STATION_AGENT_KEY`; call `/api/cv/stations/register` (B2); install sudoers entry (F1); install jq (B2). |
| `sudoers.d/bims-capture-agent` | NEW. Allows `bims` user to `systemctl restart bims-capture-agent` without password. |
| `RUNBOOK.md` | Phase 4 collapse to single sentence; new "BIMS-side env vars" section; new "Day 2" section for admin operations. |

---

## 10. Security

- `STATION_AGENT_KEY` is shared across all Pis. Rotation requires touching every Pi. Acceptable for now — small fleet. If fleet grows past ~10 stations, switch to per-station keys.
- Self-registration is gated by `STATION_AGENT_KEY` only — no IP allow-list, no signed-payload validation. If the key leaks, an attacker can register fake stations (mostly an annoyance — they can't capture cartridges because the browser still picks the station from the BIMS-rendered dropdown and an attacker-registered station shows in that dropdown to anyone).
- Heartbeat updates write back to Mongo on every call. If the key leaks, an attacker can flood writes — mitigated by adding a 5 s rate limit in C2 (deferred to Open Question 13.2 — likely OK to skip).
- Admin remote-restart requires both an admin BIMS session AND a fresh JWT minted by BIMS — defense in depth.
- jwtSecret rotation is admin-only, audit-logged, and surfaces the new secret in the UI only once.
- TLS termination at the Pi remains Tailscale Serve. Future Cloudflare Tunnel work (not in scope) would let off-tailnet operators connect.

---

## 11. Testing Strategy

| Layer | Story coverage | Notes |
|---|---|---|
| Unit (Vitest) | A1, C1, C4, D3 | Pure logic |
| Integration (with Mongo) | B1, C2, D2 actions, F3 wrapper | Use existing contract-test scaffolding under `tests/contracts/` |
| Pi-side smoke | C3, F1 | Manual: SSH to Pi, run pytest against agent.py heartbeat; run F1 end-to-end against the live BIMS endpoint |
| End-to-end | full provision flow (B2 → D1 → C3 visible in list) | Manual against a real Pi using the runbook |

CI gates: `npm run check`, `npm run test:contracts`. Add a new `npm run test:capture-station` script that runs ONLY the capture-station tests for fast feedback.

---

## 12. Rollout Plan

### Pre-flight (before any code change)

1. Set `STATION_AGENT_KEY` on Vercel (production + preview env separately). Generate with `openssl rand -base64 32`.
2. Add the same key to the existing Pi's `/etc/bims/station.env`.
3. Restart `bims-capture-agent` on the existing Pi (no-op for now; A1 isn't done yet, but verify env loads).

### Epic order

- **Epic A (foundations)** — A1, A2. Land before anything else. Doesn't break production because no endpoints check the key yet.
- **Epic B (self-registration)** — B1 first (additive endpoint). B2 (setup-station.sh) can land alongside; existing already-registered Pi unaffected. B3 (runbook) last.
- **Epic C (heartbeat)** — C1 (schema), C3 (agent timer), C2 (endpoint), C4 (derive), C5 (sweep). C4 is read-time so safe to ship before C3 — existing stations just show as `offline` until heartbeat exists.
- **Epic D (admin UI)** — D3 first (endpoint), then D1, D2, D4 in parallel.
- **Epic E (operator polish)** — E1, E2 after C4/C5 are live. E1 disables offline stations — coordinate with operators so they expect it.
- **Epic F (remote control)** — F1, F2 in parallel, F3 ties them together. F1 requires sudoers entry on every Pi — coordinate.
- **Epic G** — defer.

### Backward-compat checkpoints

After each epic, the live `/capture` flow must work for the existing already-registered Pi. Verification: `RUNBOOK.md` § "Quick-reference checklist" passes.

### Rollback

Every change is additive at the API and schema level. Rollback per epic by reverting the commits:
- A: drop `STATION_AGENT_KEY` from env — endpoints requiring it 401, no impact on existing flows.
- B: revert `setup-station.sh` change — existing Pi unaffected (already registered).
- C: revert agent heartbeat task — `lastSeenAt` stops updating (back to baseline behavior).
- D: just revert the routes — admin UI disappears, no data loss.
- E: revert page changes — dropdown stops decorating, back to today's UX.
- F: revert restart wrapper + agent handler — manual SSH restart still works.

---

## 13. Open Questions

### 13.1 Sweep endpoint auth — agent key or admin?

C5 (`/api/cv/stations/sweep`) is called by Vercel cron, which has no agent identity. Options:
- (a) Reuse `STATION_AGENT_KEY` (any agent or scheduler with the key can sweep). Simple.
- (b) Mint a separate `STATION_SWEEP_KEY` (defense in depth).
- (c) No external key; check `request.headers.get('x-vercel-cron')` (Vercel-specific, opaque, somewhat magical).

Recommendation: **(a)** for simplicity. The sweep is read-mostly and idempotent — leaked key doesn't help an attacker.

### 13.2 Heartbeat rate-limit?

At 30 s cadence across N stations, write load is N/30 writes/s. For N=10 that's 0.33 wps — trivial. Skip rate limiting until N > 100.

### 13.3 Permission for remote restart

F1 / F3 are tagged `cv:admin`. Does that permission exist? If `cv:write` is the only granular gate today, we either:
- (a) Add a new `cv:admin` permission to `src/lib/server/permissions.ts`.
- (b) Reuse `manufacturing:admin` if it exists.
- (c) Hardcode a list of usernames as a stopgap.

Recommendation: **(a)** — clean, follows existing pattern, expanding the permission matrix.

### 13.4 Vercel cron availability

C5 assumes Vercel cron is available on the project's plan. If not, document the external-pinger fallback in the runbook.

### 13.5 Multiple agents on one Pi?

Out of scope. One agent per Pi, period.

---

## 14. Out of Scope / Future Work

- LED control (V1 PRD Phase 4).
- Robot arm integration.
- Per-station agent keys.
- Cloudflare Tunnel as an alternative to Tailscale Serve.
- Cross-org / multi-tenant station isolation.
- Auto-update infrastructure (Epic G — sketched only).
- Pi-side fix for the WebRTC singleton-track leak (V1 PRD).

---

## 15. Story-to-Agent Assignment Hints

For a Claude Code agent team to parallelize, here's how I'd batch:

| Wave | Stories | Reasoning |
|---|---|---|
| 1 | A1, C1 | Pure foundations — no dependencies, no UI |
| 2 | A2, B1, C2, C4, D3 | All depend on wave 1; mostly independent of each other |
| 3 | B2, B3, C3, C5, D1 | depend on wave 2 |
| 4 | D2, D4, E1, F1, F2 | depend on wave 3 |
| 5 | E2, F3 | depend on wave 4 |

Each wave can run agents in parallel; wave-completion gates the next wave. Total estimate: ~5–8 agent-runs end-to-end.

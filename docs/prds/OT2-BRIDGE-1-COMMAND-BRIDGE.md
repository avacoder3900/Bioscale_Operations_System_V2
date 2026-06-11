# OT2-BRIDGE-1 — Command bridge: OT-2 control from the deployed app

**Date:** 2026-06-11 · **Owner:** Jacob · **Status:** Approved (conversation 2026-06-11)

## Problem

Every server-side OT-2 call goes through `src/lib/server/opentrons/proxy.ts`
(`robotFetch` → `http://{OpentronsRobot.ip}:{port}`). Vercel cannot route to the
lab LAN, so all robot control (Start Run, run monitoring, sweep, teach/jog,
health) only works when BIMS runs on a machine on the lab network.

## Decision (Jacob, 2026-06-11)

Outbound-only **command bridge**, generalizing the proven scanner-bridge
pattern. This becomes the standing BIMS IoT control-plane architecture
(robot arm + CV stations migrate later): devices poll BIMS, BIMS never dials
in; heavy realtime streams (video) remain direct browser↔device with
BIMS-minted tokens.

- **One unified daemon per robot** (`scripts/ot2-bridge.py`) replacing
  `scanner-bridge.py`: command long-poll + serial barcode scanner +
  on-robot sweep (OT2-BRIDGE-2). No new hardware — runs on the OT-2's
  internal Pi at `/data/ot2-bridge/`.
- **v1 scope:** filling flows (start run / run monitoring / tip state),
  sweep + deck scan, scanner-position teach + jog, robot health. The
  `opentrons-clone` stack (`maintenance-clone.ts`) stays direct-only.

## Architecture

### Command queue (Mongo)

New model `Ot2BridgeCommand` (`ot2_bridge_commands`):

```
_id: nanoid
robotId: String (OpentronsRobot._id)   // indexed with status+createdAt
deviceId: String                        // ot2-<slot>-bridge convention
kind: 'http' | 'sweep' | 'deck_scan'
request: { method, path, body? }        // kind:'http' — relay to localhost:31950
payload: Mixed                          // kind:'sweep'/'deck_scan' — see BRIDGE-2
status: 'pending' | 'claimed' | 'completed' | 'failed' | 'expired'
result: { status: Number, body: Mixed } // http response from the robot
error: String
ttlMs: Number (default 45000)           // pending→expired if not claimed in time
requestedBy: String
createdAt / claimedAt / completedAt
```

History self-cleans via TTL index on `completedAt` (7 days).

### Agent endpoints (auth: `requireAgentApiKey`)

- `POST /api/agent/ot2/poll` `{ deviceId, waitMs? }` — **long-poll**:
  atomically claim the oldest pending command for this device
  (findOneAndUpdate pending→claimed); if none, re-check every 250 ms for up
  to `waitMs` (cap 20 s; route `maxDuration: 60`). Returns `{ command }` or
  `{ command: null }`. Also expires overdue pending commands.
- `POST /api/agent/ot2/commands/[id]/result` `{ ok, status?, body?, error? }`
  — completes/fails the command.
- `POST /api/agent/ot2/commands/[id]/progress` — sweep slot updates
  (BRIDGE-2); response echoes `{ pauseRequested, cancelRequested }` so the
  daemon honors live control flags.
- Heartbeat: keep `POST /api/agent/scanner/event` `eventType:'heartbeat'`,
  extended `metadata.health` = the robot's local `GET /health` snapshot.

### Transport-aware proxy

`robotFetch` in `proxy.ts` gains a transport switch:

- `OT2_TRANSPORT=direct|bridge|auto` (env). `auto` (default):
  `process.env.VERCEL` → bridge, else direct. Optional per-robot override
  later if ever needed.
- Bridge path: insert `kind:'http'` command → poll the doc every 100 ms up to
  the caller's timeout (default 30 s, matching today's AbortSignal) → map
  `result` back to the same return shape callers see today. Timeout/expiry →
  throw the same error shape as a failed direct fetch.
- All ~49 call sites (run lifecycle, maintenance/jog/teach, health, lights,
  protocols, calibration) inherit with **zero changes**. `maintenance-clone.ts`
  is NOT switched (out of scope).

### Daemon (`scripts/ot2-bridge.py`)

Python (pyserial + requests, same deps as scanner-bridge), threads:
1. **Command loop**: long-poll `/api/agent/ot2/poll`; `kind:'http'` →
   execute against `http://localhost:31950` (adding `Opentrons-Version: 3`
   header as proxy.ts does) → POST result. `kind:'sweep'/'deck_scan'` → BRIDGE-2.
2. **Legacy scanner trigger loop**: unchanged scanner-bridge behavior
   (poll `/api/agent/scanner/triggers`, serial scan, POST event) so the
   per-slot rescan + teach test-scan flows keep working untouched.
3. **Heartbeat** every 10 s with `metadata.health`.

Env: `BIMS_BASE_URL`, `BIMS_AGENT_API_KEY`, `BRIDGE_DEVICE_ID`
(e.g. `ot2-b07-bridge`), `SCANNER_SERIAL_PORT`, `SCANNER_BAUD`,
`OT2_BASE_URL` (default `http://localhost:31950`), poll/timeout knobs.

DeviceId convention: `ot2-<slot>-bridge` derived from robot name the same way
as `ot2-<slot>-scanner` (`sweep/+server.ts:59-65` regex). Store on
`OpentronsRobot.bridgeDeviceId` (new field, defaulted from name) so the
proxy knows where to queue.

### Deployment

`scripts/OT2-BRIDGE-DEPLOYMENT.md` supersedes SCANNER-OT2-DEPLOYMENT.md:
install at `/data/ot2-bridge/`, `.env`, `run.sh`, **systemd unit**
(`ot2-bridge.service`, finally — survives reboot, the known scanner-bridge
gap). Rollout: B07 first (replaces scanner-bridge), then R04/B14.

## Acceptance

- With `OT2_TRANSPORT=bridge` and the daemon running, from the deployed app:
  Start Run executes on the robot, EmbeddedRunController shows live status,
  teach/jog moves the gantry (with tolerable lag), robot health resolves.
- Direct mode (local dev) behaves exactly as today.
- Daemon offline → bridged calls fail with a clear "robot bridge offline
  (last heartbeat X min ago)" error within the timeout, not a hang.
- Command docs are auditable (who, what, when, result) and self-clean after 7 days.
- `npm run check` clean vs baseline.

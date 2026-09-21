# OT2-TAILNET-2 — BIMS direct robot control (tailnet first, queue fallback)

**Date:** 2026-08-17 · **Owner:** Jacob · **Status:** Approved · **Parent:** `OT2-TAILNET-0-PLAN.md` · **Depends on:** TAILNET-1 on at least B07

## Goal

From a tailnet workstation, the interactive robot verbs in BIMS (pause,
resume, cancel, run status/current command, jog/teach, health) hit the robot
directly at `https://<robot>.<tailnet>.ts.net` and complete in ~100 ms. From
anywhere else they behave exactly as today via `Ot2BridgeCommand`. Operators
see no new screens — only faster buttons and a small transport indicator.

## Current path (what we're layering on)

- Browser components call BIMS routes under `/api/opentrons-lab/robots/[id]/…`
  (`EmbeddedRunController.svelte` for play/pause/resume/cancel + status,
  jog/teach pages under `maintenance/[runId]/…`, `robots/health`).
- Those routes call `robotFetch()` in `src/lib/server/opentrons/proxy.ts`,
  which picks transport `direct` (local dev) or `bridge` (Vercel) and, for
  bridge, enqueues + polls `Ot2BridgeCommand` (`BRIDGE_POLL_MS=100`,
  30 s timeout).
- `src/lib/stores/robot-health.ts` is **frozen** (DO NOT MODIFY) — build
  beside it, don't edit it.

## Design

### 1. Data

`OpentronsRobot` (`src/lib/server/db/models/opentrons-robot.ts`) gains:

```
directUrl: String   // e.g. https://ot2-b07.tailf65a70.ts.net — https, no port, no trailing slash
```

Editable on `/opentrons/devices/[robotId]/edit` (existing edit page; add the
field next to `bridgeDeviceId`). Exposed to the client wherever `robotId` is
already passed (run pages, run controller props, jog pages) — the load
functions that already return the robot add `directUrl`.

### 2. Client-side robot client — `src/lib/opentrons/direct-client.ts` (new, browser-only)

```ts
export interface RobotTransport { kind: 'direct' | 'queue'; baseUrl?: string }

// Probe once per robot per page load; cache result ~60 s. GET {directUrl}/health
// with Opentrons-Version header and a 1500 ms timeout. Any failure → 'queue'.
export async function resolveTransport(robot: { _id: string; directUrl?: string }): Promise<RobotTransport>

// Same verbs the BIMS routes expose today, in the same shapes the components
// already consume (so callers change one import, not their logic):
export async function runAction(robot, runId, action: 'play'|'pause'|'stop'): Promise<RunActionResult>
export async function getRun(robot, runId): Promise<RunSummary>            // status, currentCommand, errors
export async function getHealth(robot): Promise<HealthSummary>
export async function jog(robot, maintenanceRunId, axis, distance): Promise<Position>
export async function getPosition(robot, maintenanceRunId): Promise<Position>
```

Each function: `const t = await resolveTransport(robot)`; if `direct`, fetch
`{baseUrl}/runs/{id}/actions` etc. with `Opentrons-Version: *`; on network
error / 5xx **fall back to the queue path for that call** (POST to the existing
`/api/opentrons-lab/...` route) and mark the transport `queue` for the next
60 s. If `queue`, call the existing BIMS route unchanged.

The direct calls are 1:1 with the requests `robotFetch` makes today (same
paths/bodies) — copy them from the corresponding `+server.ts` files; do not
invent new robot API usage.

### 3. Recording intent + outcome in BIMS

Direct calls bypass the BIMS route, so the audit / run-record side effects
those routes perform must still happen. Rule: **the robot is the source of
truth for live state; BIMS records intent and terminal state.**

- New lightweight endpoint `POST /api/opentrons-lab/robots/[id]/runs/[rid]/record`
  `{ action, transport: 'direct', robotStatus, at }` — writes the same
  `OpentronsRunRecord` / `AuditLog` updates the actions route writes today
  (factor the write into a shared server helper so both routes call it).
  Fire-and-forget from the client after a successful direct action; retried
  once; failure surfaces as a non-blocking toast ("robot paused; BIMS record
  will catch up") — the periodic status poll reconciles.
- Status polling: when direct, poll the robot's `/runs/{id}` every 500 ms
  (cheap, LAN); post a `record` only on **transitions** (running→paused,
  →stopped, →succeeded/failed), not every tick. When queue, unchanged.

Start Run stays exactly as today (queue; durable). Not in scope to make it
direct.

### 4. UI

- `EmbeddedRunController.svelte`: swap its fetches for the direct-client
  functions; add a 10-px transport pill next to the robot name —
  `direct` (green) / `queue` (grey, tooltip "direct link unavailable — using
  queue"). Remove nothing else. The pause/auto-resume guards stay; with
  direct status they simply become fast.
- Jog/teach pages: same swap for `jog`, `position`, `move-to`.
- Robots health widget: `getHealth` direct when possible.

### 5. Server

- `robotFetch()` untouched. Add the shared "record run action" helper and
  the `record` route. Add `directUrl` to the robot edit action + validation
  (`https://`, hostname ends with `.ts.net`, no path).
- Permissions: `record` route requires the same permission the actions route
  requires today (`manufacturing:write`); it only writes BIMS records, never
  touches the robot.

## Out of scope

Start Run direct; sweeps/deck-scan (on-robot daemon); opentrons-clone stack;
removing the queue; any change to `src/lib/stores/robot-health.ts`.

## Rollout / flags

- `directUrl` unset ⇒ byte-identical to today. Set it for B07 first.
- Test matrix on a real reagent fill on B07: pause/resume/cancel from a tailnet
  laptop (expect ≤ 500 ms UI acknowledgement, pill = direct); same from a
  non-tailnet device (pill = queue, today's timing); pull the robot's
  Ethernet mid-run on the tailnet laptop → next action falls back to queue and
  the pill flips, no stuck UI.
- Then R04, B14.

## Acceptance

- Direct pause reflected in UI ≤ 500 ms; no "bridge slow" banner on the direct path.
- `OpentronsRunRecord` + `AuditLog` for a direct pause/resume/cancel match what
  the queue path writes (same fields; `transport: 'direct'` added).
- Fallback exercised in the test matrix and behaves like today.
- `npm run check` at baseline (11), unit tests for `resolveTransport` fallback
  logic (mock fetch: healthy → direct; timeout → queue; direct 5xx mid-call → queue for 60 s).
- progress.txt entry + deployment log per CLAUDE.md.

## Estimate

~1 day BIMS work after TAILNET-1 lands on B07 (client ~200 lines, record
route + helper ~100, model/edit ~30, controller swap ~50, tests ~80).

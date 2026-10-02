# OT2-TAILNET-4: BIMS ↔ OT-2 over Tailscale: one protocol, two transports, one switch per robot

**Author:** Alejandro (via Claude Code)  **Date:** 2026-09-25  **Status:** Draft → building
**Priority:** P1. Interactive robot control (pause, resume, cancel, jog, move) pays a Vercel → Mongo → long-poll round trip on every click.
**Parent:** `OT2-TAILNET-0-PLAN.md` (decisions stand). **Replaces:** `OT2-TAILNET-2-DIRECT-CONTROL.md`'s client design (see §7.1 for why). **Depends on:** `OT2-TAILNET-3-FLEET-ONBOARDING.md` S1–S2, which are done for B14.
**Target branch:** `feat/ot2-tailnet-direct` (off master)

---

## 1. Problem Statement

Robot B14 is on the tailnet. `https://ot2-b14.tailf65a70.ts.net` serves its robot API over HTTPS, answers `/health` in about 0.4 s, and accepts browser CORS from every BIMS origin (TAILNET-3 §13). Nothing in BIMS uses it yet.

On Vercel, every BIMS → robot call goes through the Mongo queue (`Ot2BridgeCommand`), which the on-robot daemon long-polls:
- Round trip measured at B14 0.6 s, B07 0.9 s, R04 2.6 s (progress.txt:7202).
- The "bridge slow" banner and the pause/auto-resume races in `EmbeddedRunController.svelte` come from this hop.

Vercel can't join the tailnet. The fast line therefore has to be the **operator's browser → the robot, over the tailnet**, with BIMS still deciding who may use it and still recording what happened.

The user's three requirements:
1. **One clear line per robot.** No path where the same action can silently go one way on one click and another way on the next.
2. **A clear test environment.** B07 and R04 must behave exactly as today.
3. **BIMS pages and databases** to configure, see, and audit the new line.

## 2. Goals

1. For a robot switched to *tailnet*, from a browser on the tailnet, these verbs go straight to the robot:
   - run status and run actions (play, pause, resume, stop);
   - maintenance motion (jog, position, move-to, move-to-well, home, drop-tip).

   Target: the UI acknowledges a pause in under 500 ms.
2. **One implementation of each verb.** The BIMS API route and the browser client call the same function; only the transport differs.
3. **A transport chosen once per page session**, shown to the operator, and never mixed silently.
4. **Robots not switched to tailnet (B07, R04) are byte-identical to today.** Merging to master changes nothing in production until an env var is set there.
5. **Every direct call is recorded** (`ot2_direct_calls`), so the trace the queue gave us isn't lost.
6. **Motion never races daemon jobs.** While a sweep, deck-scan or calibrate-tip is running on a robot, motion goes through the queue.

## 3. Non-Goals

- Moving anything that writes BIMS records or needs the on-robot daemon off the queue (see §4, lines Q1–Q4).
- Vercel servers calling robots (they can't reach the tailnet; no Funnel on robots).
- The legacy `opentrons-clone` stack and the other RAW direct-IP server paths (§4 line X). They're broken on Vercel today; separate fix.
- Changing the daemon, the queue model, Start Run, or the frozen `src/lib/stores/robot-health.ts`.

## 4. Current State: every BIMS ↔ OT-2 line, and where each one goes

Inventory taken from master @ `1b7cda13b` (full detail in the exploration notes behind this PRD). **Line** is the line after this PRD.

| # | Path | Today | Writes BIMS DB? | Line after this PRD |
|---|---|---|---|---|
| D1 | Run status `GET robots/[id]/runs/[rid]`, used by `EmbeddedRunController.svelte:145` and `/opentrons/runs/[runId]` | proxy → queue `kind:http` | no | **Direct** when the robot is tailnet, else queue |
| D2 | Run actions `POST runs/[rid]/actions`, used by `EmbeddedRunController.svelte:233` | proxy → queue | no | **Direct** / queue |
| D3 | Maintenance motion `maintenance/[runId]/{jog,position,move-to,move-to-well,home,drop-tip}`, used by `deck-calibration/+page.svelte` and `scanner-positions/[setId]/+page.svelte` | proxy → queue | no | **Direct** / queue (queue while the robot is busy, §7.6) |
| Q1 | Maintenance open/close `maintenance` POST, `[runId]` DELETE | proxy → queue | **AuditLog** | Queue (BIMS route) |
| Q2 | `load-labware` (reads LabwareDefinition), `pick-up-tip` (writes `studioTip`) | proxy → queue | yes | Queue |
| Q3 | Start/cancel/abort/finish run (`wax-filling` / `reagent-filling` `+page.server.ts`), `force-reset`, protocol upload/sync, health poller + SSE, `run-records/*` actions | proxy → queue | yes | Queue |
| Q4 | Daemon jobs: `sweep`, `deck_scan`, `calibrate_tip`, `auto_resume_run`, `tip_swap_request`, `restart_robot_server`; scanner triggers; heartbeats | `Ot2BridgeCommand` / `ScannerTrigger` / `ScannerEvent` | yes | Queue (unchanged) |
| X | RAW `http://robot.ip`: `/api/opentrons-clone/**`, `/opentrons-clone/[robotId]/**` loads, `robots/[id]/protocols` GET, `protocols/[pid]/deploy`, `/opentrons/{devices/[robotId],runs,protocols}` loads, `scripts/*.cjs` | direct IP (fails on Vercel) | some | **Unchanged; out of scope** |

Key code facts:
- **Transport is chosen per deployment, not per robot.** `src/lib/server/opentrons/proxy.ts:23-27`: `return process.env.VERCEL ? 'bridge' : 'direct';`
- **D1 and D2 are pure passthroughs.** `runs/[rid]/+server.ts:23-25` returns `json(await res.json())`. `actions/+server.ts:19-24` maps `resume → play`, and `:42-55` maps a robot 4xx to `409 {ok:false, conflict:true}` and a 5xx to 502.
- **D3 has real logic.** `maintenance.ts:141-185` `sendMaintenanceCommand` does:
  - builds `?waitUntilComplete=true&timeout=`, with a client abort of `timeout + 10 s`;
  - extracts the error detail as `errors[0].detail` → FastAPI `detail[]` → `message`;
  - **treats HTTP 201 with `data.status==='failed'` as a failure.**

  `jog` maps `leftZ/rightZ → z` (`:274-289`); `moveTo` defaults `forceDirect: true` (`:297-318`); `drop-tip` returns `200 {dropped:false}` on a "no tip" error.
- **The queue serializes per robot** (the daemon runs one command at a time). Direct calls do not.
- **The queue is also the trail.** `Ot2BridgeCommand` keeps each call for 3 days (`ot2-bridge-command.ts:74-75`).
- **Previews share the production Mongo** (`docs/onboarding/INFRA-101-knowledge.md:22-24`). There is no staging DB.
- **Staged-rollout precedent:** `src/lib/server/services/deck-calibration/rollout.ts`, where `DECK_HARDENING_ROBOT_IDS` matches `_id`, name, legacy id, serial or slot token, and unset means off everywhere.
- **No CSP** anywhere, so the browser may call `*.ts.net`. The CV pages already do (`capture/+page.svelte:609`).
- **Robot pickers use `Equipment`**, which shares `_id` with `OpentronsRobot` (`equipment/robots/+page.server.ts:38-60`), so `robotId` works for both.

## 5. Reference / Prior art

- **CV stations:** the browser dials `wss://<station>.ts.net` directly. The hostname is stored on `CaptureStation.hostname`, and a BIMS route gates access (`api/cv/stations/[id]/token`).
- **The robot arm:** the server calls the device via Funnel. That's the pattern *not* to copy for robots.
- **TAILNET-2's design** (direct-client + queue fallback + transport pill). Kept, with two changes: shared verbs instead of copied fetches, and a sticky session instead of per-call fallback.

## 6. Data Model

### 6.1 `OpentronsRobot.connection` (new subdocument, `_id: false`)
```ts
connection: {
  mode: 'queue' | 'tailnet',   // default 'queue'; unset = 'queue'
  directUrl: String,           // https://ot2-b14.tailf65a70.ts.net (validated)
  tailnetHostname: String,     // ot2-b14
  updatedAt: Date,
  updatedBy: String
}
```
B07 and R04 stay unset. Every change writes an AuditLog entry: `tableName:'opentrons_robots'`, `action:'connection_update'`, `oldData`/`newData`.

### 6.2 `Ot2DirectCall` (new collection `ot2_direct_calls`)
```ts
{ _id, robotId, sessionId, verb, method, path, status, ok, latencyMs, error, username, at }
// indexes: {robotId, at:-1}; TTL 3 days on `at`, the same retention as Ot2BridgeCommand
```
The browser posts calls in batches (fire-and-forget) to `POST /api/opentrons-lab/robots/[id]/direct-calls` (`manufacturing:write`, at most 50 rows). The server stamps `username`.

### 6.3 Deployment gate: env `OT2_TAILNET_ROBOT_IDS`
A comma-separated list of robot tokens, matched the same way as `isHardenedRobot`. **Unset = no robot is tailnet in this deployment.**

## 7. Design

### 7.1 One protocol, two transports: `src/lib/opentrons/ot2-protocol.ts` (isomorphic)
```ts
export interface Ot2Transport {
  get(path: string, opts?: { timeoutMs?: number }): Promise<Response>;
  post(path: string, body?: unknown, opts?: { timeoutMs?: number }): Promise<Response>;
}
export type VerbResult = { status: number; body: unknown };   // exactly what the BIMS route returns
export async function runVerb(t: Ot2Transport, verb: Ot2Verb, args: Record<string, unknown>): Promise<VerbResult>;
```
- `runVerb` holds each verb's validation, robot request and response shaping, **moved** out of the route handlers and `maintenance.ts`, not copied.
- **Server transport** (`src/lib/server/opentrons/transport.ts`): `{get: p => robotGet(robot, p), post: (p, b, o) => robotPost(robot, p, b, o)}`. The queue behaves exactly as today.
- **Browser transport:** `fetch(directUrl + path)` with `opentrons-version: 3` (the same header `robotFetch` sends) and a 30 s default abort.
- The routes become auth + `getRobot` + `runVerb(serverTransport(robot), …)` + `json(r.body, {status: r.status})`.
- **Why not TAILNET-2's "copy the fetches into the client":** D3's logic (the failed-201 check, `leftZ→z`, the drop-tip no-tip rule) would exist twice and drift. That drift is the "mixed lines" the user wants gone.

### 7.2 Resolution: `src/lib/server/opentrons/connection.ts`
```ts
resolveRobotConnection(robot) → { transport: 'tailnet'|'queue', directUrl?, reason }
// tailnet iff robot.connection.mode==='tailnet' && valid directUrl && robot ∈ OT2_TAILNET_ROBOT_IDS
```
`reason` is human-readable, for example `"queue — not enabled in this deployment (OT2_TAILNET_ROBOT_IDS)"`, and is shown in the UI.

### 7.3 `GET /api/opentrons-lab/robots/[id]/connection` (`manufacturing:read`)
Returns `{ transport, directUrl?, reason, busy: { kind, since } | null }`. `busy` = a claimed or pending `Ot2BridgeCommand` of kind `sweep`, `deck_scan` or `calibrate_tip` for that robot.

### 7.4 Browser session: `src/lib/opentrons/direct-client.ts`
```ts
const s = await openRobotSession(robotId);   // GET /connection; if tailnet → probe {directUrl}/health (1.5 s)
s.transport            // 'direct' | 'queue' ($state-friendly getter + onChange)
s.call(verb, args, { signal }) → Response    // same status/JSON as the BIMS route, whichever transport
s.retryDirect()        // explicit, operator-initiated
```
- **Sticky.** The transport is fixed at open.
- **On failover** (a direct call throws a network error or times out without a response):
  - the session flips to `queue` **for the rest of the page** and records the reason;
  - that one call is retried through the BIMS route;
  - the UI shows "fell back to queue".
- **Never flips back on its own.** A robot 4xx or 5xx is a robot answer, not a transport failure, so it doesn't fail over.
- **Busy guard.** Before each motion verb, if the cached `busy` (re-read every 5 s while the session is direct) is set, the call goes through the BIMS route (the queue serializes it) and the pill shows amber `busy`.
- **Logging.** Every direct call is queued for `/direct-calls` (flushed every 3 s, and on `pagehide` via `sendBeacon`-style `keepalive`).

### 7.5 What stays on the queue, and why (the line rule)
**If an action writes BIMS state or needs the daemon, it is a BIMS route and goes on the queue. If it only moves or reads the robot, it goes on the robot's line.** Q1–Q4 in §4 are the first kind. D1–D3 are the second.

### 7.6 Collision rule
The queue executes one command at a time per robot. Direct calls could interleave with a running daemon job, so motion defers to the queue while `busy`. Run status and run actions are allowed while busy: they don't move the gantry outside the protocol's own control.

## 8. UX Spec

- **`/opentrons/devices/[robotId]/edit`**, new **Connection** section:
  - Mode (Queue / Tailnet), Direct URL (`^https://[a-z0-9-]+\.tailf65a70\.ts\.net$`), Tailnet hostname.
  - Helper text: "Paste the URL printed by `scripts/ot2-tailnet-provision.sh`. Tailnet also has to be enabled for this deployment (`OT2_TAILNET_ROBOT_IDS`)."
- **`/opentrons/connectivity`** (new; the test-environment view). One row per active robot:
  - DB mode, whether this deployment allows it, the effective transport and reason;
  - bridge heartbeat age;
  - a **live probe from this browser** (✓/✗ plus latency; tailnet robots only);
  - direct calls in the last 24 h (count / errors) and the last 10 calls.
- **Transport pill**, tron tokens, 10 px:
  - `direct` (green), `queue` (grey), `busy` (amber);
  - tooltip = `reason`, plus a "Retry direct" link after a failover.
  - Shown in `EmbeddedRunController.svelte` beside the robot name, and in the deck-calibration studio header.

## 9. Stories

| ID | Story | AC |
|---|---|---|
| **S1** | `connection` subdoc, `connection.ts`, `/connection` route, `Ot2DirectCall` model + `/direct-calls` route | Unit: the resolution matrix (unset / mode-only / env-only / both / bad URL). A B07- or R04-shaped robot → `queue`. |
| **S2** | `ot2-protocol.ts` + server transport; the D1–D3 routes and `maintenance.ts` motion refactored onto it | Unit: `resume→play`; robot 4xx→409 conflict; 5xx→502 detail; maintenance 201+`failed`→502; `leftZ→z`; drop-tip no-tip→200 `{dropped:false}`; validation 400s match today's messages. Same bodies and statuses as before for the same robot responses. |
| **S3** | Edit-page Connection section + AuditLog | Saving mode/URL writes one `connection_update` AuditLog row with old and new values. A bad URL is rejected with a message. |
| **S4** | `direct-client.ts` + `EmbeddedRunController` + pill | Unit: probe ok → direct; probe timeout → queue; a mid-session network error → queue (sticky) + one retry via the route; a 4xx is not a failover; the queue session never fetches off-origin. On hardware, B14 pause acknowledged in under 500 ms with the pill showing `direct`. |
| **S5** | `/opentrons/connectivity` | Shows B14 `tailnet`/direct with latency on a tailnet machine; B07 and R04 `queue` with reason; direct-call counts. |
| **S6** | Deck-calibration studio + scanner-positions motion through the session | Jog/move/position/home/drop-tip on B14 go direct (rows in `ot2_direct_calls`). Open/close, load-labware and pick-up-tip still hit BIMS routes. |
| **S7** | Busy guard | With a B14 sweep running, a studio jog goes via the route and the pill shows `busy`. |
| **S8** | Rollout + logs | Preview env `OT2_TAILNET_ROBOT_IDS=b14`; Production unset. progress.txt entry + deployment log. |

## 10. Open Questions / Risks

- **R1: the robot's CORS echoes any origin.** Any web page open on a tailnet machine could send commands to B14. Mitigations:
  - tailnet ACL: TAILNET-3 S4, **still open; the whole tailnet can reach B14 today**;
  - lab browsers used for BIMS only.
  - *Future:* a small origin-checking proxy on the robot in front of `:31950`.
- **R2: direct calls skip BIMS's per-request permission check at the robot.** BIMS still decides *who learns the URL* (`/connection` needs `manufacturing:read`), the logging route needs `manufacturing:write`, and the tailnet decides who can reach the robot. This is equivalent to today's lab LAN, where anyone on the LAN could hit `:31950`.
- **R3: previews write to production Mongo.** A preview AuditLog, `ot2_direct_calls` row or connection change is real. That's why the gates are env + per-robot and B07/R04 are never touched.
- **R4: Vercel env changes need a redeploy.** The instant kill switch is the per-robot DB mode (Queue).
- **Q1 (user): who gets `manufacturing:write` on the edit page's Connection section?** Currently anyone with `manufacturing:write`. Should it be admin-only?

## 11. Test / Validation Plan

1. `npm run test:unit`: S1, S2 and S4 cases, all green.
2. `npm run check` stays at or below the pre-change baseline.
3. Push → Vercel preview (never the CLI). Set Preview env `OT2_TAILNET_ROBOT_IDS=b14` → redeploy → set B14 Connection on the edit page.
4. Hardware, from `alejandros-pc` (tailnet):
   - `/opentrons/connectivity` shows B14 direct;
   - a real B14 run: pause/resume/cancel with the pill `direct`, under 500 ms;
   - studio jog;
   - `ot2_direct_calls` rows.
5. From a phone off the tailnet: the same page shows `queue`, with today's behaviour.
6. B07 and R04 on the preview: `queue`, zero direct-call rows, heartbeats unchanged.
7. Failover: stop `ot2-tailscale` on B14 mid-session → the pill flips to queue and the next action still works.
8. Production: unchanged until the env is set there.

## 12. Out of Scope
Line X paths; ACLs (TAILNET-3 S4); B07/R04 onboarding (TAILNET-3 S7); the origin-checking proxy (R1 future).

---

## Appendix A — File change map

| Change | Path |
|---|---|
| Add | `src/lib/opentrons/ot2-protocol.ts` (+ `.test.ts`) |
| Add | `src/lib/opentrons/direct-client.ts` (+ `.test.ts`) |
| Add | `src/lib/server/opentrons/transport.ts`, `connection.ts` (+ `.test.ts`) |
| Add | `src/lib/server/db/models/ot2-direct-call.ts` |
| Add | `src/routes/api/opentrons-lab/robots/[id]/connection/+server.ts`, `direct-calls/+server.ts` |
| Add | `src/routes/opentrons/connectivity/+page.server.ts`, `+page.svelte` |
| Add | `src/lib/components/opentrons/TransportPill.svelte` |
| Modify | `models/opentrons-robot.ts`, `models/index.ts` |
| Modify | `src/lib/server/opentrons/maintenance.ts` (motion delegates to `ot2-protocol`) |
| Modify | `robots/[id]/runs/[rid]/+server.ts` (GET), `runs/[rid]/actions/+server.ts`, `maintenance/[runId]/{jog,position,move-to,move-to-well,home,drop-tip}/+server.ts` |
| Modify | `opentrons/devices/[robotId]/edit/+page.server.ts`, `+page.svelte` |
| Modify | `lib/components/manufacturing/EmbeddedRunController.svelte` |
| Modify | `manufacturing/cart-mfg/deck-calibration/+page.svelte`, `deck-calibration/scanner-positions/[setId]/+page.svelte` |

## Appendix B — Reference pointers
- `OT2-TAILNET-0-PLAN.md`, `OT2-TAILNET-2-DIRECT-CONTROL.md`, `OT2-TAILNET-3-FLEET-ONBOARDING.md` (§13 B14 log)
- `src/lib/server/opentrons/proxy.ts`, `maintenance.ts`; `src/lib/server/services/deck-calibration/rollout.ts`
- `scripts/ot2-bridge.py`, `scripts/ot2-tailscale.service`

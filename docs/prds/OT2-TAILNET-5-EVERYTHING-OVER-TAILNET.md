# OT2-TAILNET-5: Every BIMS → OT-2 command over Tailscale

**Author:** Alejandro (via Claude Code)  **Date:** 2026-09-25  **Status:** Draft
**Priority:** P1. The user's goal is "full use of tailscale for anything relating to the opentrons". TAILNET-4 moved the interactive verbs; this PRD moves the rest.
**Parent:** `OT2-TAILNET-4-DIRECT-TRANSPORT.md`, whose pattern this extends and must not break. **Onboarding:** `OT2-TAILNET-3-FLEET-ONBOARDING.md`.
**Target branch:** `feat/ot2-tailnet-everything` (off `feat/ot2-tailnet-direct` until that merges, then off master)

---

## 1. Problem Statement

After TAILNET-4 (branch `feat/ot2-tailnet-direct` @ `3176bf7f2`), a browser on the tailnet reaches B14 directly for:
- run status and run actions;
- every maintenance verb: open, close, load labware, pick-up tip, jog, move, position, home, drop-tip.

The preview test measured jog at 270 ms and position at 74 ms on average, with 0 failures.

Everything else still goes browser → Vercel → Mongo queue → the robot's long-poll:

| Still on the queue | Why it hurts |
|---|---|
| **Start Run** (fill pages) | 4+ robot round trips through the queue. A stale-protocol **re-upload can take up to 110 s, plus up to 120 s to verify**, inside a Vercel action capped at `maxDuration: 60` (wax `+page.server.ts:58`, reagent `:23`). The wax client aborts at 45 s (`wax +page.svelte:407`). Today this can fail half-done. |
| **Cancel / Abort / Finish** (fill pages) | The robot stop and the "which carts were filled" command read go through the queue while the operator waits. |
| **Tip swap, sweeps, deck scan, tip calibration, robot-server restart, scanner test-scan** | These are jobs of the on-robot daemon `ot2-bridge.py`, which is **outbound-only**: "the robot polls BIMS, BIMS never dials in" (`scripts/ot2-bridge.py:6`). No browser can reach them. |
| **Legacy direct-IP pages**: `/opentrons/devices/[robotId]`, protocol list/deploy, `/opentrons-clone/**` | They call `http://robot.ip:31950` from the server, so they are **broken on Vercel today**. |

## 2. Goals

1. For a robot on the tailnet line, **every command BIMS gives an OT-2** travels browser → robot over Tailscale. That covers:
   - run lifecycle, maintenance, and daemon jobs;
   - diagnostics.
2. **BIMS still records everything.** Every mutation keeps its AuditLog and its domain records (`WaxFillingRun`, `ReagentBatchRecord`, `CartridgeRecord`, `OpentronsRunRecord`, `OpentronsScannerSweepRun`, inventory transactions), written by the **same server code** as today.
3. The TAILNET-4 invariants hold:
   - **one implementation per verb**;
   - **one line per page session**, visible in the pill;
   - **two-key gate** (the robot record plus `OT2_TAILNET_ROBOT_IDS`);
   - **B07/R04 untouched until switched**;
   - the queue remains the fallback for computers not on the tailnet.
4. Fix the Start Run timeout class of failure as a side effect. The long protocol upload runs in the browser, not in a 60 s serverless function.

## 3. Non-Goals / what cannot move (and why)

- **Robot → BIMS reports stay robot → Vercel**: the heartbeat, sweep progress, and job results. BIMS runs on Vercel, which is not on the tailnet. The *record* has to reach Mongo through BIMS whatever line carried the *command*. This PRD moves every **command** onto the tailnet. **Reports** keep using BIMS's HTTPS endpoints.
- **Work with no browser in the loop** can't be browser → robot. This covers the in-memory health poller (`health-poller.ts`, a `setInterval` in a serverless process) and any future server-scheduled robot job. §7.6 retires the poller. A real server-initiated need would require the deferred lab gateway (`LAB-GATEWAY-1-DEFERRED.md`).
- **Operator scripts** (`scripts/sync-robot-protocols.ts`, `deploy-*-tipcal-guards.cjs`, …) already run from a lab machine. They only need the tailnet URL instead of the LAN IP (§7.7).
- **No change to the protocol files**, except the tip-swap flag mechanism, which the protocols already poll.

## 4. Current State (explorer inventory of `feat/ot2-tailnet-direct`, 2026-09-25)

### 4.1 Fill-page run lifecycle (wax `+page.server.ts`, reagent `+page.server.ts`)

| Action | Robot calls, in order | BIMS writes |
|---|---|---|
| `startRun` (wax `:952`, reagent `:878`) | `ensureFreshRunProtocol`, which `GET`s `/protocols/{pid}/analyses` and `/analyses/{aid}` and diffs the bundled labware wells against Mongo. If stale, it uploads through `robotUploadProtocol`, a multipart `POST /protocols` of the .py from `OpentronProtocol.fileContent` (≈77–82 KB) plus labware JSON, then waits for analysis. Then `POST /runs {protocolId, runTimeParameterValues}` and `POST /runs/{id}/actions play`. Finally it enqueues `auto_resume_run`. | `OpentronsRobot.protocols` $pull/$push, AuditLog `run_start_auto_resync`, `OpentronsRunRecord.create`, run `$set status:'Running'…`, AuditLog |
| `recordRunFinished` (wax `:1229`, reagent `:1119`), called by `EmbeddedRunController` `onComplete` | `GET /runs/{id}/commands?cursor=0&pageLength=10000`, parsing tip use | `pipetteTipState.after/consumed`. On success: `advanceCartsToWaxFilled` / `finalizeReagentRun` (carts, inventory, equipment usage, AuditLog) |
| `cancelRun`/`abortRun` (wax `:1545/:1632`, reagent `:1271/:1320`) | `stopRobotRun`: `POST /runs/{id}/actions stop`, where 404/409/terminal counts as ok. Wax also runs `cartsFilledPerRobotLog`: up to 5× `GET /runs/{id}/commands?cursor=N&pageLength=999`, parsing `Dispensed …uL into well X#` | run status/reason, cart advance or revert, `hardDeleteUnfinalizedCartridges`, AuditLog, notification |
| `requestTipSwap` (wax `:1727`, reagent `:1408`) | none. It enqueues `tip_swap_request`, and the **daemon writes `/data/ot2-bridge/tip-swap-request.json`**, which the running protocol polls | AuditLog |
| `load` reconcile (wax `:207`, reagent `:140`) | `GET /runs/{id}` at SSR | the finish records, if already succeeded |

### 4.2 Daemon jobs (`scripts/ot2-bridge.py`)

The daemon runs one command worker. Commands are strictly serial, FIFO by `createdAt`.

| Kind | On the robot | Why only the daemon can do it |
|---|---|---|
| `sweep` (`:994`) | maintenance run, per-slot `moveToCoordinates`, **serial barcode scan**, grid search fallback | scanner serial port |
| `deck_scan` (`:1132`) | move + **serial scan** | scanner serial |
| `calibrate_tip` (`:1467`) | probes X/Y against the **calibrator's limit switches over serial** | calibrator serial |
| `tip_swap_request` (`:1619`) | writes/removes a file the protocol polls | robot filesystem |
| `restart_robot_server` (`:1179`) | `systemctl restart opentrons-robot-server` | systemd |
| `auto_resume_run` (`:1212`) | polls `/runs/{id}` 75 s, then `play` on the first un-commanded pause | a safety net that works with no browser open |
| trigger loop (`:1691`) | test-scan on demand (`ScannerTrigger`) | scanner serial |

- **There is no local HTTP server** (no `http.server`, `socketserver` or `bind`).
- The scanner port is shared through `ScannerPort.lock`.
- The robots run Python 3.10; the stdlib `ThreadingHTTPServer` is available with no new dependency.
- *Note:* `calibrator_watch` exists on `feat/deck-frame-calibrator-watch`, not on this branch. When that merges, it joins §7.3's job list unchanged.

### 4.3 Server-initiated
- **Health poller**: 15 s `setInterval`, started by the `robots/health-stream` SSE. Its only consumer is `/opentrons-clone` through the frozen `src/lib/stores/robot-health.ts`. Every other health surface uses the daemon heartbeat (`health.ts`).
- **`vercel.json` crons**: none touch the robots.
- **`run-lifecycle.createAndStartRun`**: no callers.

## 5. Reference / Prior art
- **TAILNET-4's two-half pattern:** robot half in `$lib/opentrons/ot2-protocol` (either line), BIMS half on the server (`maintenance-records.ts`). The queue routes write the record inline. The tailnet line reaches the same writer (`/direct-record`, `/labware/resolve`).
- **CV station tokens:** `/api/cv/stations/[id]/token` issues a JWT the station verifies before the browser may use its WebSocket. That's the model for authorising browser → daemon calls (§7.3).
- **Tailscale serve path mounts:** `tailscale serve --bg --https=443 --set-path=/bridge http://127.0.0.1:31960` puts the daemon beside the robot API on the same HTTPS origin.

## 6. Data Model
- **No new collections.**
  - `ot2_direct_calls` (TAILNET-4) gains `verb` values for the new verbs and the daemon job kinds.
  - `Ot2BridgeCommand` is unchanged; it is still the queue line.
- **New field** `WaxFillingRun.startIntent` / `ReagentBatchRecord.startIntent`: `{ token, requestedAt, requestedBy, line, opentronsRunId?, confirmedAt? }`. This is the crash-safe marker for the two-phase start (§7.1). It is cleared on confirm, and it is read by the reconcile.
- **New env** `OT2_BRIDGE_TOKEN_SECRET`, one per deployment. It is also written on each robot as `/data/ot2-bridge/.env` `BRIDGE_TOKEN_SECRET` (the same secret, installed by the provision script). It signs daemon job tokens (§7.3).

## 7. Design

### 7.1 Two-phase run lifecycle (the fill pages)

Each lifecycle action becomes **server prepare, then robot half (either line), then server confirm**. The server halves are today's code, split at the robot calls; nothing is re-implemented in the browser.

| Action | 1. Server prepare (`?/…Prepare`) | 2. Robot half (new shared verbs) | 3. Server confirm (`?/…Confirm`) |
|---|---|---|---|
| **Start** | Guards, deck binding, RTP values. Writes `startIntent{token}`. Returns `{expectedWells, protocolFile+labwareBundle (only if a resync may be needed), rtp}` | `run.ensureFresh`: the analyses diff (moved from `protocol-freshness.ts`), and on stale `run.uploadProtocol` (multipart `POST /protocols` + wait for analysis). Then `run.create` (`POST /runs`) and `run.action play` | Records the upload, if any (`OpentronsRobot.protocols` + AuditLog `run_start_auto_resync`), `OpentronsRunRecord.create`, run `status:'Running'`, clears `startIntent`, AuditLog. **Tailnet line:** also asks the daemon for `auto_resume_run` over §7.3 |
| **Finish** | — | `run.commands` (`GET /runs/{id}/commands`, paged) and the tip-tracker parse, moved to shared | today's `recordRunFinished` body, given `{finalStatus, tipsParsed}` |
| **Cancel / Abort** | — | `run.stop` (the `stopRobotRun` rules) and, for wax, `run.filledWells` (the `cartsFilledPerRobotLog` parse) | today's cancel/abort body, given `{stopWarning, filledWells}` |
| **Tip swap** | — | daemon job `tip_swap_request` (§7.3) | AuditLog as today |

- **The queue line runs the same three steps inside one server action.** Prepare → `runVerb(serverTransport)` → confirm, so on B07 and R04 there is one code path with no browser change.
- **What the server trusts from the browser:** only robot observations, meaning the run id, the final status, and the parsed tips and wells. The server re-validates their shape and stamps `line:'tailnet'` in AuditLog. The raw parse runs in shared code both lines use.
- **Crash safety for start.** If the page dies between "robot started" and "confirm", `startIntent` is still set. The reconcile then finds the robot's current run (`GET /runs` `links.current`) and confirms it, or clears the intent if nothing is running. The intent is never lost silently: a stale intent older than 10 min is shown on the page as "start interrupted — check robot".

### 7.2 Protocol upload over the tailnet
- **Move `robotUploadProtocol`'s assembly to the server.** The server does the file lookup and labware bundle (hardened: only the referenced loadNames). The multipart POST and the analysis wait go to shared `run.uploadProtocol`, which the browser runs directly.
- **Verify CORS on B14 before building.** The multipart upload (`opentrons-version:*` header) needs a preflight. B14 already echoes any origin (TAILNET-3 §13), but this has to be confirmed for this specific request.
- **The same verb serves** the deck-calibration **Sync** action and `/api/opentrons-lab/robots/[id]/protocols` POST. Both move to the same prepare → robot → confirm shape.

### 7.3 The daemon on the tailnet: `ot2-bridge.py` gets a local job endpoint

- **Local job server.** Add a stdlib `ThreadingHTTPServer` on `127.0.0.1:31960`, mounted by Tailscale at `https://ot2-<slot>.tailf65a70.ts.net/bridge/…` (`tailscale serve --set-path=/bridge`, added to the provision script). Endpoints:
  - `POST /bridge/jobs {kind, payload}` → `{jobId}`;
  - `GET /bridge/jobs/{id}` → `{status, progress, result, error}`;
  - `POST /bridge/jobs/{id}/control {pause|resume|cancel}`;
  - `POST /bridge/scan` for a test-scan;
  - `GET /bridge/health` for the heartbeat body.
- **ONE worker, ONE queue.** Direct jobs go into the same in-process queue as the long-polled `Ot2BridgeCommand`s. Queue and tailnet jobs therefore stay strictly serial on the robot, which keeps the property the queue gave us and removes TAILNET-4's collision "busy" guard for daemon jobs.
- **Same handlers.** The job handlers are today's (`execute_sweep`, `execute_deck_scan`, …), unchanged. Only the entry point is new.
- **Auth, which is required here.** The daemon can restart robot-server and write files.
  - Every `/bridge` request carries `Authorization: Bearer <token>`, a short-lived (5 min) HMAC token from BIMS `GET /api/opentrons-lab/robots/[id]/bridge-token` (`manufacturing:write`).
  - The token is scoped to `{robotId, kinds[], exp}` and signed with `OT2_BRIDGE_TOKEN_SECRET`. This mirrors the CV-station token.
  - The daemon verifies it with stdlib `hmac`.
  - CORS is limited to the BIMS origins: prod, `*-brevitest.vercel.app`, localhost.
- **Reports keep going to BIMS.** Sweep progress still goes to `/api/agent/ot2/commands/{id}/progress`, so `OpentronsScannerSweepRun` keeps working with the browser closed. For a direct job the daemon posts to a sibling endpoint keyed by `jobId`, and **the browser also polls `/bridge/jobs/{id}`** for live progress with no Vercel hop.
- **A sweep or scan started on the tailnet line still gets its BIMS rows first.** The route's prepare half (for example `OpentronsScannerSweepRun.create` + AuditLog) runs on the server; only the command moves.

### 7.4 Pages that call the robot from the server (the "RAW" paths)
- **`/opentrons/devices/[robotId]`** (health, pipettes, runs) and the protocol list: loads move to the browser through the session with read verbs (`robot.health`, `robot.pipettes`, `run.list`, `protocol.list`). The server load stops calling the robot. This **fixes them on Vercel**.
- **`protocols/[protocolId]/deploy`**: becomes §7.2.
- **`/opentrons-clone/**`: moved onto the tailnet and kept as the full Opentrons UI** (decided by the user 2026-09-25; see §7.8).

### 7.8 The Opentrons UI (`/opentrons-clone`) over the tailnet

**Facts (explorer, 2026-09-25).**
- About 5.1k lines: 11 pages, plus 7 `/api/opentrons-clone/**` endpoints, plus `client.ts` (openapi-fetch) and `maintenance-clone.ts`.
- **It writes nothing to BIMS.** There is no AuditLog and no model writes (`maintenance-clone.ts:10`, "no AuditLog — per guardrails").
- Every robot call is a server-side `fetch http://${robot.ip}:31950` (`client.ts:30`), so the whole UI is **broken on Vercel today**.
- Its only server responsibilities are:
  - the BIMS login + `manufacturing:read` gate;
  - the operator-password cookie (`+layout.server.ts`);
  - the robot list from Mongo.

**Design: the UI becomes a browser app on the robot session.**
1. **`$lib/opentrons/robot-client.ts` (isomorphic).** It is today's `createRobotClient` (openapi-fetch + `opentrons-version` middleware) with an **injected `fetch`**:
   - Browser: `session.robotFetch`, i.e. `https://ot2-<slot>.tailf65a70.ts.net` via the tracked direct transport (logged to `ot2_direct_calls`).
   - Queue fallback: a relay fetch (item 3).

   `client.ts` becomes a thin server wrapper over it (scripts and any leftover server use).
2. **Each `/opentrons-clone/[robotId]/**` route turns its `+page.server.ts` into:**
   - a `+page.ts` load with `export const ssr = false`, which calls the robot from the browser through the robot client;
   - client functions for its form actions (upload/delete protocol, create run, run actions, LPC offsets, data files, client data, settings, error recovery, system time).

   The `+layout.server.ts` gate stays on the server, unchanged: BIMS auth plus operator cookie plus the Mongo robot list. The pages keep their markup; only data loading and actions move.
3. **Queue fallback for computers not on the tailnet.** A generic relay, `POST /api/opentrons-lab/robots/[id]/relay {method, path, body}` (`manufacturing:write`; GET-only paths allowed with `manufacturing:read`), runs one `kind:'http'` bridge command. It is the same capability the clone has today, but over the queue.
   - Binary and multipart operations (protocol upload, data-file upload/download, log download) are **tailnet-only**. On the queue line they show "needs Tailscale", except protocol upload, which reuses §7.2's `upload_protocol` bridge kind.
4. **The seven `/api/opentrons-clone/**` endpoints become direct browser calls** through the robot client:
   - downloads use a blob URL from a direct fetch;
   - the LPC maintenance endpoints reuse TAILNET-4's `mx.*` verbs where they match (open/close/labware), plus a generic `mx.command` verb for LPC's arbitrary maintenance commands.

   The endpoints are then deleted.
5. **Health.** The clone's `robot-health` store (frozen; the SSE from the retired poller) is replaced *in the clone's pages* by the session state and `/health` polling. The frozen store file itself is not modified; the clone simply stops importing it.
6. **Pill + permission.** The clone layout shows the TransportPill per robot and the "allow direct" prompt (Chrome Local Network Access), like every other robot page.

**Pre-existing weakness to fix while here (Q4):** the operator gate cookie is the constant `'ok'` (`+layout.server.ts:5-6`), so anyone who sets that cookie passes. Replace it with a signed, expiring session cookie.

### 7.5 The session and the pill
- **One `RobotSession`** covers the robot API (`/`) and the daemon (`/bridge`); both are on the same origin, so there is one permission prompt and one pill.
- The session takes a bridge token lazily and refreshes it before `exp`.
- **Failover rules** (TAILNET-4) extend per verb:
  - `run.create`, `run.uploadProtocol` and daemon job *starts* are **never auto-retried**, because they could run twice;
  - reads and stops are retried.
- **If a daemon job was started on the tailnet line and the line drops**, the job keeps running on the robot. The page reattaches through the BIMS report rows. That's why reports still land in BIMS.

### 7.6 Health
- **Retire the in-memory health poller** (`health-poller.ts` plus the `health-stream` SSE). It can't run reliably on Vercel serverless, and every other surface already uses the daemon heartbeat.
  - `/opentrons-clone` then needs the heartbeat source (Q1).
  - `OpentronsRunRecord.status` progression moves to the lifecycle confirms (§7.1), which already know the status.
- **Browser health** comes from the session (`/health`, `/bridge/health`). The heartbeat stays as the with-no-browser-open truth.

### 7.7 Scripts
Every `scripts/*` that dials `http://<robot>.local:31950` accepts `ROBOT_HOST=https://ot2-<slot>.tailf65a70.ts.net`. The protocol stays https, the port is dropped, and the header is the same. Update `deploy-*-tipcal-guards.cjs`, `sync-robot-protocols.ts`, `upload-local-protocols-to-all-robots.ts`, `list/prune-robot-protocols.ts` and `diag-probe-ot2-protocols.ts`.

## 8. UX Spec
- **The pill is unchanged.** Its tooltip gains a list of "via Tailscale" and "via BIMS queue" verbs for the page.
- **Fill pages:**
  - Start shows steps: "checking protocol → uploading (only if needed) → creating run → running". Each step is labelled with its line.
  - An interrupted start shows the banner from §7.1.
- **Studio / deck pages:** a sweep or scan started on the tailnet shows live per-slot progress from `/bridge/jobs/{id}`, as today's grid does.
- **`/opentrons/connectivity`:** a new "Daemon" column shows `/bridge/health` from this browser (✓ + latency), the daemon version, and whether `/bridge` is served.

## 9. Stories

| ID | Story | AC |
|---|---|---|
| **S1** | Shared run-lifecycle verbs: `run.list`, `run.create`, `run.stop`, `run.commands` (paged), `run.ensureFresh` (analyses diff), `run.uploadProtocol`, plus the tip and filled-well parsers, moved out of the page servers and `protocol-freshness.ts` / `proxy.ts` | Unit: parity with today's route outputs on recorded fixtures, covering the tip-tracker parse, the well parse, the stale-bundle detection, and the 404/409/terminal-stop-is-ok rule. The queue line behaves byte-identically on B07/R04. |
| **S2** | Fill-page **Finish** and **Cancel/Abort** two-phase | On B14 via the tailnet, a real reagent run finishes: carts advance, inventory moves, AuditLog has `line:'tailnet'`, and there are 0 `Ot2BridgeCommand` rows for it. Same for a wax abort, where the filled wells match what the queue path computes for the same run. |
| **S3** | Fill-page **Start** two-phase + `startIntent` + reconcile | A B14 start with a fresh protocol makes 0 queue rows. A forced-stale protocol re-uploads from the browser in under 60 s end-to-end and **no Vercel function exceeds 10 s**. Closing the tab after "creating run" leaves the run confirmed on the next page load. |
| **S4** | Protocol upload for deck-cal Sync and the protocols page | Sync on B14 via the tailnet uploads, analyses, and records the protocol entry and AuditLog. The multipart CORS preflight is verified and recorded. |
| **S5** | Daemon `/bridge` job server, token auth, CORS, one worker queue; provision script adds the serve path | On B14, `curl` without a token → 401; with a BIMS token → a job runs. A queue command and a `/bridge` job submitted together run one after the other, never concurrently. B07/R04 daemons are untouched until redeployed. |
| **S6** | Sweep, deck scan, tip calibrate, tip swap, restart and test-scan through `/bridge` from the session | Each works on B14 from a tailnet browser. `OpentronsScannerSweepRun` and the AuditLog rows are identical to the queue path. The page shows live progress with the Vercel hop removed. |
| **S7** | Device page + protocol list load via the session | `/opentrons/devices/<B14>` shows live health/pipettes/runs **on Vercel** (broken today). |
| **S8** | Retire the health poller + SSE; move `OpentronsRunRecord` status into the confirms | No `setInterval` robot polling remains server-side. Run records still reach terminal states. |
| **S9** | Scripts accept the tailnet `ROBOT_HOST` | `deploy-wax-tipcal-guards.cjs` against `https://ot2-b14.tailf65a70.ts.net` works from `alejandros-pc` off the robot LAN. |
| **S10a** | `robot-client.ts` (isomorphic openapi-fetch, injected fetch) + generic `/relay` + `mx.command` verb | Unit: the same client call produces the same robot request on direct fetch and on the relay. Relay GET needs `manufacturing:read`, and mutating relay calls need `write`. |
| **S10b** | Clone pages ported to `+page.ts` (`ssr=false`) + client actions: robot home, runs, run detail, protocols, protocol detail, labware, data files, settings | On **Vercel**, B14 via the tailnet: every clone page loads live robot data (broken today). Actions (home, lights, identify, upload/delete protocol, create run, play/pause/stop, data-file upload/download, settings) work, and each call lands in `ot2_direct_calls`. |
| **S10c** | LPC page onto the session (`mx.*` + `mx.command`) | A full LPC pass on B14 from a tailnet browser: offsets applied to the run as today. |
| **S10d** | Delete `/api/opentrons-clone/**`; the clone stops importing the frozen `robot-health` store; pill + allow-direct in the clone layout; signed operator cookie (Q4) | A grep for `http://${robot.ip}` / `robotBaseUrl(` in `src/routes` returns nothing. The operator gate rejects a hand-set `ot_operator_auth=ok` cookie. |

## 10. Open Questions / Risks
- **Q1: DECIDED (user, 2026-09-25).** Move `/opentrons-clone` onto the tailnet and keep it as the Opentrons UI (§7.8, S10a–d).
- **Q4: the operator gate cookie is the constant `'ok'`.** Fix it as part of S10d (signed, expiring cookie). The password itself isn't changed.
- **Q2 (user): `tailnet-only` robots?** Once S1–S7 land, should a robot be allowed to *refuse* the queue line? That would make queue use from a computer not on Tailscale an explicit error rather than a slow fallback. It would be a third `connection.mode`. It's the strictest reading of "everything through Tailscale", but a lab PC without Tailscale could then not run that robot at all.
- **Q3: trust boundary on confirms.** The server records robot observations the browser reports, such as tips used and filled wells. Where the stakes are high (cart states, inventory), should the confirm re-read the robot? It can't from Vercel, so the options are either to accept the browser's report or to have the daemon post the same observation independently for a cross-check. Recommendation: the daemon cross-check for `filledWells` only.
- **R1: the robot API is still unauthenticated and echoes any origin.** `/bridge` adds token auth for daemon jobs, but `:31950` itself is still open to any tailnet device. TAILNET-3 S4 (ACLs) remains the control. Consider putting `:31950` behind the same token proxy later.
- **R2: two-phase partial failure.** The robot acts but the confirm fails. The start case is covered by `startIntent`. Finish is idempotent (guarded by `pipetteTipState.after`). Cancel is covered by a retry of the confirm with the same observations, which the server de-duplicates by run id and action.
- **R3: daemon changes need a robot redeploy** (scp + systemctl, TAILNET-3 runbook). Roll out B14 first; B07/R04 keep the old daemon, which is fully compatible, because the queue line is unchanged.
- **R4: the Production env scope.** `OT2_TAILNET_ROBOT_IDS` is currently set for Production *and* Preview, so merging TAILNET-4 switches B14 in production at once. Decide deliberately before the merge.

## 11. Test / Validation Plan
1. Unit tests for every moved verb and parser, with recorded B14 fixtures (`/runs/{id}/commands` pages, analyses).
2. `npm run check` stays at or below the baseline.
3. Daemon: Python unit tests for token verification and the single-worker queue ordering, plus a bench run on B14 (§9 S5).
4. Preview with `OT2_TAILNET_ROBOT_IDS=b14`: a full wax and a full reagent run on B14 from `alejandros-pc`, start → pause → resume → finish. Then one cancel, and one forced-stale start. Afterwards, check:
   - `ot2_direct_calls` covers every step;
   - `ot2_bridge_commands` has **zero** rows for B14 in that window (the daemon's own reports are separate collections);
   - domain records match a queue-line run on R04 done the same day.
5. The same pages from a computer off the tailnet: everything works through the queue at today's speed.
6. B07/R04: no change in behaviour or records. Their daemons are not redeployed until approved.

## 12. Out of Scope
The tailnet ACLs (TAILNET-3 S4, though a strong prerequisite for S5's value), the lab gateway, Flex robots, and changes to protocol logic.

---

## Appendix A — File change map (planned)

| Change | Path |
|---|---|
| Modify | `src/lib/opentrons/ot2-protocol.ts` (run lifecycle verbs, parsers, `run.uploadProtocol`) |
| Modify | `src/lib/opentrons/direct-client.ts` (bridge origin + token, new no-retry verbs, job polling) |
| Add | `src/lib/server/opentrons/run-lifecycle-records.ts` (the BIMS halves split out of the page servers) |
| Modify | `src/routes/manufacturing/cart-mfg/{wax,reagent}-filling/+page.server.ts` (prepare/confirm actions; queue line = both in one action) |
| Modify | `src/routes/manufacturing/cart-mfg/{wax,reagent}-filling/+page.svelte`, `EmbeddedRunController.svelte`, `DeckLoadingGrid.svelte` ×2 |
| Modify | `src/lib/server/opentrons/protocol-freshness.ts`, `proxy.ts` (`robotUploadProtocol` → assembly only) |
| Add | `src/routes/api/opentrons-lab/robots/[id]/bridge-token/+server.ts` |
| Modify | `src/routes/api/scanner/{sweep,deck-scan,calibrate-tip}/+server.ts`, `opentrons-lab/robots/[id]/restart-server` (prepare/record halves) |
| Modify | `scripts/ot2-bridge.py` (`/bridge` job server, token check, shared worker queue) |
| Modify | `scripts/ot2-tailscale.service` / provision script (`serve --set-path=/bridge`) |
| Modify | `src/routes/opentrons/devices/[robotId]/+page.{server.ts,svelte}`, `robots/[id]/protocols`, `protocols/[protocolId]/deploy` |
| Remove | `src/lib/server/opentrons/health-poller.ts`, `api/opentrons-lab/robots/health-stream` (once the clone no longer uses them, S10d) |
| Add | `src/lib/opentrons/robot-client.ts`; `src/routes/api/opentrons-lab/robots/[id]/relay/+server.ts` |
| Modify | `src/routes/opentrons-clone/[robotId]/**`: `+page.server.ts` → `+page.ts` (`ssr=false`) + client actions; `+layout.svelte` (pill); `+layout.server.ts` (signed operator cookie) |
| Remove | `src/routes/api/opentrons-clone/**` (7 endpoints), after S10b–c |
| Modify | `scripts/{deploy-*-tipcal-guards.cjs, sync-robot-protocols.ts, upload-local-protocols-to-all-robots.ts, list-robot-protocols.ts, prune-robot-protocols.ts, diag-probe-ot2-protocols.ts}` |

## Appendix B — Suggested build order
S1 → S2 (Finish/Cancel: smallest, highest value, no daemon change) → S3 (Start + upload; fixes the timeout) → S4 → S10a–b (the Opentrons UI; independent of the daemon, and it fixes a page that is broken on Vercel today) → S5 (daemon, which needs a robot redeploy) → S6 → S7 → S10c–d → S9 → S8.

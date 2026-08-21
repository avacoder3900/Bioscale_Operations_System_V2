# ARM-01: Robot Arm Pi — Connection Health + Task Run Control

**Author:** Alejandro (via Claude Code)  **Date:** 2026-07-29  **Status:** Draft
**Priority:** P1 — the arm-pi is provisioned and publicly reachable, but BIMS cannot see its health and cannot start a task. The connection is proven at the curl level and unexposed at the product level.
**Target branch:** `feat/arm-pi-connection` (off `NEWDEV`)

> Branch note: the arm **client, models and API routes are already on `origin/master`**; `NEWDEV` adds the `jog/` and `calibrate/` pages plus the nav 404 fix (`ba2c37f8`). Because this PRD extends the jog/calibrate-era UI, it branches off `NEWDEV`, not `master`.

---

## 1. Problem Statement

The SO-ARM101 host has moved to a dedicated Raspberry Pi (`arm-pi`) and is on the tailnet. The transport works — but nothing in BIMS reflects that:

1. **BIMS cannot tell you whether the arm is reachable, let alone healthy.** The Robot Arm tab's landing page redirects to `control/`, which surfaces only sessions and recordings. There is no health, no preflight, no port diagnosis, no DRY_RUN indicator. When the arm is misconfigured the operator sees an empty page and a generic "Cannot reach robot-arm Pi" string.
2. **BIMS cannot run a task.** The Pi exposes `GET /tasks` and `POST /tasks/{name}/run`, and has two registered tasks. `src/lib/server/robot-arm-client.ts` wraps **17 Pi endpoints and none of them are the task endpoints.** Task execution is reachable by curl and unreachable from the product.
3. **The configuration is currently wrong in three separate ways** (§4.4), all silent. Nothing in BIMS would tell you.

The goal of this PRD is the smallest slice that makes the connection *legible* and proves BIMS can *command* the arm: a connection panel and a task runner, both landing in the existing Robot Arm tab.

---

## 2. Goals

> **G0 is a hard requirement, not a preference.** Every other goal is subordinate to it, and any design that violates it is rejected regardless of other merits.

**G0 — The arm is controllable from any device that can reach live BIMS.** Phone, tablet, laptop, on the lab floor or off-site, on cellular or any network. The *only* requirements on the client are: it can load the deployed BIMS origin, and the user is logged in with the right permission. No Tailscale client, no VPN, no tailnet membership, no per-device setup, no special browser capability.

1. Surface arm connection state in the existing Robot Arm tab: reachable / unreachable, service version, DRY_RUN state, per-port diagnosis, and the Pi's own `diagnosis` string.
2. Add `listTasks()` and `startTask()` to `robot-arm-client.ts`, matching the existing wrapper conventions.
3. Let an operator with `manufacturing:write` pick a registered task and start it, producing a `RobotArmRun` whose events stream in via the existing webhook.
4. Make the three live misconfigurations (§4.4) impossible to hold silently — either fixed by this work or visibly flagged in the UI.
5. Prove the whole path **from deployed BIMS**, not just from a tailnet-attached dev box.
6. Make the arm pages usable on a phone and tablet, and make concurrent control from multiple devices safe and legible.

## 3. Non-Goals

- No new Mongoose models. Per the operator's direction: *keep what we have and integrate with it.* `RobotArm`, `RobotArmServo`, `RobotArmRun`, `RobotArmDataset` all already exist and are sufficient.
- No live motion. This PRD is specified, built and accepted entirely against `DRY_RUN=true` (§7.4). Live motion is a follow-up, gated on the follower BusLinker being present.
- No migration to the OT-2 command-bridge (poll) architecture. Direct HTTP stays (§7.1).
- No jog/teleop/calibration changes — those pages exist and are out of scope here.
- No new nav entries; `ba2c37f8` already added Arm Jog / Arm Runs / Arm Calib.

---

## 4. Current State

### 4.1 The transport already exists and is the single chokepoint

`src/lib/server/robot-arm-client.ts:14-18`:

```ts
function baseUrl(): string {
	const url = env.ROBOT_ARM_BASE_URL;
	if (!url) throw new Error('ROBOT_ARM_BASE_URL not set in env');
	return url.replace(/\/$/, '');
}
```

Auth and timeout, `robot-arm-client.ts:20-35` — `x-api-key: ROBOT_ARM_API_KEY`, `AbortController` at `opts.timeoutMs ?? 5000`. Every arm page goes through this one function; nothing else dials the Pi.

The wrapped surface (`robot-arm-client.ts:187-254`) is: `getActive`, `getPortStatus`, `stop`, `startTeleop`, `startRecord`, `startReplay`, `preflightReplay`, `getPose`, `jogCartesian`, `resetBacklash`, `reloadJogCalibration`, `setTorque`, `jogJoint`, `listRecordings`, `health`, `getCalibration`, `captureCalibration`, `clearCalibration`.

**There is no `listTasks` and no `startTask`.** That is the functional gap for goal 3.

### 4.2 The return path already exists and is sacred

`src/routes/api/robot-arm/webhook/+server.ts:62` authenticates with `requireAgentApiKey(request)` (`AGENT_API_KEY`), upserts `RobotArmRun` by `runId`, `$push`es events, and maps arm vocabulary to BIMS status (`webhook/+server.ts:41-50`, `success` ⇒ `completed`). Terminal events stamp `endedAt` + `finalizedAt`, after which `applySacredMiddleware(robotArmRunSchema, 'finalizedAt')` (`src/lib/server/db/models/robot-arm-run.ts:55`) blocks mutation and a repeat event returns 409 (`webhook/+server.ts:105-108`).

`RobotArmRun.type` is `enum ['teleop','record','replay','calibrate']`. **A task run is none of these** — see Open Question 10.1.

### 4.3 The Robot Arm tab today

| Route | What it shows | Pi calls |
|---|---|---|
| `robot-arm/+page.server.ts:21` | `redirect(302, '.../robot-arm/control')`; no `+page.svelte` | none |
| `control/+page.server.ts` | `safeActive()`, `safeRecordings()`, `RobotArmDataset.find(...)` (`:41`); actions `startTeleop`, `startRecord`, `startReplay`, `stop` | 6 |
| `jog/+page.server.ts` | pose + active; 2 s `invalidateAll()` poll (`jog/+page.svelte:19`) | 7 |
| `calibrate/+page.server.ts` | active, then calibration (live read skipped while a session owns the bus, `:40-43`); audit-logged | 4 |
| `runs/+page.server.ts` | Mongo only, `RobotArmRun` paginated 50/page | 0 |

The unreachable-Pi state is one static string, `control/+page.svelte:34-38`: *"Cannot reach robot-arm Pi … Check that ROBOT_ARM_BASE_URL is set"*. That is the entire diagnostic surface.

### 4.4 Live state of the Pi — verified 2026-07-29, not assumed

Probed directly this session. All values re-read from the device, not recalled.

**Reachability — working, including the public path:**

| Path | Result |
|---|---|
| `http://100.117.56.74:8000/health` (tailnet) | `{"status":"ok","service":"robot-arm","version":"0.1.0"}` |
| `https://arm-pi.tailf65a70.ts.net/health` (Funnel, public) | same 200 |
| `https://arm-pi.tailf65a70.ts.net/sessions/active` **with** `x-api-key` | `200` |
| `https://arm-pi.tailf65a70.ts.net/sessions/active` **without** key | `401` |
| `https://arm-pi.tailf65a70.ts.net/tasks` | 2 tasks: `cartridge_pick_and_place_relay`, `xyz_calibration` |

`tailscale funnel status` on the Pi: `https://arm-pi.tailf65a70.ts.net → / proxy http://127.0.0.1:8000`. **The Vercel→Pi path is open and auth is enforced.** This is the fact that makes ARM-01 a UI/wiring problem rather than a networking problem.

**Three silent misconfigurations:**

1. **BIMS points at a stray server.** Local `.env` has `ROBOT_ARM_BASE_URL=http://arm-pi:8001`. Port 8001 is **not** the systemd service — `ss -tlnp` shows two uvicorns: pid 1842 on **:8000** (owned by `robot-arm.service`, `systemctl is-active` → `active`) and pid 2962 on **:8001**, a hand-started `uvicorn src.server.app:app --port 8001` up 17h45m. The Funnel proxies :8000. So **local dev and production talk to two different processes competing for one serial bus.**

2. **The running service has stale env.** `~/robot-arm/.env` on the Pi reads `LEADER_PORT=/dev/ttyACM1`, `FOLLOWER_PORT=/dev/ttyACM0`, `DRY_RUN=false`. The *running* service still reports the pre-edit values:

   ```
   "leader_port":  {"ok": false, "configured": "/dev/buslinker-leader", ...}
   "dry_run":      {"ok": true,  "value": true, "detail": "DRY_RUN=true — motion commands are logged, not executed"}
   ```

   The `.env` was corrected; `systemctl restart robot-arm` was never run. **The only thing keeping the arm in dry-run is a service that has not been restarted.** A reboot or restart flips it to live motion — with `FOLLOWER_PORT=/dev/ttyACM0` pointing at a board whose role the Pi's own probe declines to confirm (`"expected_role": null` for serial `5C4C126808`; only `5C4C126959` is identified, as leader on `/dev/ttyACM1`). This is the single most important finding in this PRD and is why §7.4 exists.

3. **Arm events are being posted to a laptop.** Pi `.env`: `BIMS_WEBHOOK_URL=http://100.104.29.116:5176/api/robot-arm/webhook` — the dev workstation's tailnet IP on a local Vite port. Production BIMS receives nothing. Any run started from deployed BIMS will execute and produce **no `RobotArmRun`**.

### 4.5 Two copies of the arm server

`services/robot-arm/` is vendored into the BIMS repo **on `origin/master`** (18 files: `src/server/app.py`, `src/arm/{driver,kinematics,backlash,recordings,telemetry,verified_move,leader_follower}.py`, `urdf/so100.urdf`, …).

The Pi does **not** run it. `~/robot-arm` on the Pi is the standalone `avacoder3900/robot-arm` repo, branch `robot-arm-pi-integration` at `751899a`.

They have diverged: the vendored copy reads `BIMS_ARM_POSE_FILE`, `BIMS_ARM_JOG_CALIBRATION`, `ROBOT_ARM_PROBE_INTERVAL_S` and has no `DRY_RUN`; the deployed copy has `DRY_RUN` and the `/health/preflight` port-diagnosis endpoint this PRD depends on. **`robot-arm-client.ts` is written against whichever of these happens to be deployed, with nothing pinning the contract.** See Open Question 10.3.

---

## 5. Reference / Prior art

- **`docs/prds/PI-STATION-ADMIN-AND-LIFECYCLE.md`** — the shipped CV-station pattern. Its liveness model is directly reusable: `STALE_THRESHOLD_MS = 90_000` and `deriveStatus()` (`src/lib/server/db/models/capture-station.ts:69,87-93`), status derived at read time so the UI stays honest between sweeps. Its *auth* model (`x-station-agent-key`, Pi→BIMS only) is **not** applicable — the arm dials outward, the CV stations do not.
- **`docs/prds/OT2-BRIDGE-1-COMMAND-BRIDGE.md:16`** — names the robot arm as a future migrant to device-polls-BIMS. Explicitly deferred here (§3).
- **`docs/prds/PI-CAPTURE-STATION.md`** §13 (`:341-345`) reserves `CaptureStation.capabilities.robotArm` (`capture-station.ts:46`). Unused; this PRD does not adopt it — the arm is not a capture station.
- **Pi-side `docs/PRD_BIMS_robot_arm.md`** (standalone repo) — phases A–E. This PRD is a narrowed, reality-checked Phase A+B.
- **Pi-side `docs/tailscale.md`** §6 — the Funnel setup that §4.4 confirms is live, though written for the retired `alejandros-pc` host.

---

## 6. Data Model & Source

**No schema additions.** Sources:

| Datum | Source | Persisted? |
|---|---|---|
| Reachability, version, DRY_RUN, port diagnosis | Pi `GET /health/preflight` | No — compute on read |
| Available tasks | Pi `GET /tasks` | No — compute on read |
| Active session | Pi `GET /sessions/active` | No — compute on read |
| Run record + event log | `robot_arm_runs`, written by `/api/robot-arm/webhook` | Yes (sacred) |
| Registered boards / servos | `robot_arms`, `robot_arm_servos` (`scripts/seed-robot-arm.ts`) | Yes |

**Join key:** the Pi's `run_id` → `RobotArmRun.runId` (required, unique, indexed — `robot-arm-run.ts`). `startTask()` returns `run_id`; the webhook upserts on the same value. This is exactly how `trigger-replay/+server.ts:97` already links `WaxFillingRun.armRunId`.

**Compute-on-read, not persist**, for everything from the Pi: a stored copy of "is the arm reachable" is a copy that goes stale the moment the Pi reboots. The CV stations persist `status` only because they have a heartbeat; the arm has none.

---

## 7. Design / Architecture

### 7.1 Keep direct HTTP; do not build a bridge

BIMS→Pi stays a server-side `fetch` through `robotArmFetch`. The usual objection — Vercel functions cannot reach a tailnet — **does not apply**, because the Funnel gives the Pi a public HTTPS origin, verified working in §4.4. Building a poll bridge would be a multi-week rewrite to solve a problem that is already solved.

The cost is honest and worth stating: the Funnel URL is reachable by anyone who guesses it, so `ROBOT_ARM_API_KEY` is the *only* thing between the public internet and the arm. It is a 43-character key and auth is enforced (401 verified). That is acceptable for dry-run; it should be revisited before live motion.

### 7.2 Two new client methods, matching existing conventions

```ts
listTasks(): Promise<{ tasks: ArmTask[] }>
startTask(name: string, body: { lot_id?: string; operator?: string }): Promise<{ run_id: string }>
```

`listTasks` at the default 5 s timeout. `startTask` at **15 s**, matching the precedent set for the slow calibration calls (`robot-arm-client.ts:241,247`) — task startup does hardware preflight on the Pi.

### 7.3 Connection panel — where it goes

`robot-arm/+page.server.ts` currently only redirects (`:21`). Rather than add a fifth sibling page, the connection panel becomes a **component rendered at the top of `control/`**, so the operator sees connection state and the controls that depend on it together. The `+page.server.ts` redirect stays as-is.

The load function calls `/health/preflight` inside the existing `Promise.all` (`control/+page.server.ts:41`) via a `safePreflight()` wrapper following the established `safeActive()` / `safeRecordings()` pattern — a Pi outage must render a degraded panel, never a 500.

### 7.4 Dry-run is an acceptance criterion, not an assumption

Per §4.4(2) the Pi's `.env` already says `DRY_RUN=false`; only an un-restarted service is holding the line. So "we'll just test in dry-run" is not a safe default — it is currently true *by accident*.

Therefore: **the Pi's `.env` must be set to `DRY_RUN=true` and the service restarted (S0) before any story here is tested.** The connection panel renders the live `dry_run` value as a prominent badge — green "DRY RUN" / red "LIVE MOTION" — so this can never again be ambiguous. Story S5 makes the task-start button refuse to submit when `dry_run` is false, until the live-motion follow-up ships the confirm + E-stop.

### 7.5 Run type for a task

`RobotArmRun.type` has no `task` value. Recommendation: **add `'task'` to the enum** — a one-line, additive, non-destructive change that keeps task runs in the same sacred, audited collection as everything else. The alternative (reusing `'replay'`) would corrupt the meaning of the existing filters on `runs/+page.server.ts:11-12`. Flagged as Open Question 10.1 because it touches a sacred model.

### 7.6 Device independence — how G0 is actually achieved

G0 is satisfied by *where the Pi connection lives*, and it is worth stating explicitly because BIMS already contains the opposite pattern.

| | CV capture stations | Robot arm (this PRD) |
|---|---|---|
| Who dials the Pi | The **browser** — `wss://${station.hostname}/ws` (`src/routes/capture/+page.svelte:607`) | The **BIMS server** — `robotArmFetch` (`robot-arm-client.ts:27`) |
| Client must be on the tailnet | **Yes** | **No** |
| Works from a phone on cellular | No | **Yes** |

The capture stations put the device channel in the client, so the operator's browser must resolve a Tailscale FQDN. That design cannot satisfy G0. The arm inverts it: the browser only ever talks to BIMS over ordinary HTTPS, and BIMS — a server with public egress — talks to the Pi over the Funnel origin. The Pi's address, its key, and its tailnet identity are never exposed to the client and never need to be.

**Consequences that follow, and are therefore in scope:**

1. **Nothing client-side may reference the Pi.** No `fetch` to `ROBOT_ARM_BASE_URL` from a `.svelte` file, no Pi hostname rendered into a link or an `<img src>`. Today this holds — every arm page reaches the Pi in its load function or a form action. It must stay a rule, not an accident; §11 adds a grep check to keep it honest.

   > **Amended 2026-08-05 — one sanctioned exception: ARM-02 mode B.**
   > The camera panel may render the Pi's origin into an `<img src>` for a
   > direct MJPEG stream. Proxying every frame through a serverless function
   > costs a round trip per frame, which is the difference between video and a
   > slideshow while someone is jogging the arm.
   >
   > The exception is bounded so the *reason* for the rule survives intact:
   > - It uses **`ROBOT_ARM_PUBLIC_URL`**, a separate variable from
   >   `ROBOT_ARM_BASE_URL`. The private address keeps its original
   >   server-only guarantee; only an origin an operator has explicitly
   >   designated as public is ever emitted.
   > - **Unset means off.** The default is still the proxy, so G0 is unchanged:
   >   a phone on cellular with no tailnet sees the arm exactly as before.
   > - The proxy is a **permanent fallback**, not a bootstrap. Any failure of
   >   the direct path — unreachable host, expired token, dropped stream —
   >   returns the viewer to it.
   > - `ROBOT_ARM_API_KEY` is still never sent. What ships is a camera-scoped
   >   token that cannot move the arm and expires in minutes.
   >
   > What is genuinely given up, and was accepted knowingly: the Funnel FQDN
   > discloses the tailnet name to anyone who can load the arm page. The origin
   > is already publicly reachable — that is what Funnel means — so this is a
   > disclosure of naming, not of access.
   >
   > A §11 grep check must therefore allow `ROBOT_ARM_PUBLIC_URL` in client
   > code while still failing on `ROBOT_ARM_BASE_URL`. (That check remains
   > unwritten; it was never implemented.)
2. **The UI must survive a phone.** "Any device" is not met by a page that renders but cannot be operated. The arm pages are currently near-zero responsive: **1 responsive utility class across all four** (`control` 1, `jog` 0, `calibrate` 0, `runs` 0). Story S7.
3. **Multiple devices can now issue commands at once.** This is new — it was implicitly single-operator when control required a tailnet workstation. Story S8.
4. **Reachability now depends on BIMS's egress, not the operator's network.** A operator on cellular sees exactly what an operator on the lab LAN sees, including failures. Good for consistency; it also means one misconfigured `ROBOT_ARM_BASE_URL` breaks every device at once, which raises the value of the §8.1 panel.

### 7.7 Concurrency: who is holding the arm

With G0, two people on two phones can press Start at the same moment. Three layers, outermost first:

1. **Permission** — `manufacturing:write`, already enforced.
2. **BIMS operator lock** *(new, S8)* — advisory, and **derived, not stored**. There is no lock field and no new collection: the arm is "held" iff there is a `RobotArmRun` with `status ∈ {pending, running}` and no `finalizedAt`. The holder is that run's existing `triggeredBy: { _id, username }`; "since" is its existing `startedAt`.

   This is strictly better than a stored `currentOperator` field. A stored lock is a second source of truth that can disagree with the run log, and `capture_stations.currentOperator` is the cautionary tale — it has no expiry and has to be cleared by hand. A derived lock cannot drift, needs no release path (the terminal webhook event that finalizes the run *is* the release), and cannot strand the arm: if the run is finalized, the lock is gone by construction. Expiry falls out of the same rule — a non-terminal run older than the staleness threshold is treated as abandoned and reported as such, exactly as `deriveStatus` (`capture-station.ts:87-93`) treats a stale `lastSeenAt`.

   Its job is to tell you *who* has the arm and keep two operators from fighting. It is not a safety mechanism.
3. **Pi single-session enforcement** — the real backstop, and it already exists: `_start_or_409` (`app.py:436`) and `_require_bus_free` (`app.py:483`) return **409** if anything holds the bus. The client already normalizes `'robot-arm 409'`.

The lock is deliberately advisory. The Pi is the authority on whether the bus is free, because it is the only party that actually knows — and a BIMS-side lock that pretended otherwise would be a lie during any BIMS/Pi disagreement.

**Stop must be available to everyone.** If any device can start a run, any device with `manufacturing:write` must be able to stop it — including a device that did not start it and does not hold the lock. A stop that respects the lock is a stop that fails when you need it most. `POST /sessions/stop` is already wrapped as `robotArm.stop`.

---

## 8. UX Spec

### 8.1 Connection panel (top of `control/`)

Tron tokens throughout (`var(--color-tron-*)`), matching the sibling arm pages.

```
┌─ ARM CONNECTION ─────────────────────────── [ Refresh ] ─┐
│  ● ONLINE   robot-arm v0.1.0        [ DRY RUN ]           │
│  arm-pi.tailf65a70.ts.net                                 │
│                                                            │
│  Leader    ✓  /dev/ttyACM1   5C4C126959                   │
│  Follower  ✗  not found                                   │
│  Session      idle                                        │
│                                                            │
│  ⚠  Follower BusLinker is not present. Configured          │
│     FOLLOWER_PORT is '/dev/buslinker-follower'.            │
└────────────────────────────────────────────────────────────┘
```

States:

| State | Dot | Body |
|---|---|---|
| Reachable, preflight ok | green | version, DRY RUN badge, per-port rows |
| Reachable, preflight not ok | amber | same, plus the Pi's `diagnosis` string verbatim in a callout |
| Unreachable | red | the configured base URL, the error, and a pointer to `ROBOT_ARM_BASE_URL` |
| `DRY_RUN=false` | — | badge turns red, reads **LIVE MOTION** |

Show the Pi's own `diagnosis` text rather than re-deriving it in BIMS — it already names the exact fix (*"Update LEADER_PORT=/dev/ttyACM1 and restart the server"*), and re-implementing that logic in TypeScript would guarantee the two drift.

No auto-poll. `control/` is an action page; a background poll every 2 s (as `jog/` does) would hammer the Funnel for no benefit. Manual **Refresh** button → `invalidateAll()`.

### 8.2 Task runner (below the connection panel)

```
┌─ RUN TASK ───────────────────────────────────────────────┐
│  Task  [ cartridge_pick_and_place_relay        ▾ ]        │
│        Three-stop cartridge relay — pick from start (A),  │
│        transfer through intermediate (B) with re-grip…    │
│        v0.1.0                                             │
│  Lot   [ (optional)            ]                          │
│                          [ Start task ]                   │
└───────────────────────────────────────────────────────────┘
```

- Select populated from `GET /tasks`; description and version shown for the selected entry.
- **Start task** disabled when: the Pi is unreachable, a session is active (the Pi returns 409 and the client already normalizes `'robot-arm 409'`), or `dry_run` is false (§7.4).
- On success → `redirect(303, '/manufacturing/cart-mfg/robot-arm/runs/{id}')`, matching the existing post-action pattern.
- On 409 → inline "A session is already active — stop it first", with the existing Stop control adjacent.

### 8.3 Run detail

`runs/[id]/` already renders the event log. Task runs need no new page — only that `type: 'task'` renders with a sensible label and is included in the `runs/` type filter whitelist (`runs/+page.server.ts:11-12`).

### 8.4 Control bar — holder + stop, visible on every arm page

Because control can now come from anywhere, every arm page gets a persistent bar showing who holds the arm and an always-live Stop.

```
┌──────────────────────────────────────────────────────────┐
│  ● RUNNING  xyz_calibration · held by avaldez · 0:42     │
│                                          [ ■ STOP ]      │
└──────────────────────────────────────────────────────────┘
```

- **Idle:** `○ IDLE — arm is free`, Stop hidden.
- **Held by you:** normal styling, Stop enabled.
- **Held by someone else:** amber, holder's username and elapsed time, **Stop still enabled** (§7.7) with a confirm reading *"{username} started this run. Stop it anyway?"*
- Sticky to the viewport bottom on small screens, inline on desktop. On a phone this is the one control that must always be one thumb-reach away.

### 8.5 Small-screen behaviour

Targets follow `docs/prds/MOBILE-01-responsive-floor-pages.md`. Mobile-first: base styles for phone, `sm:`/`md:` to widen.

| Element | Phone (<640px) | Desktop |
|---|---|---|
| Connection panel | Stacked rows, full width; port table becomes label/value pairs | Two-column as §8.1 |
| Task runner | Full-width select + full-width Start | Inline |
| Control bar | Sticky bottom, full width | Inline, top |
| Runs list | Card per run (date, type, status) | Table |
| Buttons | **Min 44×44px** touch target | Unchanged |

Jog and calibrate get responsive layout only — no new controls, and no attempt to make per-joint jog pleasant on a phone. Jog on a touchscreen with live motion is a genuinely bad idea and is explicitly not a goal (§12).

---

## 9. Stories

Each is independently shippable and independently testable.

---

**ARM-01-S0 — Correct the Pi configuration** *(ops, no BIMS code; blocks everything)*

Three fixes on `arm-pi`: set `DRY_RUN=true` in `~/robot-arm/.env`; `systemctl restart robot-arm` so the corrected port config actually loads; kill the stray pid on :8001 (`ss -tlnp` to re-confirm the pid — do not reuse the one recorded here) and confirm nothing respawns it. Repoint `BIMS_WEBHOOK_URL` at the production BIMS origin. Repoint local `.env` `ROBOT_ARM_BASE_URL` from `:8001` to the systemd service.

**AC:** `GET /health/preflight` on :8000 reports `dry_run.value === true` **and** `leader_port.ok === true`; `curl :8001/health` fails to connect; a webhook POST from the Pi lands in production `robot_arm_runs`; exactly one uvicorn in `ss -tlnp`.

---

**ARM-01-S1 — `listTasks()` + `startTask()` in the client**

Add both to `robot-arm-client.ts` with `ArmTask` / `ArmStartTaskResponse` types, following the existing wrapper style. `startTask` at `timeoutMs: 15000`.

**AC:** `npm run check` clean on the file; a scratch server-side call returns both registered task names; a call with a bad task name surfaces as a normalized `robot-arm 404`, not an unhandled throw.

---

**ARM-01-S2 — `safePreflight()` in the `control/` load**

Extend the `Promise.all` in `control/+page.server.ts:41` with a `safePreflight()` following `safeActive()`. Returns `{ preflight, preflightError }`.

**AC:** with the Pi up, `preflight` is populated and `preflightError` null; with `ROBOT_ARM_BASE_URL` pointed at a dead host, the page still renders 200 with `preflightError` set and no 500 in the server log.

---

**ARM-01-S3 — Connection panel component**

Build §8.1 as a component in `src/lib/components/`, rendered at the top of `control/+page.svelte`. All four states styled with tron tokens. Pi `diagnosis` rendered verbatim. Manual refresh via `invalidateAll()`.

**AC:** all four states reachable in a Vercel preview — green with follower absent (today's real state), amber with a bad `LEADER_PORT`, red with a dead base URL, and the red **LIVE MOTION** badge when `dry_run` is false. Panel never crashes on a partial/absent preflight payload.

---

**ARM-01-S4 — `'task'` in the run type enum** *(gated on Open Question 10.1)*

Add `'task'` to `RobotArmRun.type` (`robot-arm-run.ts`), to the webhook's type inference (`webhook/+server.ts`), and to the `runs/` filter whitelist (`runs/+page.server.ts:11`).

**AC:** a webhook event for a task run creates a `RobotArmRun` with `type: 'task'`; it appears in `runs/` and is selectable in the type filter; existing runs are untouched (non-destructive — enum widening only).

---

**ARM-01-S5 — Task runner UI + `startTask` action**

Build §8.2. New `startTask` action in `control/+page.server.ts` under `requirePermission(locals.user, 'manufacturing:write')`, writing an `AuditLog` entry (`tableName`/`recordId`/`action`/`oldData`/`newData`/`changedBy`/`changedAt`) mirroring the calibrate page's precedent. Disabled states per §8.2.

**AC:** selecting `xyz_calibration` and pressing Start returns a `run_id`, redirects to the run detail page, and the run shows streamed events with a terminal status. Starting while a session is active shows the inline 409 message and creates no run. Start is disabled when `dry_run` is false. An `AuditLog` row exists for every start.

---

**ARM-01-S6 — Prove it from deployed BIMS**

Set `ROBOT_ARM_BASE_URL` (Funnel URL) and `ROBOT_ARM_API_KEY` in Vercel for the preview environment. Run S5's flow from the deployed preview, not from a tailnet dev box.

**AC:** a task started from the Vercel preview URL, on a machine **off** the tailnet, produces a `RobotArmRun` with events and a terminal status. This is the acceptance criterion for the PRD as a whole.

---

**ARM-01-S7 — Responsive arm pages** *(G0)*

Apply §8.5 to `control/`, `runs/`, `runs/[id]/`, `jog/`, `calibrate/`. Mobile-first Tailwind, tron tokens unchanged, 44×44px minimum touch targets. No control changes — layout only.

**AC:** at a 390×844 viewport, every arm page renders with no horizontal scroll and no clipped or overlapping controls; the connection panel is fully readable; Start and Stop are both tappable without zooming. Desktop layout is visually unchanged from before the story.

---

**ARM-01-S8 — Operator lock + stop-from-any-device** *(G0)*

Add `deriveArmHolder()` in `src/lib/server/robot-arm-lock.ts` implementing the **derived** lock of §7.7 — one indexed query for a non-terminal `RobotArmRun`, returning `{ holder, since, runId, stale }` or null. **No schema change, no new collection, no write path.** The existing `{status, createdAt:-1}` index on `robot_arm_runs` covers the query. Surface it via the control bar (§8.4) on every arm page. Stop is available to any `manufacturing:write` user regardless of holder, with the §8.4 confirm, writing an `AuditLog` naming both holder and stopper.

**AC:** device A starts a task; device B (different user, different network) loads the page and sees `held by <A's username>` with elapsed time; B presses Stop, confirms, and the run reaches a terminal status; an `AuditLog` row records both usernames. Two simultaneous starts result in exactly one run — the loser sees the inline 409 message, not a second `RobotArmRun`. Killing the browser session that started a run does not strand the arm: the run is either finalized by the Pi's terminal event or reported `stale`, and the arm shows as free either way. Zero writes are attributable to the lock itself — verified by diffing the collection before and after a lock read.

---

## 10. Open Questions / Risks

**Questions for the operator:**

- **10.1 — Widen the sacred enum, or not?** S4 adds `'task'` to `RobotArmRun.type`. Enum widening is additive and non-destructive, but `robot_arm_runs` is sacred (`applySacredMiddleware`, `robot-arm-run.ts:55`) and I would rather not touch it without a nod. Alternative is a separate collection for task runs, which fragments the run log. **Recommendation: widen the enum.**
- **10.2 — What is the Funnel's exposure budget?** The arm's public HTTPS origin is guarded by one API key. Fine for dry-run. Before live motion, is the intent to (a) accept it, (b) drop the Funnel and require operators on the tailnet, or (c) put Cloudflare Access in front? This changes whether live motion is a config flip or an architecture change.
- **10.3 — Which arm server is authoritative?** §4.5: `services/robot-arm/` on `master` has diverged from what the Pi runs. Options: delete the vendored copy and treat the standalone repo as the source of truth; or make the Pi deploy from `services/robot-arm/`. **Recommendation: delete the vendored copy** — it is dead code that reads like a contract. Not in this PRD's scope either way, but it should be decided.
- **10.4 — Should `lot_id` be required?** §8.2 has it optional. If arm runs must be traceable to a lot for DHR purposes, it should be required and validated against real lots. Currently `RobotArmRun.lotId` is an unvalidated indexed string.

- **10.5 — G0 widens who can move lab hardware, and from where.** Any BIMS user with `manufacturing:write`, on any device, on any network, can now command the arm. That is precisely what was asked for, and it is worth naming the consequence: physical actuation is now reachable by anyone holding a BIMS session, from anywhere. The mitigations available are (a) leave it at `manufacturing:write`, (b) introduce a narrower `robot_arm:operate` permission so arm control is grantable independently of the rest of manufacturing, or (c) require re-authentication for a start while `dry_run` is false. **Recommendation: (a) for dry-run now, (b) before live motion.** This is a policy call, not a technical one.

**Risks:**

- **A restart flips the arm to live motion.** §4.4(2). Mitigated by S0 and the §8.1 badge, but until S0 lands, *any* reboot of `arm-pi` arms live motion with an unverified follower port. This is the highest-severity item in this document.
- **Two servers, one serial bus.** The stray :8001 process can hold the bus and make :8000's commands fail with a confusing 409. S0 removes it.
- **The Funnel hostname is not permanent.** Renaming the tailnet node or the machine re-issues the cert and changes the URL, breaking `ROBOT_ARM_BASE_URL` in Vercel. Worth a note in the runbook.
- **5 s default timeout vs. a cold Pi.** If `/health/preflight` enumerates serial ports slowly under load, the panel will show "unreachable" when the arm is merely busy. If this shows up in testing, raise `safePreflight`'s timeout rather than widening the global default.
- **G0 makes BIMS's egress a single point of failure for every device at once.** Previously a broken arm connection affected whoever was at the tailnet workstation. Now one wrong `ROBOT_ARM_BASE_URL` in Vercel takes out phone, tablet and desktop simultaneously. The §8.1 panel is the mitigation — it names the configured URL and the error rather than saying "cannot reach".
- **A stale operator lock could strand the arm.** This has real precedent in this codebase: `capture_stations.currentOperator` never auto-expires and has to be cleared by hand. S8's AC explicitly requires expiry so the arm does not inherit that bug.
- **No heartbeat means no history.** BIMS only knows the arm's state at page load. Acceptable for now; a heartbeat + `deriveStatus` (CV-station pattern) is the natural follow-up if "was the arm up at 3am?" ever becomes a question.

---

## 11. Test / Validation Plan

1. `npm run check` — no new errors. Baseline on `NEWDEV` is **46 errors / 434 warnings** (recorded in `ba2c37f8`); this must not grow.
2. Local dev against the Pi over the tailnet: all four panel states (§8.1), forced by editing `ROBOT_ARM_BASE_URL` and the Pi's `LEADER_PORT`.
3. Vercel preview deploy — never a local `vercel deploy`. Expect the usual spurious `failure` status before `success`.
4. **Real-data parity:** run `xyz_calibration` from the preview and diff the resulting `RobotArmRun.events` against the Pi's own `logs/<date>.jsonl` for the same `run_id`. Every event in the local JSONL must be present in Mongo — that proves the webhook path is lossless, including the retry queue.
5. Off-tailnet check (S6): start a task from a machine with Tailscale disabled. This is the only test that actually exercises the production path.
6. Negative: stop the `robot-arm` service mid-run, confirm BIMS renders the unreachable state and the run is left non-terminal rather than falsely completed.
7. **G0 acceptance — the test that matters.** From a **phone on cellular, with Wi-Fi off and no Tailscale installed**, load the deployed BIMS, log in, open the Robot Arm tab, read the connection panel, start `xyz_calibration`, watch events arrive, and stop it. If any step needs tailnet access, G0 is not met and the PRD is not done.
8. **Multi-device concurrency (S8):** phone and desktop, two different users. Simultaneous starts → exactly one run. Stop from the device that did not start it → run terminates.
9. **Client-purity check (§7.6.1), as a grep in review:** no `.svelte` file may reference `ROBOT_ARM_BASE_URL` or the Pi hostname. `grep -rE "ROBOT_ARM_BASE_URL|tailf65a70|arm-pi" src/**/*.svelte` must return nothing.

---

## 12. Out of Scope

Touch-optimised jog (layout only per S7 — per-joint jog from a phone with live motion is explicitly not a goal); offline/PWA support — G0 requires *any network*, not *no network*; real-time push of arm state between devices (the control bar reflects state at load and on action, not via WebSocket); a narrower `robot_arm:operate` permission (10.5); live motion and E-stop; follower BusLinker bring-up; jog/teleop/calibration changes; the OT-2-style command bridge; arm heartbeat + status history; dataset/HF-Hub work; per-servo inventory UI (`robot_arm_servos` is seeded but unsurfaced); resolving the `services/robot-arm/` divergence (10.3); lot-linkage enforcement (10.4).

---

## Appendix A — File change map

**Modify**

| Path | Change |
|---|---|
| `src/lib/server/robot-arm-client.ts` | `listTasks()`, `startTask()`, `ArmTask` / `ArmStartTaskResponse` types (S1) |
| `src/routes/manufacturing/cart-mfg/robot-arm/control/+page.server.ts` | `safePreflight()` + `listTasks()` in the load; `startTask` action with AuditLog (S2, S5) |
| `src/routes/manufacturing/cart-mfg/robot-arm/control/+page.svelte` | Render connection panel + task runner (S3, S5) |
| `src/lib/server/db/models/robot-arm-run.ts` | Add `'task'` to the `type` enum (S4, gated on 10.1) |
| `src/routes/api/robot-arm/webhook/+server.ts` | Infer `type: 'task'` (S4) |
| `src/routes/manufacturing/cart-mfg/robot-arm/runs/+page.server.ts` | `'task'` in the type whitelist, line 11 (S4) |
| `.env.example` | Replace the stale `alejandros-pc` guidance with the `arm-pi` Funnel URL |
| `.../robot-arm/{control,jog,calibrate,runs,runs/[id]}/+page.svelte` | Responsive layout per §8.5 (S7) |
| `.../robot-arm/{jog,calibrate,runs}/+page.server.ts` | Surface lock state for the control bar (S8) |

**Add**

| Path | Purpose |
|---|---|
| `src/lib/components/RobotArmConnectionPanel.svelte` | §8.1 (S3) |
| `src/lib/components/RobotArmControlBar.svelte` | §8.4 — holder + always-live Stop (S8) |
| `src/lib/server/robot-arm-lock.ts` | `deriveArmHolder()` — derived advisory lock, read-only (§7.7, S8) |

**Ops (no repo change)**

| Target | Change |
|---|---|
| `arm-pi:~/robot-arm/.env` | `DRY_RUN=true`; `BIMS_WEBHOOK_URL` → production BIMS (S0) |
| `arm-pi` systemd | `systemctl restart robot-arm`; kill the stray :8001 uvicorn (S0) |
| Local `.env` | `ROBOT_ARM_BASE_URL` off `:8001` (S0) |
| Vercel env | `ROBOT_ARM_BASE_URL`, `ROBOT_ARM_API_KEY` (S6) |

**Remove** — nothing.

---

## Appendix B — Reference pointers

- `src/lib/server/robot-arm-client.ts` — the single transport
- `src/routes/api/robot-arm/webhook/+server.ts` — the return path
- `src/lib/server/db/models/robot-arm-run.ts` — sacred run log
- `src/lib/server/db/models/capture-station.ts:69,87-93` — `STALE_THRESHOLD_MS` + `deriveStatus`, the liveness pattern to copy if a heartbeat is ever added
- `docs/prds/PI-STATION-ADMIN-AND-LIFECYCLE.md` — shipped Pi lifecycle PRD
- `docs/prds/OT2-BRIDGE-1-COMMAND-BRIDGE.md` — the poll-bridge alternative, deferred
- Standalone Pi repo `avacoder3900/robot-arm`, branch `robot-arm-pi-integration` — `docs/PRD_BIMS_robot_arm.md`, `docs/tailscale.md`, `deploy/pi/`
- `scripts/seed-robot-arm.ts` — seeds `robot_arms` + `robot_arm_servos`

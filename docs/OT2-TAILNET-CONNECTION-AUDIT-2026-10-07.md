# OT-2 connection ecosystem audit — Tailscale era (2026-10-07)

**Scope:** every line between BIMS, the three OT-2 robots, the on-robot daemon, the gantry/bench barcode scanners and Mongo, five days after Tailscale became the default line for all three robots (2026-10-02). Read-only: nothing was changed on the robots or in Mongo. Evidence = repo at master `71897356`, Mongo (prod), SSH to all three robots over the LAN, curl over the tailnet from the lab iMac (`imac-1`), and the R04/B07/B14 journals for today.

**Question asked:** now that Tailscale is core, what is stale, what should be challenged, and would we have built this differently from the ground up?

---

## 0. Verdict in six lines

1. **The tailnet transport itself is fine.** Robot API over Tailscale with a kept-alive HTTP/2 connection costs 70 ms per call, the same as the LAN. Latency spikes we see are WiFi, not Tailscale.
2. **All three robots are on WiFi.** `eth0` is down on B07, R04 and B14. Every "direct" call is still PC → access point → robot WiFi → WireGuard. The daemon's own reports to Vercel time out several times a day on every robot. Plugging in Ethernet is the highest-leverage change available and needs no code.
3. **Today's R04 "hang" was not a transport failure.** It was three code-level problems compounding: run creation on a Pi 3 takes 20–30 s against a 30 s browser timeout; the start sequence can run twice and create two robot runs; and a stale "busy" flag pinned the page to the slow queue for exactly 30 minutes. Plus a three-day-old browser tab hammering R04 through the queue (10,000 requests in 36 h).
4. **The queue (`Ot2BridgeCommand`) is now a liability, not a safety net.** On a tailnet robot it only carries fallbacks, page-load reconciles and zombies, but it still competes with real jobs on the daemon's single worker and it hides failures as slowness.
5. **If rebuilt with Tailscale as core**, the run supervisor would live on the robot (the daemon), not in the browser tab. Tailscale makes the daemon directly reachable, so the browser could be a viewer. Today the browser is the supervisor, which is why a closed tab, a double click or a 30 s timeout can strand a run.
6. **No rewrite is needed to get most of the value.** Section 6 lists eight changes, each small, ordered by payoff.

---

## 1. What actually happened on R04 today (UTC, reconstructed)

Sources: `ot2_direct_calls`, `ot2_bridge_commands`, `reagent_batch_records`, R04 `journalctl -u ot2-bridge / opentrons-robot-server / ot2-tailscale`, `journalctl --list-boots`.

| Time | Event | Evidence |
|---|---|---|
| since 10-04 21:11 | A browser somewhere polls `GET /runs/73340b87…` (a **wax run that completed on 10-05**) through the **queue**, ~250–450 times per hour, nonstop. 10,250 polls in the last 36 h; 6,093 handled by R04's daemon today alone. | `ot2_bridge_commands` per-hour counts; `requestedBy` is never stamped on queue commands so the machine cannot be identified from Mongo |
| 16:00–16:25 | Samantha starts reagent run `b389e08a` on R04 over the tailnet. `run.create` takes **25.8 s**. Several pause/resume. Stopped at 16:25 ("run got screwed up mid run"). | session `bbb0263f` |
| 16:26:59 | New start. `POST /runs` (run.create) sent. | session `7e7769d9` |
| 16:27:04 | **The start sequence runs a second time** 5 s later (two more `ensureFresh` reads, a second `POST /runs`) while the first is still in flight. | same session, two `run.create` rows |
| 16:27:29 / 16:27:34 | Both creates hit the **30 s browser timeout** ("signal timed out"). Robot log shows two run creations and `RunConflictError: Current run is not idle or stopped`. The session falls back to the queue (sticky) and shows "Direct link lost during run creation… NOT retried (it may have happened)". | `ot2_direct_calls` status 0; robot-server journal |
| 16:32–16:35 | Operator: force reset ×2. `DELETE /runs/b389e08a` via the queue expires at 30 s (robot busy). `GET /runs` returns 502. | queue rows |
| 16:36:12, 16:38:11 | Operator: restart robot-server ×2 via the queue. | `restart_robot_server` by Samantha |
| **16:36:36** | **R04 is power-cycled** (new boot). Robot-server back at 16:38:43. | `journalctl --list-boots`; `uptime` |
| 16:41:48 | New start: `ensureFresh` takes 9.9 s (robot still warming). | session `6e448365` |
| 16:41:58 | **Start sequence runs twice again** (second `ensureFresh` pair). | same session |
| 16:42:00.2 / 16:42:00.8 | Two concurrent `POST /runs`. One gets **HTTP 500** (RunConflict; the browser sees "Failed to fetch" because the 500 carries no CORS header) and the other 201. The 500 is a network-class error → **session falls back to the queue**. | robot-server: `POST /runs 500` then `201` |
| 16:42–17:12 | The run (`6a950177`) executes fine, but the page polls it **through the queue** at ~3 s per poll (418 queue rows) and stays there for **30 min 35 s**, which is `BRIDGE_BUSY_MAX_AGE_MS` + one recovery window. Direct polling resumes at 17:12:35 on the same session. | `ot2_direct_calls` gap 16:42→17:12 on session `6e448365`; `direct-client.ts:261` |
| 18:26–18:41 | Second run (`43fb0bcb`) starts cleanly: create 22 s, `/bridge` sweep + auto-resume work, completes. Twelve `run.get` spikes > 3 s (max 12.5 s) during the run = WiFi. | session `b864b4ea` |
| all day | Daemon → Vercel: 9 outbound timeouts/DNS failures today (19 yesterday). B14: 12 today. B07: 3. | journals |

**What the operator saw:** a start that "hung", a run that "got screwed up", a robot that "needed a reboot", then a run that worked but felt slow. **Root causes, in order of weight:** (1) run.create timeout too short for a Pi 3; (2) the start flow can be invoked twice; (3) the failover is sticky and recovery is blocked by a stale busy flag; (4) a zombie tab loading the daemon's single worker; (5) WiFi.

---

## 2. Physical and network layer (measured today)

| Measurement | Result |
|---|---|
| Link type, all three robots | `eth0` **down**, `wlan0` up. Signal −48 to −50 dBm, 65–72 Mbit. (B07's eth0 is known dead hardware; R04 and B14 show the smsc95xx driver registered and "link is not ready", i.e. most likely unplugged.) |
| Tailscale on robots | 1.102.4, **userspace-networking** (`--tun=userspace-networking`, required because the Opentrons kernel lacks policy routing), state on `/data/tailscale`. `serve`: `/` → `:31950`, `/bridge` → `127.0.0.1:31960`. |
| Path iMac → robot | Direct (no DERP relay) at the time of the test: `tailscale ping` 5 ms via `172.16.202.124:41641`. Endpoint churn (STUN port changes) 68–82 events per robot today = NAT rebinding on the WiFi path. |
| `GET /health`, new TLS connection | **440 ms** (TLS handshake on the Pi = 350 ms of it) |
| `GET /health`, kept-alive HTTP/2 | **70 ms** = same as LAN http (60–70 ms) |
| `GET /runs/{id}` (what the run page polls) | direct avg 77–86 ms across robots; max 12–13 s (WiFi stalls, a dozen per run) |
| `GET /runs/{id}/commands?pageLength=10000` (360 KB) | LAN 1.9–2.8 s, tailnet 2.0–2.1 s. No MTU/large-transfer penalty. |
| `POST /runs` (run.create) | **R04 avg 19.5 s, B07 24.6 s, B14 14.2 s; 10 of 19 in 14 days > 25 s; 5 never answered.** This is robot-server loading the protocol + 576-well labware on a Pi 3B+, independent of transport. |
| Daemon → Vercel | 10 s read timeouts and one DNS failure today on R04; `trigger poll failed` on all robots. |
| SSH to robots over the tailnet IP | **Hangs at key exchange.** `RunSSH: true` on all three: Tailscale SSH intercepts port 22 and then fails because busybox has no `getent` ("error calling getent for user root"). SSH over the LAN IP works. Fix: `tailscale set --ssh=false` on each robot, or use LAN IPs in the runbook. |
| Disk | 6–17 % used on all three (the journald/nginx growers are under control). |

**Conclusion:** Tailscale adds nothing measurable once the connection is up. Every slow or lost call in today's data is explained by WiFi, by the Pi's CPU, or by BIMS code.

---

## 3. The system as built (one paragraph per layer)

- **Browser session** (`src/lib/opentrons/direct-client.ts`): one `RobotSession` per page; picks `direct` or `queue` once at open (`/connection` + a 1.5 s `/health` probe + Chrome Local Network Access permission); sticky fallback to the queue on any network-class error; self-heals every 30 s only when nothing is "busy"; every direct call traced to `ot2_direct_calls`.
- **Shared protocol** (`ot2-protocol.ts`): one `runVerb` implementation for both lines (this part is right and should stay).
- **Two-phase lifecycle** (`run-lifecycle-records.ts`): server prepare → browser does the robot half → server confirm, with `startIntent` for crash safety. Right in principle; its guard has a hole (section 4, A2).
- **Queue** (`Ot2BridgeCommand` + daemon long-poll): still used by non-tailnet machines, by page-load reconciles, by auto-resume and tip-swap fallbacks, by `/relay`, and by anything that fell back.
- **Daemon** (`scripts/ot2-bridge.py` 1.2 on all three, md5 `0e380b34`): one worker for everything (queue commands, `/bridge` jobs, relays), a heartbeat thread, a legacy trigger loop polling Vercel twice a second, and the `/bridge` job server behind an HMAC token. No persistence of jobs; no watchdog on a stuck worker.
- **Scanners:** gantry scanner on the robot (serial, daemon-owned); bench guns are keyboard wedges read by the browser; capture-station scanners go over a WebSocket. Only the gantry scanner is affected by any of this.
- **Health:** derived only from the daemon heartbeat as stored in Mongo; the browser's direct `/health` is used for the probe but not for the status pill.

---

## 4. Findings

### A. Bugs with evidence from today (fix first)

**A1. Run creation times out at 30 s; the robot needs 15–30 s.** `browserTransport` defaults every verb to a 30 s abort (`ot2-protocol.ts:1639`); `run.create` passes no override. `robotFetch` on the server has the same 30 s "parity with the bridge" (`proxy.ts:227`). Half of all creates in the last 14 days ran within 5 s of that limit; five lost the answer. A lost create is `NO_RETRY`, so the page reports "it may have happened", falls back to the queue for the rest of the page, and the robot is left with a created-but-unconfirmed run. **Fix:** 90 s for `run.create` (and `run.uploadProtocol` already has 110 s); on timeout, read `GET /runs` and adopt the run the robot created instead of declaring uncertainty.

**A2. The start sequence can run twice and creates two robot runs.** `startRunWithCapturedParams` on both fill pages has no `submitting` guard (reagent `+page.svelte:299-305`, wax `:778-785`); it is called from `DeckLoadingGrid.onComplete` (reagent `:1032`). Server-side, `startPrepare` only refuses a second start when the prior intent already has an `opentronsRunId` or `uncertainAt` (`run-lifecycle-records.ts:603-613`); between prepare and create it silently **overwrites** the intent with a new token. Result today: two concurrent `POST /runs`, `RunConflictError`, a 500 the browser reads as "Failed to fetch", a failover, and an orphaned run on the robot. **Fix:** guard the page function with `submitting`; make `startPrepare` refuse (409) any intent younger than ~3 min that has not been confirmed or cleared, not only ones with a run id.

**A3. Stale "busy" blocks recovery for 30 minutes.** After a fallback, `tryRecover` refuses to probe while `effectiveBusy()` is set (`direct-client.ts:530`). A `/bridge` gantry job this session started stays "busy" until the session observes its terminal status or 30 min elapse (`:261`, `:899-903`). If the page stops watching the job (stage change, reattach to the BIMS row, fallback mid-sweep), nothing clears it. Today's 16:42→17:12 gap matches this to the minute. **Fix:** busy should gate motion verbs only, never the transport decision; clear busy from `/bridge/health` `queue.busy` (the daemon already reports it) instead of from what this tab happened to see.

**A4. The run page polls a finished run forever, through whatever line it has.** `EmbeddedRunController.svelte:233` keeps polling after terminal; on the queue line that is one Vercel function + one Mongo command + one robot request every ~3 s per open tab, indefinitely. One such tab has been running since Sunday evening against R04 (section 1). The daemon's single worker serves these zombie polls interleaved with real work, and queue commands are not stamped with `requestedBy` (`proxy.ts:165-172`), so the tab cannot be found. **Fix:** stop polling N seconds after a terminal status; stamp `requestedBy` (and page/session id) on every queue command; add a "zombie session" row to `/opentrons/connectivity`.

**A5. A robot 500 is treated as a line failure.** FastAPI's unhandled 500 carries no CORS header, so the browser throws "Failed to fetch" and the session falls back as if the tunnel dropped (`direct-client.ts:695-704`). **Fix:** before falling back, probe `/health` once; only a failed probe is a line failure.

### B. Queue-era shapes that now cost reliability

**B1. The daemon still serves the queue with the same single worker that runs sweeps, deck scans, tip calibration and `/bridge` jobs** (`ot2-bridge.py:2621-2633`). A paused sweep, a 26-stop raster, or a 270 s robot-server restart blocks every queued `GET /runs/{id}` behind it; those then expire at 30 s and the UI says "bridge may be busy or down" while the heartbeat (own thread) says "Ready". Today's expired queue rows at 16:01, 16:26 and 16:33–16:40 are exactly this. If the queue stays, status reads should bypass the worker (a second, read-only lane on the daemon), or better, not go through the daemon at all.

**B2. Every timeout is still sized for the bridge hop.** 30 s abort in `robotFetch`, `browserTransport`, `BRIDGE_TIMEOUT_MS`; 20 s poll abort and 3-miss warning in the run controller (`EmbeddedRunController.svelte:103-116`); 45 s client aborts on the fill pages; `maxDuration` 45/60 on routes. On a direct line a stalled robot is invisible for 60 s and the message blames "the bridge". The numbers need to be per-line and per-verb (status: 5 s; actions: 10 s; create: 90 s; upload: 120 s).

**B3. Three auto-resume implementations plus a fallback** (daemon `auto_resume_run`, browser `isInitialEnginePause`, `?/autoResumeFallback` queue row). They race each other and each has its own window (75 s, 90 s). The off-deck pause exists only to let the operator confirm the deck; with a deck scan already gating start, the protocol could skip that pause and all three disappear.

**B4. Page-load reconciles still go through the queue from Vercel** (`reconcileStartIntent` `run.list`, the wax/reagent load-time `robotGet`), up to 30 s per page load on a tailnet robot, and they are the only reason a tailnet page still blocks on the daemon at load.

**B5. `/connection` is re-read every 5 s per open page** purely to learn `busy` and the kill switch (`direct-client.ts:365`), and the direct-call trace flushes every 3 s. Across the lab that is thousands of Vercel invocations per hour that tell the page nothing it could not get from `/bridge/health` in 30 ms.

**B6. The daemon's legacy `trigger_loop` polls Vercel every 500 ms on every robot** for a test-scan feature now served synchronously by `POST /bridge/scan`. That is the single biggest source of the robots' outbound traffic and of the "trigger poll failed" noise in the journals.

**B7. Daemon reports (heartbeat, sweep progress, results) go only to Vercel**, with 10 s timeouts and no local buffering. On WiFi they fail several times a day. The browser is 10 ms away and already polls `/bridge/jobs/{id}`; the daemon could keep a local journal and let BIMS pull or accept late posts.

**B8. Health in BIMS is Mongo-derived only** (`health.ts`). A robot can be reachable in 70 ms from the operator's PC and still show "Offline" because its WiFi dropped the heartbeat POST. The session already has a live `/health`; the pill should use it.

**B9. Stale paths and docs:** `src/lib/server/opentrons/client.ts` and `run-lifecycle.ts` still build `http://{robot.ip}:31950` (unused on Vercel, kept for scripts); `scripts/scanner-bridge.py` and `SCANNER-OT2-DEPLOYMENT.md` describe the retired lab-Mac scanner bridge; the scanner-test page shows OT-2 scanners as permanently "Offline" because it looks for the old `ot2-*-scanner` heartbeat id; BIMS sends `scanTimeoutS: 3` which the daemon clamps to 5.5 s; the udev `/dev/scanner` rule is still "pending" in the docs though it is in use on all three robots.

**B10. Security posture is unchanged since TAILNET-4's R1:** the robot API on `:31950` has no auth and echoes any origin; the tailnet ACL (TAILNET-3 S4) is still open, so any device on the tailnet can move any robot. `/bridge` has tokens; `:31950` does not.

### C. What is right regardless of transport (keep)

- One isomorphic `runVerb` for both lines (`ot2-protocol.ts`): direct and queue cannot drift.
- Prepare → robot → confirm with `startIntent`, idempotent confirms (filtered updates), `NO_RETRY` on creates and job starts, server-side shape validation of what the browser reports.
- The daemon owning everything that is physically local: serial scanner and calibrator, `tip-swap-request.json`, `systemctl restart`, the maintenance-run open/close ladder, a single lock around the gantry.
- The two-key gate (robot record + `OT2_TAILNET_ROBOT_IDS`) and the `/bridge` HMAC token.
- Tailscale in userspace mode on `/data` with `serve`: survives Opentrons updates, no kernel changes, one HTTPS origin for API + daemon.

---

## 5. If we rebuilt this with Tailscale as the core

The current design was forced by one constraint: **Vercel cannot reach the lab.** Everything else follows from it: the queue, the long-poll, the browser doing the robot half, the two-phase protocol, the fallbacks, the 30 s budgets. Tailscale removed the constraint for the browser but not for Vercel, so the system now has two command paths and one report path, and the browser tab is the run supervisor.

From first principles, with Tailscale assumed:

1. **The run supervisor belongs on the robot.** The daemon is already there, already durable, already has the serial devices and the filesystem. It should own the run lifecycle: start (upload if stale, create, play, auto-resume), watch, finish (read commands, parse tips/wells), stop. The browser then only *asks* the daemon to do these and *watches* `/bridge/jobs/{id}` over the tailnet. A closed tab, a double click or a slow WiFi link cannot strand a run, because the robot holds the state. This is what TAILNET-5 did for sweeps and deck scans; it stopped short of doing it for the run lifecycle, which is where today's failures were.
2. **BIMS stays the system of record; the daemon reports to it.** The daemon already does this for sweeps. Reports need a local journal with retry so WiFi blips do not lose records, and BIMS needs an idempotent "accept late report" path (it mostly has one: `jobs/[jobId]/result` dedupes).
3. **The queue goes away for tailnet robots.** Non-tailnet machines are the only reason it exists, and the honest answer for them is "install Tailscale" (every lab PC and both tablets are already on the tailnet). A `connection.mode: 'tailnet-only'` (TAILNET-5 Q2) would make queue use an explicit error instead of a silent slow path.
4. **Vercel never calls a robot.** Page-load reconciles become "ask the daemon" from the browser, or a Funnel-exposed, token-authenticated `/bridge` endpoint for the rare server-initiated check (the deferred lab gateway becomes unnecessary once the daemon is that gateway).
5. **Health is live.** The pill reads `/health` and `/bridge/health` directly; Mongo's heartbeat is the with-no-browser-open truth and the alerting source, not the UI source.
6. **Ethernet.** None of the above fixes a 12 s WiFi stall on a 1 s poll loop.

That is a rewrite of the lifecycle verbs into the daemon (~1,500 lines of Python, mostly ported from `ot2-protocol.ts`) and a simplification of the browser (~2,000 lines deleted). It is not required to fix today's problems; section 6 gets most of the benefit incrementally and is compatible with that end state.

---

## 6. Recommended sequence (smallest first, each independently shippable)

| # | Change | Why first | Where |
|---|---|---|---|
| 1 | **Plug Ethernet into R04 and B14; check B07's port** (hardware). | Removes the WiFi stalls, DERP flips, STUN churn and the daemon's outbound timeouts in one move. | lab |
| 2 | **`run.create` timeout 90 s; on timeout adopt the robot's current run instead of "uncertain".** | Direct cause of today's hang. | `ot2-protocol.ts` run.create/startRunTwoPhase |
| 3 | **Double-start guard:** `submitting` check in `startRunWithCapturedParams` (both pages); `startPrepare` refuses any unconfirmed intent younger than 3 min. | Second direct cause. | reagent/wax `+page.svelte`, `run-lifecycle-records.ts:603` |
| 4 | **Busy never blocks recovery; busy comes from `/bridge/health`.** Also probe `/health` before treating a thrown fetch as a line failure. | Third direct cause; also fixes the "500 = failover" case. | `direct-client.ts` tryRecover / fallBack |
| 5 | **Stop polling after terminal (+ stamp `requestedBy`/session on queue commands; show per-robot queue load on `/opentrons/connectivity`).** | Kills the zombie class; makes the next one findable. | `EmbeddedRunController.svelte:233`, `proxy.ts:165` |
| 6 | **Per-line, per-verb timeouts** (status 5 s / actions 10 s / create 90 s on direct; keep 30 s on queue) and line-aware messages. | Stalls surface in seconds, worded correctly. | `EmbeddedRunController.svelte:103-116`, `ot2-protocol.ts` |
| 7 | **Daemon: read-only lane for `GET /runs/*` queue commands; backoff on 4xx poll; retire `trigger_loop` (test-scan is `/bridge/scan`); add busy-age to `/bridge/health` and a BIMS alarm on worker busy > 10 min.** | Removes head-of-line blocking and most outbound noise. | `scripts/ot2-bridge.py` |
| 8 | **Turn off Tailscale SSH on the robots** (`tailscale set --ssh=false`) or document LAN-IP SSH. | SSH over the tailnet hangs today. | runbook |

After 1–8, revisit section 5 and decide whether to move the run lifecycle into the daemon (recommended) and retire the queue for tailnet robots.

---

## Appendix A. Daily queue volume per robot (last 4 days, `ot2_bridge_commands`)

```
10-04  r04=742
10-05  b07=832   b14=11   r04=7662
10-06  b07=766            r04=6775
10-07  b07=1     b14=12   r04=6474
```
R04's volume is the zombie tab. B07's is the Studio maintenance session (expected). B14 is what a tailnet robot should look like.

## Appendix B. Direct-call summary, last 36 h

| Robot | run.get | avg | max | run.create avg | notes |
|---|---|---|---|---|---|
| B07 | 9,070 | 77 ms | 12.0 s | 28.3 s (1) | |
| B14 | 10,586 | 76 ms | 13.8 s | 20.5 s (2) | mx.home 26 s, dropTip 6 s avg |
| R04 | 11,284 | 86 ms | 12.5 s | 18.8 s (6, 3 lost) | 10 expired queue reads, 2 restarts, 1 reboot |

## Appendix C. Robot-side facts worth keeping

- Daemon 1.2 (`0e380b34`) on all three; `/bridge` served on all three; `BIMS_BASE_URL` = production on all three.
- Tailscale 1.102.4 userspace mode; `RunSSH: true` everywhere (see finding, section 2).
- Boots: R04 rebooted 2026-10-05 16:14 and 2026-10-07 16:36; B14 2026-10-05 17:08; B07 up 22 days.
- R04 memory 903 MB, 4 cores (BCM2835 / Pi 3B+), load ~0.6–1.0 during a run.

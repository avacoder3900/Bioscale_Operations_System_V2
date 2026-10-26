# OT2-LOG-1 — Connection journal: background logging for every robot line

**Date:** 2026-10-26 · **Status:** Approved by Jacob 2026-10-26 (OT2-WIRED-1 workstream D; 50-day retention, no alerts) · **Parent:** `OT2-WIRED-1-PLAN.md`

## 1. Why

Every connectivity question this month was answered by hand from the robot (journald, `/logs/server.log`, run comments) or from the one overwritten heartbeat doc. There is no history: `scanner_events` keeps one `hb:<deviceId>` doc, `ot2_direct_calls` lives 3 days, daemon failures stay in journald on the Pi. Phase 1 of the wired-first plan is "log first, then change the paths with data".

## 2. What is recorded, by source

| Source | Cadence | Carries | Lands in |
|---|---|---|---|
| **Daemon** (`scripts/ot2-bridge.py`), inside the existing heartbeat POST `metadata.link` | every heartbeat (10 s); BIMS samples to ≤ 1/min | default route iface; eth0 carrier + ip; wlan0 ip, RSSI, freq; tailscale self (direct/relay name, curAddr, lastHandshake age); last poll RTT ms; poll + heartbeat error counts since last heartbeat; worker busy age s; journal backlog; script sha256; uptime s | `robot_link_samples` source `daemon` |
| **Daemon local journal** `/data/ot2-bridge/journal.jsonl` | every outbound report | ring of the last 2000 report attempts (kind, url, status, ms, error) + a retry queue for failed job progress/result posts (B7); replayed on reconnect, idempotent on the BIMS side | robot only; `journalBacklog` is in the heartbeat |
| **iMac link monitor** (`scripts/imac-linkmon.py`, launchd) | 1/min per robot per path (wifi, wired, tailnet) | ICMP loss %, avg RTT ms, `/health` latency ms (or error class) | `robot_link_samples` source `imac` via `POST /api/agent/robot-link/samples` (bulk, agent key) |
| **Browser direct line** (`ot2_direct_calls`, exists) | per call | verb, line, latency, status | kept at 3 d raw; rolled up daily |
| **Vercel agent routes** | per poll / heartbeat | poll long-poll duration, heartbeat age at receipt | structured `console.log` line `[robot-link]`, and the heartbeat age goes into the daemon sample |

Cartridge-level events that already exist (first-probe miss, run_start_auto_resync, bridge_job_result errors) are counted into the daily rollup from `audit_log` and run records; nothing new is written for them.

## 3. Collections

`robot_link_samples` (TTL **50 d** on `at`; index `{robotId, at}`, `{source, at}`)
```
{ _id, robotId, deviceId, at, source: 'daemon'|'imac',
  iface?: { default: 'eth0'|'wlan0'|null, eth0: {carrier, ip}, wlan0: {ip, rssi, freq} },
  tailscale?: { direct: bool, relay: string|null, curAddr: string|null, handshakeAgeS: number|null },
  bims?: { pollRttMs, pollErrors, hbErrors, hbAgeAtReceiptMs },
  worker?: { busyAgeS, queueDepth },
  daemon?: { version, sha256, uptimeS, journalBacklog },
  server?: { healthOk, engineOk },
  paths?: [{ name: 'wifi'|'wired'|'tailnet', ip, lossPct, rttMs, healthMs, healthErr }] }
```
`robot_link_daily` (permanent; `{robotId, day}` unique)
```
{ robotId, day: 'YYYY-MM-DD', samples, hbGaps: {count, maxS}, pollRtt: {avg, p95}, relayMin,
  paths: { wifi: {lossAvg, lossMax, rttAvg}, wired: {...}, tailnet: {...} },
  directCalls: {count, errors, p95LatencyMs, byLine: {tailnet, queue}},
  firstProbeMisses, resyncs, bridgeJobErrors, daemonVersions: [..] }
```
Sampling rule for daemon heartbeats: the heartbeat route writes a sample only when the device's last sample is ≥ 55 s old (≈ 4.3k docs/day for three robots; the 2026-07-31 Atlas incident was one doc per heartbeat).

## 4. Surfaces

- `/opentrons/connectivity`: per robot, a 24 h and 7 d strip — heartbeat gaps, loss by path, poll RTT, direct vs relay, daemon version changes — plus the existing line/queue stats. No alerts (decision 6).
- MCP saved queries: "Robot link samples" (filters `robotId`, `at__gte`, `source`) and "Robot link daily" (`robotId`, `day__gte`).
- Rollup: `/api/cron/robot-link-daily` (Vercel cron, 00:10 UTC) computes yesterday for every robot; idempotent (upsert by `{robotId, day}`); also callable with `?day=`.

## 5. Stories

| # | Story | Acceptance |
|---|---|---|
| L1 | Models `RobotLinkSample` (TTL 50 d) + `RobotLinkDaily`; registration | indexes created; TTL verified on a sample |
| L2 | Heartbeat route samples `metadata.link` at ≤ 1/min; `POST /api/agent/robot-link/samples` bulk ingest (agent key, ≤ 500 rows, validated); `[robot-link]` structured log on poll + heartbeat routes | a daemon heartbeat with `link` produces one sample per minute, not ten |
| L3 | Daemon: `link` telemetry in heartbeat metadata; journal ring + retry queue; `journalBacklog` reported; no behaviour change on the job path | `python3 -m py_compile`; the heartbeat JSON contains the documented keys on a dev box without NetworkManager (fields null, never crash) |
| L4 | iMac link monitor as a launchd service (`~/Library/LaunchAgents/com.bims.linkmon.plist`), config from `~/.config/bims-linkmon.env` (BIMS URL, agent key, robots+paths); one CSV line locally per sample as a fallback | 60 min of samples visible in Mongo from the iMac |
| L5 | Daily rollup cron + `robot_link_daily` | yesterday's doc per robot after one run; re-run is idempotent |
| L6 | Connectivity page timeline (24 h / 7 d) from samples + daily | page answers "which path, which line, how often it failed, when the daemon changed" |
| L7 | Saved queries seeded (`agent_queries`); runbook entry in `docs/agent/` | MCP `list_saved_queries` shows both |

## 6. Non-goals

Alerts (decision 6). Changing any path behaviour (that is OT2-WIRED-1 phase 2). Shipping robot journald to BIMS wholesale.

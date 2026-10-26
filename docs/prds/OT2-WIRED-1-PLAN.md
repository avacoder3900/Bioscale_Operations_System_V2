# OT2-WIRED-1 — Wired-first OT-2 connectivity, connection logging, per-robot rack offsets, agent docs

**Date:** 2026-10-26 · **Status:** Draft for approval (Jacob) · **Parent:** `docs/OT2-TAILNET-CONNECTION-AUDIT-2026-10-07.md`, `docs/prds/OT2-TAILNET-0-PLAN.md` · **Kanban:** "Ethernet control of the OT-2s" (mDI7hAWkp3nl7Ly0Qy3Zv, WIP)

## 0. Facts this plan rests on (measured 2026-10-22 and 2026-10-26)

- All three robots report `eth0` type ethernet, connected, Raspberry Pi MACs. The "USB" is on the iMac side only: B07/B14 cables end in two Realtek USB-to-Ethernet adapters (en5, en7); R04's in the iMac's built-in port (en0). The wired fix is a switch/router, not a USB-host gateway.
- All three wired links are link-local (169.254/16, no gateway). They reach only the iMac. Nothing in production uses them. Production traffic today: browser → Tailscale → robot WiFi (Aquinas_Townpark, 192.168.1.x); daemon → robot WiFi → Vercel. B14's WiFi loses 15–40 % of packets, bursts to 80 %; B07/R04 0 %.
- The iMac (100.121.85.51 on the tailnet) is on Fannin_WIFI (172.16.202.x), up 27 days, caffeinated, but it is the CNC workstation (Carbide Motion). LAB-GATEWAY-1 was deferred 2026-08-17 for that reason. Here the iMac is a measurement vantage point only.
- Opentrons OS manages `eth0` with DHCP + link-local fallback, prefers Ethernet over WiFi by route metric, and Tailscale re-paths itself. No robot-side change expected; verify on R04 first (no SSH from this session).
- Shipped since the audit: run-create adopt (ffa55706, c4eae89a), TAILNET-6 S1–S5 (af886a5f). Open: S6 timeouts, busy-from-health, daemon lanes, Tailscale SSH off, restart wait, two unmerged fixes (3ac02588 health pill, 5b1ed789 background-tab polling).
- 2026-10-26 incident: tip-rack labware definitions are shared across robots; an R04 Studio edit (+2,+5 on `cosmasanddamian_96_tiprack_20ul`) reached B07 via run_start_auto_resync and broke B07's pick-ups. Same class for the drybath tube rack and the 200 µL rack (lowered z −1.0 the same day).

## 1. Decisions (Jacob, 2026-10-26)

1. **Uplink.** No known Ethernet jack near the robots; two WiFi networks (Fannin, Townpark) and we want to switch between them. → Travel/edge router with a WiFi-client (repeater/WISP) WAN, switchable between SSIDs in its admin page, wired LAN to the robots via a 5-port switch. Swap the router's WAN to a cable the day a jack exists.
2. **No automatic fallback.** Robot WiFi is turned off after cutover (config kept, re-enabled by one API call from the iMac over the switch when explicitly wanted). The queue line stops being an automatic fallback: `connection.mode: 'tailnet-only'` default; queue only when an operator explicitly selects it for that session.
3. **iMac = monitoring vantage only** (link monitor as a launchd service). Not a gateway.
4. **Per-robot calibration for tip racks and tube racks**, current geometry is the default for everyone (offset 0), except the migration below.
5. **Retention 50 days** for raw link samples; daily rollups kept.
6. **No alerts.** Timeline page + MCP saved queries only.
7. **Logging before assumptions.** Build the connection logging first (additive, no behaviour change), observe for two weeks on the wired topology, then do the honest-path code changes with data.
8. **Unmerged fixes wait** until the current fill campaign is done; nothing in this plan touches a running fill.
9. **Daemon deploys** run from this session once ssh/scp to the robots is allowed; robot must be idle; verify via `/bridge/health`, heartbeat and journald after each deploy.

## 2. Workstreams

### A. Wire (lab, no code)
- Hardware: OpenWrt travel router with repeater/WISP WAN (e.g. GL.iNet Beryl AX class) + 5-port gigabit switch. LAN → R04, B07, B14, iMac en0. Router WAN → Townpark or Fannin (saved profiles, switch in the admin page). Robots get DHCP from the router (one private subnet), eth0 preferred automatically, Tailscale direct via NAT or DERP, daemon outbound via the router. No inbound needed.
- Order: R04 → verify → B14 → B07. Verify per robot: `/networking/status` shows a routable eth0 address + gateway; `tailscale status` on the iMac shows direct endpoints on the wired IP; 48 h link monitor at ~0 % loss; zero heartbeat gaps.
- After 48 h clean: turn WiFi off on each robot (`/wifi/disconnect`), keep the SSID config documented. Single point of failure is the router: documented one-call WiFi re-enable from the iMac over the switch (explicit, never automatic).
- Caveat stated plainly: the router's uplink is still a radio until a jack exists; one well-placed router radio replaces three Pi 3B+ onboard radios and makes the network switch a router setting instead of three robot reconfigurations.

### D. Connection logging (first code work; additive)
- Daemon heartbeat metadata adds: default interface, eth0 carrier, wlan0 RSSI/freq, Tailscale self state (direct/relay, DERP region), last poll RTT, poll/heartbeat error counts since last heartbeat, worker busy age, script sha256, uptime.
- Daemon local journal (`/data/ot2-bridge/journal.jsonl`) with retry for every outbound report (audit B7); BIMS late-report path is idempotent (exists for job results; extend to progress/heartbeat samples).
- iMac link monitor (launchd): per minute, per robot, per path: ICMP loss/RTT and `/health` latency, posted with the agent key.
- Browser direct-line records (`ot2_direct_calls`) keep line + latency; TTL 3 d → 50 d.
- Vercel agent routes log poll duration and heartbeat age at receipt (structured).
- Store: `robot_link_samples` (TTL 50 d) + `robot_link_daily` rollup (permanent). `opentrons_run_records` written per run (deck id/version/hash, line, daemon version, first-probe misses).
- Surface: `/opentrons/connectivity` per-robot 24 h / 7 d timeline (heartbeat age, loss, latency, direct/relay, line mix, failures). MCP saved queries: "Robot link samples", "Robot run records".

### B. Honest paths (after two weeks of data; small, independently shippable)
- Merge 3ac02588 (health pill from live `/health`) and 5b1ed789 (stop polling in background tabs) in the first no-fill window.
- TAILNET-6 S6: per-line per-verb timeouts (status 5 s / actions 10 s / create 90 s on direct); connectivity page shows queue load and top requesters.
- Busy from `/bridge/health`; probe `/health` before declaring a line dead (audit #4).
- `tailnet-only` connection mode as default; queue is an explicit per-session choice with a clear error otherwise (TAILNET-5 Q2).
- Daemon: read-only lane for GET queue commands, backoff on 4xx, retire `trigger_loop`, busy-age in `/bridge/health` (audit #7). Restart wait 90 s → 180 s. Tailscale SSH off; document LAN/wired SSH.
- Fleet hygiene: provisioning bakes in the DNSSEC resolver fix; BIMS flags daemon hash drift (B14 runs a branch build today).

### C. Per-robot rack/tube offsets (Mongo + Studio + run start)
- New `robot_labware_offsets` {robotId, loadName, slot, vector{x,y,z}, taughtBy, taughtAt, note}. Applied as Opentrons `labwareOffsets` at run creation (the run already carries zero vectors for slots 10/11) and in the Studio's move-to / pick-up for kind=tip and kind=tube.
- Studio: kind=tip locks the selected rack to the tip profile; "Apply offset" on a rack writes the robot's offset row, not the shared definition; editing a shared definition shows which robots it reaches.
- Migration ("current state is the default"): shared 20 µL rack restored to the 2026-10-13/14 geometry (B07/B14 baseline); R04 gets offset (+2, +5, 0) on it (its state today). 200 µL rack: the −1.0 z applied 2026-10-26 on B07 becomes B07's offset unless it was meant for all robots (confirm with Samantha). Tube racks start at 0.
- Verification: pick-up + first probe passes on B07 and R04 with their own offsets; Studio move-to equals pick-up position on both.

### E. Documentation for the agentic coding system (parallel, from day one)
- `docs/agent/` indexed from AGENTS.md "Reference Documents": SYSTEM-MAP (robots, ids, hostnames, IPs, mounts, decks, fixtures, bend strings, probe Z, normal adjust bands), CONNECTION-ARCHITECTURE (post-rework; the "line" vocabulary; what runs where), INVARIANTS (shared labware definitions, tip profile vs selected rack, heartbeat staleness, restart wait, Pi 3 run-create 20–30 s, probe recipe per profile, DNSSEC), RUNBOOKS (connectivity triage, stuck-run triage, calibration triage, rack/deck drift triage — exact endpoints/queries), DATA-DICTIONARY (collections, TTLs, saved queries), DECISIONS (ADR log), IMPROVEMENT-LOOP (after an incident: pull samples + audit → incident note → kanban via MCP → PRD).
- CLAUDE.md "Common Pitfalls" gets the invariants. Session memories mirrored into the repo.

## 3. Sequence and gates

| Phase | Scope | Gate | Effort |
|---|---|---|---|
| 0 | A: router + switch, R04 first, then B14, B07; 48 h monitor; WiFi off | B14 ~0 % loss, direct Tailscale on wired IPs, zero heartbeat gaps | order hardware; 1 lab afternoon; 2 days watching |
| 1 | D: logging (daemon telemetry + journal, iMac monitor, collections, page, MCP queries). E starts. | two weeks of samples on the wired topology; page answers "which line, which path, how often it failed" | ~1 week code, daemon deploy in a no-fill window |
| 2 | B: merges, S6, busy/health, tailnet-only, daemon lanes, restart wait, SSH off, hygiene | each change justified by phase-1 data; no new "bridge did not respond" on a fill day | 3–5 days |
| 3 | C: per-robot rack/tube offsets + migration + Studio lock | B07 and R04 both pick up first-time with their own offsets | 3–4 days |
| later | Audit §5: run supervisor on the daemon, retire the queue for tailnet robots | two clean weeks on phases 0–3 | separate PRD |

Immediate, outside the phases: revert the 20 µL rack shift (staged script, needs a Mongo connection string) and re-seat R04's rack, or — if C lands first — keep the shared revert and give R04 its offset.

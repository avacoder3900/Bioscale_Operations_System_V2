# Connection architecture (after OT2-WIRED-1 phase 0)

## The vocabulary

- **Line** — how the browser reaches a robot. `tailnet` = direct HTTPS to `https://ot2-<slot>.tailf65a70.ts.net` (`/` → robot API :31950, `/bridge` → daemon :31960). `queue` = a `ot2_bridge_commands` doc the daemon polls from Vercel and relays to the robot's localhost. Today the page falls back to queue automatically; after phase 2 the queue is an explicit per-session choice (`connection.mode: 'tailnet-only'`).
- **Daemon** — `ot2-bridge.py` on the Pi. Outbound only: long-poll `/api/agent/ot2/poll`, heartbeat `/api/agent/scanner/event`, job progress/results `/api/agent/ot2/jobs/<id>/…`. Inbound only over the tailnet (`/bridge`, token-gated).
- **Path** — the physical route a packet takes: `wifi` (robot wlan0 → Aquinas_Townpark AP), `wired` (robot eth0 → iMac NIC), `tailnet` (WireGuard over whichever path is up, direct or via a DERP relay).

## Topology

```
Vercel (BIMS)  ◄── daemon heartbeat/poll/results (outbound HTTPS) ─── robot Pi
     ▲                                                               ▲
     │ page loads, start/confirm records                              │ Tailscale (direct or DERP)
 browser (lab PC / iMac / tablet, on the tailnet) ── tailnet line ────┘
                                                                     │
 lab iMac: Internet Sharing (Wi-Fi Fannin → en0, en5, en7) ◄── eth0 ─┘  (phase 0)
           link monitor (scripts/imac-linkmon.py) → /api/agent/robot-link/samples
```

Phase 0 (OT2-WIRED-1): the three robot Ethernet cables terminate on the iMac (en0 built-in → R04; en5/en7 USB NICs → B07/B14). Internet Sharing on the iMac gives them DHCP + NAT over the iMac's Wi‑Fi uplink; each robot switches `eth0` from the `wired-linklocal` profile to the DHCP `wired` profile; Ethernet wins the default route (metric 100 vs 600); Tailscale re-paths; the daemon's outbound and the browser's tailnet line both ride the wire. After 48 h clean, robot WiFi is turned off (`/wifi/disconnect`), re-enabled only by an explicit API call from the iMac. Single point of failure: the iMac; documented recovery is to plug a laptop into the robot's Ethernet and call `/wifi/configure`, or reboot the iMac.

## What decides which line a page uses

`src/lib/server/opentrons/connection.ts` (`resolveRobotConnection`, `tailnetAllowedHere`) plus the browser's own probe of `https://ot2-<slot>…/health`. Health pill: live `/health` + `/bridge/health` on the page (3ac02588), Mongo heartbeat (`health.ts`, 60 s) as the no-browser truth.

## Where it fails, by symptom

| Symptom | Usual cause | First check |
|---|---|---|
| "bridge did not respond within 30 s" / start_intent_cleared | daemon's outbound path lost packets (B14 WiFi 15–80 % loss on 2026-10-22) | `robot_link_samples` for that deviceId; heartbeat gaps |
| "did not come back after restart" | 90 s wait vs 2–3 min boot | wait; `/health` over the wire |
| fill page frozen at start | run.create 15–30 s on Pi 3; the run exists | `/runs` on the robot; the next start adopts it |
| robot "offline" on every page | heartbeat older than 60 s | daemon journal (`journalctl -u ot2-bridge`), `/bridge/health` |
| queue traffic from nowhere | a backgrounded or dead tab polling a finished run | `ot2_bridge_commands` requester; 5b1ed789 stops it |

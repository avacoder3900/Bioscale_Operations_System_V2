# System map — the OT-2 fleet as of 2026-10-26

## Robots

| | B07 "Robot 3" | R04 "Robot 2" | B14 "Robot 1" |
|---|---|---|---|
| BIMS robotId | `2vIu0fzsbqzkZ7_Zjj3h2` | `CCyX8FjTRGvYOd9vISGvi` | `8LufEAi5sYJ5JRk_fTfT7` |
| hostname | `hidden-leaf` | `OT2CEP20210817R04` | `muddy-water` |
| bridge deviceId | `ot2-b07-bridge` | `ot2-r04-bridge` | `ot2-b14-bridge` |
| tailnet | `ot2-b07.tailf65a70.ts.net` / 100.109.115.63 | `ot2-r04…` / 100.88.240.14 | `ot2-b14…` / 100.122.230.39 |
| WiFi (Aquinas_Townpark) | 192.168.1.59 | 192.168.1.224 | 192.168.1.206 |
| wired (link-local to the iMac, pre-cutover) | 169.254.199.218 on iMac en5 (USB NIC) | 169.254.5.191 on iMac en0 | 169.254.134.36 on iMac en7 (USB NIC) |
| pipettes | p20 right (wax), p300 left (reagent) | p20 right, p300 left | p300 left (reagent); p20 right when wax |
| usual deck | DECK-004 (`gen4deck_gen7cartridge_004`) | DECK-001 | DECK-003 |
| calibrator bend string ('C') | `-1.0:2.5` | `-5.0:1.8` | see fixture row |
| probe Z wax / reagent | 40.15 / 40.8 | 34.491 / 39.8 | – / 40.8 |
| max_tip_adjust | 4.0 (protocol default) | 8.0 (fixture) | 8.0 |
| normal wax adjust (x, y) | −2.4 … −3.2, +0.3 … −1.7 (y drifts negative as a tip is used) | ≈ −6.2, −0.3 … −2.4 | – |
| normal reagent adjust | ≈ −2.1, ≈ 0 | ≈ −7.3, ≈ −1.8 | – |

All three run the same daemon build as `origin/master:scripts/ot2-bridge.py` (verified by md5 over SSH on 2026-10-26). Robot-server 8.7.0, Pi 3B+ (run creation takes 15–30 s).

Network facts (robot side): `eth0` is a NetworkManager profile `wired-linklocal` (`ipv4.method link-local`, metric 100); a spare profile `wired` is DHCP (`ipv4.method auto`, autoconnect-priority 1) — `nmcli con up wired` switches once a DHCP server is on the wire, `nmcli con up wired-linklocal` rolls back. `wlan0` default route metric 600. DNSSEC is disabled by `/etc/systemd/resolved.conf.d/90-bims-no-dnssec.conf` (not yet in provisioning; an OS update drops it). Tailscale binary: `/data/tailscale/tailscale`. SSH: `ssh root@<wired or LAN ip>` from the lab iMac with its default key; Tailscale SSH is unreliable.

## Lab iMac (100.121.85.51 on the tailnet)

macOS 13.6, always on (caffeinated; it is also the CNC controller running Carbide Motion). Uplink: Wi‑Fi `Fannin_WIFI` (172.16.202.x, default route via 172.16.202.1, which also routes to 192.168.1.x). Ports: en0 built-in Ethernet → R04; en5/en7 Realtek USB 10/100 NICs → B07/B14. After OT2-WIRED-1 phase 0 it shares its Wi‑Fi to those three ports (Internet Sharing) and runs the link monitor (`scripts/imac-linkmon.py`). `sudo` needs a password there; System Settings changes are done by the operator.

Repos on the iMac: `~/github/Bioscale_Operations_System_V2` (BIMS; local branch lags), `~/github/bioscale-app` (consumer app). The BIMS Mongo string: not in the repo; a full env export was dropped at `~/github/bioscale-app/ATT92158.env` (CRLF, extra lines, many unrelated secrets, excluded via `.git/info/exclude`). Extract `MONGODB_URI` with a small Python loop; never `source` it, never commit it.

## BIMS pieces on the robot path

- Fill pages (wax: `/manufacturing/wax-filling/...`, reagent: `/manufacturing/reagent-filling/...`) run the start sequence in the browser (`src/lib/opentrons/ot2-protocol.ts` `startRunSequence`) over the **tailnet line** (direct HTTPS to the robot, `direct-client.ts`) with the **queue line** (`ot2_bridge_commands`, polled by the daemon) as today's automatic fallback (to become explicit, OT2-WIRED-1 phase 2).
- Server: `src/lib/server/opentrons/run-lifecycle-records.ts` (startPrepare/startConfirm, run-time parameters incl. calibrator and rack offsets), `protocol-freshness.ts` (run-start auto re-sync when bundled labware wells ≠ Mongo), `calibration-rtps.ts`, `health.ts` (60 s stale heartbeat), `proxy.ts` (`assembleProtocolUpload`: bundles the whole labware library for non-hardened robots).
- Daemon on each Pi: `scripts/ot2-bridge.py` (systemd `ot2-bridge.service`, env in `/data/ot2-bridge/ot2-bridge.env`): long-polls `/api/agent/ot2/poll`, heartbeats to `/api/agent/scanner/event` every 10 s, serves `/bridge` (port 31960, HS256 tokens) for Studio jobs (calibrate_tip, sweep, deck_scan, tip_swap_request, restart_robot_server, auto_resume_run). Owns the serial devices (barcode scanner, calibrator fixture).
- Deck Calibration Studio: `/manufacturing/cart-mfg/deck-calibration` (`kind=deck|tube|tip|calibrator`), maintenance runs over the tailnet line.
- Protocols: `protocols/Wax_Filling_GEN7_Cartridge.py`, `protocols/Reagent_Filling_GEN7.py`; the source the robots get is `opentrons_protocols.fileContent` (refresh with `scripts/refresh-stored-protocols.ts`), bundled with labware from `labware_definitions` at upload.

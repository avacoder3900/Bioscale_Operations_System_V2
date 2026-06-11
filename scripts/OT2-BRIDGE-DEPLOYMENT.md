# OT-2 Bridge Deployment

Deploys the unified bridge daemon (`scripts/ot2-bridge.py`) to an OT-2's internal Raspberry Pi.

**Supersedes [`SCANNER-OT2-DEPLOYMENT.md`](SCANNER-OT2-DEPLOYMENT.md)** — the bridge daemon REPLACES `scanner-bridge.py`. It keeps the legacy scanner trigger/event behavior (per-slot rescans, teach test-scans) byte-for-byte, and adds:

- **Command long-poll** (`POST /api/agent/ot2/poll`) — robot control from the deployed app (start run, jog/teach, health) via `kind:'http'` relay to the local robot API.
- **On-robot sweep** (`kind:'sweep'`) — the whole cartridge-sweep choreography runs next to the hardware; per-slot progress streams back to BIMS.
- **Deck-barcode scan** (`kind:'deck_scan'`) — gantry-scanner read of the deck label.
- **Heartbeat** every 10 s with the robot's local `GET /health` snapshot in `metadata.health`.

PRDs: `docs/prds/OT2-BRIDGE-1-COMMAND-BRIDGE.md`, `docs/prds/OT2-BRIDGE-2-ONROBOT-SWEEP-DECK-SCAN.md`.

## Rollout order

1. **B07** — replaces the running scanner-bridge.
2. **R04** — second robot (the original scanner-bridge pilot; see superseded doc for its hardware notes).
3. **B14** — last.

## Device identity convention

Per robot, two logical device IDs (both reported to BIMS):

| Env var | Convention | Used by |
| --- | --- | --- |
| `BRIDGE_DEVICE_ID` | `ot2-<slot>-bridge` (e.g. `ot2-b07-bridge`) | command long-poll + heartbeat |
| `SCANNER_DEVICE_ID` | `ot2-<slot>-scanner` (e.g. `ot2-b07-scanner`) | legacy trigger/event loop |

`<slot>` is the trailing R/B + two digits in the robot's BIMS name ("Robot 3 B07" → `b07`), matching the `deviceIdForRobot` regex in `src/routes/api/scanner/sweep/+server.ts`. If `SCANNER_DEVICE_ID` is unset, the daemon derives it from `BRIDGE_DEVICE_ID` (`-bridge` → `-scanner`) — set it explicitly anyway.

## Prerequisites (per robot)

- Waveshare GM-class barcode scanner on the robot's USB port (enumerates as `/dev/ttyACM0` via `cdc_acm`). Watch for the ttyACM collision noted in the superseded doc if a Particle device is also plugged in.
- SSH access — key at `docs/brevitest-opentrons-files-4-21/ot2_ssh_key`:

```bash
cp docs/brevitest-opentrons-files-4-21/ot2_ssh_key /tmp/ot2_key && chmod 600 /tmp/ot2_key
ssh -i /tmp/ot2_key root@<robot-ip>
```

For SCP, force legacy mode (the OT-2 has no sftp-server):

```bash
scp -O -i /tmp/ot2_key <local> root@<robot-ip>:/data/ot2-bridge/
```

## 0. Stop and disable the old scanner-bridge FIRST

The bridge owns the same serial port and the same `ot2-<slot>-scanner` trigger identity — the two daemons must never run together.

```bash
# If scanner-bridge runs as a foreground/manual process:
pkill -f scanner-bridge.py || true

# If it was ever wired into systemd (it was not on R04 as of the old doc, but check):
systemctl disable --now scanner-bridge 2>/dev/null || true

# Keep /data/scanner-bridge/ around as a rollback copy until the bridge is verified.
```

## 1. Install files at `/data/ot2-bridge/`

`/` is mounted read-only (Buildroot); `/data` is writable and survives most firmware updates.

```bash
ssh -i /tmp/ot2_key root@<robot-ip> "mkdir -p /data/ot2-bridge"
scp -O -i /tmp/ot2_key scripts/ot2-bridge.py        root@<robot-ip>:/data/ot2-bridge/ot2-bridge.py
scp -O -i /tmp/ot2_key scripts/ot2-bridge-run.sh    root@<robot-ip>:/data/ot2-bridge/run.sh
scp -O -i /tmp/ot2_key scripts/ot2-bridge.service   root@<robot-ip>:/data/ot2-bridge/ot2-bridge.service
ssh -i /tmp/ot2_key root@<robot-ip> "chmod 755 /data/ot2-bridge/run.sh"
```

| Path | Mode | Notes |
| --- | --- | --- |
| `/data/ot2-bridge/ot2-bridge.py` | 644 | Copy of `scripts/ot2-bridge.py` |
| `/data/ot2-bridge/.env` | **600** | Config — holds the real `AGENT_API_KEY` |
| `/data/ot2-bridge/run.sh` | 755 | Copy of `scripts/ot2-bridge-run.sh` |
| `/data/ot2-bridge/ot2-bridge.service` | 644 | Staged copy; installed into `/etc/systemd/system/` in step 4 |

## 2. Python dependencies (OT-2 `--user` quirk)

```bash
pip3 install --user pyserial requests
```

**OT-2 pip quirk** — `pip install --user` writes to `/var/user-packages/root/.local/...` instead of the standard `/root/.local/...` that Python's `USER_SITE` resolves to. Without a symlink, `import requests` fails inside scripts. Fix once per robot:

```bash
ln -sf /var/user-packages/root/.local /root/.local
```

(Already in place on R04. Re-apply if a firmware update wipes it.) `pyserial` ships with the OT-2 image; `requests` usually needs installing.

## 3. `.env`

Create `/data/ot2-bridge/.env` (mode 600). Full variable reference — example for B07:

```bash
# --- required ---
BIMS_BASE_URL=https://bioscale-operations-system-mongodb.vercel.app
BIMS_AGENT_API_KEY=PLACEHOLDER_SET_REAL_AGENT_API_KEY   # AGENT_API_KEY from BIMS env (same value as mocreo/openclaw)
BRIDGE_DEVICE_ID=ot2-b07-bridge                         # command long-poll + heartbeat identity
SCANNER_SERIAL_PORT=/dev/ttyACM0                        # Waveshare scanner USB-CDC port

# --- recommended explicit ---
SCANNER_DEVICE_ID=ot2-b07-scanner                       # legacy trigger-loop identity (default: derived from BRIDGE_DEVICE_ID)

# --- defaults (uncomment to override) ---
#SCANNER_BAUD=9600                # scanner serial baud
#OT2_BASE_URL=http://localhost:31950   # local robot HTTP API
#POLL_WAIT_MS=18000               # server-side long-poll hold (capped 20s server-side)
#TRIGGER_POLL_INTERVAL_MS=500     # legacy trigger queue poll interval
#HEARTBEAT_INTERVAL_S=10          # heartbeat cadence
#SCAN_TIMEOUT_S=3                 # max wait for serial scanner response
```

```bash
chmod 600 /data/ot2-bridge/.env
```

`run.sh` refuses to start while `BIMS_AGENT_API_KEY` contains `PLACEHOLDER`/`REPLACE`/`changeme` or any required var is empty.

## 4. Foreground smoke test

```bash
/data/ot2-bridge/run.sh
```

Expected within ~10 s: `ot2-bridge/1.0 starting`, `Opened serial port /dev/ttyACM0 @ 9600 baud`, then quiet long-poll cycles. Ctrl-C to stop. Verify in BIMS (see "Verification" below) before installing the unit.

## 5. systemd unit (survives reboot)

`/etc/systemd/system/` lives on the read-only root — remount, install, remount back:

```bash
mount -o remount,rw /
cp /data/ot2-bridge/ot2-bridge.service /etc/systemd/system/ot2-bridge.service
systemctl daemon-reload
systemctl enable --now ot2-bridge
mount -o remount,ro /

systemctl status ot2-bridge          # active (running)
journalctl -u ot2-bridge -f          # live daemon logs
```

The unit runs `/data/ot2-bridge/run.sh` with `Restart=always` / `RestartSec=5`, after `network-online.target`. While root is rw, this is also the moment to add the udev rule for a stable `/dev/scanner` symlink if the robot has competing `ttyACM` devices (see the superseded doc's conflict warning).

## Verification

1. **Heartbeat** — within ~10 s of start, `scanner_events` in BIMS Mongo gets `eventType:'heartbeat'` docs with `deviceId=<BRIDGE_DEVICE_ID>` (e.g. `ot2-b07-bridge`) and `metadata.health` populated from the robot (null means the daemon is up but can't reach `localhost:31950`). `metadata.version` should read `ot2-bridge/1.0`.
2. **Test http command** — from the deployed app (with `OT2_TRANSPORT=bridge`), load the robot's health/status page, or insert a `kind:'http'` command (`request: { method: 'GET', path: '/health' }`) for the device and confirm it flips `pending → claimed → completed` with `result.status: 200` within a couple of seconds.
3. **Legacy scanner path** — open `/manufacturing/opentron-control/scanner-test?deviceId=<SCANNER_DEVICE_ID>`, click trigger, point the scanner at a barcode: a `scan` event should land.
4. **Sweep** — run "Scan Cartridges" from the wax/reagent deck page; live per-slot progress should appear in the existing sweep UI, and pause/cancel should take effect between slots.
5. **Reboot test** — `reboot`, wait for the robot to come back, confirm heartbeats resume without manual intervention (the whole point of the systemd unit).

## Rollback

```bash
systemctl disable --now ot2-bridge
# then restart the old daemon manually if needed:
/data/scanner-bridge/run.sh
```

Note: with the bridge off, bridged robot control and sweeps from the deployed app stop working; the old daemon only restores the legacy trigger/scan path.

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

# --- /bridge job server (OT2-TAILNET-5; see "Over the tailnet" below) ---
#BRIDGE_TOKEN_SECRET=              # = BIMS OT2_BRIDGE_TOKEN_SECRET; set = job server on 127.0.0.1:31960, unset = off (1.0 behaviour)
#BRIDGE_ROBOT_ID=                  # optional: this robot's BIMS _id; tokens must then carry it too
#BRIDGE_JOB_SERVER_PORT=31960      # job server port (always bound to 127.0.0.1)
#BRIDGE_ALLOWED_ORIGINS=           # optional extra exact CORS origins, comma-separated
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

## Over the tailnet (/bridge) — OT2-TAILNET-5

PRD: `docs/prds/OT2-TAILNET-5-EVERYTHING-OVER-TAILNET.md` §7.3 (S5/S6). Daemon **`ot2-bridge/1.1`** adds an optional **job server** so a browser on the tailnet can start the daemon's jobs (sweep, deck scan, tip calibration, tip swap, robot-server restart, auto-resume, test-scan) straight on the robot, with no Vercel hop:

```
browser ──https──▶ https://ot2-<slot>.tailf65a70.ts.net/bridge/…  (tailscale serve --set-path=/bridge)
                    └──▶ 127.0.0.1:31960  ot2-bridge.py job server ──▶ the SAME worker queue + handlers
```

- **One worker, one queue.** `/bridge` jobs and long-polled `Ot2BridgeCommand`s go into the same in-process queue and run one at a time on the same worker, through the same handlers. They never run concurrently.
- **Reports still go to BIMS.** A `/bridge` sweep posts progress to `/api/agent/ot2/jobs/<jobId>/progress` and its outcome to `/api/agent/ot2/jobs/<jobId>/result` (same `x-agent-api-key` auth as the commands routes), so `OpentronsScannerSweepRun` keeps updating with the browser closed. Queue commands still report to `/api/agent/ot2/commands/<id>/…`, unchanged.
- **Auth.** Every `/bridge` request needs `Authorization: Bearer <token>`: a 5-minute HMAC token from BIMS `GET /api/opentrons-lab/robots/<id>/bridge-token?kinds=…` (`manufacturing:write`, audit-logged, only when the robot is on the tailnet line in that deployment). It is signed with BIMS `OT2_BRIDGE_TOKEN_SECRET`; the robot verifies it with the same value as `BRIDGE_TOKEN_SECRET` in `/data/ot2-bridge/.env`. No/bad/expired token → **401**; a token for another robot or kind → **403**.
- **CORS.** Only the BIMS origins may read responses: production, `https://*-brevitest.vercel.app`, `http://localhost:*`, plus the origin of this robot's `BIMS_BASE_URL` and any `BRIDGE_ALLOWED_ORIGINS`.
- **Off by default.** With no `BRIDGE_TOKEN_SECRET` the job server never starts (no listening socket) and the daemon behaves exactly like 1.0. **B07 and R04 are untouched** until someone runs this section on them, and an old 1.0 daemon stays fully compatible with BIMS.

### Paths

Tailscale serve strips the mount point, so `https://…/bridge/jobs` arrives at the daemon as `/jobs`. The daemon accepts **both** forms (`/bridge/jobs` and `/jobs`), so it works whether or not a serve config forwards the prefix.

| Method + path | Body | Answer |
| --- | --- | --- |
| `GET /bridge/health` | — | `{ok, service:"ot2-bridge", version, jobServer, deviceId, robotId, heartbeat, heartbeatAgeS, serialOpen, serialPort, queue}` (any valid token, even `kinds: []`) |
| `POST /bridge/jobs` | `{kind, payload, jobId?}` | `202 {jobId, kind, status, position, duplicate:false}`; re-sending a known `jobId` → `200 {…, duplicate:true}` and it is **not** run twice |
| `GET /bridge/jobs/<id>` | — | `{jobId, kind, status: queued\|running\|completed\|failed\|cancelled, progress, result, error, queuePosition, …}` |
| `POST /bridge/jobs/<id>/control` | `{action: pause\|resume\|cancel}` | the job snapshot; `409` when not possible (pause/resume = sweeps only; a running non-sweep cannot be cancelled) |
| `POST /bridge/scan` | `{source?, contextRef?}` | `{scanId, barcode, rawPayload, error, eventPosted}`: one test-scan under the same `ScannerPort` lock, reported as a `ScannerEvent` |
| `OPTIONS *` | — | CORS preflight (incl. Chrome's `Access-Control-Allow-Private-Network`) for allowed origins; no token needed |

### Rollout: B14 first

Do **B14 only**. Leave B07 and R04 on the 1.0 daemon until this is approved for them (PRD R3).

1. **Secret.** Generate once per BIMS deployment and keep it out of git: `openssl rand -base64 48`. Set it as `OT2_BRIDGE_TOKEN_SECRET` in that deployment's Vercel env (Preview first; see PRD R4 on Production).
2. **Daemon.** Copy the new daemon to the robot (step 1 above: `scp -O scripts/ot2-bridge.py root@<robot>:/data/ot2-bridge/ot2-bridge.py`). Do not restart yet.
3. **Provision.** From a tailnet workstation:
   ```bash
   OT2_BRIDGE_TOKEN_SECRET='<the secret>' scripts/ot2-tailnet-provision.sh b14 --robot-id <B14's BIMS _id>
   # add --host <lan-ip> --key /tmp/ot2_key if Tailscale SSH is not available; --dry-run to preview
   ```
   It checks that tailscaled is `Running` and the daemon on disk is 1.1+; writes `BRIDGE_TOKEN_SECRET` (and `BRIDGE_ROBOT_ID`) into `/data/ot2-bridge/.env` (mode 600, over SSH stdin); applies both serve mounts:
   ```bash
   tailscale serve --bg --https=443 http://localhost:31950                         # robot API (TAILNET-3)
   tailscale serve --bg --https=443 --set-path=/bridge http://127.0.0.1:31960      # daemon job server
   ```
   It then restarts `ot2-bridge`, waits for the job server, and checks the 401 from your machine. `--install-unit` also installs the updated `ot2-tailscale.service`, which re-asserts both mounts on every tailscaled start (the `/bridge` mount only when `.env` holds a secret). `run.sh` already exports every `.env` variable, so `ot2-bridge.service` is unchanged.
4. **BIMS.** The robot record must be `connection.mode = 'tailnet'` with its `directUrl`, and the deployment's `OT2_TAILNET_ROBOT_IDS` must list it (the two-key gate). Then open `/opentrons/connectivity`: the **Daemon** column should show `✓ <ms>` and `ot2-bridge/1.1`.

### Smoke test (curl)

From any machine on the tailnet:

```bash
# 1. Without a token → 401 from the daemon (not 404/502).
curl -s -w '\n%{http_code}\n' https://ot2-b14.tailf65a70.ts.net/bridge/health
#   {"error": "missing bearer token", "service": "ot2-bridge"}
#   401

# 2. With a token → 200 + version. Mint one on the robot (same secret, 5 min):
TOKEN=$(ssh root@ot2-b14 'cd /data/ot2-bridge && set -a && . ./.env && set +a && python3 ot2-bridge.py --mint-token scan')
curl -s https://ot2-b14.tailf65a70.ts.net/bridge/health -H "Authorization: Bearer $TOKEN"
#   {"ok": true, "service": "ot2-bridge", "version": "ot2-bridge/1.1", "jobServer": true, …}

# 3. A job runs: one test-scan (point the scanner at a barcode first).
curl -s -X POST https://ot2-b14.tailf65a70.ts.net/bridge/scan -H "Authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' -d '{"source":"test"}'

# 4. Scope is enforced: the scan-only token cannot start a restart → 403.
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://ot2-b14.tailf65a70.ts.net/bridge/jobs \
     -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"kind":"restart_robot_server","payload":{}}'
```

A BIMS-minted token (from a signed-in browser: `/api/opentrons-lab/robots/<id>/bridge-token?kinds=scan`) works the same way.

Serial ordering (S5 AC) on the bench: start a queue sweep from a page on the queue line, then POST a `/bridge` `deck_scan` while it runs. `GET /bridge/health` shows the sweep as `queue.busy` and the deck scan in `queue.waiting`, and the deck scan starts only after the sweep finishes.

### Rollback

Remove the secret line and restart. The job server does not start, and the daemon is 1.0-equivalent again:

```bash
sed -i '/^BRIDGE_TOKEN_SECRET=/d; /^BRIDGE_ROBOT_ID=/d' /data/ot2-bridge/.env && systemctl restart ot2-bridge
/data/tailscale/tailscale --socket=/data/tailscale/tailscaled.sock serve --https=443 --set-path=/bridge off   # optional: drop the mount
```

Never run `tailscale serve reset`: it also removes the robot-API mount at `/`.

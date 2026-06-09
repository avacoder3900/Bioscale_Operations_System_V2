# Scanner Bridge → OT-2 R04 Deployment

Status notes for the Waveshare GM-class barcode scanner mounted on Opentron OT-2 **R04** (USB-3 port).

## Hardware

- **Scanner**: Waveshare USBScn Module / USBScn Chip — USB ID `0218:0212`, serial `2027300413413333`.
- **Host**: Opentron OT-2 R04 — hostname `OT2CEP20210817R04`, mDNS `OT2CEP20210817R04.local`, current IP `172.16.28.144` (lab subnet `172.16.28.0/24`).
- **Connection**: USB CDC ACM, mapped to `/dev/ttyACM0`. Driver: `cdc_acm`.

## Bridge target

- **BIMS prod URL** (active): `https://bioscale-operations-system-mongodb.vercel.app`
  - `POST /api/agent/scanner/event` and `POST /api/agent/scanner/triggers` both reachable (verified 405 on GET = exists).
- **Auth**: `AGENT_API_KEY` (same value used by mocreo / openclaw).

## Conflict warning — `/dev/ttyACM0` collision

R04's USB hub has previously enumerated a Particle Argon device (`2b04:c00c`) on the same `cdc_acm` driver. Both the Particle and the scanner claim `ttyACM0`. If both are plugged in, the second device gets `ttyACM1`. To eliminate the ordering risk we'll add a udev rule pinning the scanner to a stable `/dev/scanner` symlink — pending the systemd phase, since installing it requires remounting `/` rw.

## R04 filesystem layout

`/` is mounted **read-only** (typical Buildroot OT-2). Writable partitions:
- `/var` and `/data` — ext4 rw, both backed by `/dev/mmcblk0p6` (~14G total).
- `/root` — bind-mounted from the writable partition.

This means systemd units in `/etc/systemd/system/` and udev rules in `/etc/udev/rules.d/` require `mount -o remount,rw /` to install. Deferred until after physical smoke test.

## Files staged on R04 (`/data/scanner-bridge/`)

| Path | Mode | Owner | Notes |
| --- | --- | --- | --- |
| `scanner-bridge.py` | 644 | root | Copy of `scripts/scanner-bridge.py` from this repo |
| `.env` | 600 | root | Config — **`BIMS_AGENT_API_KEY` is a placeholder; must be filled before first run** |
| `run.sh` | 755 | root | Sources `.env`, validates API key, execs `python3 scanner-bridge.py` |

Python deps installed via `pip3 install --user`:
- `pyserial` 3.5 (was already present)
- `requests` 2.33.1 (newly installed)

**OT-2 pip quirk** — `pip install --user` writes to `/var/user-packages/root/.local/...` instead of the standard `/root/.local/...` that Python's `USER_SITE` resolves to. Without a symlink, `import requests` fails inside scripts. Fixed once with:
```bash
ln -sf /var/user-packages/root/.local /root/.local
```
This is in place on R04. Re-apply if a firmware update wipes it.

## Auth + heartbeat verified

API key set on R04, daemon ran for ~14s, two heartbeats arrived in BIMS Mongo (`scanner_events` collection, `deviceId=ot2-r04-scanner`). End-to-end network/auth path works. Daemon is **not** currently running — manual start required for next test.

To re-check what's in BIMS at any point: `npx tsx scripts/inspect-r04-scanner.ts`.

## SSH access

Private key checked into this repo: `docs/brevitest-opentrons-files-4-21/ot2_ssh_key`.

Stage with proper perms before use (key in repo is 644; SSH wants 600):
```bash
cp docs/brevitest-opentrons-files-4-21/ot2_ssh_key /tmp/ot2_key && chmod 600 /tmp/ot2_key
ssh -i /tmp/ot2_key root@172.16.28.144
```

For SCP, force legacy mode (OT-2 has no sftp-server):
```bash
scp -O -i /tmp/ot2_key <local> root@172.16.28.144:/data/scanner-bridge/
```

## Pending steps

1. ~~Set the API key~~ — done. Real `AGENT_API_KEY` written to `/data/scanner-bridge/.env`.
2. **Physical smoke test** — SSH to R04, run `/data/scanner-bridge/run.sh` (foreground), then in BIMS open `/manufacturing/opentron-control/scanner-test?deviceId=ot2-r04-scanner`. Heartbeats should appear within ~10s. Click "trigger" on the page and point the scanner at any barcode — the decoded value should land as a `scan` event.
3. **Wire into wax/reagent UIs** — `source` enum on `ScannerEvent` already reserves `wax_filling` / `reagent_filling`; UI integration not done yet.
4. **udev rule** for stable `/dev/scanner` symlink (resolves Particle/scanner collision).
5. **systemd unit** so the bridge auto-starts on boot.

## Quick-reference: chosen device identity

- `SCANNER_DEVICE_ID=ot2-r04-scanner`
- Multi-robot: each future robot gets its own `ot2-<slot>-scanner`.

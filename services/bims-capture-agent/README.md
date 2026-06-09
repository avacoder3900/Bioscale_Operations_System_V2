# bims-capture-agent

Pi-side Python service for the BIMS remote capture station. One agent process
per Raspberry Pi exposes the station's USB camera, USB barcode scanner, and
(optional) 365 nm UV LED to the BIMS `/capture` page via HTTP + WebSocket +
WebRTC.

See `docs/prds/PI-CAPTURE-STATION.md` for the full design. This README covers
how to run and install the agent.

## What it does

- `GET /health` — discovery + status endpoint polled by BIMS. Returns
  station identity, agent version, peripheral readiness flags, and uptime.
- `WS /ws` — single WebSocket per connected operator browser. Carries
  WebRTC signaling (Phase 2), scanner events (Phase 3), and LED commands
  (Phase 4). Phase 1 implements only ping/pong + auth.
- The Pi never writes to the BIMS database. Captured frames are grabbed by
  the operator's browser via WebRTC and POSTed to `/api/cv/capture` exactly
  as the local-camera flow does today.

## Stack

- Python 3.11 (default on Pi OS Bookworm)
- `aiohttp` — HTTP + WebSocket server
- `aiortc` — WebRTC for the camera track (Phase 2)
- `evdev` — barcode scanner input (Phase 3)
- `gpiozero` — LED GPIO control (Phase 4)
- `opencv-python` — camera frame capture

## Dev setup (on a Pi)

```bash
cd services/bims-capture-agent
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env   # then edit STATION_ID, STATION_NAME, STATION_TOKEN
python agent.py
```

The service binds `0.0.0.0:8765` by default. Override with `PORT=...`.

## Env file

In production the env file lives at `/etc/bims/station.env` (mode 0600,
owned by `root:bims`). `setup-station.sh` writes it on first boot. In dev
the agent also reads a local `.env` if present.

Required keys:

| Key | Purpose |
|---|---|
| `STATION_ID` | UUID assigned at provisioning time. Stable for the life of the SD card. |
| `STATION_NAME` | Human-friendly label, e.g. `"Wax Fill Bench 1"`. |
| `STATION_TOKEN` | Shared secret required in the `X-Station-Token` header on `/ws`. |
| `BIMS_URL` | Origin used for self-registration calls back to BIMS. |
| `PORT` | Optional; defaults to `8765`. |

## Production install (systemd)

```bash
sudo cp bims-capture-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bims-capture-agent
sudo journalctl -u bims-capture-agent -f
```

The unit expects the agent installed at `/opt/bims-capture-agent` with the
virtualenv at `/opt/bims-capture-agent/.venv`, and `/etc/bims/station.env`
populated. `setup-station.sh` handles both.

## Layout

```
services/bims-capture-agent/
  agent.py                       main aiohttp entry point
  camera.py                      WebRTC camera bridge (Phase 2)
  scanner.py                     evdev scanner reader (Phase 3)
  led.py                         GPIO/USB LED controller (Phase 4)
  requirements.txt
  bims-capture-agent.service     systemd unit
  setup-station.sh               first-boot configuration
  README.md
```

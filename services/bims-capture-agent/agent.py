"""bims-capture-agent — Pi-side service entry point.

Phase 1 implements only the HTTP /health endpoint used by BIMS for station
discovery. WebSocket signaling, camera, scanner, and LED handlers land in
later phases (see docs/prds/PI-CAPTURE-STATION.md §5).
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

from aiohttp import WSMsgType, web
from dotenv import load_dotenv

# Local sibling module — agent.py is run as a script, not as a package member.
import camera as camera_mod  # noqa: E402

__version__ = "0.1.0"

_HERE = Path(__file__).resolve().parent

# Prod env file is /etc/bims/station.env (written by setup-station.sh).
# Dev fallback is a local .env next to this file. Both are optional —
# missing files are fine; missing required keys surface on /health.
load_dotenv("/etc/bims/station.env")
load_dotenv(_HERE / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("bims-capture-agent")

_started_at = time.monotonic()


def _bool_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


async def health(_request: web.Request) -> web.Response:
    return web.json_response(
        {
            "station_id": os.environ.get("STATION_ID", ""),
            "station_name": os.environ.get("STATION_NAME", ""),
            "agent_version": __version__,
            "camera_ok": camera_mod.is_available(),
            "scanner_ok": False,
            "led_ok": False,
            "robot_arm_ok": False,
            "uptime_s": int(time.monotonic() - _started_at),
        }
    )


async def websocket(request: web.Request) -> web.WebSocketResponse:
    expected = os.environ.get("STATION_TOKEN", "")
    presented = request.headers.get("X-Station-Token", "")
    peer = request.remote or "?"

    ws = web.WebSocketResponse()

    if not expected or presented != expected:
        await ws.prepare(request)
        log.info("ws reject %s — bad/missing X-Station-Token", peer)
        # 4401 is an application-private close code mirroring HTTP 401.
        await ws.close(code=4401, message=b"unauthorized")
        return ws

    await ws.prepare(request)
    log.info("ws connect %s", peer)

    await ws.send_json(
        {
            "event": "hello",
            "station_id": os.environ.get("STATION_ID", ""),
            "agent_version": __version__,
        }
    )

    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    payload = json.loads(msg.data)
                except json.JSONDecodeError:
                    log.warning("ws %s sent non-JSON frame", peer)
                    continue

                cmd = payload.get("cmd")
                if cmd == "ping":
                    await ws.send_json(
                        {"event": "pong", "ts": int(time.time() * 1000)}
                    )
                elif cmd == "close":
                    await ws.close(code=1000, message=b"client requested")
                    break
                else:
                    log.debug("ws %s unhandled cmd=%r (Phase 1 stub)", peer, cmd)
            elif msg.type == WSMsgType.ERROR:
                log.warning("ws %s error: %s", peer, ws.exception())
    finally:
        log.info("ws disconnect %s", peer)

    return ws


def build_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/health", health)
    app.router.add_get("/ws", websocket)
    return app


def main() -> None:
    port = int(os.environ.get("PORT", "8765"))
    log.info("starting bims-capture-agent v%s on 0.0.0.0:%d", __version__, port)
    if camera_mod.probe():
        log.info("camera ready")
    else:
        log.warning("camera not available — /health will report camera_ok=false")
    web.run_app(build_app(), host="0.0.0.0", port=port, print=None)


if __name__ == "__main__":
    main()

"""bims-capture-agent — Pi-side service entry point.

Phase 1 implements only the HTTP /health endpoint used by BIMS for station
discovery. WebSocket signaling, camera, scanner, and LED handlers land in
later phases (see docs/prds/PI-CAPTURE-STATION.md §5).
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path

from aiohttp import web
from dotenv import load_dotenv

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
            "camera_ok": False,
            "scanner_ok": False,
            "led_ok": False,
            "robot_arm_ok": False,
            "uptime_s": int(time.monotonic() - _started_at),
        }
    )


def build_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/health", health)
    return app


def main() -> None:
    port = int(os.environ.get("PORT", "8765"))
    log.info("starting bims-capture-agent v%s on 0.0.0.0:%d", __version__, port)
    web.run_app(build_app(), host="0.0.0.0", port=port, print=None)


if __name__ == "__main__":
    main()

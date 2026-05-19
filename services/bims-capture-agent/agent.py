"""bims-capture-agent — Pi-side service entry point.

HTTP /health for station discovery + WebSocket /ws for the per-operator
session. /ws carries WebRTC SDP offer/answer + ICE candidates (Phase 2)
and (Phase 3) scanner events. Scanner + LED modules wire in over the
same socket. See docs/prds/PI-CAPTURE-STATION.md §5.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Set

from aiohttp import WSMsgType, web
from aiortc import RTCIceCandidate, RTCPeerConnection, RTCSessionDescription
from dotenv import load_dotenv

# Local sibling modules — agent.py is run as a script, not as a package member.
import camera as camera_mod  # noqa: E402
import scanner as scanner_mod  # noqa: E402

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

# Connected operator browsers. Scanner events fan out to every member.
#
# PRD §11 says the multi-tenant invariant is "one operator per station at a
# time" — but that lock is enforced server-side by BIMS on station-select
# (POST /api/cv/stations/[id]/lock). The Pi has no view into who's logged
# in, so we broadcast to every authenticated WS peer. If a second tab from
# the same operator connects (legitimate per PRD §6.3), both see the scan;
# if a misbehaving second operator somehow bypasses the BIMS lock, they
# also see scans — but they shouldn't be connected in the first place.
_ws_clients: Set[web.WebSocketResponse] = set()


def _bool_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


async def health(_request: web.Request) -> web.Response:
    return web.json_response(
        {
            "station_id": os.environ.get("STATION_ID", ""),
            "station_name": os.environ.get("STATION_NAME", ""),
            "agent_version": __version__,
            "camera_ok": camera_mod.is_available(),
            "scanner_ok": scanner_mod.is_available(),
            "led_ok": False,
            "robot_arm_ok": False,
            "uptime_s": int(time.monotonic() - _started_at),
        }
    )


def _ws_token_ok(request: web.Request) -> bool:
    """Validate STATION_TOKEN from header or query string.

    Browser WebSocket constructors can't set custom headers, so the BIMS
    frontend passes the token in ?token=<value>. Native clients (curl,
    Python test rigs) can still use the X-Station-Token header.
    """
    expected = os.environ.get("STATION_TOKEN", "")
    if not expected:
        return False
    header = request.headers.get("X-Station-Token", "")
    query = request.query.get("token", "")
    return header == expected or query == expected


def _parse_ice_candidate(payload: dict) -> RTCIceCandidate | None:
    """Decode the candidate dict the browser ships over the WS into aiortc form.

    The browser sends RTCIceCandidateInit-shaped objects:
      {candidate: "candidate:...", sdpMid: "0", sdpMLineIndex: 0}
    aiortc.RTCIceCandidate wants the parsed SDP a-line components.
    """
    cand_str = payload.get("candidate") or ""
    if not cand_str.startswith("candidate:"):
        return None
    # SDP candidate line layout, RFC 5245 §15.1:
    # candidate:<foundation> <component> <transport> <priority> <ip> <port>
    # typ <type> [raddr <ip> rport <port>] ...
    parts = cand_str[len("candidate:"):].split()
    if len(parts) < 8 or parts[6] != "typ":
        return None
    try:
        return RTCIceCandidate(
            foundation=parts[0],
            component=int(parts[1]),
            protocol=parts[2].lower(),
            priority=int(parts[3]),
            ip=parts[4],
            port=int(parts[5]),
            type=parts[7],
            sdpMid=payload.get("sdpMid"),
            sdpMLineIndex=payload.get("sdpMLineIndex"),
        )
    except (ValueError, IndexError):
        return None


async def websocket(request: web.Request) -> web.WebSocketResponse:
    peer = request.remote or "?"
    ws = web.WebSocketResponse()

    if not _ws_token_ok(request):
        await ws.prepare(request)
        log.info("ws reject %s — bad/missing station token", peer)
        # 4401 is an application-private close code mirroring HTTP 401.
        await ws.close(code=4401, message=b"unauthorized")
        return ws

    await ws.prepare(request)
    _ws_clients.add(ws)
    log.info("ws connect %s (clients=%d)", peer, len(_ws_clients))

    await ws.send_json(
        {
            "event": "hello",
            "station_id": os.environ.get("STATION_ID", ""),
            "agent_version": __version__,
        }
    )

    # One peer connection per WebSocket session. Closed on disconnect.
    pc: RTCPeerConnection | None = None

    async def teardown_pc() -> None:
        nonlocal pc
        if pc is not None:
            try:
                await pc.close()
            except Exception:
                log.exception("error closing peer connection for %s", peer)
            pc = None

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
                elif cmd == "sdp_offer":
                    sdp = payload.get("sdp")
                    if not sdp:
                        log.warning("ws %s sdp_offer missing sdp field", peer)
                        continue
                    await teardown_pc()
                    pc = RTCPeerConnection()

                    @pc.on("connectionstatechange")
                    async def _on_pc_state() -> None:
                        if pc is not None:
                            log.info(
                                "ws %s pc state -> %s",
                                peer,
                                pc.connectionState,
                            )

                    track = camera_mod.get_camera_track()
                    if track is None:
                        await ws.send_json(
                            {
                                "event": "error",
                                "code": "no_camera",
                                "message": "camera not available",
                            }
                        )
                        await teardown_pc()
                        continue
                    pc.addTrack(track)

                    await pc.setRemoteDescription(
                        RTCSessionDescription(sdp=sdp, type="offer")
                    )
                    answer = await pc.createAnswer()
                    await pc.setLocalDescription(answer)
                    # aiortc gathers all ICE candidates synchronously during
                    # setLocalDescription, so the answer SDP carries them
                    # inline — no separate trickle from the agent is needed.
                    await ws.send_json(
                        {
                            "event": "sdp_answer",
                            "sdp": pc.localDescription.sdp,
                        }
                    )
                elif cmd == "ice_candidate":
                    candidate_payload = payload.get("candidate")
                    if pc is None or not isinstance(candidate_payload, dict):
                        continue
                    candidate = _parse_ice_candidate(candidate_payload)
                    if candidate is None:
                        log.debug("ws %s skipped unparseable ICE candidate", peer)
                        continue
                    try:
                        await pc.addIceCandidate(candidate)
                    except Exception:
                        log.exception("ws %s failed to add ICE candidate", peer)
                else:
                    log.debug("ws %s unhandled cmd=%r", peer, cmd)
            elif msg.type == WSMsgType.ERROR:
                log.warning("ws %s error: %s", peer, ws.exception())
    finally:
        await teardown_pc()
        _ws_clients.discard(ws)
        log.info("ws disconnect %s (clients=%d)", peer, len(_ws_clients))

    return ws


async def _broadcast_scans() -> None:
    """Forward each barcode scan to every connected WebSocket client.

    Each send is guarded so one dead client can't stall the broadcast for
    the rest. Dead clients are dropped from the set on the next handler
    iteration when their /ws coroutine unwinds.
    """
    queue = scanner_mod.event_queue()
    while True:
        code = await queue.get()
        message = {"event": "scan", "code": code, "ts": int(time.time() * 1000)}
        for ws in list(_ws_clients):
            if ws.closed:
                _ws_clients.discard(ws)
                continue
            try:
                await ws.send_json(message)
            except Exception:
                log.exception("failed to forward scan to a client; dropping")
                _ws_clients.discard(ws)


async def _on_startup(app: web.Application) -> None:
    await scanner_mod.start()
    app["scan_broadcaster"] = asyncio.create_task(
        _broadcast_scans(), name="bims-scan-broadcaster"
    )


async def _on_cleanup(app: web.Application) -> None:
    task = app.get("scan_broadcaster")
    if task is not None:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass


def build_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/health", health)
    app.router.add_get("/ws", websocket)
    app.on_startup.append(_on_startup)
    app.on_cleanup.append(_on_cleanup)
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

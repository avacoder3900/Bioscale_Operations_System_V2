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
import subprocess
import time
from pathlib import Path
from typing import Set

import jwt as pyjwt
from aiohttp import ClientSession, ClientTimeout, WSMsgType, web
from aiortc import RTCIceCandidate, RTCPeerConnection, RTCSessionDescription
from dotenv import load_dotenv

# Local sibling modules — agent.py is run as a script, not as a package member.
import camera as camera_mod  # noqa: E402
import preview as preview_mod  # noqa: E402
import scanner as scanner_mod  # noqa: E402
import sequence as sequence_mod  # noqa: E402

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

# Set by a {cmd: "trigger_scan"} from the operator's browser (Space on the
# capture page). The next barcode the scanner emits is broadcast tagged
# triggered=True so the UI knows it's the answer to that Space-press and can
# run scan → auto-capture. A single global flag mirrors the broadcast model
# in _broadcast_scans: the BIMS one-operator-per-station lock (PRD §11)
# guarantees at most one driving client, so per-client arming buys nothing.
_scan_armed = False


def _bool_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


async def _broadcast(message: dict) -> None:
    """Fan a JSON event out to every connected operator browser.

    Same dead-client-guarding model as _broadcast_scans. Used by the sequence
    engine for sequence_progress / sequence_done / sequence_error events.
    """
    for ws in list(_ws_clients):
        if ws.closed:
            _ws_clients.discard(ws)
            continue
        try:
            await ws.send_json(message)
        except Exception:
            log.exception("failed to broadcast to a client; dropping")
            _ws_clients.discard(ws)


async def health(_request: web.Request) -> web.Response:
    # `capabilities` lets the /capture UI feature-gate. The timed microscope
    # sequence engine is always compiled in, so "sequence" is always advertised;
    # the browser still checks camera_ok before offering the Start button.
    return web.json_response(
        {
            "station_id": os.environ.get("STATION_ID", ""),
            "station_name": os.environ.get("STATION_NAME", ""),
            "agent_version": __version__,
            "camera_ok": camera_mod.is_available(),
            "camera_profile": camera_mod.profile(),
            "scanner_ok": scanner_mod.is_available(),
            "led_ok": False,
            "robot_arm_ok": False,
            "capabilities": ["sequence"],
            "uptime_s": int(time.monotonic() - _started_at),
        }
    )


class _AuthOutcome:
    __slots__ = ("ok", "claims", "close_code", "close_reason")

    def __init__(
        self,
        ok: bool,
        *,
        claims: dict | None = None,
        close_code: int = 4401,
        close_reason: bytes = b"unauthorized",
    ) -> None:
        self.ok = ok
        self.claims = claims or {}
        self.close_code = close_code
        self.close_reason = close_reason


def _ws_authenticate(request: web.Request) -> _AuthOutcome:
    """Verify the per-session JWT presented on /ws.

    The BIMS frontend hands the operator a station-scoped HS256 JWT minted
    server-side and forwards it in ?token=<jwt>. Native clients (test rigs,
    curl) may use the X-Station-Token header instead — browsers can't set
    custom headers on the WebSocket constructor, but everything else can.

    Signing secret comes from STATION_JWT_SECRET, written into station.env
    during station registration. An empty secret is a configuration error
    and we reject all connections rather than fail open.
    """
    secret = os.environ.get("STATION_JWT_SECRET", "")
    if not secret:
        log.warning(
            "STATION_JWT_SECRET is empty — rejecting all /ws connections"
        )
        return _AuthOutcome(False, close_reason=b"server misconfigured")

    presented = request.query.get("token") or request.headers.get(
        "X-Station-Token", ""
    )
    if not presented:
        return _AuthOutcome(False, close_reason=b"missing token")

    try:
        claims = pyjwt.decode(presented, secret, algorithms=["HS256"])
    except pyjwt.ExpiredSignatureError:
        return _AuthOutcome(False, close_reason=b"token expired")
    except pyjwt.InvalidTokenError as exc:
        log.info("ws reject %s — invalid JWT: %s", request.remote or "?", exc)
        return _AuthOutcome(False, close_reason=b"unauthorized")

    return _AuthOutcome(True, claims=claims)


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

    auth = _ws_authenticate(request)
    if not auth.ok:
        await ws.prepare(request)
        # 4401 is an application-private close code mirroring HTTP 401.
        await ws.close(code=auth.close_code, message=auth.close_reason)
        return ws

    await ws.prepare(request)
    _ws_clients.add(ws)
    operator = auth.claims.get("operatorUsername") or auth.claims.get("sub") or "?"
    log.info(
        "ws connect %s operator=%s (clients=%d)",
        peer,
        operator,
        len(_ws_clients),
    )

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
                elif cmd == "trigger_scan":
                    # Operator pressed Space: arm the agent so the *next*
                    # barcode read is forwarded tagged triggered=True, and
                    # drop any reads already queued so a stale sighting can't
                    # satisfy this trigger. The Waveshare is a keyboard-wedge
                    # (input-only over HID) — we can't electrically pulse its
                    # trigger — so "trigger_scan" means "the next physical read
                    # belongs to this Space-press."
                    global _scan_armed
                    dropped = scanner_mod.drain_pending()
                    _scan_armed = True
                    await ws.send_json(
                        {
                            "event": "scan_armed",
                            "dropped": dropped,
                            "ts": int(time.time() * 1000),
                        }
                    )
                elif cmd == "sequence_start":
                    # Timed microscope run: grab N full-res stills on an
                    # interval, spool + upload each to /api/cv/capture-ingest,
                    # stream sequence_progress events back. Rejected (error
                    # event) if a run is already active or cartridgeId missing.
                    ok, result = await sequence_mod.manager.start(
                        cartridge_id=payload.get("cartridgeId"),
                        count=payload.get("count"),
                        interval_ms=payload.get("intervalMs"),
                        grab_still=camera_mod.grab_still,
                        broadcast=_broadcast,
                    )
                    if ok:
                        # Ack with the sequenceId so the UI can wire Abort
                        # immediately (before the first sequence_progress).
                        await ws.send_json(
                            {"event": "sequence_started", "sequenceId": result}
                        )
                    else:
                        await ws.send_json(
                            {"event": "sequence_error", "message": result}
                        )
                elif cmd == "sequence_abort":
                    sequence_mod.manager.abort()
                    await ws.send_json(
                        {
                            "event": "sequence_aborting",
                            "sequenceId": sequence_mod.manager.current_id,
                        }
                    )
                elif cmd == "get_camera_params":
                    # Remote camera tuning: browser asks for current values
                    # to populate slider defaults on first open. Returns
                    # every CAP_PROP the agent knows about, with whatever
                    # value cv2 reports back (often 0 for unsupported props,
                    # which the UI can use to skip / hide the slider).
                    params = camera_mod.get_camera_params()
                    # Cached after startup-warm, so this is normally instant.
                    # Run it off-loop anyway as a safety net: a cold-cache call
                    # would shell out to v4l2-ctl and must never block the loop
                    # mid-stream. Safe in a thread — it doesn't touch cv2.
                    ranges = await asyncio.to_thread(camera_mod.get_camera_ranges)
                    await ws.send_json(
                        {
                            "event": "camera_params",
                            "params": params,
                            "known": camera_mod.known_param_names(),
                            # Real per-control min/max/step (from V4L2 when
                            # available) so the sliders span the camera's true
                            # editable range, not our advisory guess.
                            "ranges": ranges,
                        }
                    )
                elif cmd == "set_camera_param":
                    # Adjust one CAP_PROP and echo back the value the
                    # camera reports after the set (may differ from the
                    # request due to driver clamping). Browser updates its
                    # slider position to the actual value.
                    prop = payload.get("prop")
                    value = payload.get("value")
                    if not isinstance(prop, str) or not isinstance(value, (int, float)):
                        await ws.send_json(
                            {
                                "event": "error",
                                "code": "bad_set_camera_param",
                                "message": "prop (string) and value (number) required",
                            }
                        )
                        continue
                    actual = camera_mod.set_camera_param(prop, float(value))
                    if actual is None:
                        await ws.send_json(
                            {
                                "event": "error",
                                "code": "set_camera_param_failed",
                                "message": f"prop {prop!r} unknown or set rejected",
                            }
                        )
                    else:
                        await ws.send_json(
                            {
                                "event": "camera_param_set",
                                "prop": prop,
                                "value": actual,
                            }
                        )
                elif cmd == "admin_restart":
                    # Story F1: BIMS admin asks the agent to restart itself.
                    # The known-good workaround for the singleton-track RTP
                    # wedge — one click on /cv/stations/[id] beats SSH + sudo
                    # systemctl restart from every operator.
                    if not auth.claims.get("admin"):
                        await ws.send_json(
                            {
                                "event": "error",
                                "code": "forbidden",
                                "message": "admin claim required",
                            }
                        )
                        continue
                    log.warning(
                        "admin restart requested by operator=%s peer=%s",
                        operator,
                        peer,
                    )
                    await ws.send_json(
                        {
                            "event": "restart_pending",
                            "ts": int(time.time() * 1000),
                        }
                    )
                    await ws.close(code=1000, message=b"restart")
                    # Detach so systemctl can kill this process without
                    # waiting on us. The /etc/sudoers.d/bims-capture-agent
                    # drop-in lets the bims user run this one command
                    # without a password. systemd brings us back within 5s.
                    subprocess.Popen(  # noqa: S603,S607
                        [
                            "sudo",
                            "-n",
                            "systemctl",
                            "restart",
                            "bims-capture-agent",
                        ],
                        start_new_session=True,
                    )
                    return ws
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


async def _heartbeat_loop() -> None:
    """Phone home to BIMS every HEARTBEAT_INTERVAL_S so the dashboard
    knows we're alive.

    POST /api/cv/stations/{STATION_ID}/heartbeat with the same payload
    shape as /health (cameraOk, scannerOk, ledOk, uptimeS, agentVersion).
    BIMS bumps lastSeenAt + status; the read-time deriveStatus helper
    coerces a station to 'offline' if three consecutive heartbeats are
    missed (90 s threshold).

    Logs network/HTTP failures at WARNING and keeps looping — a transient
    BIMS outage or DNS hiccup must not knock the agent over.

    Per docs/prds/PI-STATION-ADMIN-AND-LIFECYCLE.md story C3.
    """
    bims_url = os.environ.get("BIMS_URL", "").rstrip("/")
    station_id = os.environ.get("STATION_ID", "").strip()
    agent_key = os.environ.get("STATION_AGENT_KEY", "").strip()

    if not bims_url or not station_id or not agent_key:
        log.warning(
            "heartbeat disabled — missing one of BIMS_URL / STATION_ID / "
            "STATION_AGENT_KEY"
        )
        return

    interval_s = float(os.environ.get("HEARTBEAT_INTERVAL_S", "30"))
    url = f"{bims_url}/api/cv/stations/{station_id}/heartbeat"
    headers = {
        "Content-Type": "application/json",
        "x-station-agent-key": agent_key,
    }

    log.info(
        "heartbeat loop starting — every %.0fs to %s", interval_s, url
    )

    timeout = ClientTimeout(total=10)
    async with ClientSession(timeout=timeout) as session:
        while True:
            body = {
                "cameraOk": camera_mod.is_available(),
                "scannerOk": scanner_mod.is_available(),
                "ledOk": False,
                "uptimeS": int(time.monotonic() - _started_at),
                "agentVersion": __version__,
            }
            try:
                async with session.post(url, json=body, headers=headers) as resp:
                    if resp.status == 204:
                        log.debug("heartbeat ok")
                    else:
                        text = await resp.text()
                        log.warning(
                            "heartbeat returned HTTP %d: %s",
                            resp.status,
                            text[:200],
                        )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("heartbeat failed: %s", exc)

            try:
                await asyncio.sleep(interval_s)
            except asyncio.CancelledError:
                raise


async def _broadcast_scans() -> None:
    """Forward each barcode scan to every connected WebSocket client.

    Each send is guarded so one dead client can't stall the broadcast for
    the rest. Dead clients are dropped from the set on the next handler
    iteration when their /ws coroutine unwinds.
    """
    global _scan_armed
    queue = scanner_mod.event_queue()
    while True:
        code = await queue.get()
        # Consume the armed flag: this read is the answer to the operator's
        # Space-press, so tag it and disarm. Untriggered reads (a direct pull
        # of the scanner's own trigger) broadcast with triggered=False and the
        # UI treats them as a plain cartridge lock.
        triggered = _scan_armed
        _scan_armed = False
        message = {
            "event": "scan",
            "code": code,
            "triggered": triggered,
            "ts": int(time.time() * 1000),
        }
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
    # Warm the V4L2 control-range cache off the event loop, before we accept
    # any client. get_camera_ranges() shells out to `v4l2-ctl` the first time;
    # if that ran inline during a session (it's triggered by get_camera_params
    # on connect) it blocked the loop long enough to stall WebRTC and drop the
    # video ~1s after it started. Warming here makes the in-session call a cache
    # hit. v4l2-ctl doesn't touch the cv2 capture, so a worker thread is safe.
    try:
        await asyncio.to_thread(camera_mod.get_camera_ranges)
    except Exception:
        log.exception("warming camera ranges failed (non-fatal)")
    app["scan_broadcaster"] = asyncio.create_task(
        _broadcast_scans(), name="bims-scan-broadcaster"
    )
    app["heartbeat"] = asyncio.create_task(
        _heartbeat_loop(), name="bims-heartbeat"
    )
    # PREVIEW=local renders the camera full-screen on the station's own
    # display — sensor→screen, no encode, no network (the latency floor).
    if os.environ.get("PREVIEW", "").strip().lower() == "local":
        preview_mod.run_local_preview(camera_mod.grab_still)


async def _on_cleanup(app: web.Application) -> None:
    # Stop any in-flight sequence run before tearing the loop down.
    await sequence_mod.manager.shutdown()
    for key in ("scan_broadcaster", "heartbeat"):
        task = app.get(key)
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
    # Low-latency MJPEG live preview (no WebRTC negotiation, no VP8) —
    # <img src="https://<station>/preview.mjpg?token=<station JWT>"> renders
    # natively via Tailscale Serve. Same JWT validation as /ws.
    preview_mod.attach_mjpeg_route(
        app, camera_mod.grab_still, lambda req: _ws_authenticate(req).ok
    )
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

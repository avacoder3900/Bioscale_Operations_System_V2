"""
FastAPI server for the SO-100 / SO-ARM100 arm pair.

Two responsibilities:

  1. Direct control of the FOLLOWER (jog/move/torque/pose endpoints) —
     used by the old BIMS Direct Control UI, the CLI, and ad-hoc scripts.

  2. Leader-follower teleop / record / replay sessions — what the
     existing /manufacturing/robot-arm/control page POSTs to. The page
     forms map onto /teleop/start, /record/start, /replay/start,
     /sessions/active, /sessions/stop. A single LeaderFollowerSession
     can be active at a time; concurrent /start requests get 409.

Webhook: every session emits {kind}.start / {kind}.complete /
{kind}.failed / {kind}.cancelled events to BIMS_WEBHOOK_URL with
header `x-agent-api-key: $AGENT_API_KEY`. The BIMS sacred receiver
upserts a RobotArmRun and appends the event.

Run:
    cd services/robot-arm
    .venv/bin/uvicorn server.app:app --app-dir src --host 0.0.0.0 --port 8765 --reload

Env:
    LEADER_PORT          serial port for the leader arm
    FOLLOWER_PORT        serial port for the follower arm
    ROBOT_ARM_BAUD       baud rate (default 1000000)
    ROBOT_ARM_API_KEY    if set, every request must carry x-api-key
    BIMS_WEBHOOK_URL     where to POST session events
                         (default http://localhost:5177/api/robot-arm/webhook)
    AGENT_API_KEY        x-agent-api-key for the webhook
"""

from __future__ import annotations

import asyncio
import json
import os
import queue
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from arm.driver import (
    DEFAULT_BAUD,
    POS_MAX,
    POS_MIN,
    ArmDriver,
    ServoState,
)
from arm.leader_follower import LeaderFollowerSession
from arm.recordings import list_recordings as list_recordings_files
from arm.recordings import load_recording as load_recording_file

POSE_FILE = Path(
    os.environ.get("BIMS_ARM_POSE_FILE", str(Path.home() / ".bims-arm" / "poses.json"))
)
SERVICE_VERSION = "0.2.0"

DEFAULT_LEADER_PORT = "/dev/cu.usbmodem5C4C1269591"
DEFAULT_FOLLOWER_PORT = "/dev/cu.usbmodem5C4C1280501"

BIMS_WEBHOOK_URL = os.environ.get(
    "BIMS_WEBHOOK_URL", "http://localhost:5177/api/robot-arm/webhook"
)

# Background ping every N seconds so /health can flip leader_connected /
# follower_connected to false when the bus is dead — without this, a
# USB unplug leaves the FastAPI port handles open and /health stays
# falsely positive. See NEXT_STEPS.md #6.
LIVENESS_PROBE_INTERVAL_S = float(os.environ.get("ROBOT_ARM_PROBE_INTERVAL_S", "5"))


class _State:
    leader: Optional[ArmDriver] = None
    follower: Optional[ArmDriver] = None
    lock: Optional[asyncio.Lock] = None  # serializes blocking driver calls (follower)
    active_session: Optional[LeaderFollowerSession] = None
    session_lock: Optional[asyncio.Lock] = None  # serializes /start /stop
    leader_alive: bool = False
    follower_alive: bool = False
    probe_tasks: list = []  # asyncio.Task; populated in lifespan


state = _State()


# Webhook delivery is async on a dedicated daemon thread so a slow BIMS
# can't slow the 30 Hz teleop loop. Producers (the session thread,
# `_emit_to_bims`) push events to _webhook_queue; the drainer thread
# POSTs with retry + exponential backoff. Queue is bounded so a long
# BIMS outage doesn't grow memory unboundedly — overflow drops the
# oldest event and logs (events are advisory; the run record itself is
# rebuildable from the final terminal event). See NEXT_STEPS.md #7.
WEBHOOK_QUEUE_MAX = int(os.environ.get("ROBOT_ARM_WEBHOOK_QUEUE_MAX", "256"))
WEBHOOK_RETRY_DELAYS_S = [1.0, 2.0, 4.0]
_webhook_queue: "queue.Queue[dict]" = queue.Queue(maxsize=WEBHOOK_QUEUE_MAX)
_webhook_stop = threading.Event()
_webhook_thread: Optional[threading.Thread] = None


def _emit_to_bims(event: dict) -> None:
    """Producer: enqueue an event for the drainer thread to POST.

    Called from the session thread. Never blocks more than a no-op queue
    put. On overflow, drops the oldest queued event to make room — the
    most recent event is more useful for live state than a stale one.
    """
    if _webhook_queue.full():
        try:
            dropped = _webhook_queue.get_nowait()
            print(
                f"[webhook] queue full ({WEBHOOK_QUEUE_MAX}); dropped oldest event "
                f"{dropped.get('type')} for run {dropped.get('run_id')}",
                flush=True,
            )
        except queue.Empty:
            pass
    try:
        _webhook_queue.put_nowait(event)
    except queue.Full:
        print(f"[webhook] failed to enqueue event {event.get('type')}", flush=True)


def _webhook_post_once(event: dict, api_key: str) -> tuple[bool, str]:
    """One POST attempt. Returns (ok, reason). Caller handles retry."""
    try:
        with httpx.Client(timeout=5.0) as client:
            resp = client.post(
                BIMS_WEBHOOK_URL,
                json={"run_id": event["run_id"], "event": event},
                headers={"x-agent-api-key": api_key},
            )
        if resp.status_code < 400:
            return True, ""
        # 4xx is a client error — retrying won't help (auth, bad payload,
        # finalized run). Don't burn retry budget on it.
        if 400 <= resp.status_code < 500:
            return False, f"client error {resp.status_code}: {resp.text[:200]}"
        return False, f"server error {resp.status_code}: {resp.text[:200]}"
    except Exception as exc:
        return False, f"exception: {exc}"


def _webhook_drainer() -> None:
    """Background daemon: pop events, POST with retry."""
    api_key = os.environ.get("AGENT_API_KEY", "")
    if not api_key:
        print("[webhook] AGENT_API_KEY not set — drainer running but every event will drop")
    while not _webhook_stop.is_set():
        try:
            event = _webhook_queue.get(timeout=0.5)
        except queue.Empty:
            continue
        if not api_key:
            print(f"[webhook] no api key — dropping event {event.get('type')}", flush=True)
            _webhook_queue.task_done()
            continue
        ok, reason = _webhook_post_once(event, api_key)
        if not ok:
            # 4xx -> don't retry; 5xx / network -> retry with backoff
            if reason.startswith("client error"):
                print(f"[webhook] {reason}; not retrying (event {event.get('type')})", flush=True)
            else:
                for delay in WEBHOOK_RETRY_DELAYS_S:
                    if _webhook_stop.wait(delay):
                        break
                    ok, reason = _webhook_post_once(event, api_key)
                    if ok:
                        break
                if not ok:
                    print(
                        f"[webhook] gave up after {len(WEBHOOK_RETRY_DELAYS_S)} retries "
                        f"on {event.get('type')} for {event.get('run_id')}: {reason}",
                        flush=True,
                    )
        _webhook_queue.task_done()


def _resolve_port(env_path: str, env_serial: str, default_path: str) -> str:
    """Pick a serial-port device node.

    Priority:
      1. Chip-serial match (env var like LEADER_CHIP_SERIAL=5C4C126959)
         — scan pyserial's list_ports for a device whose serial_number
         matches; return its node. Survives cable reseats that renumber
         /dev/cu.usbmodem*.
      2. Explicit device path (env var LEADER_PORT=/dev/cu.usbmodem...)
         — used as-is.
      3. Hard-coded default (DEFAULT_LEADER_PORT etc.).

    See NEXT_STEPS.md #3.
    """
    serial_target = os.environ.get(env_serial, "").strip()
    if serial_target:
        try:
            from serial.tools import list_ports
        except Exception as exc:
            print(f"[arm-server] {env_serial} set but pyserial.list_ports unavailable: {exc}")
        else:
            for p in list_ports.comports():
                # pyserial's serial_number is the chip's USB serial. macOS
                # device nodes look like /dev/cu.usbmodem<serial><iface#>
                # so we substring-match to be robust to the trailing digit.
                sn = (p.serial_number or "").strip()
                if sn and (sn == serial_target or serial_target in sn or sn in serial_target):
                    print(f"[arm-server] {env_serial}={serial_target} resolved to {p.device}")
                    return p.device
            print(
                f"[arm-server] {env_serial}={serial_target} not found among "
                f"{[p.device for p in list_ports.comports()]}; falling back"
            )
    return os.environ.get(env_path, default_path)


async def _liveness_probe(driver_attr: str, alive_attr: str, lock: Optional[asyncio.Lock]) -> None:
    """Ping driver.servo_ids[0] every LIVENESS_PROBE_INTERVAL_S; flip alive flag on failure.

    Skipped while a session is active — the session's own bus traffic
    serves as the liveness signal, and a concurrent probe would race
    with sync_read/sync_write on the same port. On the follower we
    share state.lock with direct-control endpoints; the leader has no
    direct-control surface so no lock is required.
    """
    while True:
        try:
            await asyncio.sleep(LIVENESS_PROBE_INTERVAL_S)
            driver = getattr(state, driver_attr)
            if driver is None:
                setattr(state, alive_attr, False)
                continue
            sess = state.active_session
            if sess is not None and sess.is_active():
                continue
            try:
                if lock is not None:
                    async with lock:
                        await asyncio.to_thread(driver.ping, driver.servo_ids[0])
                else:
                    await asyncio.to_thread(driver.ping, driver.servo_ids[0])
                if not getattr(state, alive_attr):
                    print(f"[arm-server] {driver_attr} probe recovered")
                setattr(state, alive_attr, True)
            except Exception as exc:
                if getattr(state, alive_attr):
                    print(f"[arm-server] {driver_attr} probe failed: {exc}")
                setattr(state, alive_attr, False)
        except asyncio.CancelledError:
            return


@asynccontextmanager
async def lifespan(_: FastAPI):
    leader_port = _resolve_port("LEADER_PORT", "LEADER_CHIP_SERIAL", DEFAULT_LEADER_PORT)
    follower_port = _resolve_port("FOLLOWER_PORT", "FOLLOWER_CHIP_SERIAL", DEFAULT_FOLLOWER_PORT)
    baud = int(os.environ.get("ROBOT_ARM_BAUD", str(DEFAULT_BAUD)))

    # Follower is required; leader is best-effort (CLI/jog still works without it).
    state.follower = ArmDriver(port=follower_port, baud=baud)
    state.follower.open()
    state.follower_alive = True
    print(f"[arm-server] FOLLOWER open on {follower_port} @ {baud}")
    try:
        state.leader = ArmDriver(port=leader_port, baud=baud)
        state.leader.open()
        # ping at least one servo to confirm the bus is alive
        state.leader.ping(state.leader.servo_ids[0])
        state.leader_alive = True
        print(f"[arm-server] LEADER   open on {leader_port} @ {baud}")
    except Exception as exc:
        if state.leader is not None:
            try:
                state.leader.close()
            except Exception:
                pass
        state.leader = None
        state.leader_alive = False
        print(f"[arm-server] LEADER unavailable: {exc}  (teleop/record will 503)")

    state.lock = asyncio.Lock()
    state.session_lock = asyncio.Lock()

    # Background liveness probes — one per port. follower probe shares
    # state.lock with direct-control endpoints; leader has no shared lock.
    state.probe_tasks = [
        asyncio.create_task(_liveness_probe("leader", "leader_alive", None)),
        asyncio.create_task(_liveness_probe("follower", "follower_alive", state.lock)),
    ]

    # Webhook drainer thread — async POSTs so slow BIMS doesn't block the 30 Hz loop.
    global _webhook_thread
    _webhook_stop.clear()
    _webhook_thread = threading.Thread(
        target=_webhook_drainer, name="bims-webhook-drainer", daemon=True
    )
    _webhook_thread.start()

    try:
        yield
    finally:
        for t in state.probe_tasks:
            t.cancel()
        await asyncio.gather(*state.probe_tasks, return_exceptions=True)
        # graceful: if a session is still running, ask it to stop
        if state.active_session is not None and state.active_session.is_active():
            print("[arm-server] cancelling active session on shutdown...")
            state.active_session.stop(timeout=3.0)
        # Drain webhook queue with a short window so terminal events make it out.
        _webhook_stop.set()
        if _webhook_thread is not None:
            _webhook_thread.join(timeout=3.0)
            if _webhook_thread.is_alive():
                print(
                    f"[webhook] drainer didn't finish in 3 s — "
                    f"{_webhook_queue.qsize()} event(s) dropped"
                )
        if state.follower is not None:
            state.follower.close()
        if state.leader is not None:
            state.leader.close()
        print("[arm-server] both ports closed")


async def require_api_key(x_api_key: Optional[str] = Header(None)) -> None:
    expected = os.environ.get("ROBOT_ARM_API_KEY")
    if not expected:
        return  # auth disabled when no key configured (dev mode)
    if x_api_key != expected:
        raise HTTPException(status_code=401, detail="invalid x-api-key")


app = FastAPI(title="bims-robot-arm", version=SERVICE_VERSION, lifespan=lifespan)


# --- request / response models ---------------------------------------------


class ServoStateResponse(BaseModel):
    id: int
    position: int
    speed: int
    load: int
    voltage: float
    temperature: int
    torque: bool


class JogRequest(BaseModel):
    delta_steps: int = Field(..., ge=-POS_MAX, le=POS_MAX)
    speed: Optional[int] = Field(None, ge=0, le=1023)


class MoveOneRequest(BaseModel):
    position: int = Field(..., ge=POS_MIN, le=POS_MAX)
    speed: Optional[int] = Field(None, ge=0, le=1023)


class MoveAllRequest(BaseModel):
    positions: list[int] = Field(..., min_length=6, max_length=6)
    speed: Optional[int] = Field(None, ge=0, le=1023)


class TorqueRequest(BaseModel):
    enable: bool


class TriggeredBy(BaseModel):
    _id: Optional[str] = None
    username: Optional[str] = None


class TeleopStartRequest(BaseModel):
    rate_hz: Optional[int] = Field(None, ge=1, le=100)
    duration_s: Optional[float] = Field(None, ge=0.1)
    triggered_by: Optional[dict] = None
    lot_id: Optional[str] = None
    manufacturing_step: Optional[str] = None
    recorded_during_run_id: Optional[str] = None


class RecordStartRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    rate_hz: Optional[int] = Field(None, ge=1, le=100)
    duration_s: Optional[float] = Field(None, ge=0.1)
    triggered_by: Optional[dict] = None
    lot_id: Optional[str] = None
    manufacturing_step: Optional[str] = None
    recorded_during_run_id: Optional[str] = None


class ReplayStartRequest(BaseModel):
    source: str = Field(..., min_length=1)
    loops: Optional[int] = Field(1, ge=1, le=100)
    triggered_by: Optional[dict] = None
    lot_id: Optional[str] = None
    manufacturing_step: Optional[str] = None
    recorded_during_run_id: Optional[str] = None
    # When true the server runs the preflight check inline and rejects
    # the start with 409 if it fails. tolerance_steps is forwarded to
    # the check. Off by default to preserve legacy behavior.
    enforce_preflight: bool = False
    preflight_tolerance_steps: Optional[int] = Field(None, ge=0, le=POS_MAX)


class PreflightRequest(BaseModel):
    source: str = Field(..., min_length=1)
    tolerance_steps: int = Field(50, ge=0, le=POS_MAX)


class PreflightResult(BaseModel):
    ready: bool
    leader_alive: bool
    follower_alive: bool
    expected: dict[int, int]
    actual: dict[int, int]
    deltas: dict[int, int]
    tolerance_steps: int
    issues: list[str]


class PoseInfo(BaseModel):
    name: str
    positions: list[int]
    saved_at: float


class SessionInfo(BaseModel):
    run_id: str
    kind: str
    started_at: Optional[float]
    rate_hz: int
    duration_s: Optional[float]
    active: bool


# --- helpers ----------------------------------------------------------------


def _follower() -> ArmDriver:
    if state.follower is None:
        raise HTTPException(status_code=503, detail="follower arm not connected")
    return state.follower


def _leader_required() -> ArmDriver:
    if state.leader is None:
        raise HTTPException(
            status_code=503,
            detail="leader arm not connected — only direct-control endpoints are available",
        )
    return state.leader


def _state_to_response(s: ServoState, torque: bool) -> ServoStateResponse:
    return ServoStateResponse(
        id=s.id,
        position=s.position,
        speed=s.speed,
        load=s.load,
        voltage=s.voltage,
        temperature=s.temperature,
        torque=torque,
    )


def _read_poses() -> dict[str, dict]:
    if not POSE_FILE.exists():
        return {}
    try:
        raw = json.loads(POSE_FILE.read_text())
    except Exception:
        return {}
    out: dict[str, dict] = {}
    for name, value in raw.items():
        if isinstance(value, list):
            out[name] = {"positions": value, "saved_at": 0.0}
        else:
            out[name] = value
    return out


def _write_poses(poses: dict[str, dict]) -> None:
    POSE_FILE.parent.mkdir(parents=True, exist_ok=True)
    POSE_FILE.write_text(json.dumps(poses, indent=2))


async def _with_follower(fn, *args, **kwargs):
    assert state.lock is not None
    if state.active_session is not None and state.active_session.is_active():
        raise HTTPException(
            status_code=409,
            detail=f"a {state.active_session.kind} session is active — stop it first",
        )
    async with state.lock:
        return await asyncio.to_thread(fn, *args, **kwargs)


def _require_servo(sid: int) -> None:
    if sid not in _follower().servo_ids:
        raise HTTPException(status_code=404, detail=f"servo {sid} not on bus")


# --- core: health + servo state ---------------------------------------------


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "service": "bims-robot-arm",
        "version": SERVICE_VERSION,
        # Reflect the last liveness-probe result, not just "did we open at boot."
        # Probe runs every LIVENESS_PROBE_INTERVAL_S; a USB unplug shows up
        # within that window.
        "leader_connected": state.leader is not None and state.leader_alive,
        "follower_connected": state.follower is not None and state.follower_alive,
        "probe_interval_s": LIVENESS_PROBE_INTERVAL_S,
        "active_session": state.active_session.run_id
        if state.active_session and state.active_session.is_active()
        else None,
    }


@app.get(
    "/servos",
    response_model=list[ServoStateResponse],
    dependencies=[Depends(require_api_key)],
)
async def list_servos() -> list[ServoStateResponse]:
    follower = _follower()
    states = await asyncio.to_thread(follower.list_states)
    torques = await asyncio.to_thread(follower.get_torques)
    return [_state_to_response(s, torques.get(s.id, False)) for s in states]


@app.get(
    "/servos/{sid}",
    response_model=ServoStateResponse,
    dependencies=[Depends(require_api_key)],
)
async def get_servo(sid: int) -> ServoStateResponse:
    _require_servo(sid)
    s = await asyncio.to_thread(_follower().get_state, sid)
    t = await asyncio.to_thread(_follower().get_torque, sid)
    return _state_to_response(s, t)


# --- direct control (follower jog/move/torque/poses) ------------------------


@app.post("/servos/{sid}/jog", dependencies=[Depends(require_api_key)])
async def jog_servo(sid: int, req: JogRequest) -> dict:
    _require_servo(sid)
    follower = _follower()
    if not await _with_follower(follower.get_torque, sid):
        raise HTTPException(status_code=409, detail=f"torque off on servo {sid}")
    new_pos = await _with_follower(follower.jog, sid, req.delta_steps, speed=req.speed)
    return {"id": sid, "goal": new_pos}


@app.post("/servos/{sid}/move", dependencies=[Depends(require_api_key)])
async def move_servo(sid: int, req: MoveOneRequest) -> dict:
    _require_servo(sid)
    follower = _follower()
    if not await _with_follower(follower.get_torque, sid):
        raise HTTPException(status_code=409, detail=f"torque off on servo {sid}")
    await _with_follower(follower.set_position, sid, req.position, speed=req.speed)
    return {"id": sid, "goal": req.position}


@app.post("/servos/positions", dependencies=[Depends(require_api_key)])
async def set_all_positions(req: MoveAllRequest) -> dict:
    follower = _follower()
    torques = await _with_follower(follower.get_torques)
    off = [sid for sid, on in torques.items() if not on]
    if off:
        raise HTTPException(status_code=409, detail=f"torque off on {off}")
    goals = dict(zip(follower.servo_ids, req.positions))
    await _with_follower(follower.set_positions, goals, speed=req.speed)
    return {"goals": goals}


@app.post("/home", dependencies=[Depends(require_api_key)])
async def go_home() -> dict:
    poses = _read_poses()
    if "home" not in poses:
        raise HTTPException(status_code=404, detail="no 'home' pose saved")
    follower = _follower()
    torques = await _with_follower(follower.get_torques)
    off = [sid for sid, on in torques.items() if not on]
    if off:
        raise HTTPException(status_code=409, detail=f"torque off on {off}")
    positions = poses["home"]["positions"]
    goals = dict(zip(follower.servo_ids, positions))
    await _with_follower(follower.set_positions, goals)
    return {"moving_to": positions}


@app.post("/e-stop", dependencies=[Depends(require_api_key)])
async def e_stop() -> dict:
    # E-stop should work even mid-session — cancel the session first.
    if state.active_session is not None and state.active_session.is_active():
        await asyncio.to_thread(state.active_session.stop)
    await asyncio.to_thread(_follower().e_stop)
    return {"torque": False, "warning": "arm may sag under gravity"}


@app.post("/pause", dependencies=[Depends(require_api_key)])
async def pause() -> dict:
    follower = _follower()
    torques = await _with_follower(follower.get_torques)
    off = [sid for sid, on in torques.items() if not on]
    if off:
        raise HTTPException(status_code=409, detail=f"torque off on {off}")
    await _with_follower(follower.pause)
    return {"status": "paused"}


@app.post("/torque", dependencies=[Depends(require_api_key)])
async def set_torque(req: TorqueRequest) -> dict:
    await _with_follower(_follower().set_torque_all, req.enable)
    return {"enabled": req.enable}


@app.post(
    "/poses/{name}",
    dependencies=[Depends(require_api_key)],
    status_code=201,
)
async def save_pose(name: str) -> PoseInfo:
    follower = _follower()
    positions_map = await _with_follower(follower.get_positions)
    positions = [positions_map[sid] for sid in follower.servo_ids]
    poses = _read_poses()
    poses[name] = {"positions": positions, "saved_at": time.time()}
    _write_poses(poses)
    return PoseInfo(name=name, positions=positions, saved_at=poses[name]["saved_at"])


@app.get("/poses", dependencies=[Depends(require_api_key)])
async def list_poses() -> list[PoseInfo]:
    poses = _read_poses()
    return [
        PoseInfo(name=n, positions=v["positions"], saved_at=v.get("saved_at", 0.0))
        for n, v in poses.items()
    ]


@app.post("/poses/{name}/move", dependencies=[Depends(require_api_key)])
async def goto_pose(name: str) -> dict:
    poses = _read_poses()
    if name not in poses:
        raise HTTPException(status_code=404, detail=f"no pose named '{name}'")
    follower = _follower()
    torques = await _with_follower(follower.get_torques)
    off = [sid for sid, on in torques.items() if not on]
    if off:
        raise HTTPException(status_code=409, detail=f"torque off on {off}")
    positions = poses[name]["positions"]
    goals = dict(zip(follower.servo_ids, positions))
    await _with_follower(follower.set_positions, goals)
    return {"name": name, "moving_to": positions}


@app.delete("/poses/{name}", dependencies=[Depends(require_api_key)])
async def delete_pose(name: str) -> dict:
    poses = _read_poses()
    if name not in poses:
        raise HTTPException(status_code=404, detail=f"no pose named '{name}'")
    del poses[name]
    _write_poses(poses)
    return {"deleted": name}


# --- leader-follower sessions: teleop / record / replay ---------------------


def _new_run_id() -> str:
    # short id, easy to spot in logs / BIMS UI
    return "arm-" + uuid.uuid4().hex[:10]


async def _start_session(kind: str, params: dict, triggered_by: Optional[dict]) -> dict:
    if state.session_lock is None:
        raise HTTPException(status_code=503, detail="server not yet ready")

    leader = state.leader  # may be None
    follower = state.follower

    if kind in ("teleop", "record") and leader is None:
        raise HTTPException(
            status_code=503,
            detail="leader arm not connected — teleop/record require both arms",
        )
    if follower is None:
        raise HTTPException(status_code=503, detail="follower arm not connected")

    async with state.session_lock:
        if state.active_session is not None and state.active_session.is_active():
            raise HTTPException(
                status_code=409,
                detail=f"a {state.active_session.kind} session "
                f"({state.active_session.run_id}) is already active",
            )
        run_id = _new_run_id()
        sess = LeaderFollowerSession(
            run_id=run_id,
            kind=kind,
            leader=leader if leader is not None else follower,  # replay doesn't use leader
            follower=follower,
            params=params,
            on_event=_emit_to_bims,
            triggered_by=triggered_by,
        )
        state.active_session = sess
        # start in a worker thread so the event-loop returns immediately
        await asyncio.to_thread(sess.start)
        return {"run_id": run_id, "kind": kind}


def _provenance(req) -> dict:
    return {
        "lot_id": req.lot_id,
        "manufacturing_step": req.manufacturing_step,
        "recorded_during_run_id": req.recorded_during_run_id,
    }


@app.post("/teleop/start", dependencies=[Depends(require_api_key)])
async def teleop_start(req: TeleopStartRequest) -> dict:
    _leader_required()
    return await _start_session(
        "teleop",
        {"rate_hz": req.rate_hz, "duration_s": req.duration_s, **_provenance(req)},
        req.triggered_by,
    )


@app.post("/record/start", dependencies=[Depends(require_api_key)])
async def record_start(req: RecordStartRequest) -> dict:
    _leader_required()
    return await _start_session(
        "record",
        {
            "name": req.name,
            "rate_hz": req.rate_hz,
            "duration_s": req.duration_s,
            **_provenance(req),
        },
        req.triggered_by,
    )


async def _run_preflight(source: str, tolerance_steps: int) -> PreflightResult:
    """Read first frame of `source` and compare against current follower pose."""
    follower = _follower()
    frames = await asyncio.to_thread(load_recording_file, source)
    if not frames:
        raise HTTPException(status_code=400, detail=f"recording '{source}' is empty")
    raw_first = frames[0].get("positions", {}) or {}
    expected = {int(sid): int(p) for sid, p in raw_first.items()}
    actual = await _with_follower(follower.get_positions)
    deltas = {sid: int(actual.get(sid, 0)) - expected.get(sid, 0) for sid in expected}
    issues: list[str] = []
    if not state.follower_alive:
        issues.append("follower liveness probe last failed")
    over = {sid: d for sid, d in deltas.items() if abs(d) > tolerance_steps}
    if over:
        issues.append(
            f"joints {sorted(over.keys())} exceed {tolerance_steps}-step tolerance "
            f"(deltas {over}) — operator must home the follower first"
        )
    return PreflightResult(
        ready=not issues,
        leader_alive=state.leader_alive,
        follower_alive=state.follower_alive,
        expected=expected,
        actual=actual,
        deltas=deltas,
        tolerance_steps=tolerance_steps,
        issues=issues,
    )


@app.post(
    "/replay/preflight",
    response_model=PreflightResult,
    dependencies=[Depends(require_api_key)],
)
async def replay_preflight(req: PreflightRequest) -> PreflightResult:
    return await _run_preflight(req.source, req.tolerance_steps)


@app.post("/replay/start", dependencies=[Depends(require_api_key)])
async def replay_start(req: ReplayStartRequest) -> dict:
    if req.enforce_preflight:
        pre = await _run_preflight(
            req.source,
            req.preflight_tolerance_steps if req.preflight_tolerance_steps is not None else 50,
        )
        if not pre.ready:
            raise HTTPException(
                status_code=409,
                detail={"preflight_failed": True, "issues": pre.issues, "deltas": pre.deltas},
            )
    return await _start_session(
        "replay",
        {"source": req.source, "loops": req.loops, **_provenance(req)},
        req.triggered_by,
    )


@app.get("/sessions/active", dependencies=[Depends(require_api_key)])
async def sessions_active() -> dict:
    sess = state.active_session
    if sess is None or not sess.is_active():
        return {"active": None}
    return {"active": {"run_id": sess.run_id, "kind": sess.kind}}


@app.post("/sessions/stop", dependencies=[Depends(require_api_key)])
async def sessions_stop() -> dict:
    sess = state.active_session
    if sess is None or not sess.is_active():
        return {"stopped_run_id": None}
    run_id = sess.run_id
    await asyncio.to_thread(sess.stop)
    return {"stopped_run_id": run_id}


@app.get("/ports/status", dependencies=[Depends(require_api_key)])
async def ports_status() -> dict:
    sess = state.active_session
    active_info = (
        {"run_id": sess.run_id, "kind": sess.kind}
        if sess and sess.is_active()
        else None
    )
    return {
        "leader": {
            "port": state.leader.port_name if state.leader else "",
            "present": state.leader is not None,
            "in_use": active_info is not None and sess.kind in ("teleop", "record"),
        },
        "follower": {
            "port": state.follower.port_name if state.follower else "",
            "present": state.follower is not None,
            "in_use": True,
        },
        "active": active_info,
    }


@app.get("/recordings", dependencies=[Depends(require_api_key)])
async def recordings() -> dict:
    files = list_recordings_files()
    # the BIMS client expects RFC-3339-ish modified strings
    out = []
    for r in files:
        out.append(
            {
                "name": r["name"],
                "path": r["path"],
                "size_bytes": r["size_bytes"],
                "modified": time.strftime(
                    "%Y-%m-%dT%H:%M:%S", time.localtime(r["modified"])
                ),
                # Sidecar meta (lot/step/operator/...) when present; null
                # for legacy recordings without a sidecar.
                "meta": r.get("meta"),
            }
        )
    return {"recordings": out}

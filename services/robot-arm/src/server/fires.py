"""
Fire steps without the arm — a move set that is only fire steps (trapdoor
solenoids and/or the conveyor belt) plays here instead of through the replay.

Why (2026-11-04): a replay needs the follower servos, so a fires-only move set
did nothing with the arm's power unplugged, although the pins live on the Pi.
This plays the same `{t, pin, ms}` schedule BIMS would have put in the
recording, through the same pulse functions the replay uses, and never opens
the servo bus.

Endpoints (auth is applied by app.py when the router is included):
    POST /fires/play     {fires: [{t, pin, ms, solenoid?}], title?}  -> {run_id, duration_s}
    GET  /fires/status   {active: run_id | null, last: {...}}
    POST /fires/stop     cancel whatever has not fired; a pulse in progress ends early

Rules:
  * Solenoid pins (gpio.ALLOWED_PINS, GPIO 17 / 27) go through
    gpio.pulse_blocking: its coil lock keeps two trapdoors from opening at once
    and its 2 s cap applies. The conveyor pin (conveyor.PIN, GPIO 22 = Pin 15)
    goes through conveyor.pulse_blocking on its own timer, so a long belt pulse
    never delays a trapdoor (replay_settle.FireTimer, same as a replay).
  * One fire run at a time (409). A fire that fails (bad pin, busy, out of
    range) is recorded and the run goes on.
"""

from __future__ import annotations

import threading
import time
import uuid
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/fires", tags=["fires"])

MAX_FIRES = 200
MAX_T_S = 3600.0


class FireIn(BaseModel):
    t: float = Field(..., ge=0, le=MAX_T_S)
    pin: int
    ms: int = Field(..., ge=1)
    solenoid: Optional[str] = None


class PlayRequest(BaseModel):
    fires: List[FireIn] = Field(..., min_length=1, max_length=MAX_FIRES)
    title: Optional[str] = None


class _Run:
    def __init__(self) -> None:
        self.run_id: Optional[str] = None
        self.title: Optional[str] = None
        self.started: float = 0.0
        self.duration_s: float = 0.0
        self.halt = threading.Event()
        self.timers: list = []
        self.watcher: Optional[threading.Thread] = None
        self.results: list[dict] = []
        self.ended: Optional[float] = None

    @property
    def active(self) -> bool:
        return self.watcher is not None and self.watcher.is_alive()


_run = _Run()
_lock = threading.Lock()


def _pulsers():
    from src.server import conveyor as belt
    from src.server import gpio as solenoid_gpio

    return belt.PIN, belt.pulse_blocking, set(solenoid_gpio.ALLOWED_PINS), solenoid_gpio.pulse_blocking


@router.post("/play")
async def fires_play(req: PlayRequest) -> dict:
    from src.hardware.replay_settle import FireTimer, fire_schedule

    belt_pin, belt_pulse, coil_pins, coil_pulse = _pulsers()
    for f in req.fires:
        if f.pin != belt_pin and f.pin not in coil_pins:
            raise HTTPException(status_code=400, detail=f"GPIO {f.pin} is not a solenoid or the conveyor belt")
    with _lock:
        if _run.active:
            raise HTTPException(status_code=409, detail="fire steps are already playing")
        frames = [{"t": f.t, "fire": {"pin": f.pin, "ms": f.ms, "solenoid": f.solenoid}} for f in req.fires]
        fires = fire_schedule(frames)
        belt_fires = [f for f in fires if f["pin"] == belt_pin]
        coil_fires = [f for f in fires if f["pin"] != belt_pin]
        _run.run_id = f"fires-{uuid.uuid4().hex[:10]}"
        _run.title = req.title
        _run.halt = threading.Event()
        _run.results = []
        _run.ended = None
        _run.duration_s = max(f["t"] + f["ms"] / 1000.0 for f in fires)
        _run.started = time.perf_counter()
        _run.timers = []
        if coil_fires:
            _run.timers.append(FireTimer(coil_fires, _run.started, _run.halt, coil_pulse, 1))
        if belt_fires:
            _run.timers.append(FireTimer(belt_fires, _run.started, _run.halt, belt_pulse, 1))
        for t in _run.timers:
            t.start()

        timers = list(_run.timers)

        def watch() -> None:
            for t in timers:
                t.join()
            for t in timers:
                _run.results.extend(t.results)
            _run.ended = time.time()
            print(f"[fires] {_run.run_id} done: {len(_run.results)} result(s)", flush=True)

        _run.watcher = threading.Thread(target=watch, name="fires-watch", daemon=True)
        _run.watcher.start()
        print(f"[fires] {_run.run_id} playing {len(fires)} fire(s) over {_run.duration_s:.1f} s", flush=True)
        return {"run_id": _run.run_id, "duration_s": round(_run.duration_s, 3), "fires": len(fires)}


@router.get("/status")
async def fires_status() -> dict:
    return {
        "active": _run.run_id if _run.active else None,
        "last": None
        if _run.run_id is None
        else {
            "run_id": _run.run_id,
            "title": _run.title,
            "duration_s": round(_run.duration_s, 3),
            "elapsed_s": round(time.perf_counter() - _run.started, 3),
            "done": not _run.active,
            "results": _run.results,
        },
    }


@router.post("/stop")
async def fires_stop() -> dict:
    was = _run.run_id if _run.active else None
    _run.halt.set()
    if _run.watcher is not None:
        _run.watcher.join(2.0)
    return {"stopped_run_id": was}

"""
Conveyor belt GPIO for the robot-arm service (wax fill cooling belt).

The belt motor's enable line hangs off BCM 22 (physical pin 15). This module
is the ONLY owner of that pin inside the service. It is kept apart from
gpio.py on purpose: the solenoids have a 2 s cap and share one lock because of
the 12 V inrush, and neither rule applies to the belt, which can run for a
long time.

Endpoints (auth is applied by app.py when the router is included):
    GET  /conveyor/status        {pin, state, running, ends_in_ms, simulated, ...}
    POST /conveyor/pulse         {ms: 600, delay_ms: 0}
    POST /conveyor/stop          belt off now, cancels a pending delay too
    POST /conveyor/off           Force Off: one write driving the pin low

Move-set conveyor steps (2026-11-04): replay_settle.py fires a `fire` frame
whose pin is CONVEYOR_GPIO_PIN through pulse_blocking() below, on its own
timer thread, so a long belt pulse never delays a trapdoor solenoid.
replay_settle.install() sets REPLAY_FIRE_SUPPORTED (GET /conveyor/status ->
replay_fire), and BIMS refuses to play a conveyor step on a Pi without it.

A pulse is fire-and-forget: /pulse answers as soon as the pulse is scheduled,
and the belt is switched off by a background task. That is what lets a pulse
run longer than BIMS's 30 s request budget. Poll /status to see it finish.

Safety rules, enforced here regardless of what the caller sends:
  * Only CONVEYOR_GPIO_PIN (default 22) is driven.
  * A pulse is capped at CONVEYOR_MAX_PULSE_MS (default 600000, 10 min), and
    every on() is paired with off() in a finally, so a cancelled or failed
    task still leaves the belt off.
  * One pulse at a time: a second /pulse while one is pending or running
    gets 409. /stop always works.
  * The belt is switched off at interpreter exit (atexit), which covers a
    `systemctl restart robot-arm`.

Hardware access goes through gpiozero (lgpio backend on Pi 5 / Bookworm), the
same as gpio.py. Without it (dev laptop, CI) the module runs SIMULATED:
timing is honoured, nothing is driven, and responses say simulated=true.
"""

from __future__ import annotations

import asyncio
import atexit
import os
import threading
import time
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/conveyor", tags=["conveyor"])

# ---------------------------------------------------------------- config

PIN = int(os.environ.get("CONVEYOR_GPIO_PIN", "22"))
if not (0 <= PIN <= 27):
    raise ValueError(f"CONVEYOR_GPIO_PIN out of range: {PIN}")
MAX_PULSE_MS = int(os.environ.get("CONVEYOR_MAX_PULSE_MS", "600000"))
MIN_PULSE_MS = 10
MAX_DELAY_MS = 600000

#: Set by replay_settle.install(): the replay fires conveyor `fire` frames.
REPLAY_FIRE_SUPPORTED = False
#: Held while the replay's timer drives the belt (pulse_blocking).
_replay_lock = threading.Lock()

# ---------------------------------------------------------------- backend

class _Backend:
    """Owns the output device. Lazy: nothing is claimed until first use."""

    def __init__(self) -> None:
        self._device = None
        self._sim_state = 0
        self._simulated: Optional[bool] = None  # unknown until first open

    def _ensure_open(self) -> None:
        if self._simulated is not None:
            return
        try:
            from gpiozero import DigitalOutputDevice  # type: ignore

            # initial_value=False -> pin driven LOW on claim: belt off.
            self._device = DigitalOutputDevice(PIN, active_high=True, initial_value=False)
            self._simulated = False
            print(f"[conveyor] claimed BCM {PIN} via gpiozero", flush=True)
        except Exception as exc:  # ImportError, BadPinFactory, pin busy...
            self._device = None
            self._simulated = True
            print(f"[conveyor] SIMULATED (no hardware GPIO): {exc}", flush=True)

    @property
    def simulated(self) -> bool:
        self._ensure_open()
        return bool(self._simulated)

    def state(self) -> int:
        self._ensure_open()
        if self._simulated:
            return self._sim_state
        return int(bool(self._device.value))  # type: ignore[union-attr]

    def on(self) -> None:
        self._ensure_open()
        if self._simulated:
            self._sim_state = 1
            return
        self._device.on()  # type: ignore[union-attr]

    def off(self) -> None:
        if self._simulated is None:
            return  # never opened: nothing to turn off
        if self._simulated:
            self._sim_state = 0
            return
        try:
            self._device.off()  # type: ignore[union-attr]
        except Exception as exc:
            print(f"[conveyor] off failed on BCM {PIN}: {exc}", flush=True)

    def force_low(self) -> None:
        """Drive the pin low, claiming it first if nothing has yet."""
        self._ensure_open()
        if self._simulated:
            self._sim_state = 0
            return
        self._device.off()  # type: ignore[union-attr]

    def close(self) -> None:
        self.off()
        if self._device is not None:
            try:
                self._device.close()
            except Exception:
                pass
        self._device = None
        self._simulated = None


_backend = _Backend()
atexit.register(_backend.off)


class _Job:
    """The one pending-or-running pulse, if any."""

    def __init__(self) -> None:
        self.task: Optional[asyncio.Task] = None
        self.ms = 0
        self.delay_ms = 0
        self.started_at = 0.0   # monotonic, when /pulse was accepted
        self.on_at: Optional[float] = None  # monotonic, when the belt went on

    @property
    def active(self) -> bool:
        return self.task is not None and not self.task.done()


_job = _Job()


def all_off() -> None:
    """Stop the belt and cancel any pending pulse. Safe to call from anywhere."""
    if _job.active:
        _job.task.cancel()  # type: ignore[union-attr]
    _backend.off()


def close() -> None:
    """Release the GPIO line."""
    all_off()
    _backend.close()


def pulse_blocking(pin: int, ms: int, stop_event: Optional[threading.Event] = None, wait_s: float = 0.0) -> dict:
    """Run the belt from a worker thread (the replay's conveyor fire timer).

    Drives the belt pin (GPIO 22 = Pin 15 by default) high for ms, then low;
    a set stop_event ends it early.
    Refuses (never raises) when the pin is wrong, ms is out of range, or a
    pulse from the page is already running, so a replay is never killed by
    the belt. Same return shape as gpio.pulse_blocking.
    """
    if pin != PIN:
        return {"ok": False, "pin": pin, "ms": ms, "error": f"pin must be {PIN}"}
    if not (MIN_PULSE_MS <= ms <= MAX_PULSE_MS):
        return {"ok": False, "pin": pin, "ms": ms, "error": f"ms must be {MIN_PULSE_MS}..{MAX_PULSE_MS}"}
    if _job.active:
        return {"ok": False, "pin": pin, "ms": ms, "error": "a conveyor pulse from the page is running"}
    if not _replay_lock.acquire(timeout=wait_s):
        return {"ok": False, "pin": pin, "ms": ms, "error": "the previous conveyor step is still running"}
    t0 = time.monotonic()
    try:
        _backend.on()
        try:
            if stop_event is not None:
                stop_event.wait(ms / 1000.0)
            else:
                time.sleep(ms / 1000.0)
        finally:
            _backend.off()
    except Exception as exc:  # hardware error: report it, the replay goes on
        return {"ok": False, "pin": pin, "ms": ms, "error": str(exc), "simulated": _backend.simulated}
    finally:
        _replay_lock.release()
    return {"ok": True, "pin": pin, "ms": ms, "simulated": _backend.simulated, "elapsed_ms": int((time.monotonic() - t0) * 1000)}


async def _run(delay_ms: int, ms: int) -> None:
    try:
        if delay_ms > 0:
            await asyncio.sleep(delay_ms / 1000.0)
        _backend.on()
        _job.on_at = time.monotonic()
        await asyncio.sleep(ms / 1000.0)
    finally:
        _backend.off()


# ---------------------------------------------------------------- models

class PulseRequest(BaseModel):
    ms: int = Field(600, ge=MIN_PULSE_MS, le=MAX_PULSE_MS)
    delay_ms: int = Field(0, ge=0, le=MAX_DELAY_MS)


# ---------------------------------------------------------------- routes

def _status() -> dict:
    now = time.monotonic()
    running = _job.active
    phase = None
    ends_in_ms = None
    if running:
        if _job.on_at is None:
            phase = "delay"
            ends_in_ms = int((_job.started_at + (_job.delay_ms + _job.ms) / 1000.0 - now) * 1000)
        else:
            phase = "on"
            ends_in_ms = int((_job.on_at + _job.ms / 1000.0 - now) * 1000)
        ends_in_ms = max(0, ends_in_ms)
    return {
        "pin": PIN,
        "state": _backend.state(),
        "running": running,
        "phase": phase,
        "ms": _job.ms if running else None,
        "delay_ms": _job.delay_ms if running else None,
        "ends_in_ms": ends_in_ms,
        "max_pulse_ms": MAX_PULSE_MS,
        "simulated": _backend.simulated,
        "replay_busy": _replay_lock.locked(),
        "replay_fire": REPLAY_FIRE_SUPPORTED,
    }


@router.get("/status")
async def conveyor_status() -> dict:
    return _status()


@router.post("/pulse")
async def conveyor_pulse(req: PulseRequest) -> dict:
    if _job.active or _replay_lock.locked():
        raise HTTPException(status_code=409, detail="a conveyor pulse is already in progress")
    _job.ms = req.ms
    _job.delay_ms = req.delay_ms
    _job.started_at = time.monotonic()
    _job.on_at = None
    _job.task = asyncio.create_task(_run(req.delay_ms, req.ms))
    # Let a zero-delay pulse switch the belt on before answering, so the
    # status in the response is the real one.
    await asyncio.sleep(0)
    return _status()


@router.post("/stop")
async def conveyor_stop() -> dict:
    was_running = _job.active
    all_off()
    if _job.task is not None:
        try:
            await _job.task
        except (asyncio.CancelledError, Exception):
            pass
    return {**_status(), "stopped": was_running}


@router.post("/off")
async def conveyor_force_off() -> dict:
    """One write: BCM 22 low. Leaves any pulse task alone (use /stop for that)."""
    _backend.force_low()
    return _status()

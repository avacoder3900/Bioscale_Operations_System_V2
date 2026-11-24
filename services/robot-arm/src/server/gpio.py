"""
Solenoid GPIO for the robot-arm service (cartridge chute).

Two low-side solenoid channels hang off the Pi's GPIO through the UCC27524
driver board: BCM 17 and BCM 27. This module is the ONLY owner of those pins
inside the service, so /e-stop and shutdown can always force them low, and so
no second process fights the service for the libgpiod line handles.

Endpoints (auth is applied by app.py when the router is included):
    GET  /gpio/status            {pins: {"17": {state: 0|1, last_on: {...}}}, simulated, busy, read_at}
    GET  /gpio/events?since=     every pin change, GPIO 22 too (gpio_events.py, 2026-11-24)
    POST /gpio/pulse             {pin: 17, ms: 1000}
    POST /gpio/sequence          {pins: [17, 27], ms: 1000, gap_ms: 500}

Safety rules, enforced here regardless of what the caller sends:
  * Only pins in SOLENOID_GPIO_PINS (default "17,27") can be driven.
  * A pulse is capped at MAX_PULSE_MS (2000). A coil is never left on: every
    on() is paired with off() in a finally, and all_off() is called on e-stop
    and shutdown.
  * Pulses are serialized with a lock. A second request while one is in
    progress gets 409 rather than overlapping, because the 12 V supply cannot
    carry two inrushes at once (bench finding, 2026-10-15).
  * Pulses use asyncio.sleep, never time.sleep, so the 30 Hz teleop thread and
    the webhook drainer are never blocked.
  * One coil at a time, across EVERY caller (2026-10-28): the REST routes and
    the replay's fire timer (BIMS Animate fire steps, replay_settle.py) share
    _coil_lock, a threading.Lock. The asyncio lock alone could not see the
    replay thread, and both trapdoors open together drops the whole cartridge
    stack. REST callers get 409 while it is held; the replay waits its turn.

Replay fire steps: replay_settle.install() sets REPLAY_FIRE_SUPPORTED, and
GET /gpio/status reports it as replay_fire, so BIMS refuses to play a path
with fire steps on a Pi whose replay would silently skip them.

Hardware access goes through gpiozero (lgpio backend on Pi 5 / Bookworm). If
gpiozero or the pin factory is unavailable (dev laptop, CI), the module runs
in SIMULATED mode: state is tracked, timing is honoured, nothing is driven,
and every response says simulated=true so BIMS can label it.

Deps on the Pi (inside the uv project):  uv add gpiozero lgpio
"""

from __future__ import annotations

import asyncio
import os
import threading
import time
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

try:  # every pin change, kept for BIMS (2026-11-24); a Pi without the module still pulses
    from src.server import gpio_events as _events
except Exception:  # pragma: no cover - run outside the service tree
    try:
        from . import gpio_events as _events  # type: ignore
    except Exception:
        _events = None  # type: ignore[assignment]

router = APIRouter(prefix="/gpio", tags=["gpio"])

# ---------------------------------------------------------------- config

def _parse_pins(raw: str) -> List[int]:
    pins: List[int] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        n = int(part)
        if not (0 <= n <= 27):
            raise ValueError(f"GPIO pin out of range: {n}")
        pins.append(n)
    if not pins:
        raise ValueError("SOLENOID_GPIO_PINS is empty")
    return pins


ALLOWED_PINS: List[int] = _parse_pins(os.environ.get("SOLENOID_GPIO_PINS", "17,27"))
MAX_PULSE_MS = int(os.environ.get("SOLENOID_MAX_PULSE_MS", "2000"))
MIN_PULSE_MS = 20
MAX_GAP_MS = 5000
MAX_SEQUENCE_PINS = 4

# ---------------------------------------------------------------- backend

class _Backend:
    """Owns the output devices. Lazy: nothing is claimed until first use."""

    def __init__(self) -> None:
        self._devices: Dict[int, object] = {}
        self._sim_state: Dict[int, int] = {p: 0 for p in ALLOWED_PINS}
        self._simulated: Optional[bool] = None  # unknown until first open
        self._factory = None

    # -- open / close -------------------------------------------------

    def _ensure_open(self) -> None:
        if self._simulated is not None:
            return
        try:
            from gpiozero import DigitalOutputDevice  # type: ignore

            for p in ALLOWED_PINS:
                # active_high=True, initial_value=False -> pin driven LOW on
                # claim, which matches the board's 10k pull-downs: coil off.
                self._devices[p] = DigitalOutputDevice(p, active_high=True, initial_value=False)
            self._simulated = False
            print(f"[gpio] claimed BCM {ALLOWED_PINS} via gpiozero", flush=True)
        except Exception as exc:  # ImportError, BadPinFactory, permission...
            for d in self._devices.values():
                try:
                    d.close()  # type: ignore[attr-defined]
                except Exception:
                    pass
            self._devices.clear()
            self._simulated = True
            print(f"[gpio] SIMULATED (no hardware GPIO): {exc}", flush=True)

    def close(self) -> None:
        self.all_off()
        for d in self._devices.values():
            try:
                d.close()  # type: ignore[attr-defined]
            except Exception:
                pass
        self._devices.clear()
        self._simulated = None

    # -- state ----------------------------------------------------------

    @property
    def simulated(self) -> bool:
        self._ensure_open()
        return bool(self._simulated)

    def state(self, pin: int) -> int:
        self._ensure_open()
        if self._simulated:
            return self._sim_state.get(pin, 0)
        dev = self._devices.get(pin)
        return int(bool(dev.value)) if dev is not None else 0  # type: ignore[attr-defined]

    def read_if_open(self, pin: int) -> Optional[int]:
        """The pin's level for the gpio_events watcher; None until this service has claimed it."""
        if self._simulated is None:
            return None
        if self._simulated:
            return self._sim_state.get(pin, 0)
        dev = self._devices.get(pin)
        return int(bool(dev.value)) if dev is not None else None  # type: ignore[attr-defined]

    def on(self, pin: int, ms: Optional[int] = None) -> None:
        self._ensure_open()
        with _write_lock():
            if self._simulated:
                self._sim_state[pin] = 1
            else:
                self._devices[pin].on()  # type: ignore[attr-defined]
            if _events is not None:
                _events.record(pin, 1, ms=ms)

    def off(self, pin: int) -> None:
        if self._simulated is None:
            return  # never opened: nothing to turn off
        with _write_lock():
            if self._simulated:
                self._sim_state[pin] = 0
            else:
                dev = self._devices.get(pin)
                if dev is None:
                    return
                dev.off()  # type: ignore[attr-defined]
            if _events is not None:
                _events.record(pin, 0)

    def all_off(self) -> None:
        for p in ALLOWED_PINS:
            try:
                self.off(p)
            except Exception as exc:
                print(f"[gpio] all_off failed on BCM {p}: {exc}", flush=True)


def _write_lock():
    """gpio_events' lock, so the watcher never reads a pin between its write and its record."""
    return _events.write_lock if _events is not None else _NO_LOCK


class _NoLock:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


_NO_LOCK = _NoLock()

_backend = _Backend()
if _events is not None:
    try:
        _events.note_boot(ALLOWED_PINS)
        for _p in ALLOWED_PINS:
            _events.register(_p, lambda _p=_p: _backend.read_if_open(_p))
    except Exception as _exc:  # never stop the service over its log
        print(f"[gpio] pin events not started: {_exc}", flush=True)
_lock = asyncio.Lock()
#: Held while ANY coil is energised, by any caller (REST or the replay thread).
_coil_lock = threading.Lock()
#: Set by replay_settle.install(): the replay fires `fire` frames.
REPLAY_FIRE_SUPPORTED = False
#: Set by replay_settle.install(): the replay sets a move set step's own P / D / I (2026-11-19).
REPLAY_GAINS_SUPPORTED = False


def _as(source: str, **meta):
    """Writes inside are logged with this source (gpio_events), or nothing without the module."""
    if _events is None:
        return _NoLock()
    return _events.source(source, **meta)


def all_off() -> None:
    """Force every solenoid pin low. Called from /e-stop and on shutdown."""
    with _as("all-off", note="e-stop or stop"):
        _backend.all_off()


def close() -> None:
    """Release the GPIO lines. Called from the lifespan shutdown path."""
    with _as("shutdown"):
        _backend.close()


# ---------------------------------------------------------------- helpers

def _check_pin(pin: int) -> None:
    if pin not in ALLOWED_PINS:
        raise HTTPException(status_code=400, detail=f"pin must be one of {ALLOWED_PINS}")


def _check_ms(ms: int) -> None:
    if not (MIN_PULSE_MS <= ms <= MAX_PULSE_MS):
        raise HTTPException(status_code=400, detail=f"ms must be {MIN_PULSE_MS}..{MAX_PULSE_MS}")


async def _pulse_locked(pin: int, ms: int) -> None:
    """Drive one pin high for ms, then low. Caller holds _lock and _coil_lock."""
    _backend.on(pin, ms=ms)
    try:
        await asyncio.sleep(ms / 1000.0)
    finally:
        _backend.off(pin)


def _coil_busy() -> HTTPException:
    return HTTPException(status_code=409, detail="a solenoid pulse is already in progress")


def pulse_blocking(pin: int, ms: int, stop_event: Optional[threading.Event] = None, wait_s: float = 3.0) -> dict:
    """Pulse one pin from a worker thread (the replay's fire timer).

    Waits up to wait_s for any other pulse to finish (never overlaps one),
    then drives the pin for ms. A set stop_event ends the pulse early. The
    pin is always driven low again. Returns what happened; never raises for
    a busy lock or a bad request, so a replay is never killed by a trapdoor.
    """
    if pin not in ALLOWED_PINS:
        return {"ok": False, "pin": pin, "ms": ms, "error": f"pin must be one of {ALLOWED_PINS}"}
    if not (MIN_PULSE_MS <= ms <= MAX_PULSE_MS):
        return {"ok": False, "pin": pin, "ms": ms, "error": f"ms must be {MIN_PULSE_MS}..{MAX_PULSE_MS}"}
    if not _coil_lock.acquire(timeout=wait_s):
        return {"ok": False, "pin": pin, "ms": ms, "error": "another solenoid pulse did not finish in time"}
    t0 = time.monotonic()
    try:
        _backend.on(pin, ms=ms)
        try:
            if stop_event is not None:
                stop_event.wait(ms / 1000.0)
            else:
                time.sleep(ms / 1000.0)
        finally:
            _backend.off(pin)
    except Exception as exc:  # hardware error: report it, the replay goes on
        return {"ok": False, "pin": pin, "ms": ms, "error": str(exc), "simulated": _backend.simulated}
    finally:
        _coil_lock.release()
    return {"ok": True, "pin": pin, "ms": ms, "simulated": _backend.simulated, "elapsed_ms": int((time.monotonic() - t0) * 1000)}


# ---------------------------------------------------------------- models

class PulseRequest(BaseModel):
    pin: int
    ms: int = Field(1000, ge=MIN_PULSE_MS, le=MAX_PULSE_MS)


class SequenceRequest(BaseModel):
    pins: List[int] = Field(..., min_length=1, max_length=MAX_SEQUENCE_PINS)
    ms: int = Field(1000, ge=MIN_PULSE_MS, le=MAX_PULSE_MS)
    gap_ms: int = Field(500, ge=0, le=MAX_GAP_MS)


# ---------------------------------------------------------------- routes

def _pin_status(p: int) -> dict:
    out: dict = {"state": _backend.state(p)}
    if _events is not None:
        out["last"] = _events.last(p)
        out["last_on"] = _events.last_on(p)
    return out


@router.get("/status")
async def gpio_status() -> dict:
    return {
        "pins": {str(p): _pin_status(p) for p in ALLOWED_PINS},
        "read_at": _events.now_iso() if _events is not None else None,
        "events": _events is not None,
        "allowed_pins": ALLOWED_PINS,
        "max_pulse_ms": MAX_PULSE_MS,
        "simulated": _backend.simulated,
        "busy": _lock.locked() or _coil_lock.locked(),
        "replay_fire": REPLAY_FIRE_SUPPORTED,
        "replay_gains": REPLAY_GAINS_SUPPORTED,
    }


@router.get("/events")
async def gpio_events_route(since: Optional[str] = None, limit: int = 500) -> dict:
    """Every pin change since `since` (ISO), oldest first; the conveyor's GPIO 22 too."""
    if _events is None:
        raise HTTPException(status_code=501, detail="gpio_events.py is not installed on this Pi")
    pins: Dict[str, Optional[int]] = {str(p): _backend.read_if_open(p) for p in ALLOWED_PINS}
    try:
        from src.server import conveyor as _belt

        pins[str(_belt.PIN)] = _belt._backend.read_if_open()
    except Exception:
        pass
    last = {k: _events.last(int(k)) for k in pins}
    return {"events": _events.events(since, limit), "boot_id": _events.BOOT_ID, "now": _events.now_iso(), "pins": pins, "last": last}


@router.post("/pulse")
async def gpio_pulse(req: PulseRequest) -> dict:
    _check_pin(req.pin)
    _check_ms(req.ms)
    if _lock.locked() or _coil_lock.locked():
        raise _coil_busy()
    t0 = time.monotonic()
    async with _lock:
        if not _coil_lock.acquire(blocking=False):
            raise _coil_busy()
        try:
            with _as("bims-pulse"):
                await _pulse_locked(req.pin, req.ms)
        finally:
            _coil_lock.release()
    return {
        "pins": [req.pin],
        "ms": req.ms,
        "simulated": _backend.simulated,
        "elapsed_ms": int((time.monotonic() - t0) * 1000),
    }


@router.post("/sequence")
async def gpio_sequence(req: SequenceRequest) -> dict:
    for p in req.pins:
        _check_pin(p)
    _check_ms(req.ms)
    if _lock.locked() or _coil_lock.locked():
        raise _coil_busy()
    t0 = time.monotonic()
    async with _lock:
        if not _coil_lock.acquire(blocking=False):
            raise _coil_busy()
        try:
            with _as("bims-pulse", note="sequence"):
                for i, p in enumerate(req.pins):
                    if i > 0 and req.gap_ms > 0:
                        await asyncio.sleep(req.gap_ms / 1000.0)
                    await _pulse_locked(p, req.ms)
        finally:
            _coil_lock.release()
    return {
        "pins": list(req.pins),
        "ms": req.ms,
        "gap_ms": req.gap_ms,
        "simulated": _backend.simulated,
        "elapsed_ms": int((time.monotonic() - t0) * 1000),
    }

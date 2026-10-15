"""
Solenoid GPIO for the robot-arm service (cartridge chute).

Two low-side solenoid channels hang off the Pi's GPIO through the UCC27524
driver board: BCM 17 and BCM 27. This module is the ONLY owner of those pins
inside the service, so /e-stop and shutdown can always force them low, and so
no second process fights the service for the libgpiod line handles.

Endpoints (auth is applied by app.py when the router is included):
    GET  /gpio/status            {pins: {"17": {state: 0|1}}, simulated, busy}
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

Hardware access goes through gpiozero (lgpio backend on Pi 5 / Bookworm). If
gpiozero or the pin factory is unavailable (dev laptop, CI), the module runs
in SIMULATED mode: state is tracked, timing is honoured, nothing is driven,
and every response says simulated=true so BIMS can label it.

Deps on the Pi (inside the uv project):  uv add gpiozero lgpio
"""

from __future__ import annotations

import asyncio
import os
import time
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

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

    def on(self, pin: int) -> None:
        self._ensure_open()
        if self._simulated:
            self._sim_state[pin] = 1
            return
        self._devices[pin].on()  # type: ignore[attr-defined]

    def off(self, pin: int) -> None:
        if self._simulated is None:
            return  # never opened: nothing to turn off
        if self._simulated:
            self._sim_state[pin] = 0
            return
        dev = self._devices.get(pin)
        if dev is not None:
            dev.off()  # type: ignore[attr-defined]

    def all_off(self) -> None:
        for p in ALLOWED_PINS:
            try:
                self.off(p)
            except Exception as exc:
                print(f"[gpio] all_off failed on BCM {p}: {exc}", flush=True)


_backend = _Backend()
_lock = asyncio.Lock()


def all_off() -> None:
    """Force every solenoid pin low. Called from /e-stop and on shutdown."""
    _backend.all_off()


def close() -> None:
    """Release the GPIO lines. Called from the lifespan shutdown path."""
    _backend.close()


# ---------------------------------------------------------------- helpers

def _check_pin(pin: int) -> None:
    if pin not in ALLOWED_PINS:
        raise HTTPException(status_code=400, detail=f"pin must be one of {ALLOWED_PINS}")


def _check_ms(ms: int) -> None:
    if not (MIN_PULSE_MS <= ms <= MAX_PULSE_MS):
        raise HTTPException(status_code=400, detail=f"ms must be {MIN_PULSE_MS}..{MAX_PULSE_MS}")


async def _pulse_locked(pin: int, ms: int) -> None:
    """Drive one pin high for ms, then low. Caller holds _lock."""
    _backend.on(pin)
    try:
        await asyncio.sleep(ms / 1000.0)
    finally:
        _backend.off(pin)


# ---------------------------------------------------------------- models

class PulseRequest(BaseModel):
    pin: int
    ms: int = Field(1000, ge=MIN_PULSE_MS, le=MAX_PULSE_MS)


class SequenceRequest(BaseModel):
    pins: List[int] = Field(..., min_length=1, max_length=MAX_SEQUENCE_PINS)
    ms: int = Field(1000, ge=MIN_PULSE_MS, le=MAX_PULSE_MS)
    gap_ms: int = Field(500, ge=0, le=MAX_GAP_MS)


# ---------------------------------------------------------------- routes

@router.get("/status")
async def gpio_status() -> dict:
    return {
        "pins": {str(p): {"state": _backend.state(p)} for p in ALLOWED_PINS},
        "allowed_pins": ALLOWED_PINS,
        "max_pulse_ms": MAX_PULSE_MS,
        "simulated": _backend.simulated,
        "busy": _lock.locked(),
    }


@router.post("/pulse")
async def gpio_pulse(req: PulseRequest) -> dict:
    _check_pin(req.pin)
    _check_ms(req.ms)
    if _lock.locked():
        raise HTTPException(status_code=409, detail="a solenoid pulse is already in progress")
    t0 = time.monotonic()
    async with _lock:
        await _pulse_locked(req.pin, req.ms)
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
    if _lock.locked():
        raise HTTPException(status_code=409, detail="a solenoid pulse is already in progress")
    t0 = time.monotonic()
    async with _lock:
        for i, p in enumerate(req.pins):
            if i > 0 and req.gap_ms > 0:
                await asyncio.sleep(req.gap_ms / 1000.0)
            await _pulse_locked(p, req.ms)
    return {
        "pins": list(req.pins),
        "ms": req.ms,
        "gap_ms": req.gap_ms,
        "simulated": _backend.simulated,
        "elapsed_ms": int((time.monotonic() - t0) * 1000),
    }

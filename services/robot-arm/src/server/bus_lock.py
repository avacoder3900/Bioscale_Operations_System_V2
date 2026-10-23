"""
One process-wide lock for the servo serial bus, shared by every one-shot
route (GET /servos, jog, move, torque, replay preflight, calibration capture).

Why (2026-10-22): each of those opens the BusLinker port, does its reads or
writes, and closes it again (manual_control._connected_arms). FastAPI runs
sync routes on a thread pool, so two requests at once open the SAME port
twice and their packets interleave. Seen in production while capturing a
pose's camera reference: the Animate editor's 1.5 s GET /servos poll landed
in the same instant as the capture's own GET /servos, and pyserial raised
"device reports readiness to read but returned no data (device disconnected
or multiple access on port?)" → 500. Sessions (teleop/record/replay) own the
bus for their whole run and are already kept apart from these routes by
app.py's _require_bus_free; this lock keeps the one-shot routes apart from
each other. Re-entrant, so a locked function may call another locked one.

Installed on the Pi by scripts/install_bus_lock.py, which wraps the public
functions of manual_control and calibration in app.py (the modules
themselves are not edited). move.py takes the lock itself.
"""

from __future__ import annotations

import functools
import threading
from types import ModuleType
from typing import Any, Callable, TypeVar

F = TypeVar("F", bound=Callable[..., Any])

BUS_LOCK = threading.RLock()


def locked(fn: F) -> F:
    """`fn` runs with BUS_LOCK held. Idempotent: wrapping twice is a no-op."""
    if getattr(fn, "_bus_locked", False):
        return fn

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        with BUS_LOCK:
            return fn(*args, **kwargs)

    wrapper._bus_locked = True  # type: ignore[attr-defined]
    return wrapper  # type: ignore[return-value]


def wrap_module(mod: ModuleType, names: tuple[str, ...]) -> list[str]:
    """Rebind `mod.<name>` to a locked version for each name that exists; returns the names wrapped."""
    done: list[str] = []
    for name in names:
        fn = getattr(mod, name, None)
        if callable(fn):
            setattr(mod, name, locked(fn))
            done.append(name)
    return done


# What the installer wraps. app.py calls these as `manual.read_servos()` /
# `calib.capture()` — attribute lookups at call time — so rebinding on the
# module is enough.
MANUAL_FUNCTIONS = ("set_torque", "jog_joint", "replay_preflight", "read_servos")
CALIBRATION_FUNCTIONS = ("capture", "clear", "status", "capture_pose", "delete_pose", "clear_map", "map_status")

"""
POST /servos/hold — re-engage the follower's torque WITHOUT a jump (ARM-06 Animate).

Why: BIMS drops torque so the operator can pose the arm by hand, reads the
encoders, saves the pose — and then torque has to come back on. A bare
torque-on (POST /torque {enable: true}) makes every servo drive to its LAST
goal, which is wherever the arm was before it went limp: the arm jumps, fast.
This route writes goal := present on each servo first, then enables torque,
so the arm freezes where it is.

Re-ported 2026-10-23 onto the Pi's real layout (the 2026-10-21 draft reached
into app.py for `_follower` / `_with_follower` / `state`, none of which exist
there). Mirrors move.py: manual_control._connected_arms, the goal written
BEFORE Torque_Enable (the servo latches a stale goal otherwise), everything
under BUS_LOCK so it never opens the port while GET /servos or another
one-shot route has it. A servo whose torque is ALREADY on keeps its goal
(rewriting it to the sagged present position would let a loaded joint drop
a few steps).

Installed on the Pi by scripts/install_hold_router.py (after
install_bus_lock.py: bus_lock.py must be next to app.py): it includes the
router under require_api_key with the same single-owner bus gate the jog
route uses (`bus_free` is set by the installer's include line so this
module does not import app.py).

    curl -X POST -H "x-api-key: $KEY" localhost:8000/servos/hold
    -> {"held": true, "positions": {"1": 2031, ...}, "already_on": [2],
        "failed_ids": []}

`held` is only ever true in a 200; when NO servo could be held the route
answers 503. A partial failure is reported in failed_ids like /torque does.
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from fastapi import APIRouter, HTTPException

from src.hardware.dual_arm import NUM_MOTORS
from src.server.bus_lock import BUS_LOCK
from src.server.manual_control import _connected_arms

router = APIRouter(tags=["servos"])

# The app's "a session owns the bus" check, set by the installer
# (`pi_hold.bus_free = _require_bus_free`). None = no gate (tests).
bus_free: Optional[Callable[[], None]] = None


def hold_arm() -> dict[str, Any]:
    """Follower: goal := present on every servo whose torque is off, then torque on. No leader needed."""
    arms = _connected_arms(require_leader=False)
    positions: dict[int, int] = {}
    already_on: list[int] = []
    failed: list[int] = []
    try:
        bus = arms.follower
        assert bus is not None
        for sid in range(1, NUM_MOTORS + 1):
            present = bus.read(sid, "Present_Position")
            if present is None:
                failed.append(sid)
                continue
            if bus.read(sid, "Torque_Enable") == 1:
                # Already holding: leave its goal alone.
                positions[sid] = int(present)
                already_on.append(sid)
                continue
            # Goal before torque — same ordering note as jog_joint.
            if not bus.write(sid, "Goal_Position", int(present)):
                failed.append(sid)
                continue
            if not bus.write(sid, "Torque_Enable", 1):
                failed.append(sid)
                continue
            positions[sid] = int(present)
    finally:
        arms.disconnect()
    if not positions:
        raise RuntimeError(
            "No follower motor acknowledged the hold. Check the arm's 12V supply and the BusLinker USB connection."
        )
    return {
        "held": True,
        "positions": {str(sid): pos for sid, pos in positions.items()},
        "already_on": already_on,
        "failed_ids": failed,
    }


@router.post("/servos/hold")
def hold_servos() -> dict[str, Any]:
    """Freeze the follower where it is: goal = present on every servo, then torque on."""
    if bus_free is not None:
        bus_free()
    try:
        with BUS_LOCK:
            return hold_arm()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

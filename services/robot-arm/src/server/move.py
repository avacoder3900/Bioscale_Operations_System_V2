"""
POST /servos/{servo_id}/move — one follower joint to an ABSOLUTE goal.

Why (2026-10-22): BIMS's Animate sliders (ARM-06 §13) send absolute goals
and fall back to `/servos/{id}/jog` when this route is missing. A jog is
goal = present + delta, and a loaded shoulder rests 20–30 steps BELOW its
goal, so the first −10 presses only lifted it back to where it already
sagged — "I have to press −10 about three times before it moves". With an
absolute goal the servo is told the number on the slider and that is that.

Mirrors manual_control.jog_joint exactly in everything but the arithmetic:
same connect/disconnect, same EEPROM angle-limit clamp, goal written BEFORE
torque is enabled (the servo latches a stale goal otherwise), Goal_Speed
only when asked. Refuses a goal further than MAX_MOVE_STEPS from the
present position: a slider move is small; big moves are for replay.

Installed on the Pi by scripts/install_move_router.py (after
install_bus_lock.py: bus_lock.py must be next to app.py): it includes the
router under require_api_key, with the same single-owner bus gate the jog
route uses (`bus_free` is set by the installer's include line so this
module does not import app.py). The move itself runs under BUS_LOCK, so it
never opens the port while GET /servos or another one-shot route has it.

    curl -H "x-api-key: $KEY" -H 'content-type: application/json' \
         -d '{"position": 2048}' localhost:8000/servos/2/move
    → {"id": 2, "joint": "shoulder_lift", "role": "follower",
       "present": 2031, "goal": 2048, "delta": 17, "clamped": false}
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from src.hardware.dual_arm import JOINT_NAMES, NUM_MOTORS
from src.server.bus_lock import BUS_LOCK
from src.server.manual_control import _ROLES, _connected_arms

router = APIRouter(tags=["servos"])

# Largest |goal − present| accepted in one request. BIMS sends ≤ 120 per
# slider step and its server refuses > 600 (MAX_LIVE_STEP); this is the
# hard stop on the Pi for anything else that finds the route.
MAX_MOVE_STEPS = 1000

# The app's "a session owns the bus" check, set by the installer
# (`pi_move.bus_free = _require_bus_free`). None = no gate (tests).
bus_free: Optional[Callable[[], None]] = None


class MoveOneRequest(BaseModel):
    position: int = Field(description="Absolute encoder goal, 0..4095 (clamped to the servo's EEPROM limits).")
    speed: int | None = None
    role: str = Field(default="follower", description="'leader' or 'follower'.")


def move_joint(servo_id: int, position: int, speed: int | None = None, role: str = "follower") -> dict[str, Any]:
    if role not in _ROLES:
        raise ValueError(f"role must be one of {_ROLES}, got {role!r}")
    if not 1 <= servo_id <= NUM_MOTORS:
        raise ValueError(f"servo_id must be 1..{NUM_MOTORS}, got {servo_id}")
    if not 0 <= position <= 4095:
        raise ValueError(f"position must be 0..4095, got {position}")

    arms = _connected_arms(require_leader=role == "leader")
    try:
        bus = arms.leader if role == "leader" else arms.follower
        assert bus is not None
        present = bus.read(servo_id, "Present_Position")
        if present is None:
            raise RuntimeError(
                f"{role.capitalize()} motor {servo_id} did not respond to a position read. "
                "Check the 12V supply and BusLinker connection."
            )
        if abs(position - present) > MAX_MOVE_STEPS:
            raise ValueError(
                f"goal {position} is {abs(position - present)} steps from the present position {present}; "
                f"at most {MAX_MOVE_STEPS} per move. Use replay for large moves."
            )
        lo = bus.read(servo_id, "Min_Angle_Limit")
        hi = bus.read(servo_id, "Max_Angle_Limit")
        lo = lo if lo is not None else 0
        hi = hi if hi is not None else 4095
        goal = max(lo, min(hi, position))

        if speed is not None:
            bus.write(servo_id, "Goal_Speed", max(0, min(4095, speed)))
        # Goal before torque — same ordering note as jog_joint.
        if not bus.write(servo_id, "Goal_Position", goal):
            raise RuntimeError(f"{role.capitalize()} motor {servo_id} rejected the goal write.")
        bus.write(servo_id, "Torque_Enable", 1)
    finally:
        arms.disconnect()
    return {
        "id": servo_id,
        "joint": JOINT_NAMES[servo_id - 1],
        "role": role,
        "present": present,
        "goal": goal,
        "delta": goal - present,
        "clamped": goal != position,
    }


@router.post("/servos/{servo_id}/move")
def move_servo(servo_id: int, body: MoveOneRequest) -> dict[str, Any]:
    """Move one joint to an absolute goal (default arm: follower)."""
    if bus_free is not None:
        bus_free()
    try:
        with BUS_LOCK:
            return move_joint(servo_id=servo_id, position=body.position, speed=body.speed, role=body.role)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

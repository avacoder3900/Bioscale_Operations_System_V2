"""
Hold — re-engage the follower's torque WITHOUT a jump. ARM-06 Animate.

The Animate tab lets the operator pose the arm by hand: BIMS drops torque
(POST /torque {enable:false}), the operator moves the arm, BIMS reads the
encoders (GET /servos) and saves the pose. Torque then has to come back on —
but a bare torque-on makes every servo drive to its LAST goal, which is
wherever the arm was before it went limp: the arm jumps, fast. The driver
already has the right primitive (`ArmDriver.pause()`: goal := present
position, then torque on); this router exposes it.

Endpoint (auth is applied by app.py when the router is included):
    POST /servos/hold   -> {"held": true, "positions": {sid: steps}}

Refused with 409 while a session (teleop / record / replay) owns the bus,
exactly like the jog route.

NOT yet exercised against hardware (written 2026-10-21 without Pi access).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/servos", tags=["hold"])


@router.post("/hold")
async def hold_servos():
    """Freeze the follower where it is: goal = present on every servo, then torque on."""
    # Imported lazily so this module can be dropped next to app.py without
    # knowing its import graph; app.py is the live server module.
    from . import app as server  # type: ignore

    follower = server._follower()
    if getattr(server.state, "active_session", None) is not None and server.state.active_session.is_active():
        raise HTTPException(status_code=409, detail="a session owns the bus; stop it first")

    def _hold():
        positions = follower.get_positions()
        for sid, pos in positions.items():
            follower.set_position(sid, pos)
        follower.set_torque_all(True)
        return positions

    positions = await server._with_follower(_hold)
    return {"held": True, "positions": {str(sid): int(pos) for sid, pos in positions.items()}}

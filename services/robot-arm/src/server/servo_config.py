"""
GET /servos/config — READ-ONLY: each follower servo's stiffness and torque settings.

Why (2026-11-05): a loaded joint sits short of its goal because the STS3215's
position loop is proportional — it pushes harder only as the error grows. On
the SO-ARM101 the shoulder stalled 108 steps short of a typed 2300 (load -159)
and the elbow ~80 short. Before deciding whether to make the joints stiffer
(raise P_Coefficient), this route reads what the servos are set to now. It
writes nothing; a write route comes later and only on the operator's go-ahead.

Registers (STS3215 / SMS_STS memory map; the same addresses lerobot uses):
    16  Max_Torque_Limit     2  EEPROM, 0..1000 (0.1 %)
    21  P_Coefficient        1  EEPROM, position-loop P gain
    22  D_Coefficient        1
    23  I_Coefficient        1
    24  Minimum_Startup_Force 2
    26  CW_Dead_Zone         1
    27  CCW_Dead_Zone        1
    28  Protection_Current   2
    34  Protective_Torque    1
    35  Protection_Time      1
    36  Overload_Torque      1
    48  Torque_Limit         2  RAM, 0..1000, reset to Max_Torque_Limit at power-on
They are read by address with the bus's packet handler, so _feetech_bus.py's
REGISTERS table is left untouched.

Installed on the Pi by scripts/install_servo_config_router.py (bus_lock.py must
be next to app.py). Runs under BUS_LOCK and the single-owner bus gate, like
move.py.

    curl -H "x-api-key: $KEY" localhost:8000/servos/config
    → {"servos": [{"id": 1, "joint": "shoulder_pan", "P_Coefficient": 16, ...}, ...]}
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from fastapi import APIRouter, HTTPException
from scservo_sdk import COMM_SUCCESS  # type: ignore[import-untyped]

from src.hardware.dual_arm import JOINT_NAMES, NUM_MOTORS
from src.server.bus_lock import BUS_LOCK
from src.server.manual_control import _connected_arms

router = APIRouter(tags=["servos"])

# The app's "a session owns the bus" check, set by the installer. None = no gate (tests).
bus_free: Optional[Callable[[], None]] = None

#: name -> (address, length)
CONFIG_REGISTERS: dict[str, tuple[int, int]] = {
    "Max_Torque_Limit": (16, 2),
    "P_Coefficient": (21, 1),
    "D_Coefficient": (22, 1),
    "I_Coefficient": (23, 1),
    "Minimum_Startup_Force": (24, 2),
    "CW_Dead_Zone": (26, 1),
    "CCW_Dead_Zone": (27, 1),
    "Protection_Current": (28, 2),
    "Protective_Torque": (34, 1),
    "Protection_Time": (35, 1),
    "Overload_Torque": (36, 1),
    "Torque_Limit": (48, 2),
}


def _read_raw(bus: Any, servo_id: int, address: int, length: int, retries: int = 2) -> int | None:
    ph, port = bus._packet_handler, bus._port_handler
    for _ in range(retries + 1):
        if length == 1:
            value, comm, _err = ph.read1ByteTxRx(port, servo_id, address)
        else:
            value, comm, _err = ph.read2ByteTxRx(port, servo_id, address)
        if comm == COMM_SUCCESS:
            return int(value)
    return None


def read_config() -> list[dict[str, Any]]:
    arms = _connected_arms(require_leader=False)
    try:
        bus = arms.follower
        assert bus is not None
        out = []
        for sid in range(1, NUM_MOTORS + 1):
            row: dict[str, Any] = {"id": sid, "joint": JOINT_NAMES[sid - 1]}
            for name, (addr, length) in CONFIG_REGISTERS.items():
                row[name] = _read_raw(bus, sid, addr, length)
            out.append(row)
        return out
    finally:
        arms.disconnect()


@router.get("/servos/config")
def servos_config() -> dict[str, Any]:
    """Read every follower servo's gain / torque registers. Writes nothing."""
    if bus_free is not None:
        bus_free()
    try:
        with BUS_LOCK:
            return {"servos": read_config()}
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

"""
GET  /servos/config — READ-ONLY: each follower servo's stiffness and torque settings.
POST /servos/gains  — write P/D/I gains only; temporary (lost at power-off) unless persist.
                      Every changed gain is reported to BIMS's Change Log (bims_changes.py).

Why (2026-11-05): a loaded joint sits short of its goal because the STS3215's
position loop is proportional — it pushes harder only as the error grows. On
the SO-ARM101 the shoulder stalled 108 steps short of a typed 2300 (load -159)
and the elbow ~80 short. Before deciding whether to make the joints stiffer
(raise P_Coefficient), GET reads what the servos are set to now; POST
/servos/gains (added on Alejandro's go-ahead, 2026-11-05) writes only the gains.

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
from pydantic import BaseModel, Field
from scservo_sdk import COMM_SUCCESS  # type: ignore[import-untyped]

from src.hardware.dual_arm import JOINT_NAMES, NUM_MOTORS
from src.server.bus_lock import BUS_LOCK
from src.server.manual_control import _connected_arms

try:
    from src.server.bims_changes import report_gains  # the Change Log's Pi half (2026-11-06)
except ImportError:  # a Pi without bims_changes.py next to app.py
    def report_gains(*_a, **_k) -> None:
        return None

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
    "Lock": (55, 1),
}

#: The only registers POST /servos/gains may write, with their allowed range.
GAIN_LIMITS: dict[str, tuple[int, int]] = {
    "P_Coefficient": (1, 64),
    "D_Coefficient": (0, 254),
    "I_Coefficient": (0, 254),
}
LOCK_ADDRESS = 55


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


def _write_byte(bus: Any, servo_id: int, address: int, value: int, retries: int = 2) -> bool:
    ph, port = bus._packet_handler, bus._port_handler
    for _ in range(retries + 1):
        comm, _err = ph.write1ByteTxRx(port, servo_id, address, value)
        if comm == COMM_SUCCESS:
            return True
    return False


class GainWrite(BaseModel):
    id: int = Field(ge=1, le=NUM_MOTORS)
    P_Coefficient: int | None = None
    D_Coefficient: int | None = None
    I_Coefficient: int | None = None


class GainsRequest(BaseModel):
    writes: list[GainWrite]
    persist: bool = Field(
        default=False,
        description="False (default): Lock stays 1, the new gains act now and are lost at power-off. True: saved to EEPROM.",
    )


def write_gains(req: GainsRequest) -> list[dict[str, Any]]:
    """
    Write P/D/I gains on follower servos. Torque is never touched (the arm
    keeps holding). Temporary by default: with Lock = 1 an EEPROM-area write
    takes effect but is not saved, so a power cycle restores the old gains.
    persist=True unlocks (Lock 0), writes, and locks again. Every servo ends
    with Lock = 1. Returns each servo's gains and Lock before and after.
    """
    for w in req.writes:
        for name, (lo, hi) in GAIN_LIMITS.items():
            v = getattr(w, name)
            if v is not None and not lo <= v <= hi:
                raise ValueError(f"servo {w.id}: {name} must be {lo}..{hi}, got {v}")
    arms = _connected_arms(require_leader=False)
    out: list[dict[str, Any]] = []
    try:
        bus = arms.follower
        assert bus is not None
        for w in req.writes:
            names = [n for n in GAIN_LIMITS if getattr(w, n) is not None]
            before = {n: _read_raw(bus, w.id, CONFIG_REGISTERS[n][0], 1) for n in [*GAIN_LIMITS, "Lock"]}
            if not _write_byte(bus, w.id, LOCK_ADDRESS, 0 if req.persist else 1):
                raise RuntimeError(f"servo {w.id}: Lock write failed")
            try:
                for n in names:
                    if not _write_byte(bus, w.id, CONFIG_REGISTERS[n][0], int(getattr(w, n))):
                        raise RuntimeError(f"servo {w.id}: {n} write failed")
            finally:
                _write_byte(bus, w.id, LOCK_ADDRESS, 1)
            after = {n: _read_raw(bus, w.id, CONFIG_REGISTERS[n][0], 1) for n in [*GAIN_LIMITS, "Lock"]}
            out.append({"id": w.id, "joint": JOINT_NAMES[w.id - 1], "persist": req.persist, "before": before, "after": after})
    finally:
        arms.disconnect()
    return out


@router.post("/servos/gains")
def servos_gains(body: GainsRequest) -> dict[str, Any]:
    """Write P/D/I gains (temporary unless persist). Never touches torque or goals."""
    if bus_free is not None:
        bus_free()
    try:
        with BUS_LOCK:
            written = write_gains(body)
        # Every gain that changed goes to BIMS's Change Log (servo.p_coefficient servo:N old -> new).
        report_gains(written, body.persist)
        return {"servos": written}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


#: GET /servos/state (2026-11-10): the registers that tell a miss apart. name -> (address, length, sign bit or None)
STATE_REGISTERS: dict[str, tuple[int, int, int | None]] = {
    "goal_position": (42, 2, 15),
    "torque_limit": (48, 2, None),
    "position": (56, 2, 15),
    "speed": (58, 2, 15),
    "load": (60, 2, 10),
    "status": (65, 1, None),
    "moving": (66, 1, None),
    "current": (69, 2, 15),
    "p_coefficient": (21, 1, None),
    "d_coefficient": (22, 1, None),
    "i_coefficient": (23, 1, None),
}

#: STS3215 Present_Current unit.
CURRENT_MA_PER_UNIT = 6.5


def _signed(raw: int | None, sign_bit: int | None) -> int | None:
    """STS3215 sign-magnitude registers: bit ``sign_bit`` is the direction."""
    if raw is None or sign_bit is None:
        return raw
    magnitude = raw & ((1 << sign_bit) - 1)
    return -magnitude if raw & (1 << sign_bit) else magnitude


def read_state() -> list[dict[str, Any]]:
    """
    Each follower servo's live registers. Read-only. Why (2026-11-10): the
    shoulder stopped 26-34 steps short of a pose; GET /servos shows position
    and load but not the goal the servo is really holding, its current, its
    error flags or the gains in effect, so "stalled under load" could only
    be inferred. Status bits: 0 voltage, 1 angle sensor, 2 temperature,
    3 current, 5 overload.
    """
    arms = _connected_arms(require_leader=False)
    try:
        bus = arms.follower
        assert bus is not None
        out = []
        for sid in range(1, NUM_MOTORS + 1):
            row: dict[str, Any] = {"id": sid, "joint": JOINT_NAMES[sid - 1]}
            for name, (addr, length, sign) in STATE_REGISTERS.items():
                row[name] = _signed(_read_raw(bus, sid, addr, length), sign)
            row["moving"] = bool(row["moving"]) if row["moving"] is not None else None
            row["current_ma"] = round(row["current"] * CURRENT_MA_PER_UNIT) if row["current"] is not None else None
            out.append(row)
        return out
    finally:
        arms.disconnect()


@router.get("/servos/state")
def servos_state() -> dict[str, Any]:
    """Read every follower servo's goal, position, load, current, status and gains. Writes nothing."""
    if bus_free is not None:
        bus_free()
    try:
        with BUS_LOCK:
            return {"servos": read_state()}
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


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

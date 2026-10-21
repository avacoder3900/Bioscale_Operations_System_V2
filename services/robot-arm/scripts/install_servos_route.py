#!/usr/bin/env python3
"""
Add a read-only GET /servos (follower state) to the robot-arm service on the Pi.

BIMS calls it (robotArm.listServos) for the Vision tab's Save calibration and
for the Clean-up tab's "read arm" / "send arm". Follower only, so it works with
the leader BusLinker unplugged. Run from the robot-arm project root on arm-pi,
then restart the service:

    python3 scripts/install_servos_route.py

Three idempotent edits (installed on arm-pi 2026-10-20, backups *.bak-pre-servos):
  1. src/hardware/_feetech_bus.py: Present_Speed (58) and Present_Load (60) registers.
  2. src/server/manual_control.py: read_servos() -> [{id, name, position, speed,
     load, voltage, temperature, torque}], never writes to the bus.
  3. src/server/app.py: GET /servos (require_api_key, 409 while a session holds the bus).
"""
from pathlib import Path

bus = Path("src/hardware/_feetech_bus.py")
mc = Path("src/server/manual_control.py")
app = Path("src/server/app.py")

b = bus.read_text(encoding="utf-8")
if '"Present_Load"' not in b:
    old = '    "Present_Position": _Reg(56, 2),\n'
    assert b.count(old) == 1, "Present_Position register not found"
    b = b.replace(
        old,
        old + '    "Present_Speed": _Reg(58, 2),\n    "Present_Load": _Reg(60, 2),\n',
    )
    bus.write_text(b, encoding="utf-8")

m = mc.read_text(encoding="utf-8")
if "def read_servos(" not in m:
    m = m.rstrip("\n") + '''


def _signed(raw: int | None, sign_bit: int) -> int | None:
    """STS3215 sign-magnitude registers: bit ``sign_bit`` is the direction."""
    if raw is None:
        return None
    magnitude = raw & ((1 << sign_bit) - 1)
    return -magnitude if raw & (1 << sign_bit) else magnitude


def read_servos() -> list[dict[str, Any]]:
    """Present state of the six follower motors. Read-only; never moves the arm.

    ``position`` is the raw 12-bit encoder step, ``load`` the signed present
    load (about +-1000 = +-100 %), ``speed`` signed steps/s, ``voltage`` volts,
    ``temperature`` deg C. A motor that does not answer is left out.
    """
    arms = _connected_arms(require_leader=False)
    try:
        bus = arms.follower
        assert bus is not None
        out: list[dict[str, Any]] = []
        for sid in range(1, NUM_MOTORS + 1):
            position = bus.read(sid, "Present_Position")
            if position is None:
                continue
            voltage = bus.read(sid, "Present_Voltage")
            torque = bus.read(sid, "Torque_Enable")
            out.append(
                {
                    "id": sid,
                    "name": JOINT_NAMES[sid - 1] if sid - 1 < len(JOINT_NAMES) else str(sid),
                    "position": position,
                    "speed": _signed(bus.read(sid, "Present_Speed"), 15),
                    "load": _signed(bus.read(sid, "Present_Load"), 10),
                    "voltage": voltage / 10 if voltage is not None else None,
                    "temperature": bus.read(sid, "Present_Temperature"),
                    "torque": bool(torque) if torque is not None else None,
                }
            )
    finally:
        arms.disconnect()
    if not out:
        raise RuntimeError(
            "No follower motor answered. Check the arm's power supply and the "
            "follower BusLinker USB connection."
        )
    return out
'''
    mc.write_text(m, encoding="utf-8")

a = app.read_text(encoding="utf-8")
if '@app.get("/servos"' not in a:
    anchor = '@app.post("/servos/{servo_id}/jog", dependencies=[Depends(require_api_key)])'
    assert a.count(anchor) == 1, "jog route not found"
    route = '''@app.get("/servos", dependencies=[Depends(require_api_key)])
def list_servos() -> list[dict[str, Any]]:
    """Follower motors' present position/load/temperature (read-only)."""
    _require_bus_free()
    try:
        return manual.read_servos()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


'''
    a = a.replace(anchor, route + anchor)
    app.write_text(a, encoding="utf-8")

print("patched")

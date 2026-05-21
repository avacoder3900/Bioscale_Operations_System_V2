"""
Feetech STS3215 driver for the SO-100 / SO-ARM100 follower arm.

Wraps scservo_sdk in a small task-shaped API: list_states, get_position,
set_position(s), jog, torque, e_stop, pause. Positions are raw 0..4095
steps; speed is 0..1023 (0 = max).

Used by both scripts/teleop_cli.py and the FastAPI server.
"""

from __future__ import annotations

from dataclasses import dataclass
import scservo_sdk as scs

ADDR_TORQUE_ENABLE = 40
ADDR_GOAL_POSITION = 42
ADDR_GOAL_SPEED = 46
ADDR_PRESENT_POSITION = 56
ADDR_PRESENT_SPEED = 58
ADDR_PRESENT_LOAD = 60
ADDR_PRESENT_VOLTAGE = 62
ADDR_PRESENT_TEMPERATURE = 63

DEFAULT_PORT = "/dev/cu.usbmodem5C4C1280501"
DEFAULT_BAUD = 1_000_000
DEFAULT_SERVO_IDS = (1, 2, 3, 4, 5, 6)

POS_MIN = 0
POS_MAX = 4095


@dataclass
class ServoState:
    id: int
    position: int
    speed: int
    load: int
    voltage: float
    temperature: int
    error: int


# STS3215 status byte bits — set by the servo to report its own state.
# Returned alongside successful comm operations; the data on the wire is
# still valid. Treat as informational, not fatal.
_SERVO_ERR_BITS = {
    0x01: "voltage",
    0x02: "angle_limit",
    0x04: "overheat",
    0x08: "range",
    0x10: "checksum",
    0x20: "overload",
    0x40: "instruction",
}


def _decode_servo_err(err: int) -> str:
    bits = [name for bit, name in _SERVO_ERR_BITS.items() if err & bit]
    return ",".join(bits) if bits else f"0x{err:02x}"


def _check(comm: int, err: int, op: str) -> None:
    """Raise on bus comm errors; log servo status bytes without raising.

    Earlier versions raised on any non-zero status byte, which broke
    follower recovery — e.g. OVERLOAD (0x20) is set after the servo
    clears an overload condition and the next successful write still
    carries that bit. The op completed; the data is valid; the servo is
    just reporting its state (see NEXT_STEPS.md #1). Bus comm errors
    (COMM_TX_FAIL, COMM_RX_TIMEOUT, etc.) mean nothing happened on the
    wire and must still raise.
    """
    if comm != scs.COMM_SUCCESS:
        raise RuntimeError(f"{op}: comm error {comm}")
    if err != 0:
        print(
            f"[arm-driver] {op}: servo status {_decode_servo_err(err)} (0x{err:02x})",
            flush=True,
        )


class ArmDriver:
    """One per process. Not thread-safe — wrap calls in a lock at the server layer."""

    def __init__(
        self,
        port: str = DEFAULT_PORT,
        baud: int = DEFAULT_BAUD,
        servo_ids: tuple[int, ...] = DEFAULT_SERVO_IDS,
    ) -> None:
        self.port_name = port
        self.baud = baud
        self.servo_ids = tuple(servo_ids)
        self._port = scs.PortHandler(port)
        self._packet = scs.PacketHandler(0)
        self._open = False

    def open(self) -> None:
        if self._open:
            return
        if not self._port.openPort():
            raise RuntimeError(f"could not open {self.port_name}")
        if not self._port.setBaudRate(self.baud):
            self._port.closePort()
            raise RuntimeError(f"could not set baud {self.baud}")
        self._open = True

    def close(self) -> None:
        if self._open:
            self._port.closePort()
            self._open = False

    def __enter__(self) -> "ArmDriver":
        self.open()
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def ping(self, sid: int) -> int:
        model, comm, err = self._packet.ping(self._port, sid)
        _check(comm, err, f"ping({sid})")
        return model

    def get_state(self, sid: int) -> ServoState:
        pos, c1, e1 = self._packet.read2ByteTxRx(self._port, sid, ADDR_PRESENT_POSITION)
        spd, c2, e2 = self._packet.read2ByteTxRx(self._port, sid, ADDR_PRESENT_SPEED)
        load, c3, e3 = self._packet.read2ByteTxRx(self._port, sid, ADDR_PRESENT_LOAD)
        volt, c4, e4 = self._packet.read1ByteTxRx(self._port, sid, ADDR_PRESENT_VOLTAGE)
        temp, c5, e5 = self._packet.read1ByteTxRx(self._port, sid, ADDR_PRESENT_TEMPERATURE)
        for c, e, op in [
            (c1, e1, "pos"),
            (c2, e2, "speed"),
            (c3, e3, "load"),
            (c4, e4, "voltage"),
            (c5, e5, "temp"),
        ]:
            _check(c, e, f"read {op}({sid})")
        return ServoState(
            id=sid,
            position=pos,
            speed=_signed(spd),
            load=_signed(load),
            voltage=volt / 10.0,
            temperature=temp,
            error=0,
        )

    def list_states(self) -> list[ServoState]:
        return [self.get_state(sid) for sid in self.servo_ids]

    def get_position(self, sid: int) -> int:
        pos, comm, err = self._packet.read2ByteTxRx(self._port, sid, ADDR_PRESENT_POSITION)
        _check(comm, err, f"read pos({sid})")
        return pos

    def get_positions(self) -> dict[int, int]:
        return {sid: self.get_position(sid) for sid in self.servo_ids}

    def set_position(self, sid: int, goal: int, speed: int | None = None) -> None:
        goal = _clamp(int(goal), POS_MIN, POS_MAX)
        if speed is not None:
            sp = _clamp(int(speed), 0, 1023)
            comm, err = self._packet.write2ByteTxRx(self._port, sid, ADDR_GOAL_SPEED, sp)
            _check(comm, err, f"write speed({sid})")
        comm, err = self._packet.write2ByteTxRx(self._port, sid, ADDR_GOAL_POSITION, goal)
        _check(comm, err, f"write goal({sid})")

    def set_positions(self, goals: dict[int, int], speed: int | None = None) -> None:
        for sid, goal in goals.items():
            self.set_position(sid, goal, speed=speed)

    def jog(self, sid: int, delta: int, speed: int | None = None) -> int:
        cur = self.get_position(sid)
        goal = _clamp(cur + int(delta), POS_MIN, POS_MAX)
        self.set_position(sid, goal, speed=speed)
        return goal

    def set_torque(self, sid: int, on: bool) -> None:
        comm, err = self._packet.write1ByteTxRx(self._port, sid, ADDR_TORQUE_ENABLE, 1 if on else 0)
        _check(comm, err, f"torque({sid})")

    def set_torque_all(self, on: bool) -> None:
        for sid in self.servo_ids:
            self.set_torque(sid, on)

    def get_torque(self, sid: int) -> bool:
        val, comm, err = self._packet.read1ByteTxRx(self._port, sid, ADDR_TORQUE_ENABLE)
        _check(comm, err, f"read torque({sid})")
        return bool(val)

    def get_torques(self) -> dict[int, bool]:
        return {sid: self.get_torque(sid) for sid in self.servo_ids}

    def e_stop(self) -> None:
        """Limp — drop torque on every servo. Arm will sag under gravity."""
        self.set_torque_all(False)

    def pause(self) -> None:
        """Freeze in place — set goal to current and keep torque on."""
        for sid in self.servo_ids:
            cur = self.get_position(sid)
            self.set_position(sid, cur)

    # --- batched I/O ----------------------------------------------------
    # GroupSyncRead / GroupSyncWrite collapse all 6 servos into a single
    # bus transaction. Required for 30 Hz teleop — six individual
    # round-trips at ~3 ms each would saturate the bus.

    def sync_read_positions(self) -> dict[int, int]:
        gsr = scs.GroupSyncRead(self._port, self._packet, ADDR_PRESENT_POSITION, 2)
        try:
            for sid in self.servo_ids:
                gsr.addParam(sid)
            comm = gsr.txRxPacket()
            if comm != scs.COMM_SUCCESS:
                raise RuntimeError(f"sync_read_positions: comm error {comm}")
            out: dict[int, int] = {}
            for sid in self.servo_ids:
                if not gsr.isAvailable(sid, ADDR_PRESENT_POSITION, 2):
                    raise RuntimeError(f"sync_read_positions: no data for id={sid}")
                out[sid] = gsr.getData(sid, ADDR_PRESENT_POSITION, 2)
            return out
        finally:
            gsr.clearParam()

    def sync_write_positions(self, goals: dict[int, int]) -> None:
        gsw = scs.GroupSyncWrite(self._port, self._packet, ADDR_GOAL_POSITION, 2)
        try:
            for sid, pos in goals.items():
                pos = _clamp(int(pos), POS_MIN, POS_MAX)
                gsw.addParam(sid, bytearray([pos & 0xFF, (pos >> 8) & 0xFF]))
            comm = gsw.txPacket()
            if comm != scs.COMM_SUCCESS:
                raise RuntimeError(f"sync_write_positions: comm error {comm}")
        finally:
            gsw.clearParam()


def _clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


def _signed(raw: int) -> int:
    """STS3215 returns speed/load as 11-bit magnitude + sign-bit in bit 10."""
    if raw & 0x400:
        return -(raw & 0x3FF)
    return raw & 0x3FF

#!/usr/bin/env python3
"""
Exercise src/hardware/replay_settle.py without an arm: a fake DualArm whose
follower bus sags under gravity (servos 2–4 settle short of their goal by a
fixed droop), a fake logger that captures events, and a composed recording
with settle flags like BIMS writes.

    python3 scripts/simulate_replay_settle.py

Checks:
  1. A recording WITHOUT settle flags produces exactly the writes the
     original replay_session would (one Goal_Position per servo per frame,
     torque off/on first, off at the end) and no reads, no replay.settle.
  2. With settle flags, every flagged pose ends within SETTLE_TOL of its
     target on servos 1–5, the gripper is never corrected, the carried
     offset equals the droop, and one replay.settle event is logged inside
     the run (before replay.stop) with the BIMS contract fields.
  3. stop_event set mid-replay ends it promptly, torque off, no settle event
     claimed as ok for poses never reached.
  4. The offset is capped at MAX_OFFSET on a blocked joint and the result
     says ok = False.
  6. A header with hold_at_end (BIMS Animate) keeps torque ON at the end,
     whether the replay finished or was stopped.

Pure Python, no serial, no Pi packages. Also runnable on the dev PC.
"""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "src" / "hardware"))
import replay_settle as rs  # noqa: E402

rs.SETTLE_WAIT_S = 0.01  # keep the simulation quick; the loop's logic does not depend on it
rs.WINDOW_MARGIN_S = 0.0


class FakeBus:
    """Six servos; `droop[sid]` is how far short of the goal a servo settles."""

    def __init__(self, droop: dict[int, int], blocked: dict[int, int] | None = None) -> None:
        self.goal = {s: 2048 for s in range(1, 7)}
        self.droop = droop
        self.blocked = blocked or {}
        self.writes: list[tuple[int, str, int]] = []
        self.reads = 0

    def read(self, sid: int, name: str, retries: int = 2) -> int | None:
        self.reads += 1
        if name == "Present_Position":
            present = self.goal[sid] - self.droop.get(sid, 0)
            if sid in self.blocked:
                present = min(present, self.blocked[sid])
            return present
        return 0

    def write(self, sid: int, name: str, value: int) -> bool:
        self.writes.append((sid, name, int(value)))
        if name == "Goal_Position":
            self.goal[sid] = int(value)
        return True


class FakeLogger:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    def log_event(self, event_type: str, payload: dict) -> None:
        self.events.append((event_type, json.loads(json.dumps(payload))))


class FakeArms:
    dry_run = False

    def __init__(self, bus: FakeBus) -> None:
        self.follower = bus
        self.logger = FakeLogger()
        self.ramps: list[list[int]] = []

    def _write_all_torque(self, bus: FakeBus, value: int) -> None:
        for sid in range(1, 7):
            bus.write(sid, "Torque_Enable", value)

    def _ramp_follower_to(self, target: list[int | None], duration_s: float = 3.0) -> None:
        self.ramps.append([int(v) for v in target if v is not None])
        for i, v in enumerate(target):
            if v is not None:
                self.follower.write(i + 1, "Goal_Position", int(v))


def recording(path: Path, poses: list[tuple[list[int], float, bool, str | None]], rate_hz: float = 50.0, hold_at_end: bool = False, trim: dict[int, int] | None = None) -> None:
    """
    poses: (pose[6], hold_s, settle?, pose_id). Each pose holds for hold_s frames at rate_hz.
    `trim` (BIMS droop trim, {sid: steps}) is added to every frame's goal, as BIMS does; the
    settle frames echo the bare pose as `target`.
    """
    trimmed = lambda p: [v + (trim or {}).get(i + 1, 0) for i, v in enumerate(p)]  # noqa: E731
    header = {"event": "header", "version": "1", "rate_hz": rate_hz, "follower_neutral": trimmed(poses[0][0])}
    if hold_at_end:
        header["hold_at_end"] = True
    lines = [header]
    t = 0.0
    for target, hold_s, flag, pose in poses:
        goal = trimmed(target)
        n = max(1, int(hold_s * rate_hz))
        for k in range(n):
            rec: dict = {"event": "frame", "t": round(t, 4), "goal": goal}
            if flag and k == 0:
                rec.update({"settle": True, "pose": pose, "target": target})
            lines.append(rec)
            t += 1.0 / rate_hz
    lines.append({"event": "footer", "frames": len(lines) - 1})
    path.write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")


def goal_writes(bus: FakeBus) -> list[tuple[int, int]]:
    return [(s, v) for s, n, v in bus.writes if n == "Goal_Position"]


def check(cond: bool, msg: str) -> None:
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond:
        sys.exit(1)


def main() -> None:
    tmp = Path(tempfile.mkdtemp())
    A = [2048, 1500, 2600, 2000, 2048, 1800]
    B = [2100, 1300, 2900, 1900, 2048, 1800]
    droop = {2: 18, 3: 9, 4: 5}

    # 1. no flags: the original writes, plus position reads (in-play measurement), no settle event
    rs.MEASURE_DIR = tmp / "measured"
    frames_plain = 4  # two poses x 0.04 s at 50 Hz (was 2, which failed on master before 2026-11-19)
    p = tmp / "plain.jsonl"
    recording(p, [(A, 0.04, False, None), (B, 0.04, False, None)])
    bus = FakeBus(droop)
    arms = FakeArms(bus)
    rs.replay_session_settling(arms, p, loops=1, stop_event=threading.Event())
    kinds = [e for e, _ in arms.logger.events]
    check(kinds == ["replay.start", "replay.loop", "replay.ramp", "replay.stop"], f"plain: events {kinds}")
    # 2026-11-11: a plain play now reads each servo's position after each frame (in-play
    # measurement), never anything else, and saves the samples for BIMS.
    stop = [p for e, p in arms.logger.events if e == "replay.stop"][0]
    check(bus.reads <= 6 * frames_plain, f"plain: at most 6 position reads per frame ({bus.reads})")
    check(stop["measured"]["samples"] >= 1 and stop["measured"]["file"], f"plain: measured samples saved {stop['measured']}")
    torque = [(s, v) for s, n, v in bus.writes if n == "Torque_Enable"]
    check(torque[:6] == [(s, 0) for s in range(1, 7)] and torque[6:12] == [(s, 1) for s in range(1, 7)] and torque[-6:] == [(s, 0) for s in range(1, 7)], "plain: torque off, on, ..., off")
    gw = goal_writes(bus)
    frames = 4
    check(len(gw) == 6 + frames * 6, f"plain: ramp + one goal write per servo per frame ({len(gw)})")
    check(arms.ramps == [A], "plain: ramped to follower_neutral once")
    check(gw[-6:] == [(s, v) for s, v in zip(range(1, 7), B)], "plain: last frame written exactly as recorded")

    # 2. flagged poses settle; gripper untouched; carry = droop; event inside the run
    p = tmp / "settle.jsonl"
    recording(p, [(A, 0.5, True, "poseA"), (B, 0.5, True, "poseB")])
    bus = FakeBus(droop)
    arms = FakeArms(bus)
    t0 = time.time()
    rs.replay_session_settling(arms, p, loops=1, stop_event=threading.Event())
    kinds = [e for e, _ in arms.logger.events]
    check(kinds == ["replay.start", "replay.loop", "replay.ramp", "replay.settle", "replay.stop"], f"settle: events {kinds}")
    ev = dict(arms.logger.events)["replay.settle"]
    check(len(ev["settle"]) == 2 and [e["pose"] for e in ev["settle"]] == ["poseA", "poseB"], "settle: one entry per flagged pose, in order")
    for e in ev["settle"]:
        check(e["ok"] is True, f"settle: {e['pose']} ok after {e['rounds']} rounds, residual {e['residual']}")
        check(all(abs(r) <= rs.SETTLE_TOL for r in e["residual"][:5]), f"settle: {e['pose']} residual within tol")
        check(e["written"][5] == e["target"][5] == e["goal"][5], "settle: gripper goal never corrected")
        check(e["target"] == (A if e["pose"] == "poseA" else B), "settle: target echoed back for BIMS")
        for k in ("frame", "t", "pose", "target", "goal", "written", "present", "residual", "rounds", "ok"):
            check(k in e, f"settle: contract field {k}")
    check(ev["carry"] == [0, 18, 9, 5, 0, 0], f"settle: carried offset equals the droop {ev['carry']}")
    present_now = {s: bus.read(s, "Present_Position") for s in range(1, 6)}
    check(all(abs(present_now[s] - B[s - 1]) <= rs.SETTLE_TOL for s in range(1, 6)), f"settle: arm rests ON pose B {present_now}")
    check(time.time() - t0 < 5, "settle: finished within the recording's own time budget")

    # 2b. second loop reuses the carry (feed-forward) so the first write already lands close
    bus = FakeBus(droop)
    arms = FakeArms(bus)
    rs.replay_session_settling(arms, p, loops=2, stop_event=threading.Event())
    ev = dict(arms.logger.events)["replay.settle"]
    check(len(ev["settle"]) == 4 and [e["loop"] for e in ev["settle"]] == [1, 1, 2, 2], "loops: settle entries for both loops")
    check(ev["settle"][2]["rounds"] <= ev["settle"][0]["rounds"], "loops: carried offset makes the second pass no slower")

    # 2c. BIMS frames carry a droop trim in the goal (2026-11-06): the arm must rest on the
    #     TARGET (the pose), not on goal = pose + trim, and written - target is the true droop
    #     — whether the stored trim is too small, right, or stale-and-too-big.
    for label, trim in (("small", {2: 5, 3: 2, 4: 1}), ("exact", dict(droop)), ("stale", {2: 60, 3: 40, 4: 25})):
        p = tmp / f"trim-{label}.jsonl"
        recording(p, [(A, 0.5, True, "poseA"), (B, 0.5, True, "poseB")], trim=trim)
        bus = FakeBus(droop)
        arms = FakeArms(bus)
        rs.replay_session_settling(arms, p, loops=1, stop_event=threading.Event())
        ev = dict(arms.logger.events)["replay.settle"]
        for e in ev["settle"]:
            want = A if e["pose"] == "poseA" else B
            check(e["ok"] is True, f"trim {label}: {e['pose']} ok after {e['rounds']} rounds, residual {e['residual']}")
            check(all(abs(e["present"][s - 1] - want[s - 1]) <= rs.SETTLE_TOL for s in range(1, 6)), f"trim {label}: {e['pose']} rests on the pose, not pose + trim {e['present']} vs {want}")
            learned = [e["written"][s - 1] - e["target"][s - 1] for s in range(1, 6)]
            check(all(abs(learned[s - 1] - droop.get(s, 0)) <= rs.SETTLE_TOL for s in range(1, 6)), f"trim {label}: written - target is the true droop {learned}")
        present_now = {s: bus.read(s, "Present_Position") for s in range(1, 6)}
        check(all(abs(present_now[s] - B[s - 1]) <= rs.SETTLE_TOL for s in range(1, 6)), f"trim {label}: arm rests ON pose B at the end {present_now}")
        if label == "exact":
            check(ev["settle"][0]["rounds"] == 1, f"trim exact: a well-learned pose settles in one round ({ev['settle'][0]['rounds']})")

    # 3. stop mid-replay
    p = tmp / "long.jsonl"
    recording(p, [(A, 0.3, True, "poseA"), (B, 3.0, True, "poseB")])
    bus = FakeBus(droop)
    arms = FakeArms(bus)
    stop = threading.Event()
    threading.Timer(0.15, stop.set).start()
    t0 = time.time()
    rs.replay_session_settling(arms, p, loops=1, stop_event=stop)
    check(time.time() - t0 < 1.0, "stop: replay ended promptly after stop_event")
    torque = [(s, v) for s, n, v in bus.writes if n == "Torque_Enable"]
    check(torque[-6:] == [(s, 0) for s in range(1, 7)], "stop: torque off at the end")
    check([e for e, _ in arms.logger.events][-1] == "replay.stop", "stop: replay.stop still logged")

    # 4. blocked joint: offset capped, ok False, replay still completes
    p = tmp / "blocked.jsonl"
    recording(p, [(A, 0.5, True, "poseA")])
    bus = FakeBus(droop, blocked={2: A[1] - 120})
    arms = FakeArms(bus)
    rs.replay_session_settling(arms, p, loops=1, stop_event=threading.Event())
    ev = dict(arms.logger.events)["replay.settle"]
    e = ev["settle"][0]
    check(e["ok"] is False and abs(e["written"][1] - A[1]) == rs.MAX_OFFSET, f"blocked: offset capped at +/-{rs.MAX_OFFSET}, ok=False (written {e['written'][1]} vs goal {A[1]})")
    check([k for k, _ in arms.logger.events][-1] == "replay.stop", "blocked: replay completed")

    # 6. hold_at_end: torque stays on at the end (finished or stopped); the last goal is the last frame
    p = tmp / "hold.jsonl"
    recording(p, [(A, 0.04, False, None), (B, 0.04, False, None)], hold_at_end=True)
    bus = FakeBus(droop)
    arms = FakeArms(bus)
    rs.replay_session_settling(arms, p, loops=1, stop_event=threading.Event())
    torque = [(s, v) for s, n, v in bus.writes if n == "Torque_Enable"]
    check(torque == [(s, 0) for s in range(1, 7)] + [(s, 1) for s in range(1, 7)], "hold: torque off/on at the start only, never off at the end")
    check(goal_writes(bus)[-6:] == [(s, v) for s, v in zip(range(1, 7), B)], "hold: last goal is the last frame, so the arm holds it")
    check(dict(arms.logger.events)["replay.stop"].get("held") is True, "hold: replay.stop says held")
    p = tmp / "hold-long.jsonl"
    recording(p, [(A, 0.3, False, None), (B, 3.0, False, None)], hold_at_end=True)
    bus = FakeBus(droop)
    arms = FakeArms(bus)
    stop = threading.Event()
    threading.Timer(0.15, stop.set).start()
    rs.replay_session_settling(arms, p, loops=1, stop_event=stop)
    torque = [(s, v) for s, n, v in bus.writes if n == "Torque_Enable"]
    check(torque[-6:] == [(s, 1) for s in range(1, 7)], "hold: stopped mid-replay, torque still on")

    # 7. step PID (2026-11-19): set at the step's frame, normal gains back at its restore frame
    #    and at the end, Lock 1 before every gain write, a died play's gains recovered first.
    class FakePacket:
        def __init__(self, regs: dict[tuple[int, int], int], fail_read: set[int] | None = None) -> None:
            self.regs = regs
            self.fail_read = fail_read or set()
            self.log: list[tuple[int, int, int]] = []

        def read1ByteTxRx(self, _port, sid: int, addr: int):
            if sid in self.fail_read:
                return 0, -1, 0
            return self.regs.get((sid, addr), 0), 0, 0

        def write1ByteTxRx(self, _port, sid: int, addr: int, value: int):
            self.regs[(sid, addr)] = value
            self.log.append((sid, addr, value))
            return 0, 0

    rs.GAINS_STATE_FILE = tmp / "step-gains.json"
    rs.StepGains.__init__.__defaults__ = (rs.GAINS_STATE_FILE,)
    normal = {(s, a): v for s in range(1, 7) for a, v in ((21, 32), (22, 45), (23, 4))}

    def gain_recording(path: Path, stop_long: bool = False) -> None:
        lines = [{"event": "header", "version": "1", "rate_hz": 50, "follower_neutral": A, "hold_at_end": True}]
        for k in range(6):
            rec: dict = {"event": "frame", "t": round(k * 0.02, 4), "goal": A if k < 3 else B}
            if k == 1:
                rec["gains"] = {"set": [{"id": 3, "i": 0, "d": 30}, {"id": 2, "p": 99}]}  # p 99 is out of range: dropped
            if k == 4 and not stop_long:
                rec["gains"] = {"restore": True}
            lines.append(rec)
        if stop_long:
            lines += [{"event": "frame", "t": round(0.12 + k * 0.02, 4), "goal": B} for k in range(150)]
        path.write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")

    def gain_bus(fail_read: set[int] | None = None) -> FakeBus:
        b = FakeBus(droop)
        b._packet_handler = FakePacket(dict(normal), fail_read)  # type: ignore[attr-defined]
        b._port_handler = None  # type: ignore[attr-defined]
        return b

    p = tmp / "gains.jsonl"
    gain_recording(p)
    bus = gain_bus()
    arms = FakeArms(bus)
    rs.replay_session_settling(arms, p, loops=1, stop_event=threading.Event())
    ph = bus._packet_handler  # type: ignore[attr-defined]
    ev = dict(arms.logger.events)
    check(ev["replay.start"]["gain_servos"] == [3], f"gains: only servo 3 has a usable override {ev['replay.start']['gain_servos']}")
    sets = [e for e in ev["replay.gains"]["gains"] if "set" in e]
    check(len(sets) == 1 and sets[0]["servo"] == 3 and sets[0]["set"] == {"i": 0, "d": 30} and sets[0]["frame"] == 1, f"gains: servo 3 set at frame 1 {sets}")
    restores = [e for e in ev["replay.gains"]["gains"] if "restore" in e]
    check(restores and restores[0]["frame"] == 4 and restores[0]["restore"] == {"p": 32, "d": 45, "i": 4}, f"gains: normal gains back at frame 4 {restores}")
    check(ph.regs[(3, 22)] == 45 and ph.regs[(3, 23)] == 4 and ph.regs[(2, 21)] == 32, "gains: registers end at the normal values")
    lock_first = all(ph.log[i - 1] == (sid, 55, 1) for i, (sid, addr, _v) in enumerate(ph.log) if addr in (21, 22, 23) and ph.log[i - 1][1] != addr - 1 and ph.log[i - 1][1] not in (21, 22))
    check(lock_first and all(v == 1 for _s, a, v in ph.log if a == 55), f"gains: Lock 1 before each servo's gain writes, never 0 {ph.log}")
    check(not rs.GAINS_STATE_FILE.exists(), "gains: state file removed after a clean end")
    check([k for k, _ in arms.logger.events][-1] == "replay.stop", "gains: replay completed")

    # 7b. stopped mid-step: gains still come back
    p = tmp / "gains-stop.jsonl"
    gain_recording(p, stop_long=True)
    bus = gain_bus()
    arms = FakeArms(bus)
    stop = threading.Event()
    threading.Timer(0.3, stop.set).start()
    rs.replay_session_settling(arms, p, loops=1, stop_event=stop)
    ph = bus._packet_handler  # type: ignore[attr-defined]
    check(ph.regs[(3, 22)] == 45 and ph.regs[(3, 23)] == 4, "gains stop: normal gains back after Stop")
    check(not rs.GAINS_STATE_FILE.exists(), "gains stop: state file removed")

    # 7c. a died play left gains set: the next play puts them back before reading the normal ones
    rs.GAINS_STATE_FILE.write_text(json.dumps({"3": {"p": 32, "d": 45, "i": 4}}), encoding="utf-8")
    bus = gain_bus()
    bus._packet_handler.regs[(3, 23)] = 0  # type: ignore[attr-defined]  # left at the override
    arms = FakeArms(bus)
    p = tmp / "gains.jsonl"
    gain_recording(p)
    rs.replay_session_settling(arms, p, loops=1, stop_event=threading.Event())
    ev = dict(arms.logger.events)["replay.gains"]["gains"]
    check(ev[0].get("recover") == {"3": {"p": 32, "d": 45, "i": 4}} and ev[0]["ok"], f"gains recover: died play's gains restored first {ev[0]}")
    restores = [e for e in ev if "restore" in e]
    check(restores[0]["restore"] == {"p": 32, "d": 45, "i": 4}, "gains recover: normal gains read after the recovery, not the override")

    # 7d. gains cannot be read: that servo is left alone
    bus = gain_bus(fail_read={3})
    arms = FakeArms(bus)
    rs.replay_session_settling(arms, p, loops=1, stop_event=threading.Event())
    ph = bus._packet_handler  # type: ignore[attr-defined]
    check(not any(a in (21, 22, 23) for _s, a, _v in ph.log), "gains unreadable: no gain write at all")

    # 7e. a plain play never touches gains (FakeBus without a packet handler, as in checks 1-6)
    p = tmp / "plain.jsonl"
    bus = gain_bus()
    arms = FakeArms(bus)
    rs.replay_session_settling(arms, p, loops=1, stop_event=threading.Event())
    check(not bus._packet_handler.log and "replay.gains" not in dict(arms.logger.events), "plain: no gain writes, no replay.gains event")  # type: ignore[attr-defined]

    # 5. install() rebinds the name in a stand-in sessions module
    import types

    fake_sessions = types.ModuleType("src.server.sessions")
    original = object()
    fake_sessions.replay_session = original  # type: ignore[attr-defined]
    sys.modules["src.server.sessions"] = fake_sessions
    r1 = rs.install()
    r2 = rs.install()
    check(fake_sessions.replay_session is rs.replay_session_settling and fake_sessions.replay_session_original is original, "install: sessions.replay_session rebound, original kept")  # type: ignore[attr-defined]
    check(r1 == {"installed": True, "already": False} and r2 == {"installed": True, "already": True}, "install: idempotent")

    print("\nall checks passed")


if __name__ == "__main__":
    main()

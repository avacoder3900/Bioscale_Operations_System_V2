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


def recording(path: Path, poses: list[tuple[list[int], float, bool, str | None]], rate_hz: float = 50.0) -> None:
    """poses: (goal[6], hold_s, settle?, pose_id). Each pose holds for hold_s frames at rate_hz."""
    lines = [{"event": "header", "version": "1", "rate_hz": rate_hz, "follower_neutral": poses[0][0]}]
    t = 0.0
    for goal, hold_s, flag, pose in poses:
        n = max(1, int(hold_s * rate_hz))
        for k in range(n):
            rec: dict = {"event": "frame", "t": round(t, 4), "goal": goal}
            if flag and k == 0:
                rec.update({"settle": True, "pose": pose, "target": goal})
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

    # 1. no flags: identical to the original (writes only, no reads, no settle event)
    p = tmp / "plain.jsonl"
    recording(p, [(A, 0.04, False, None), (B, 0.04, False, None)])
    bus = FakeBus(droop)
    arms = FakeArms(bus)
    rs.replay_session_settling(arms, p, loops=1, stop_event=threading.Event())
    kinds = [e for e, _ in arms.logger.events]
    check(kinds == ["replay.start", "replay.loop", "replay.stop"], f"plain: events {kinds}")
    check(bus.reads == 0, "plain: no bus reads")
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
    check(kinds == ["replay.start", "replay.loop", "replay.settle", "replay.stop"], f"settle: events {kinds}")
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

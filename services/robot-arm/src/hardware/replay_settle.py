"""
Closed-loop replay — settle the follower ON the goal wherever the path holds
still. ARM-06 Animate, PRD §11.

Why: replay is open-loop. Each frame's goal is written and nothing else, and
under gravity a loaded STS3215 settles a few to a few tens of steps SHORT of
its goal (its position loop is proportional), so the claw ends low at every
pose. Only the replay loop can fix this mid-path, because it owns the serial
bus while it runs — BIMS cannot read or nudge the arm until the session ends.

What: BIMS marks the frames where the path arrives at a held pose, and the
last frame, with `"settle": true` (plus `"pose"` and `"target"`, echoed back
so BIMS can learn each pose's droop). At such a frame this loop writes the
goal, waits for the servo to stop, reads where it is, adds the shortfall to a
per-servo OFFSET (servos 1–5, never the gripper), writes goal + offset and
repeats, until every servo is within SETTLE_TOL steps or the hold window runs
out. The offset is carried into the following frames (a gravity feed-forward
for the next move) and re-learned at the next settle point. Frames keep their
timing: settling only uses the time the path would have spent holding still.

Results are logged as one `replay.settle` run event (the same JSONL logger +
BIMS webhook pipeline every session event uses, so it lands in
robot_arm_runs.events with payload.settle / payload.carry):
    {"settle": [{"frame", "t", "pose", "target", "goal", "written",
                 "present", "residual", "rounds", "ok"}], "carry": [6]}

How it fits the live Pi (re-ported 2026-10-22 against the real layout —
the first draft assumed a session class with `_replay_loop`, which the Pi
does not have):
  * `src/server/sessions.py` runs `replay_session(arms, source_path, loops,
    stop_event)` from `src/hardware/dual_arm.py` in a worker thread, with the
    run id set on the logging context, so `arms.logger.log_event(...)` from
    here reaches BIMS as a run event.
  * `replay_session_settling` below is a drop-in with the same signature and
    the same behaviour (header check, replay.start / loop / stop events,
    torque off→on, ramp to `follower_neutral`, per-frame goal writes, torque
    off at the end) plus the settle pass at flagged frames. Exception: a
    header with `"hold_at_end": true` (BIMS Animate) keeps torque ON at the
    end, so the arm holds the last pose instead of sagging off it.
  * The bus is `arms.follower` (FeetechBus): `read(sid, "Present_Position")`
    and `write(sid, "Goal_Position", steps)`, one servo at a time.
  * `install()` rebinds the name `replay_session` inside
    `src.server.sessions` (it imported it by name, so patching
    `dual_arm.replay_session` alone would do nothing). Done by
    scripts/install_replay_settle.py, which adds two lines to app.py.

Recording lines accepted: `{"event":"frame","t":…,"goal":[6]}` (what the Pi
records and what BIMS composes), and the older `{"t":…,"positions":{sid:steps}}`.
Header/footer lines are skipped for playback; the header's `follower_neutral`
is the ramp target as in the original (first frame's goal if the header has
none). Recordings without settle flags play exactly as before: one write per
servo per frame, no reads.

Simulated against a sagging fake bus (services/robot-arm/scripts/
simulate_replay_settle.py); not yet run on the arm.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Callable, Optional

POS_MIN = 0
POS_MAX = 4095
SERVO_COUNT = 6

#: Servos corrected for droop: base, shoulder, elbow, wrist flex, wrist roll.
#: Not the gripper — its shortfall when closed on a part IS the grip.
SETTLE_SERVOS = (1, 2, 3, 4, 5)
#: Done when every settled servo is within this many steps of the goal.
SETTLE_TOL = 2
#: The offset may not grow past this; more is a stalled or blocked joint, not droop.
MAX_OFFSET = 50
#: How long a servo is given to stop after a goal write before it is read.
SETTLE_WAIT_S = 0.25
#: A settle window ends this long before the next moving frame, so that frame is on time.
WINDOW_MARGIN_S = 0.12
#: The last frame has no next frame; give it this long at most.
END_WINDOW_S = 2.5
MAX_ROUNDS = 8


def _clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


# ── recordings ──────────────────────────────────────────────────────────


def parse_frames(lines: list[dict]) -> list[dict]:
    """Frames of a parsed recording as `{t, goal: {sid: steps}, settle, pose, target}`."""
    out: list[dict] = []
    for rec in lines:
        ev = rec.get("event")
        if ev is not None and ev != "frame":
            continue
        if isinstance(rec.get("goal"), list):
            goal = {i + 1: _clamp(int(v), POS_MIN, POS_MAX) for i, v in enumerate(rec["goal"])}
        elif isinstance(rec.get("positions"), dict):
            goal = {int(sid): _clamp(int(v), POS_MIN, POS_MAX) for sid, v in rec["positions"].items()}
        else:
            raise ValueError("recording frame has neither goal[] nor positions{}")
        out.append(
            {
                "t": float(rec["t"]),
                "goal": goal,
                "settle": bool(rec.get("settle")),
                "pose": rec.get("pose"),
                "target": rec.get("target"),
            }
        )
    return out


def load_frames(source: str, recordings_dir: Optional[Path] = None) -> list[dict]:
    """Frames of a recording file (kept for callers of the first draft)."""
    p = Path(source)
    candidates: list[Path] = [p] if p.is_absolute() else [p]
    if recordings_dir is not None and not p.is_absolute():
        candidates += [recordings_dir / source, recordings_dir / f"{source}.jsonl"]
    path = next((c for c in candidates if c.exists()), None)
    if path is None:
        raise FileNotFoundError(f"recording not found: {source}")
    with path.open("r", encoding="utf-8") as fh:
        lines = [json.loads(line) for line in fh if line.strip()]
    return parse_frames(lines)


def window_end_index(frames: list[dict], i: int) -> int:
    """First frame after `i` whose goal differs (len(frames) if none): the hold ends there."""
    j = i + 1
    while j < len(frames) and frames[j]["goal"] == frames[i]["goal"]:
        j += 1
    return j


# ── the settle pass ─────────────────────────────────────────────────────


def settle(
    read: Callable[[], dict[int, int]],
    write: Callable[[dict[int, int]], None],
    goal: dict[int, int],
    offset: dict[int, int],
    deadline: float,
    cancelled: Callable[[float], bool],
) -> dict[str, Any]:
    """
    Nudge the follower onto `goal` (servos 1–5) before `deadline` (time.time()).
    `offset` is the carried feed-forward; it is updated in place with what
    this pose needed. `cancelled(seconds)` waits that long and returns True
    if the session was cancelled meanwhile. Returns the round-by-round result.
    """
    rounds = 0
    present: dict[int, int] = {}
    residual: dict[int, int] = {}
    ok = False
    written = {sid: _clamp(goal[sid] + offset.get(sid, 0), POS_MIN, POS_MAX) for sid in goal}
    while rounds < MAX_ROUNDS:
        wait = min(SETTLE_WAIT_S, deadline - time.time())
        if wait <= 0:
            break
        if cancelled(wait):
            break
        rounds += 1
        present = read()
        residual = {sid: goal[sid] - present[sid] for sid in SETTLE_SERVOS if sid in goal and sid in present}
        ok = bool(residual) and all(abs(r) <= SETTLE_TOL for r in residual.values())
        if ok or not residual:
            break
        for sid, r in residual.items():
            offset[sid] = _clamp(offset.get(sid, 0) + r, -MAX_OFFSET, MAX_OFFSET)
        written = {sid: _clamp(goal[sid] + offset.get(sid, 0), POS_MIN, POS_MAX) for sid in goal}
        if time.time() >= deadline:
            break
        write(written)
    return {
        "goal": [goal.get(s) for s in range(1, SERVO_COUNT + 1)],
        "written": [written.get(s) for s in range(1, SERVO_COUNT + 1)],
        "present": [present.get(s) for s in range(1, SERVO_COUNT + 1)],
        "residual": [residual.get(s, 0) for s in range(1, SERVO_COUNT + 1)],
        "rounds": rounds,
        "ok": ok,
    }


# ── the Pi's replay, with settling ──────────────────────────────────────


def _bus_io(bus: Any) -> tuple[Callable[[], dict[int, int]], Callable[[dict[int, int]], None]]:
    """read()/write() over a FeetechBus, one servo at a time (its only API)."""

    def read() -> dict[int, int]:
        out: dict[int, int] = {}
        for sid in SETTLE_SERVOS:
            v = bus.read(sid, "Present_Position")
            if v is not None:
                out[sid] = int(v)
        return out

    def write(goals: dict[int, int]) -> None:
        for sid, v in goals.items():
            bus.write(sid, "Goal_Position", int(v))

    return read, write


def replay_session_settling(
    arms: Any,
    source_path: Path,
    loops: int = 1,
    stop_event: Any = None,
) -> None:
    """Drop-in for dual_arm.replay_session: the same replay, settling on flagged frames.

    The leader is NOT touched during replay (its torque stays disabled).
    The follower is ramped to the recorded follower_neutral, then driven
    through the recorded goals at the recorded cadence. Each loop ramps
    back to neutral first.
    """
    source_path = Path(source_path)
    if not source_path.exists():
        raise FileNotFoundError(f"recording not found: {source_path}")

    with source_path.open("r", encoding="utf-8") as fp:
        lines = [json.loads(line) for line in fp if line.strip()]
    header = next((entry for entry in lines if entry.get("event") == "header"), None)
    if header is None:
        raise ValueError(f"recording {source_path} has no header")
    frames = parse_frames(lines)
    if not frames:
        raise ValueError(f"recording {source_path} has no frames")
    flagged = sum(1 for f in frames if f["settle"])

    arms.logger.log_event(
        "replay.start",
        {"source_path": str(source_path), "loops": loops, "frames": len(frames), "settle_frames": flagged},
    )
    if arms.dry_run:
        arms.logger.log_event(
            "replay.dry_run_skip", {"frames": len(frames), "loops": loops}
        )
        return

    assert arms.follower is not None
    follower = arms.follower
    read, write = _bus_io(follower)

    def cancelled(seconds: float) -> bool:
        if stop_event is None:
            time.sleep(seconds)
            return False
        return bool(stop_event.wait(seconds))

    def stopped() -> bool:
        return stop_event is not None and stop_event.is_set()

    arms._write_all_torque(follower, 0)
    arms._write_all_torque(follower, 1)
    first_goal = [frames[0]["goal"].get(s) for s in range(1, SERVO_COUNT + 1)]
    follower_neutral = header.get("follower_neutral") or first_goal

    offset: dict[int, int] = {sid: 0 for sid in SETTLE_SERVOS}
    results: list[dict] = []
    n = len(frames)
    try:
        for loop_idx in range(loops):
            if stopped():
                break
            arms.logger.log_event("replay.loop", {"index": loop_idx + 1, "of": loops})
            arms._ramp_follower_to(follower_neutral)
            t_loop_start = time.perf_counter()
            for i, frame in enumerate(frames):
                if stopped():
                    break
                wait = frame["t"] - (time.perf_counter() - t_loop_start)
                if wait > 0 and cancelled(wait):
                    break
                goal = frame["goal"]
                write({sid: _clamp(p + offset.get(sid, 0), POS_MIN, POS_MAX) for sid, p in goal.items()})
                if not frame["settle"]:
                    continue
                j = window_end_index(frames, i)
                if j < n:
                    deadline = time.time() + (frames[j]["t"] - (time.perf_counter() - t_loop_start)) - WINDOW_MARGIN_S
                else:
                    deadline = time.time() + END_WINDOW_S
                r = settle(read, write, goal, offset, deadline, cancelled)
                r.update({"frame": i, "t": frame["t"], "pose": frame.get("pose"), "target": frame.get("target"), "loop": loop_idx + 1})
                results.append(r)
    except KeyboardInterrupt:
        pass
    finally:
        if results:
            try:
                arms.logger.log_event(
                    "replay.settle",
                    {"settle": results, "carry": [offset.get(s, 0) for s in range(1, SERVO_COUNT + 1)]},
                )
            except Exception as exc:  # the webhook must never fail the replay
                print(f"[replay_settle] settle event not logged: {exc}")
        # BIMS Animate recordings ask to keep holding (header `hold_at_end`,
        # 2026-10-22): dropping torque here let the arm sag off the last pose
        # every time, so it never ended where the move set put it. The last
        # goal written is the last frame, so torque-on simply holds it.
        if arms.follower is not None and not header.get("hold_at_end"):
            arms._write_all_torque(arms.follower, 0)
    arms.logger.log_event("replay.stop", {"settled": len(results), "held": bool(header.get("hold_at_end"))})


def install() -> dict[str, Any]:
    """Make the session manager run the settling replay (idempotent).

    `src.server.sessions` imported `replay_session` by name, so the name is
    rebound there; `dual_arm.replay_session` stays as the original for
    anything else that uses it.
    """
    import importlib
    import sys

    name = "src.server.sessions"
    sessions_mod = sys.modules.get(name) or importlib.import_module(name)
    current = getattr(sessions_mod, "replay_session", None)
    if current is replay_session_settling:
        return {"installed": True, "already": True}
    if current is None:
        raise RuntimeError("src.server.sessions has no replay_session to replace")
    sessions_mod.replay_session_original = current  # type: ignore[attr-defined]
    sessions_mod.replay_session = replay_session_settling  # type: ignore[attr-defined]
    return {"installed": True, "already": False}

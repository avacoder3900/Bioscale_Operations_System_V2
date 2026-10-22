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

Results are emitted as one `replay.settle` session event (webhook) at the end:
    {"settle": [{"frame", "t", "pose", "target", "goal", "written",
                 "present", "residual", "rounds", "ok"}], "carry": [6]}

Recording lines accepted: `{"event":"frame","t":…,"goal":[6]}` (what the Pi
writes and what BIMS writes), and the older `{"t":…,"positions":{sid:steps}}`.
Header/footer lines are skipped. Recordings without settle flags play exactly
as before (one write per frame, no reads).

Installed by scripts/install_replay_settle.py: `install(SessionClass)`
replaces the class's `_replay_loop`. The loop uses these session attributes,
as in src/arm/leader_follower.py: `follower` (sync_read_positions /
sync_write_positions), `source`, `loops`, `_cancel` (threading.Event) and
`_emit(suffix, extra)`. If the Pi's session class (dual_arm.py) names them
differently, edit the five references in `_replay_loop_settling`.

NOT yet exercised against hardware (written 2026-10-22 without Pi access).
"""

from __future__ import annotations

import json
import os
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


def load_frames(source: str, recordings_dir: Optional[Path] = None) -> list[dict]:
    """Frames of a recording as `{t, goal: {sid: steps}, settle, pose, target}`."""
    p = Path(source)
    candidates: list[Path] = [p] if p.is_absolute() else []
    if recordings_dir is not None and not p.is_absolute():
        candidates += [recordings_dir / source, recordings_dir / f"{source}.jsonl"]
    path = next((c for c in candidates if c.exists()), None)
    if path is None:
        raise FileNotFoundError(f"recording not found: {source}")
    out: list[dict] = []
    with path.open() as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
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
        ok = all(abs(r) <= SETTLE_TOL for r in residual.values())
        if ok:
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


def _recordings_dir() -> Optional[Path]:
    try:
        from arm.recordings import RECORDINGS_DIR  # type: ignore

        return Path(RECORDINGS_DIR)
    except Exception:
        env = os.environ.get("BIMS_ARM_RECORDINGS")
        return Path(env) if env else None


def _replay_loop_settling(self: Any) -> None:
    """Drop-in for the session's `_replay_loop`: the original behaviour plus settling."""
    if not self.source:
        raise RuntimeError("replay requires a `source` recording name")
    frames = load_frames(self.source, _recordings_dir())
    if not frames:
        raise RuntimeError(f"recording '{self.source}' is empty")
    follower = self.follower
    cancel = self._cancel

    # Follower torque on, goals snapped first (as the original loop does).
    snap = follower.sync_read_positions()
    follower.sync_write_positions(snap)
    follower.set_torque_all(True)

    offset: dict[int, int] = {sid: 0 for sid in SETTLE_SERVOS}
    results: list[dict] = []
    n = len(frames)
    for _loop in range(max(int(getattr(self, "loops", 1) or 1), 1)):
        if cancel.is_set():
            return
        loop_start = time.time()
        for i, frame in enumerate(frames):
            if cancel.is_set():
                return
            target_t = loop_start + frame["t"]
            sleep_for = target_t - time.time()
            if sleep_for > 0 and cancel.wait(sleep_for):
                return
            goal = frame["goal"]
            follower.sync_write_positions({sid: _clamp(p + offset.get(sid, 0), POS_MIN, POS_MAX) for sid, p in goal.items()})
            if not frame["settle"]:
                continue
            j = window_end_index(frames, i)
            deadline = (loop_start + frames[j]["t"] - WINDOW_MARGIN_S) if j < n else (time.time() + END_WINDOW_S)
            r = settle(follower.sync_read_positions, follower.sync_write_positions, goal, offset, deadline, cancel.wait)
            r.update({"frame": i, "t": frame["t"], "pose": frame.get("pose"), "target": frame.get("target")})
            results.append(r)

    if results:
        try:
            self._emit("settle", extra={"settle": results, "carry": [offset.get(s, 0) for s in range(1, SERVO_COUNT + 1)]})
        except Exception as exc:  # the webhook must never fail the replay
            print(f"[replay_settle] emit failed: {exc}")


def install(session_cls: type) -> None:
    """Replace `session_cls._replay_loop` with the settling loop (idempotent)."""
    if getattr(session_cls, "_replay_loop", None) is _replay_loop_settling:
        return
    session_cls._replay_loop_original = getattr(session_cls, "_replay_loop", None)  # type: ignore[attr-defined]
    session_cls._replay_loop = _replay_loop_settling  # type: ignore[attr-defined]

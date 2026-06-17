"""
Per-move telemetry log for the SO-100 follower.

Each completed move (any /servos/positions, /poses/{name}/move, /jog/...
that goes through `verified_move`) appends one JSONL line to
~/.bims-arm/move-log.jsonl. The log is the only place that captures
across-time drift: STS3215 wear shows up as slowly-growing residuals,
declining hold torque, or rising peak loads for the same commanded pose.

Schema per line (all fields optional except `t` and `op`):

  t                  ISO 8601 UTC timestamp at move completion
  op                 "set_positions" | "pose_move" | "joint_jog" | "cartesian_jog"
  target             list[int]  goal step per servo (id order 1..6)
  speed              int        goal_speed register value (0 = uncapped/max)
  achieved           list[int]  actual position at end-of-move
  residuals          list[int]  achieved - target, per servo
  peak_loads         list[int]  max |load| observed per servo during move
  peak_temps         list[int]  max temperature observed per servo
  duration_ms        int        wall time from goal write to settled/timeout
  attempts           int        retry attempts within verified_move
  success            bool       within-tolerance arrival
  failure_reason     str        absent on success; one of "stalled_short",
                                 "timed_out", "stalled_short_retries_exhausted"
  pose_name          str?       set when op = pose_move
  note               str?       free-form context

Thread-safe — append-only, one fd per write.
"""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MOVE_LOG_PATH = Path(
    os.environ.get(
        "BIMS_ARM_MOVE_LOG",
        str(Path.home() / ".bims-arm" / "move-log.jsonl"),
    )
)

_lock = threading.Lock()


def log_move(record: dict[str, Any]) -> None:
    """Append one move record. Adds `t` if absent. Errors are swallowed —
    telemetry must never break the move itself."""
    try:
        record.setdefault("t", datetime.now(timezone.utc).isoformat())
        MOVE_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with _lock:
            with MOVE_LOG_PATH.open("a") as fh:
                fh.write(json.dumps(record, separators=(",", ":")) + "\n")
    except Exception as exc:
        print(f"[telemetry] log_move failed (swallowed): {exc}", flush=True)


def tail(n: int = 50) -> list[dict]:
    """Read the last `n` JSONL records (most recent first). Returns [] if no log."""
    if not MOVE_LOG_PATH.exists():
        return []
    try:
        with MOVE_LOG_PATH.open() as fh:
            lines = fh.readlines()
        out: list[dict] = []
        for line in reversed(lines[-n:]):
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                continue
        return out
    except Exception as exc:
        print(f"[telemetry] tail failed: {exc}")
        return []

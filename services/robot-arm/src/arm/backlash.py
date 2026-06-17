"""
Per-joint backlash compensation for the SO-100 follower's plastic gear train.

STS3215 servos read their own encoder on the motor side, not the gearbox
output. When commanded motion reverses direction, the motor has to take up
the gear backlash (~0.5-1° = ~2-3mm at the tip) before the *output* shaft
starts moving. The first reversal-direction move under-runs the commanded
distance by exactly that backlash.

Compensation: track each joint's last-commanded direction. When the next
commanded delta reverses that direction, ADD `backlash_steps` to the
target in the new direction so the gear slack is consumed and the output
shaft reaches the intended position. The motor will read past-target by
the backlash amount; the *arm tip* will reach the intended target.

State persists to ~/.bims-arm/jog-state.json so server restarts don't
forget the last direction (otherwise the first jog after restart always
behaves as if reversing from unknown).

Backlash amount is configurable per joint in jog-calibration.json under
"backlash_steps" (default 10 = ~0.9° = ~3mm tip). Tune empirically.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Optional

JOG_STATE_PATH = Path(
    os.environ.get(
        "BIMS_ARM_JOG_STATE",
        str(Path.home() / ".bims-arm" / "jog-state.json"),
    )
)

DEFAULT_BACKLASH_STEPS = 10  # ~0.88°; per-joint override in calibration JSON


class BacklashCompensator:
    """Per-joint last-direction tracker + reversal compensation.

    Thread-safe — used by the FastAPI server's worker threads.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # last_direction[sid] in {+1, -1, 0}. 0 = unknown (no compensation
        # applied; treated as same-direction).
        self.last_direction: dict[int, int] = {}
        self._load()

    def _load(self) -> None:
        if JOG_STATE_PATH.exists():
            try:
                raw = json.loads(JOG_STATE_PATH.read_text())
                self.last_direction = {int(k): int(v) for k, v in (raw.get("last_direction") or {}).items()}
            except Exception as exc:
                print(f"[backlash] failed to load {JOG_STATE_PATH}: {exc}")

    def _save(self) -> None:
        JOG_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        JOG_STATE_PATH.write_text(json.dumps({"last_direction": self.last_direction}, indent=2))

    @staticmethod
    def _backlash_for(sid: int, calibration: dict) -> int:
        # Per-joint override in calibration JSON; fallback to global default.
        bl = (calibration.get("backlash_steps") or {}).get(str(sid))
        if bl is None:
            return DEFAULT_BACKLASH_STEPS
        return max(0, int(bl))

    def compensate(
        self,
        current_steps: dict[int, int],
        target_steps: dict[int, int],
        calibration: dict,
    ) -> tuple[dict[int, int], dict[int, int]]:
        """Apply compensation to `target_steps` based on each joint's last direction.

        Returns (compensated_targets, compensation_applied_per_joint).
        Compensation amount is signed: positive means we added steps in the new
        direction; zero means no compensation (no reversal or backlash=0).
        Saves updated last_direction state to disk.
        """
        compensated: dict[int, int] = {}
        applied: dict[int, int] = {}
        new_directions: dict[int, int] = {}
        with self._lock:
            for sid, target in target_steps.items():
                cur = current_steps.get(sid, target)
                delta = target - cur
                new_dir = 0 if delta == 0 else (1 if delta > 0 else -1)
                last_dir = self.last_direction.get(sid, 0)
                comp = 0
                if new_dir != 0 and last_dir != 0 and new_dir != last_dir:
                    # Direction reversed — eat the backlash by overshooting.
                    backlash = self._backlash_for(sid, calibration)
                    comp = new_dir * backlash
                compensated[sid] = target + comp
                applied[sid] = comp
                # Record the *commanded* direction (after compensation) so the
                # next call knows what side of the backlash we're on.
                if new_dir != 0:
                    new_directions[sid] = new_dir
                else:
                    new_directions[sid] = last_dir  # no motion = no change
            self.last_direction.update(new_directions)
            try:
                self._save()
            except Exception as exc:
                print(f"[backlash] save failed: {exc}")
        return compensated, applied

    def reset(self) -> None:
        """Clear all last-direction state. Use after a manual move where direction
        isn't known (e.g., hand-poseing the arm with torque off)."""
        with self._lock:
            self.last_direction = {}
            try:
                self._save()
            except Exception as exc:
                print(f"[backlash] save failed: {exc}")


_singleton: Optional[BacklashCompensator] = None


def get_backlash() -> BacklashCompensator:
    global _singleton
    if _singleton is None:
        _singleton = BacklashCompensator()
    return _singleton

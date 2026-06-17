"""
verified_move — watch a follower move and react if it stalls.

Replaces the naive "write goal, sleep, hope" pattern with:

  1. Write goal at requested speed.
  2. Poll position+load at ~10 Hz.
  3. Classify each tick: moving / arrived / stalled / timed-out.
  4. On stall short of target, retry with progressively stronger remedies:
        a. Re-write goal at full speed (the original speed may have been
           too gentle for the load).
        b. Brief torque cycle on stuck joints (often unwedges an STS3215
           that latched into an overload state), then re-write goal.
     If neither recovers, return failure_reason="stalled_short_retries_exhausted".
  5. Always log the attempt to arm.telemetry — success or failure.

Synchronous (blocking). Designed to be called from `asyncio.to_thread`
on the FastAPI side so the event loop keeps spinning.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Optional

from arm.driver import ArmDriver
from arm.telemetry import log_move

ARRIVAL_TOLERANCE = 20         # steps; STS3215 settles within ~10-20 under load
STALL_WINDOW_S = 0.5           # if no joint moves >2 steps for this long, declare stall
STALL_MIN_DELTA = 2            # steps of motion that counts as "still moving"
SAMPLE_INTERVAL_S = 0.1        # 10 Hz position sampling
MOVE_TIMEOUT_S = 8.0           # per-attempt wall-clock cap
MAX_RETRY_ATTEMPTS = 2         # in addition to the initial attempt


@dataclass
class MoveResult:
    success: bool
    target: list[int]
    achieved: list[int]
    residuals: list[int]
    peak_loads: list[int]
    peak_temps: list[int]
    duration_ms: int
    attempts: int
    failure_reason: Optional[str] = None
    samples: int = 0
    extra: dict = field(default_factory=dict)

    def as_log_record(self, op: str, speed: int, **extras) -> dict:
        rec = {
            "op": op,
            "target": self.target,
            "speed": speed,
            "achieved": self.achieved,
            "residuals": self.residuals,
            "peak_loads": self.peak_loads,
            "peak_temps": self.peak_temps,
            "duration_ms": self.duration_ms,
            "attempts": self.attempts,
            "success": self.success,
            "samples": self.samples,
        }
        if self.failure_reason:
            rec["failure_reason"] = self.failure_reason
        rec.update({k: v for k, v in extras.items() if v is not None})
        return rec


def _read_snapshot(driver: ArmDriver) -> tuple[list[int], list[int], list[int]]:
    """One bus round-trip: positions, |load|, temperature per servo."""
    states = driver.list_states()
    states.sort(key=lambda s: s.id)
    positions = [s.position for s in states]
    loads = [abs(s.load) for s in states]
    temps = [s.temperature for s in states]
    return positions, loads, temps


def _power_cycle_joint(driver: ArmDriver, sid: int) -> None:
    """Toggle torque on one servo: off → brief wait → on. Sometimes clears
    a latched OVERLOAD or COMM error that's preventing motion."""
    try:
        driver.set_torque(sid, False)
        time.sleep(0.15)
        # snap goal to current so torque-on doesn't jerk on stale goal
        cur = driver.get_position(sid)
        driver.set_position(sid, cur)
        driver.set_torque(sid, True)
    except Exception as exc:
        print(f"[verified_move] power-cycle J{sid} failed: {exc}")


def verified_move(
    driver: ArmDriver,
    target: list[int],
    speed: int,
    op: str,
    *,
    tolerance: int = ARRIVAL_TOLERANCE,
    timeout: float = MOVE_TIMEOUT_S,
    max_retries: int = MAX_RETRY_ATTEMPTS,
    log_extras: Optional[dict] = None,
) -> MoveResult:
    """Drive the follower to `target` and verify arrival. Always logs."""
    if len(target) != len(driver.servo_ids):
        raise ValueError(
            f"target has {len(target)} positions; driver has {len(driver.servo_ids)} servos"
        )
    sid_order = sorted(driver.servo_ids)
    goals = dict(zip(sid_order, target))
    peak_loads = [0] * len(sid_order)
    peak_temps = [0] * len(sid_order)
    samples = 0
    start = time.time()
    achieved = list(target)
    failure_reason: Optional[str] = None

    for attempt in range(max_retries + 1):
        # Attempt strategy:
        #   0: requested speed
        #   1: max speed (uncapped) — punch through gentle-speed stalls
        #   2: power-cycle stuck joints, then max speed
        if attempt == 0:
            write_speed = speed
        else:
            write_speed = 0  # uncapped/max
        if attempt == 2:
            # identify joints not yet within tolerance + power-cycle them
            stuck = [
                sid for i, sid in enumerate(sid_order)
                if abs(achieved[i] - target[i]) > tolerance
            ]
            for sid in stuck:
                _power_cycle_joint(driver, sid)

        driver.set_positions(goals, speed=write_speed)
        attempt_start = time.time()
        last_motion = time.time()
        prev_positions = None

        while True:
            now = time.time()
            elapsed = now - attempt_start
            try:
                positions, loads, temps = _read_snapshot(driver)
            except Exception as exc:
                print(f"[verified_move] read snapshot failed: {exc}")
                time.sleep(SAMPLE_INTERVAL_S)
                continue
            achieved = positions
            samples += 1
            peak_loads = [max(p, l) for p, l in zip(peak_loads, loads)]
            peak_temps = [max(p, t) for p, t in zip(peak_temps, temps)]
            residuals = [achieved[i] - target[i] for i in range(len(sid_order))]
            worst = max(abs(r) for r in residuals)

            if worst <= tolerance:
                duration_ms = int((time.time() - start) * 1000)
                result = MoveResult(
                    success=True,
                    target=list(target),
                    achieved=achieved,
                    residuals=residuals,
                    peak_loads=peak_loads,
                    peak_temps=peak_temps,
                    duration_ms=duration_ms,
                    attempts=attempt + 1,
                    samples=samples,
                )
                log_move(result.as_log_record(op, speed, **(log_extras or {})))
                return result

            # Stall detection: any joint moved >= STALL_MIN_DELTA since last sample?
            moving = (
                prev_positions is not None
                and any(abs(positions[i] - prev_positions[i]) >= STALL_MIN_DELTA for i in range(len(positions)))
            )
            if moving:
                last_motion = now
            elif now - last_motion > STALL_WINDOW_S:
                failure_reason = "stalled_short"
                break  # break out of inner loop → try next attempt

            if elapsed > timeout:
                failure_reason = "timed_out"
                break

            prev_positions = positions
            time.sleep(SAMPLE_INTERVAL_S)

    # Exhausted retries
    duration_ms = int((time.time() - start) * 1000)
    residuals = [achieved[i] - target[i] for i in range(len(sid_order))]
    final_reason = (
        "stalled_short_retries_exhausted"
        if failure_reason == "stalled_short"
        else (failure_reason or "timed_out")
    )
    result = MoveResult(
        success=False,
        target=list(target),
        achieved=achieved,
        residuals=residuals,
        peak_loads=peak_loads,
        peak_temps=peak_temps,
        duration_ms=duration_ms,
        attempts=max_retries + 1,
        failure_reason=final_reason,
        samples=samples,
    )
    log_move(result.as_log_record(op, speed, **(log_extras or {})))
    return result

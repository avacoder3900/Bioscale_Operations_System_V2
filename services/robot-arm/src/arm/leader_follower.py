"""
Background session that ties a LEADER arm to a FOLLOWER arm.

Three kinds of session, all driven by the same loop machinery:

    teleop   poll leader positions at rate_hz, write to follower goal,
             no recording. Ends when caller cancels or duration expires.
    record   same as teleop, plus log each frame to ~/.bims-arm/recordings/
             <name>.jsonl. Persisted on graceful end OR cancel (partial
             takes are useful too).
    replay   read frames from a recording, drive follower at the captured
             cadence. Loops `loops` times unless cancelled.

Runs in its own OS thread; cancellation is a threading.Event the loop
checks every tick. The FastAPI server holds the only reference; on
process shutdown the thread is daemonized so it dies with the parent.

Webhook events are emitted via `on_event(dict)` — the caller wires this
to BIMS's /api/robot-arm/webhook endpoint, with at-least the fields
the BIMS sacred receiver expects (`run_id`, `type` with prefix
matching the session kind).
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from arm.driver import ArmDriver
from arm.recordings import load_recording, save_recording

EventEmitter = Callable[[dict], None]

DEFAULT_RATE_HZ = 30
POS_MAX = 4095
POS_MIN = 0


def _clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


class LeaderFollowerSession:
    def __init__(
        self,
        *,
        run_id: str,
        kind: str,
        leader: ArmDriver,
        follower: ArmDriver,
        params: dict,
        on_event: EventEmitter,
        triggered_by: Optional[dict] = None,
    ) -> None:
        if kind not in ("teleop", "record", "replay"):
            raise ValueError(f"unknown session kind: {kind!r}")
        self.run_id = run_id
        self.kind = kind
        self.leader = leader
        self.follower = follower
        self.params = params
        self.on_event = on_event
        self.triggered_by = triggered_by

        self.rate_hz: int = int(params.get("rate_hz") or DEFAULT_RATE_HZ)
        raw_dur = params.get("duration_s")
        self.duration_s: Optional[float] = float(raw_dur) if raw_dur else None
        self.recording_name: Optional[str] = params.get("name")  # record only
        self.source: Optional[str] = params.get("source")  # replay only
        self.loops: int = int(params.get("loops") or 1)
        # Provenance (all optional). Propagated to the recording sidecar
        # AND stamped on the BIMS RobotArmRun via the start webhook event,
        # so a recording on disk and the matching MongoDB run can be
        # cross-referenced by lot.
        self.lot_id: Optional[str] = (params.get("lot_id") or None)
        self.manufacturing_step: Optional[str] = (params.get("manufacturing_step") or None)
        self.recorded_during_run_id: Optional[str] = (
            params.get("recorded_during_run_id") or None
        )

        self._cancel = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.started_at: Optional[float] = None
        self.ended_at: Optional[float] = None
        self.frames: list[dict] = []
        self.error: Optional[str] = None
        self.frames_written = 0
        self.recording_path: Optional[str] = None

    # --- lifecycle --------------------------------------------------------

    def start(self) -> None:
        self.started_at = time.time()
        self._emit(
            "start",
            extra={
                "rate_hz": self.rate_hz,
                "duration_s": self.duration_s,
                "loops": self.loops if self.kind == "replay" else None,
                "source": self.source if self.kind == "replay" else None,
                "name": self.recording_name if self.kind == "record" else None,
                # Provenance — webhook receiver stamps these on RobotArmRun
                "lot_id": self.lot_id,
                "manufacturing_step": self.manufacturing_step,
                "recorded_during_run_id": self.recorded_during_run_id,
            },
        )
        self._thread = threading.Thread(
            target=self._run, name=f"arm-session-{self.run_id}", daemon=True
        )
        self._thread.start()

    def stop(self, timeout: float = 3.0) -> None:
        self._cancel.set()
        t = self._thread
        if t is not None:
            t.join(timeout=timeout)

    def is_active(self) -> bool:
        t = self._thread
        return t is not None and t.is_alive()

    def info(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "kind": self.kind,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "rate_hz": self.rate_hz,
            "duration_s": self.duration_s,
            "frames": len(self.frames) if self.kind == "record" else None,
            "recording_path": self.recording_path,
            "active": self.is_active(),
            "error": self.error,
        }

    # --- internals --------------------------------------------------------

    def _emit(self, suffix: str, extra: Optional[dict] = None) -> None:
        # `at` MUST be an ISO 8601 string — BIMS webhook does
        # `new Date(String(event.at))` and a float would become Invalid Date.
        ev: dict[str, Any] = {
            "type": f"{self.kind}.{suffix}",
            "at": datetime.now(timezone.utc).isoformat(),
            "run_id": self.run_id,
            "kind": self.kind,
        }
        if self.triggered_by:
            ev["triggered_by"] = self.triggered_by
        if extra:
            ev.update({k: v for k, v in extra.items() if v is not None})
        try:
            self.on_event(ev)
        except Exception as exc:
            # don't let webhook failures stop the session
            print(f"[arm-session {self.run_id}] webhook emit failed: {exc}")

    def _run(self) -> None:
        try:
            if self.kind in ("teleop", "record"):
                self._teleop_loop()
            else:
                self._replay_loop()
        except Exception as exc:
            self.error = str(exc)
            self.ended_at = time.time()
            self._emit("failed", extra={"status": "failed", "error": str(exc)})
            return

        self.ended_at = time.time()
        if self._cancel.is_set():
            self._emit(
                "cancelled",
                extra={"status": "cancelled", "frames": len(self.frames) or None},
            )
        else:
            self._emit(
                "complete",
                extra={"status": "success", "frames": len(self.frames) or None},
            )

    def _teleop_loop(self) -> None:
        # Leader must be limp so the operator can pose it by hand.
        self.leader.set_torque_all(False)
        # Follower: snap goal to its current pose first so torque-on
        # doesn't jerk it back to a stale value, then energize.
        snap = self.follower.sync_read_positions()
        self.follower.sync_write_positions(snap)
        self.follower.set_torque_all(True)

        tick_dt = 1.0 / self.rate_hz
        next_tick = time.time()
        while not self._cancel.is_set():
            leader_pos = self.leader.sync_read_positions()
            # Multi-turn joints (typically the wrist roll on SO-100
            # leaders) report position values past 4095 — that's the
            # encoder counting full rotations. The follower can only
            # cover one turn, so we wrap to the angular position
            # within the current rotation. Python `%` handles negative
            # multi-turn values too (-1 % 4096 == 4095).
            goals = {sid: int(p) % 4096 for sid, p in leader_pos.items()}
            self.follower.sync_write_positions(goals)

            if self.kind == "record":
                assert self.started_at is not None
                self.frames.append(
                    {"t": time.time() - self.started_at, "positions": leader_pos}
                )

            if self.duration_s is not None and self.started_at is not None:
                if (time.time() - self.started_at) >= self.duration_s:
                    break

            next_tick += tick_dt
            sleep_for = next_tick - time.time()
            if sleep_for > 0:
                # interruptible sleep — wakes immediately on cancel
                if self._cancel.wait(sleep_for):
                    break
            else:
                # we're behind; reset the clock so we don't catch-up burst
                next_tick = time.time()

        # Persist on either graceful end or cancel — partial takes
        # are still useful for debugging / curating later. Always write
        # a meta sidecar so even ad-hoc recordings carry rate + start
        # time + operator; lot/step are optional.
        if self.kind == "record" and self.frames:
            if not self.recording_name:
                self.recording_name = f"unnamed-{int(self.started_at or time.time())}"
            started_iso = (
                datetime.fromtimestamp(self.started_at, tz=timezone.utc).isoformat()
                if self.started_at
                else None
            )
            meta = {
                "lot_id": self.lot_id,
                "manufacturing_step": self.manufacturing_step,
                "recorded_during_run_id": self.recorded_during_run_id,
                "operator": (self.triggered_by or {}).get("username")
                if self.triggered_by
                else None,
                "started_at_iso": started_iso,
                "rate_hz": self.rate_hz,
                "run_id": self.run_id,
            }
            path = save_recording(self.recording_name, self.frames, meta=meta)
            self.recording_path = str(path)
            self.frames_written = len(self.frames)

    def _replay_loop(self) -> None:
        if not self.source:
            raise RuntimeError("replay requires a `source` recording name")
        frames = load_recording(self.source)
        if not frames:
            raise RuntimeError(f"recording '{self.source}' is empty")

        # Follower torque on, goals snapped first.
        snap = self.follower.sync_read_positions()
        self.follower.sync_write_positions(snap)
        self.follower.set_torque_all(True)

        for _loop in range(max(self.loops, 1)):
            if self._cancel.is_set():
                return
            loop_start = time.time()
            for frame in frames:
                if self._cancel.is_set():
                    return
                target_t = loop_start + float(frame["t"])
                sleep_for = target_t - time.time()
                if sleep_for > 0:
                    if self._cancel.wait(sleep_for):
                        return
                # JSON object keys are strings — coerce back to int
                raw = frame["positions"]
                goals = {int(sid): _clamp(int(p), POS_MIN, POS_MAX) for sid, p in raw.items()}
                self.follower.sync_write_positions(goals)

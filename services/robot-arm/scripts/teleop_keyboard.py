#!/usr/bin/env python3
"""
Realtime keyboard teleop for SO-100 / SO-ARM100.

Hold a key to jog continuously; release to stop. Two modes, switch with `m`:

  joint-space (default)    each key pair drives ONE servo
  task-space               (coming in a follow-up commit — IK + URDF needed)

Keys
  w / s      base ±          (joint 1)
  a / d      shoulder ±      (joint 2)
  r / f      elbow ±         (joint 3)
  e / q      wrist pitch ±   (joint 4)
  t / g      wrist roll ±    (joint 5)
  z / c      gripper open / close (joint 6)

  m          toggle mode (joint <-> task)
  + / -      step size up / down  (steps per 20 ms tick)
  0          go to saved "home" pose  (must be saved first via teleop_cli)
  Space      E-STOP — drop torque on all 6 servos. Arm will sag.
  Esc        quit — leaves arm in its current state (no e-stop)

macOS first-run note: pynput requires Accessibility permission for the
process that runs Python. If keypresses do nothing, go to
System Settings → Privacy & Security → Accessibility and add Terminal
(or iTerm, VS Code, whichever you launched from).

Conflicts: this script opens the serial port directly via ArmDriver.
Stop the FastAPI server (services/robot-arm/) before running this — they
can't share the bus.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from pynput import keyboard  # noqa: E402

from arm.driver import (  # noqa: E402
    DEFAULT_BAUD,
    DEFAULT_PORT,
    ArmDriver,
)

POSE_FILE = Path.home() / ".bims-arm" / "poses.json"

# joint-space key map: ch -> (servo_id, sign)
JOINT_KEYS: dict[str, tuple[int, int]] = {
    "w": (1, +1), "s": (1, -1),
    "a": (2, +1), "d": (2, -1),
    "r": (3, +1), "f": (3, -1),
    "e": (4, +1), "q": (4, -1),
    "t": (5, +1), "g": (5, -1),
    "z": (6, +1), "c": (6, -1),
}

TICK_HZ = 50.0
TICK_DT = 1.0 / TICK_HZ
RENDER_DT = 0.1  # 10 Hz status line

DEFAULT_STEP = 8       # raw steps per tick; 50 Hz * 8 = 400 steps/s ≈ 35°/s
MIN_STEP = 1
MAX_STEP = 60
SERVO_SPEED = 600      # max-ish servo speed for snappier response


def load_poses() -> dict[str, list[int]]:
    if not POSE_FILE.exists():
        return {}
    try:
        raw = json.loads(POSE_FILE.read_text())
    except Exception:
        return {}
    # CLI saves as a list; FastAPI saves as {"positions": [...], "saved_at": ...}
    out: dict[str, list[int]] = {}
    for name, v in raw.items():
        if isinstance(v, list):
            out[name] = v
        elif isinstance(v, dict) and "positions" in v:
            out[name] = v["positions"]
    return out


class Teleop:
    def __init__(self, arm: ArmDriver) -> None:
        self.arm = arm
        self.held: set[str] = set()
        self.held_lock = threading.Lock()
        self.mode = "joint"
        self.step = DEFAULT_STEP
        self.running = True
        self.e_stopped = False
        self.message = ""
        self.message_until = 0.0

    # --- key handlers (pynput callbacks; run in listener thread) ----------

    def _key_char(self, key) -> str | None:
        try:
            ch = key.char
        except AttributeError:
            return None
        return ch.lower() if ch else None

    def on_press(self, key) -> bool | None:
        ch = self._key_char(key)
        if ch:
            with self.held_lock:
                self.held.add(ch)
            # one-shot handlers — fire on key-down regardless of held state
            if ch == "m":
                self._toggle_mode()
            elif ch == "0":
                self._go_home()
            elif ch in "+=":
                self.step = min(MAX_STEP, self.step + 1)
                self._flash(f"step = {self.step}")
            elif ch in "-_":
                self.step = max(MIN_STEP, self.step - 1)
                self._flash(f"step = {self.step}")
            return None
        if key == keyboard.Key.space:
            self._e_stop()
            return None
        if key == keyboard.Key.esc:
            self.running = False
            return False  # stop listener
        return None

    def on_release(self, key) -> None:
        ch = self._key_char(key)
        if ch:
            with self.held_lock:
                self.held.discard(ch)

    # --- one-shot actions -------------------------------------------------

    def _toggle_mode(self) -> None:
        if self.mode == "joint":
            self.mode = "task"
            self._flash("MODE: task-space (NOT YET IMPLEMENTED — press 'm' to switch back)")
        else:
            self.mode = "joint"
            self._flash("MODE: joint-space")

    def _e_stop(self) -> None:
        try:
            self.arm.e_stop()
        except Exception as exc:
            self._flash(f"E-STOP failed: {exc}")
            return
        self.e_stopped = True
        self._flash("E-STOP — torque dropped. Quit (Esc) and use teleop_cli 'torque on' to recover.")

    def _go_home(self) -> None:
        poses = load_poses()
        if "home" not in poses:
            self._flash("no 'home' pose saved — use teleop_cli first: save home")
            return
        positions = poses["home"]
        if len(positions) != len(self.arm.servo_ids):
            self._flash(f"'home' has {len(positions)} positions; need {len(self.arm.servo_ids)}")
            return
        try:
            goals = dict(zip(self.arm.servo_ids, positions))
            self.arm.set_positions(goals, speed=300)
            self._flash(f"moving to home: {positions}")
        except Exception as exc:
            self._flash(f"home failed: {exc}")

    def _flash(self, msg: str, secs: float = 2.5) -> None:
        self.message = msg
        self.message_until = time.time() + secs

    # --- tick + render ----------------------------------------------------

    def tick(self) -> None:
        if self.e_stopped:
            return
        with self.held_lock:
            held = self.held.copy()
        if self.mode == "joint":
            # collect deltas per servo (so opposing keys cancel)
            deltas: dict[int, int] = {}
            for ch in held:
                pair = JOINT_KEYS.get(ch)
                if pair:
                    sid, sign = pair
                    deltas[sid] = deltas.get(sid, 0) + sign * self.step
            for sid, delta in deltas.items():
                if delta:
                    try:
                        self.arm.jog(sid, delta, speed=SERVO_SPEED)
                    except Exception as exc:
                        self._flash(f"jog id={sid} failed: {exc}")
                        self.e_stopped = True
                        return
        # task mode: no-op for now; mode toggle already flashed a notice

    def render(self) -> None:
        try:
            positions = self.arm.get_positions()
        except Exception:
            positions = {}
        pos_str = "  ".join(f"{sid}:{p:>4}" for sid, p in positions.items())
        with self.held_lock:
            held_str = ",".join(sorted(self.held)) if self.held else "·"
        flag = " [E-STOP]" if self.e_stopped else ""
        bottom = (
            f"mode={self.mode:<5}  step={self.step:>3}  "
            f"keys={held_str:<14}  {pos_str}{flag}"
        )
        # status line always; message overlays for a few seconds
        if self.message and time.time() < self.message_until:
            print(f"\r\x1b[K  {self.message}\n\r\x1b[K{bottom}\x1b[1A", end="", flush=True)
        else:
            print(f"\r\x1b[K{bottom}", end="", flush=True)

    def run(self) -> None:
        listener = keyboard.Listener(on_press=self.on_press, on_release=self.on_release)
        listener.start()
        next_render = time.time()
        try:
            while self.running and listener.running:
                self.tick()
                now = time.time()
                if now >= next_render:
                    self.render()
                    next_render = now + RENDER_DT
                time.sleep(TICK_DT)
        finally:
            listener.stop()
            print()  # leave the status line behind


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default=DEFAULT_PORT)
    ap.add_argument("--baud", type=int, default=DEFAULT_BAUD)
    args = ap.parse_args()

    print(__doc__)
    print(f"connecting to {args.port} @ {args.baud}...")
    try:
        arm = ArmDriver(port=args.port, baud=args.baud)
        arm.open()
    except RuntimeError as exc:
        print(f"\nERROR: {exc}")
        print(
            "If the FastAPI server is running, stop it first — only one "
            "process can hold the serial port at a time."
        )
        sys.exit(1)

    print("ready. press keys to jog; Esc to quit.\n")
    try:
        Teleop(arm).run()
    finally:
        arm.close()
        print("exiting (arm holds current state unless e-stopped)")


if __name__ == "__main__":
    main()

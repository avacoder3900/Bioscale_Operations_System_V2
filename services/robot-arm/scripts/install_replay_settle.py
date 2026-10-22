#!/usr/bin/env python3
"""
Wire src/hardware/replay_settle.py (ARM-06 Animate: closed-loop replay — the
arm settles ON each held pose instead of sagging below it) into the robot-arm
service on the Pi.

Copy replay_settle.py into src/hardware/ (next to dual_arm.py) first, then run
from the robot-arm project root on arm-pi:

    python3 scripts/install_replay_settle.py            # apply
    python3 scripts/install_replay_settle.py --check    # report only

One idempotent edit to src/server/app.py, right after the line that imports
the session manager (`from src.server.sessions import SessionManager`):

    from src.hardware import replay_settle as _replay_settle
    _replay_settle.install()

`install()` rebinds the name `replay_session` inside src.server.sessions
(which imports it by name from src.hardware.dual_arm) to
`replay_session_settling`, a drop-in with the same signature. Nothing else in
the service changes; dual_arm.replay_session itself is left alone.

The checker confirms the layout the port was written against (2026-10-22):
  * src/hardware/dual_arm.py defines `def replay_session(` and the DualArm
    helpers the port calls (`_write_all_torque`, `_ramp_follower_to`,
    `logger`, `dry_run`, `follower`);
  * src/hardware/_feetech_bus.py has `def read(` / `def write(` and the
    `Present_Position` / `Goal_Position` registers;
  * src/server/sessions.py imports `replay_session` by name.
Each mismatch is printed and the install refuses, so a future change to the
Pi's own code cannot be patched over blindly.

Then: `sudo systemctl restart robot-arm` (only with GET /sessions/active ==
{"active": null}). Any recording without settle flags plays exactly as before.
To test: in BIMS Animate, give a pose a hold of 1 s and Play — the claw should
land on the pose and stay; the run's events (robot_arm_runs) gain one
`replay.settle` entry with the per-pose residuals.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "src" / "server" / "app.py"
SESSIONS = ROOT / "src" / "server" / "sessions.py"
DUAL_ARM = ROOT / "src" / "hardware" / "dual_arm.py"
BUS = ROOT / "src" / "hardware" / "_feetech_bus.py"
MODULE = ROOT / "src" / "hardware" / "replay_settle.py"
CHECK = "--check" in sys.argv

IMPORT_LINES = "from src.hardware import replay_settle as _replay_settle\n_replay_settle.install()\n"
SESSIONS_IMPORT_RE = re.compile(r"^from src\.server\.sessions import [^\n]*\bSessionManager\b[^\n]*\n", re.M)

NEEDED = {
    DUAL_ARM: ("def replay_session(", "def _write_all_torque(", "def _ramp_follower_to(", "self.logger", "self.dry_run", "self.follower"),
    BUS: ("def read(", "def write(", '"Present_Position"', '"Goal_Position"'),
    SESSIONS: ("replay_session(", "from src.hardware.dual_arm import"),
}


def main() -> int:
    missing_files = [p for p in (APP, SESSIONS, DUAL_ARM, BUS) if not p.exists()]
    if missing_files:
        for p in missing_files:
            print(f"not found: {p}")
        return 2
    if not MODULE.exists():
        print(f"replay_settle.py not found at {MODULE}; copy it there first")
        return 2

    problems = 0
    for path, needles in NEEDED.items():
        text = path.read_text(encoding="utf-8")
        for needle in needles:
            if needle not in text:
                print(f"mismatch: {path.relative_to(ROOT)} has no `{needle}` — the port relies on it")
                problems += 1
    if problems:
        print(f"\n{problems} mismatch(es); refusing to install. Re-port replay_settle.py against the Pi's code first.")
        return 1
    print("layout check: ok (dual_arm.replay_session, FeetechBus.read/write, sessions imports replay_session)")

    app = APP.read_text(encoding="utf-8")
    original = app
    if "_replay_settle.install(" in app:
        print("install: already present in app.py")
    else:
        m = SESSIONS_IMPORT_RE.search(app)
        if not m:
            print("app.py does not import SessionManager from src.server.sessions; add by hand after that import:")
            print("    " + IMPORT_LINES.replace("\n", "\n    ").rstrip())
            return 1
        app = app[: m.end()] + IMPORT_LINES + app[m.end():]
        print(f"install: added after `{m.group(0).strip()}`")

    if app == original:
        print("no changes needed")
        return 0
    if CHECK:
        print("--check: would modify app.py (not written)")
        return 0
    backup = APP.with_suffix(".py.bak-replay-settle")
    backup.write_text(original, encoding="utf-8", newline="\n")
    APP.write_text(app, encoding="utf-8", newline="\n")
    print(f"wrote {APP} (backup at {backup.name}). Now, with no session active: sudo systemctl restart robot-arm")
    return 0


if __name__ == "__main__":
    sys.exit(main())

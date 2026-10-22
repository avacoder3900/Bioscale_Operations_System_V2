#!/usr/bin/env python3
"""
Wire src/arm/replay_settle.py (ARM-06 Animate: closed-loop replay — the arm
settles ON each held pose instead of sagging below it) into the robot-arm
service on the Pi.

Copy replay_settle.py into src/arm/ first, then run from the robot-arm
project root on arm-pi:

    python3 scripts/install_replay_settle.py            # apply
    python3 scripts/install_replay_settle.py --check    # report only

One idempotent edit to src/server/app.py, after the line that imports the
session class (the one with `_replay_loop`; `dual_arm.py` on the live Pi,
`leader_follower.py` in the repo):

    from arm import replay_settle as _replay_settle
    _replay_settle.install(<SessionClass>)

The installer finds the session module and class by looking for `def
_replay_loop` under src/arm/, and checks that the class's methods use the
attribute names replay_settle.py relies on (`self.follower`, `self.source`,
`self.loops`, `self._cancel`, `self._emit`) and that the driver has
`sync_read_positions` / `sync_write_positions`. Each missing name is printed;
fix the five references at the top of `_replay_loop_settling` to match.

Then: `sudo systemctl restart robot-arm`. Any recording without settle flags
plays exactly as before. To test: in BIMS Animate, give a pose a hold of 1 s
and Play — the claw should land on the pose and stay; the run's events in
Mongo (robot_arm_runs) gain one `replay.settle` entry with the per-pose
residuals.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "src" / "server" / "app.py"
ARM = ROOT / "src" / "arm"
CHECK = "--check" in sys.argv

NEEDED_ATTRS = ("self.follower", "self.source", "self.loops", "self._cancel", "self._emit(")
NEEDED_DRIVER = ("def sync_read_positions", "def sync_write_positions")


def find_session() -> tuple[Path, str] | None:
    for py in sorted(ARM.glob("*.py")):
        src = py.read_text(encoding="utf-8")
        if "def _replay_loop" not in src:
            continue
        classes = [m for m in re.finditer(r"^class (\w+)\b", src, re.M) if m.start() < src.find("def _replay_loop")]
        if not classes:
            continue
        return py, classes[-1].group(1)
    return None


def main() -> int:
    if not APP.exists():
        print(f"app.py not found at {APP}")
        return 2
    if not (ARM / "replay_settle.py").exists():
        print(f"replay_settle.py not found in {ARM}; copy it there first")
        return 2

    found = find_session()
    if not found:
        print("no module under src/arm/ defines `_replay_loop`; cannot find the session class")
        return 2
    module_path, cls = found
    module = module_path.stem
    src_session = module_path.read_text(encoding="utf-8")
    print(f"session class: {cls} in src/arm/{module}.py")
    for attr in NEEDED_ATTRS:
        if attr not in src_session:
            print(f"warning: {module}.py never uses `{attr}` — replay_settle._replay_loop_settling relies on it; edit it to match")
    driver = ARM / "driver.py"
    if driver.exists():
        d = driver.read_text(encoding="utf-8")
        for name in NEEDED_DRIVER:
            if name not in d:
                print(f"warning: driver.py has no `{name}` — the settling loop needs batched reads/writes")

    app = APP.read_text(encoding="utf-8")
    original = app
    if "replay_settle.install(" in app:
        print("install: already present")
    else:
        m = re.search(rf"^from arm\.{module} import [^\n]*\b{cls}\b[^\n]*\n|^from arm import [^\n]*\b{module}\b[^\n]*\n|^import arm\.{module}[^\n]*\n", app, re.M)
        if not m:
            print(f"app.py does not import {cls} from arm.{module}; add by hand after that import:")
            print(f"    from arm import replay_settle as _replay_settle\n    _replay_settle.install({cls})")
            return 1
        ref = cls if re.match(rf"^from arm\.{module} import", m.group(0)) else f"{module}.{cls}"
        lines = f"from arm import replay_settle as _replay_settle\n_replay_settle.install({ref})\n"
        app = app[: m.end()] + lines + app[m.end():]
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
    print(f"wrote {APP} (backup at {backup.name}). Now: sudo systemctl restart robot-arm")
    return 0


if __name__ == "__main__":
    sys.exit(main())

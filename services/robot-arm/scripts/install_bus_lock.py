#!/usr/bin/env python3
"""
Wire src/server/bus_lock.py (one lock for the servo serial bus across every
one-shot route) into the robot-arm service's app.py on the Pi.

Copy bus_lock.py next to app.py first, then run from the robot-arm project
root on arm-pi:

    python3 scripts/install_bus_lock.py            # apply
    python3 scripts/install_bus_lock.py --check    # report only

One idempotent edit to src/server/app.py: right after the line
`from src.server import manual_control as manual` (and the calibration
import before it), add

    from . import bus_lock as pi_bus_lock
    pi_bus_lock.wrap_module(manual, pi_bus_lock.MANUAL_FUNCTIONS)
    pi_bus_lock.wrap_module(calib, pi_bus_lock.CALIBRATION_FUNCTIONS)

so GET /servos, jog, torque, replay preflight and the calibration captures
never open the BusLinker port at the same time. Refuses when app.py does not
import those modules under those names. Backup: app.py.bak-bus-lock.

Then: `sudo systemctl restart robot-arm` (only with GET /sessions/active ==
{"active": null}). Verify: six GET /servos in parallel all answer 200
(before this, two at once could 500 with pyserial "multiple access on port").
"""

from __future__ import annotations

import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "src" / "server" / "app.py"
CHECK = "--check" in sys.argv

MANUAL_IMPORT = "from src.server import manual_control as manual\n"
CALIB_IMPORT = "from src.server import calibration as calib\n"
LINES = (
    "from . import bus_lock as pi_bus_lock\n"
    "pi_bus_lock.wrap_module(manual, pi_bus_lock.MANUAL_FUNCTIONS)\n"
    "pi_bus_lock.wrap_module(calib, pi_bus_lock.CALIBRATION_FUNCTIONS)\n"
)


def main() -> int:
    if not APP.exists():
        print(f"app.py not found at {APP}")
        return 2
    if not (APP.parent / "bus_lock.py").exists():
        print(f"bus_lock.py not found next to app.py ({APP.parent}); copy it there first")
        return 2
    src = APP.read_text(encoding="utf-8")
    original = src
    if "import bus_lock as pi_bus_lock" in src:
        print("bus lock: already present")
    elif MANUAL_IMPORT not in src or CALIB_IMPORT not in src:
        print("app.py does not import manual_control as `manual` and calibration as `calib`; refusing. Add by hand after those imports:")
        print("    " + LINES.replace("\n", "\n    ").rstrip())
        return 1
    else:
        k = src.index(MANUAL_IMPORT) + len(MANUAL_IMPORT)
        src = src[:k] + LINES + src[k:]
        print("bus lock: added after `from src.server import manual_control as manual`")
    if src == original:
        print("no changes needed")
        return 0
    if CHECK:
        print("--check: would modify app.py (not written)")
        return 0
    backup = APP.with_suffix(".py.bak-bus-lock")
    backup.write_text(original, encoding="utf-8", newline="\n")
    APP.write_text(src, encoding="utf-8", newline="\n")
    print(f"wrote {APP} (backup at {backup.name}). Now, with no session active: sudo systemctl restart robot-arm")
    return 0


if __name__ == "__main__":
    sys.exit(main())

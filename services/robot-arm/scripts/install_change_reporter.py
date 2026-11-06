#!/usr/bin/env python3
"""
Wire src/server/bims_changes.py into the robot-arm service's app.py on the Pi,
so every service start reports itself to BIMS's Change Log (pi.service.start,
plus pi.route <path> Added / Removed and pi.app_py when app.py changed since
the previous start). Gain writes report from servo_config.py and installs from
the install_*.py scripts; both only need bims_changes.py next to app.py.

Copy bims_changes.py next to app.py first, then run from the robot-arm project
root on arm-pi:

    python3 scripts/install_change_reporter.py            # apply
    python3 scripts/install_change_reporter.py --check    # report only

Two idempotent edits to src/server/app.py, the same way the other installers do it:
  1. `from . import bims_changes as pi_bims_changes` after the `from fastapi import ...` statement.
  2. `pi_bims_changes.service_started(app)` at the end of the module (a daemon thread; the
     app starts exactly as before).

Then: `sudo systemctl restart robot-arm` (only with GET /sessions/active == {"active": null})
and look for the pi.service.start row on Maintenance > Change Log. The service needs
BIMS_WEBHOOK_URL (or BIMS_CHANGES_URL) and AGENT_API_KEY in its environment, which the
webhook already uses.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    from bims_report import report_install  # scripts/bims_report.py: tells BIMS's Change Log about this install
except ImportError:  # run from a copy without bims_report.py
    def report_install(*_a, **_k) -> None:
        return None

APP = Path(__file__).resolve().parents[1] / "src" / "server" / "app.py"
CHECK = "--check" in sys.argv

IMPORT_LINE = "from . import bims_changes as pi_bims_changes\n"
INCLUDE_LINE = "pi_bims_changes.service_started(app)\n"
FASTAPI_IMPORT_RE = re.compile(r"^from fastapi import \([^)]*\)\n|^from fastapi import [^\n]*\n", re.M)
APP_CTOR_RE = re.compile(r"^app\s*=\s*FastAPI\(", re.M)


def main() -> int:
    if not APP.exists():
        print(f"app.py not found at {APP}")
        return 2
    if not (APP.parent / "bims_changes.py").exists():
        print(f"bims_changes.py not found next to app.py ({APP.parent}); copy it there first")
        return 2

    src = APP.read_text(encoding="utf-8")
    original = src
    todo: list[tuple[str, str]] = []

    if "import bims_changes as pi_bims_changes" in src:
        print("[1/2] import: already present")
    else:
        m = FASTAPI_IMPORT_RE.search(src)
        if not m:
            todo.append(("import", IMPORT_LINE))
            print("[1/2] import: `from fastapi import ...` not found")
        else:
            src = src[: m.end()] + IMPORT_LINE + src[m.end():]
            print("[1/2] import: added")

    if "pi_bims_changes.service_started(app)" in src:
        print("[2/2] service_started: already present")
    elif not APP_CTOR_RE.search(src):
        todo.append(("service_started", INCLUDE_LINE))
        print("[2/2] service_started: `app = FastAPI(` not found")
    else:
        k = src.find("\nif __name__ ==")
        if k != -1:
            src = src[: k + 1] + INCLUDE_LINE + "\n" + src[k + 1:]
        else:
            src = src.rstrip("\n") + "\n\n" + INCLUDE_LINE
        print("[2/2] service_started: added at end of module")

    if todo:
        print("\nApply these by hand:")
        for where, line in todo:
            print(f"  - {where}: {line.strip()}")
    if src == original:
        print("\nno changes needed")
        return 1 if todo else 0
    if CHECK:
        print("\n--check: would modify app.py (not written)")
        return 0
    backup = APP.with_suffix(".py.bak-change-reporter")
    backup.write_text(original, encoding="utf-8", newline="\n")
    APP.write_text(src, encoding="utf-8", newline="\n")
    report_install("change_reporter", [APP])
    print(f"\nwrote {APP} (backup at {backup.name}). Now, with no session active: sudo systemctl restart robot-arm")
    return 0


if __name__ == "__main__":
    sys.exit(main())

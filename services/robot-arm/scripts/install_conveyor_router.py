#!/usr/bin/env python3
"""
Wire src/server/conveyor.py (BCM 22 / pin 15 conveyor belt: GET /conveyor/status,
POST /conveyor/pulse, POST /conveyor/stop) into the robot-arm service's app.py on the Pi.

Copy conveyor.py next to app.py first, then run from the robot-arm project
root on arm-pi:

    python3 scripts/install_conveyor_router.py            # apply
    python3 scripts/install_conveyor_router.py --check    # report only

Two idempotent edits to src/server/app.py, the same way the thermal, hold and
apriltag installers do it:
  1. `from . import conveyor as pi_conveyor` (and `import fastapi as _fastapi`
     unless an earlier installer added it), after the `from fastapi import ...`
     statement.
  2. `app.include_router(pi_conveyor.router, dependencies=[_fastapi.Depends(require_api_key)])`
     at the end of the module. Refuses if `require_api_key` does not exist:
     GPIO is never exposed unauthenticated.

conveyor.py needs gpiozero + lgpio in the uv project, which gpio.py already
added. It touches nothing in app.py and does not use the servo bus.

Then, with GET /sessions/active == {"active": null}: `sudo systemctl restart robot-arm`,
and `curl -H "x-api-key: $KEY" localhost:8000/conveyor/status` — expect
pin 22, state 0 and simulated:false.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "src" / "server" / "app.py"
CHECK = "--check" in sys.argv

IMPORT_LINE = "from . import conveyor as pi_conveyor\n"
FASTAPI_ALIAS = "import fastapi as _fastapi\n"
INCLUDE_LINE = "app.include_router(pi_conveyor.router, dependencies=[_fastapi.Depends(require_api_key)])\n"

FASTAPI_IMPORT_RE = re.compile(r"^from fastapi import \([^)]*\)\n|^from fastapi import [^\n]*\n", re.M)
APP_CTOR_RE = re.compile(r"^app\s*=\s*FastAPI\(", re.M)


def main() -> int:
    if not APP.exists():
        print(f"app.py not found at {APP}")
        return 2
    if not (APP.parent / "conveyor.py").exists():
        print(f"conveyor.py not found next to app.py ({APP.parent}); copy it there first")
        return 2
    src = APP.read_text(encoding="utf-8")
    original = src
    todo: list[tuple[str, str]] = []

    if "import conveyor as pi_conveyor" in src:
        print("[1/2] import: already present")
    else:
        m = FASTAPI_IMPORT_RE.search(src)
        if not m:
            todo.append(("import", IMPORT_LINE + FASTAPI_ALIAS))
            print("[1/2] import: `from fastapi import ...` not found")
        else:
            line = IMPORT_LINE + ("" if "import fastapi as _fastapi" in src else FASTAPI_ALIAS)
            src = src[: m.end()] + line + src[m.end():]
            print("[1/2] import: added")

    if "include_router(pi_conveyor.router" in src:
        print("[2/2] include_router: already present")
    elif "def require_api_key" not in src:
        todo.append(("include_router", INCLUDE_LINE))
        print("[2/2] include_router: require_api_key not found; refusing to expose it unauthenticated")
    elif not APP_CTOR_RE.search(src):
        todo.append(("include_router", INCLUDE_LINE))
        print("[2/2] include_router: `app = FastAPI(` not found")
    else:
        k = src.find("\nif __name__ ==")
        if k != -1:
            src = src[: k + 1] + INCLUDE_LINE + "\n" + src[k + 1:]
        else:
            src = src.rstrip("\n") + "\n\n" + INCLUDE_LINE
        print("[2/2] include_router: added at end of module")

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

    backup = APP.with_suffix(".py.bak-conveyor")
    backup.write_text(original, encoding="utf-8", newline="\n")
    APP.write_text(src, encoding="utf-8", newline="\n")
    print(f"\nwrote {APP} (backup at {backup.name}). Now: sudo systemctl restart robot-arm")
    return 0


if __name__ == "__main__":
    sys.exit(main())

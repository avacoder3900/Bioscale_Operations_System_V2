#!/usr/bin/env python3
"""
Wire src/server/move.py (POST /servos/{id}/move — one joint to an ABSOLUTE
goal, what BIMS's Animate sliders want) into the robot-arm service's app.py
on the Pi.

Copy move.py next to app.py first, then run from the robot-arm project root
on arm-pi:

    python3 scripts/install_move_router.py            # apply
    python3 scripts/install_move_router.py --check    # report only

Two idempotent edits to src/server/app.py, the same way the thermal, hold,
depth and apriltag installers do it:

  1. `from . import move as pi_move` (and `import fastapi as _fastapi` unless
     an earlier installer added it), after the `from fastapi import ...`.
  2. At the end of the module:
         pi_move.bus_free = _require_bus_free
         app.include_router(pi_move.router, dependencies=[_fastapi.Depends(require_api_key)])
     Refuses if `require_api_key` or `_require_bus_free` is missing — the
     route must be authenticated and must respect the single-owner bus.

Then: `sudo systemctl restart robot-arm` (only with GET /sessions/active ==
{"active": null}), and
`curl -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{"position": <present>}' localhost:8000/servos/2/move`
— expect {"id": 2, "goal": <present>, "delta": 0}. BIMS's live sliders stop
saying "This Pi has no absolute move route" on the next move.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "src" / "server" / "app.py"
CHECK = "--check" in sys.argv

IMPORT_LINE = "from . import move as pi_move\n"
FASTAPI_ALIAS = "import fastapi as _fastapi\n"
INCLUDE_LINES = (
    "pi_move.bus_free = _require_bus_free\n"
    "app.include_router(pi_move.router, dependencies=[_fastapi.Depends(require_api_key)])\n"
)
FASTAPI_IMPORT_RE = re.compile(r"^from fastapi import \([^)]*\)\n|^from fastapi import [^\n]*\n", re.M)
APP_CTOR_RE = re.compile(r"^app\s*=\s*FastAPI\(", re.M)


def main() -> int:
    if not APP.exists():
        print(f"app.py not found at {APP}")
        return 2
    if not (APP.parent / "move.py").exists():
        print(f"move.py not found next to app.py ({APP.parent}); copy it there first")
        return 2
    if not (APP.parent / "manual_control.py").exists():
        print("manual_control.py not found next to app.py — move.py relies on its _connected_arms; refusing")
        return 2

    src = APP.read_text(encoding="utf-8")
    original = src
    todo: list[tuple[str, str]] = []

    if "import move as pi_move" in src:
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

    if "include_router(pi_move.router" in src:
        print("[2/2] include_router: already present")
    elif "def require_api_key" not in src:
        todo.append(("include_router", INCLUDE_LINES))
        print("[2/2] include_router: require_api_key not found; refusing to expose it unauthenticated")
    elif "def _require_bus_free" not in src:
        todo.append(("include_router", INCLUDE_LINES))
        print("[2/2] include_router: _require_bus_free not found; refusing (the route must respect the bus owner)")
    elif not APP_CTOR_RE.search(src):
        todo.append(("include_router", INCLUDE_LINES))
        print("[2/2] include_router: `app = FastAPI(` not found")
    else:
        k = src.find("\nif __name__ ==")
        if k != -1:
            src = src[: k + 1] + INCLUDE_LINES + "\n" + src[k + 1:]
        else:
            src = src.rstrip("\n") + "\n\n" + INCLUDE_LINES
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
    backup = APP.with_suffix(".py.bak-move")
    backup.write_text(original, encoding="utf-8", newline="\n")
    APP.write_text(src, encoding="utf-8", newline="\n")
    print(f"\nwrote {APP} (backup at {backup.name}). Now, with no session active: sudo systemctl restart robot-arm")
    return 0


if __name__ == "__main__":
    sys.exit(main())

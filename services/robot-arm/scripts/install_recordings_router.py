#!/usr/bin/env python3
"""
Wire src/server/recordings_admin.py into the robot-arm service's app.py on the Pi.

Run from the robot-arm project root on arm-pi:

    python3 scripts/install_recordings_router.py            # apply
    python3 scripts/install_recordings_router.py --check    # report only

It makes up to two idempotent edits to src/server/app.py:
  1. `from . import recordings_admin` and `import fastapi as _fastapi`, placed
     AFTER the whole `from fastapi import ...` statement (which may be a
     parenthesised multi-line block, as on the live arm-pi app.py).
  2. At the END of the module (before any `if __name__ == ...` block):
       recordings_admin.bind(state)            # only if `state = ` exists
       app.include_router(recordings_admin.router, dependencies=[_fastapi.Depends(require_api_key)])
     Refuses if `require_api_key` does not exist: recordings are never exposed
     unauthenticated.

Always `sudo systemctl restart robot-arm` after.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "src" / "server" / "app.py"
CHECK = "--check" in sys.argv

IMPORT_LINE = "from . import recordings_admin\nimport fastapi as _fastapi\n"
BIND_LINE = "recordings_admin.bind(state)\n"
INCLUDE_LINE = (
    "app.include_router(recordings_admin.router, "
    "dependencies=[_fastapi.Depends(require_api_key)])\n"
)

FASTAPI_IMPORT_RE = re.compile(r"^from fastapi import \([^)]*\)\n|^from fastapi import [^\n]*\n", re.M)
APP_CTOR_RE = re.compile(r"^app\s*=\s*FastAPI\(", re.M)
STATE_RE = re.compile(r"^state\s*[:=]", re.M)


def main() -> int:
    if not APP.exists():
        print(f"app.py not found at {APP}")
        return 2
    src = APP.read_text(encoding="utf-8")
    original = src

    # 1) import
    if "import recordings_admin" in src:
        print("[1/2] import: already present")
    else:
        m = FASTAPI_IMPORT_RE.search(src)
        if not m:
            print("[1/2] import: `from fastapi import ...` not found; add by hand:\n" + IMPORT_LINE)
            return 1
        line = IMPORT_LINE
        # The GPIO installer may already have imported fastapi as _fastapi.
        if "import fastapi as _fastapi" in src:
            line = "from . import recordings_admin\n"
        src = src[: m.end()] + line + src[m.end() :]
        print("[1/2] import: added")

    # 2) bind + include_router at end of module
    if "include_router(recordings_admin.router" in src:
        print("[2/2] include_router: already present")
    elif "def require_api_key" not in src:
        print("[2/2] include_router: require_api_key not found; refusing to expose recordings unauthenticated")
        return 1
    elif not APP_CTOR_RE.search(src):
        print("[2/2] include_router: `app = FastAPI(` not found; add by hand:\n" + INCLUDE_LINE)
        return 1
    else:
        block = INCLUDE_LINE
        if STATE_RE.search(src):
            block = BIND_LINE + INCLUDE_LINE
        else:
            print("      note: no module-level `state`; delete will not check for an active session")
        k = src.find("\nif __name__ ==")
        if k != -1:
            src = src[: k + 1] + block + "\n" + src[k + 1 :]
        else:
            src = src.rstrip("\n") + "\n\n" + block
        print("[2/2] include_router: added at end of module")

    if src == original:
        print("\nno changes needed")
        return 0

    if CHECK:
        print("\n--check: would modify app.py (not written)")
        return 0

    backup = APP.with_suffix(".py.bak-recordings")
    backup.write_text(original, encoding="utf-8", newline="\n")
    APP.write_text(src, encoding="utf-8", newline="\n")
    print(f"\nwrote {APP} (backup at {backup.name}). Now: sudo systemctl restart robot-arm")
    return 0


if __name__ == "__main__":
    sys.exit(main())

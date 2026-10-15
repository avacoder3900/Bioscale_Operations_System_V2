#!/usr/bin/env python3
"""
Wire src/server/gpio.py into the robot-arm service's app.py on the Pi.

Run from the robot-arm project root on arm-pi:

    python3 scripts/install_gpio_router.py            # apply
    python3 scripts/install_gpio_router.py --check    # report only

It makes three idempotent edits to src/server/app.py:
  1. `from . import gpio as solenoid_gpio` next to the other imports
  2. `app.include_router(solenoid_gpio.router, dependencies=[Depends(require_api_key)])`
     right after the `app = FastAPI(...)` statement
  3. `solenoid_gpio.all_off()` as the first line of the /e-stop handler

If an anchor cannot be found it says so and changes nothing; apply that step by
hand with the snippet it prints. Always run `systemctl restart robot-arm` after.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "src" / "server" / "app.py"
CHECK = "--check" in sys.argv

IMPORT_LINE = "from . import gpio as solenoid_gpio\n"
INCLUDE_LINE = (
    "app.include_router(solenoid_gpio.router, dependencies=[Depends(require_api_key)])\n"
)
ESTOP_LINE = "    solenoid_gpio.all_off()  # drop every solenoid before touching the arm\n"


def main() -> int:
    if not APP.exists():
        print(f"app.py not found at {APP}")
        return 2
    src = APP.read_text(encoding="utf-8")
    original = src
    todo = []

    # 1) import
    if "import gpio as solenoid_gpio" in src:
        print("[1/3] import: already present")
    else:
        m = re.search(r"^from fastapi import [^\n]*\n", src, re.M)
        if not m:
            todo.append(("import", IMPORT_LINE))
            print("[1/3] import: anchor not found")
        else:
            src = src[: m.end()] + IMPORT_LINE + src[m.end() :]
            print("[1/3] import: added")

    # 2) include_router after `app = FastAPI(...)`
    if "include_router(solenoid_gpio.router" in src:
        print("[2/3] include_router: already present")
    else:
        m = re.search(r"^app\s*=\s*FastAPI\(", src, re.M)
        if not m:
            todo.append(("include_router", INCLUDE_LINE))
            print("[2/3] include_router: anchor `app = FastAPI(` not found")
        else:
            # walk to the matching close paren of the FastAPI(...) call
            i = m.end()
            depth = 1
            while i < len(src) and depth:
                depth += {"(": 1, ")": -1}.get(src[i], 0)
                i += 1
            eol = src.find("\n", i)
            eol = len(src) if eol == -1 else eol + 1
            if "Depends" not in src:
                todo.append(("include_router", INCLUDE_LINE))
                print("[2/3] include_router: `Depends` is not imported in app.py; add it by hand")
            else:
                src = src[:eol] + INCLUDE_LINE + src[eol:]
                print("[2/3] include_router: added")

    # 3) e-stop hook
    if "solenoid_gpio.all_off()" in src:
        print("[3/3] e-stop hook: already present")
    else:
        m = re.search(r"^async def e_stop\([^)]*\)[^\n]*:\n", src, re.M)
        if not m:
            todo.append(("e-stop", ESTOP_LINE))
            print("[3/3] e-stop hook: handler `async def e_stop(` not found")
        else:
            # skip a docstring/comment block if present, insert as first statement
            j = m.end()
            body = src[j:]
            ds = re.match(r'(\s*"""[\s\S]*?"""\n)', body)
            if ds:
                j += ds.end()
            src = src[:j] + ESTOP_LINE + src[j:]
            print("[3/3] e-stop hook: added")

    if todo:
        print("\nApply these by hand:")
        for where, line in todo:
            print(f"  - {where}: {line.strip()}")

    if src == original:
        print("\nno changes needed")
        return 0 if not todo else 1

    if CHECK:
        print("\n--check: would modify app.py (not written)")
        return 0

    backup = APP.with_suffix(".py.bak-gpio")
    backup.write_text(original, encoding="utf-8", newline="\n")
    APP.write_text(src, encoding="utf-8", newline="\n")
    print(f"\nwrote {APP} (backup at {backup.name}). Now: sudo systemctl restart robot-arm")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
Wire src/server/gpio.py into the robot-arm service's app.py on the Pi.

Run from the robot-arm project root on arm-pi:

    python3 scripts/install_gpio_router.py            # apply
    python3 scripts/install_gpio_router.py --check    # report only

It makes up to three idempotent edits to src/server/app.py:
  1. `from . import gpio as solenoid_gpio` and `import fastapi as _fastapi`,
     placed AFTER the whole `from fastapi import ...` statement, which may be a
     parenthesised multi-line block (the live arm-pi app.py is).
  2. `app.include_router(solenoid_gpio.router, dependencies=[_fastapi.Depends(require_api_key)])`
     at the END of the module, before any `if __name__ == ...` block, so `app`
     and `require_api_key` are both defined whatever order app.py declares them.
     Refuses if `require_api_key` does not exist: GPIO is never exposed unauthenticated.
  3. `solenoid_gpio.all_off()` as the first statement of an `async def e_stop(`
     handler, if one exists. Its absence is reported, not treated as a failure.

If an anchor cannot be found it says so and changes nothing for that step; apply
it by hand with the snippet it prints. Always `sudo systemctl restart robot-arm`
after, then `curl /gpio/status` and expect simulated:false.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "src" / "server" / "app.py"
CHECK = "--check" in sys.argv

IMPORT_LINE = "from . import gpio as solenoid_gpio\nimport fastapi as _fastapi\n"
INCLUDE_LINE = (
    "app.include_router(solenoid_gpio.router, "
    "dependencies=[_fastapi.Depends(require_api_key)])\n"
)
ESTOP_LINE = "    solenoid_gpio.all_off()  # drop every solenoid before touching the arm\n"

# A parenthesised multi-line import first, then the single-line form.
FASTAPI_IMPORT_RE = re.compile(r"^from fastapi import \([^)]*\)\n|^from fastapi import [^\n]*\n", re.M)
APP_CTOR_RE = re.compile(r"^app\s*=\s*FastAPI\(", re.M)
ESTOP_RE = re.compile(r"^async def e_stop\([^)]*\)[^\n]*:\n", re.M)


def main() -> int:
    if not APP.exists():
        print(f"app.py not found at {APP}")
        return 2
    src = APP.read_text(encoding="utf-8")
    original = src
    todo: list[tuple[str, str]] = []

    # 1) import
    if "import gpio as solenoid_gpio" in src:
        print("[1/3] import: already present")
    else:
        m = FASTAPI_IMPORT_RE.search(src)
        if not m:
            todo.append(("import", IMPORT_LINE))
            print("[1/3] import: `from fastapi import ...` not found")
        else:
            src = src[: m.end()] + IMPORT_LINE + src[m.end() :]
            print("[1/3] import: added")

    # 2) include_router at end of module
    if "include_router(solenoid_gpio.router" in src:
        print("[2/3] include_router: already present")
    elif "def require_api_key" not in src:
        todo.append(("include_router", INCLUDE_LINE))
        print("[2/3] include_router: require_api_key not found; refusing to expose GPIO unauthenticated")
    elif not APP_CTOR_RE.search(src):
        todo.append(("include_router", INCLUDE_LINE))
        print("[2/3] include_router: `app = FastAPI(` not found")
    else:
        k = src.find("\nif __name__ ==")
        if k != -1:
            src = src[: k + 1] + INCLUDE_LINE + "\n" + src[k + 1 :]
        else:
            src = src.rstrip("\n") + "\n\n" + INCLUDE_LINE
        print("[2/3] include_router: added at end of module")

    # 3) e-stop hook (optional)
    if "solenoid_gpio.all_off()" in src:
        print("[3/3] e-stop hook: already present")
    else:
        m = ESTOP_RE.search(src)
        if not m:
            print(
                "[3/3] e-stop hook: no `async def e_stop(` handler in this app.py; skipped "
                "(call solenoid_gpio.all_off() from your stop path by hand if one exists)"
            )
        else:
            j = m.end()
            ds = re.match(r'(\s*"""[\s\S]*?"""\n)', src[j:])
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
        return 1 if todo else 0

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

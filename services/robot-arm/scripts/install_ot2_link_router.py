#!/usr/bin/env python3
"""
Wire src/server/ot2_link.py (the direct arm-pi <-> OT-2 link over the USB-B
cable: /ot2/link, /ot2/api/{path}, /ot2/run/{id}/pause|wait, /ot2/loop/*)
into the robot-arm service's app.py on the Pi.

Copy ot2_link.py next to app.py first, then run from the robot-arm project
root on arm-pi:

    python3 scripts/install_ot2_link_router.py            # apply
    python3 scripts/install_ot2_link_router.py --check    # report only

Two idempotent edits to src/server/app.py, like the conveyor installer:
  1. `from . import ot2_link as pi_ot2_link` after the `from fastapi import ...`
     statement.
  2. At the end of the module: `pi_ot2_link.require_api_key = require_api_key`
     and `app.include_router(pi_ot2_link.router)`. The router is included
     WITHOUT a blanket dependency on purpose: every route declares its own
     (the key, or the key-or-the-robot-itself for the two the protocol calls
     over the cable). Refuses if `require_api_key` does not exist.

ot2_link.py needs httpx, which app.py already imports. It touches nothing
in app.py and never uses the servo bus.

Then, with GET /sessions/active == {"active": null}: `sudo systemctl restart robot-arm`,
and `curl -H "x-api-key: $KEY" localhost:8000/ot2/link` — expect the robot's
name and `active: "cable"` when the cable is in (else "lan").

Network prerequisite (once, sudo): a fixed link-local address on the cable
interface so the robot can reach THIS Pi at a known address:
    nmcli con add type ethernet ifname eth1 con-name ot2-cable ipv4.method manual \
        ipv4.addresses 169.254.42.1/16 ipv4.never-default yes ipv6.method link-local \
        connection.autoconnect yes connection.autoconnect-priority 50
(The stock `netplan-eth0` profile otherwise grabs eth1 and loops on DHCP.)
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

IMPORT_LINE = "from . import ot2_link as pi_ot2_link\n"
INJECT_LINE = "pi_ot2_link.require_api_key = require_api_key\n"
INCLUDE_LINE = "app.include_router(pi_ot2_link.router)\n"

FASTAPI_IMPORT_RE = re.compile(r"^from fastapi import \([^)]*\)\n|^from fastapi import [^\n]*\n", re.M)


def main() -> int:
    if not APP.exists():
        print(f"app.py not found at {APP}")
        return 2
    if not (APP.parent / "ot2_link.py").exists():
        print(f"ot2_link.py not found next to app.py ({APP.parent}); copy it there first")
        return 2
    src = APP.read_text(encoding="utf-8")
    original = src
    if "def require_api_key" not in src and "async def require_api_key" not in src:
        print("app.py has no require_api_key; refusing to expose the OT-2 link unauthenticated")
        return 2

    if IMPORT_LINE not in src:
        m = FASTAPI_IMPORT_RE.search(src)
        if not m:
            print("could not find the `from fastapi import ...` statement in app.py")
            return 2
        src = src[: m.end()] + IMPORT_LINE + src[m.end():]
        print("+ import")
    else:
        print("= import present")

    if INJECT_LINE not in src or INCLUDE_LINE not in src:
        tail = ""
        if INJECT_LINE not in src:
            tail += INJECT_LINE
        if INCLUDE_LINE not in src:
            tail += INCLUDE_LINE
        src = src.rstrip("\n") + "\n" + tail
        print("+ include_router (end of module)")
    else:
        print("= include_router present")

    if src == original:
        print("nothing to do")
        return 0
    if CHECK:
        print("--check: changes NOT written")
        return 1
    backup = APP.with_suffix(".py.bak-ot2-link")
    if not backup.exists():
        backup.write_text(original, encoding="utf-8")
        print(f"backup: {backup.name}")
    APP.write_text(src, encoding="utf-8")
    print(f"wrote {APP}")
    report_install("ot2_link", [APP])
    return 0


if __name__ == "__main__":
    sys.exit(main())

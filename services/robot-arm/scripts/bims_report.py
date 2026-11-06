#!/usr/bin/env python3
"""
Tell BIMS's robot arm Change Log about a change made on the Pi (2026-11-06).

Run from the robot-arm project root on arm-pi (reads .env there for
BIMS_WEBHOOK_URL / BIMS_CHANGES_URL and AGENT_API_KEY):

    python3 scripts/bims_report.py install thermal                 # pi.router.thermal Installed
    python3 scripts/bims_report.py change --hardware network --key pi.wifi_ssid --new Aquinas_Townpark
    python3 scripts/bims_report.py change --hardware servo --key servo.limit_steps --target servo:1 \
        --old "718-3317" --new "700-3300" --unit steps --note "EEPROM limits widened"
    python3 scripts/bims_report.py change --hardware camera --key hardware.cable --target camera:arm \
        --new "USB 3" --page hand --source hand
    python3 scripts/bims_report.py flush                           # resend anything still pending
    python3 scripts/bims_report.py pending                         # what is waiting

Keys are lower-case and dotted (servo.p_coefficient, pi.router.thermal); BIMS
rejects anything else. The install_*.py scripts import report_install from
here, so an install reports itself.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "src" / "server" / "bims_changes.py"

_spec = importlib.util.spec_from_file_location("bims_changes", MODULE)
if _spec is None or _spec.loader is None:
    raise SystemExit(f"bims_changes.py not found at {MODULE}")
bims_changes = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bims_changes)

report_install = bims_changes.report_install


def _value(s: str | None):
    """A number stays a number; 'on' / 'off' become booleans; anything else is text."""
    if s is None:
        return None
    t = s.strip()
    if t.lower() in ("on", "true"):
        return True
    if t.lower() in ("off", "false"):
        return False
    try:
        return int(t)
    except ValueError:
        pass
    try:
        return float(t)
    except ValueError:
        return t


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Report a Pi-side change to BIMS's robot arm Change Log")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_install = sub.add_parser("install", help="pi.router.<name> Installed")
    p_install.add_argument("name", help="router name, e.g. thermal, servo_config")
    p_install.add_argument("--note")

    p_change = sub.add_parser("change", help="one labelled change")
    p_change.add_argument("--hardware", required=True, help="servo gripper leader-arm camera depth vision solenoid conveyor stage pi network")
    p_change.add_argument("--key", required=True, help="lower-case dotted, e.g. pi.wifi_ssid")
    p_change.add_argument("--target", help="servo:2, pin:22, camera:arm")
    p_change.add_argument("--old")
    p_change.add_argument("--new")
    p_change.add_argument("--unit")
    p_change.add_argument("--note")
    p_change.add_argument("--page", default="pi", help="pi (default) or hand")
    p_change.add_argument("--source", default="pi", help="pi (default), hand or code")

    sub.add_parser("flush", help="send every pending row")
    sub.add_parser("pending", help="list pending rows")

    a = ap.parse_args(argv)
    if a.cmd == "install":
        report_install(a.name, [ROOT / "src" / "server" / "app.py"], note=a.note, wait=True)
        return 0
    if a.cmd == "change":
        row = bims_changes.change(a.hardware, a.key, target=a.target, old=_value(a.old), new=_value(a.new), unit=a.unit, note=a.note, page=a.page, source=a.source)
        stored = bims_changes.report([row], wait=True)
        print(f"{'stored' if stored else 'pending'}: {a.key} {a.target or ''} {a.old or ''} -> {a.new or ''}".replace("  ", " "))
        return 0 if stored else 1
    if a.cmd == "flush":
        stored = bims_changes.flush()
        print(f"stored {stored}; {len(bims_changes._read_pending())} still pending")
        return 0
    if a.cmd == "pending":
        for r in bims_changes._read_pending():
            print(json.dumps(r))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())

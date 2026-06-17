#!/usr/bin/env python3
"""
Cartesian-jog calibration REPL for the SO-100 follower.

Talks to the running FastAPI server at ROBOT_ARM_BASE_URL (default
http://127.0.0.1:8765). Lets the operator capture servo zero positions,
flip joint signs, and remap operator-axis labels (right/forward/up) onto
URDF axes — then writes ~/.bims-arm/jog-calibration.json and asks the
server to reload it.

Typical session:

    $ services/robot-arm/.venv/bin/python services/robot-arm/scripts/calibrate_jog.py
    > pose                                       # show current pose
    > set-zero                                   # capture current servo
                                                 # positions as joint zeros
    > jog x 5                                    # nudge +5 mm in operator-X;
                                                 # watch which way the arm
                                                 # actually moves
    > flip-axis x                                # arm moved left instead
                                                 # of right? flip the X sign
    > jog x 5                                    # verify
    > save                                       # write JSON + ask server to
                                                 # reload
    > quit

Commands:
    pose                       — print current pose + calibration
    set-zero                   — capture current servo positions as
                                 zero_step for every joint
    flip <joint>               — flip sign on joint N (1..5)
    flip-axis <x|y|z>          — flip the operator-axis sign
    axes <right> <forward> <up>
                               — set axes_map; each axis is one of x/y/z
                                 optionally prefixed with - (e.g. "axes x -y z")
    jog <axis> <mm>            — call /jog/cartesian to nudge
                                 (uses current calibration)
    torque on|off              — toggle follower torque
    show                       — print pending (unsaved) calibration
    save                       — write JSON + POST /jog/reload-calibration
    reload                     — re-fetch calibration from the server
    help                       — show this list
    quit / exit                — leave (warns if unsaved changes)
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import httpx

BASE_URL = os.environ.get("ROBOT_ARM_BASE_URL", "http://127.0.0.1:8765")
API_KEY = os.environ.get("ROBOT_ARM_API_KEY", "")
CAL_PATH = Path(
    os.environ.get(
        "BIMS_ARM_JOG_CALIBRATION",
        str(Path.home() / ".bims-arm" / "jog-calibration.json"),
    )
)
JOINTS = (1, 2, 3, 4, 5)


def hdr() -> dict:
    return {"x-api-key": API_KEY} if API_KEY else {}


def api(method: str, path: str, **kw) -> dict:
    with httpx.Client(timeout=10.0) as c:
        r = c.request(method, f"{BASE_URL}{path}", headers=hdr(), **kw)
        r.raise_for_status()
        return r.json()


def default_cal() -> dict:
    return {
        "joints": {str(s): {"zero_step": 2048, "sign": 1} for s in JOINTS},
        "axes_map": {"x": "x", "y": "y", "z": "z"},
        "axes_sign": {"x": 1, "y": 1, "z": 1},
    }


def load_local() -> dict:
    if CAL_PATH.exists():
        try:
            cal = default_cal()
            raw = json.loads(CAL_PATH.read_text())
            cal["joints"].update({str(k): v for k, v in (raw.get("joints") or {}).items()})
            cal["axes_map"].update(raw.get("axes_map") or {})
            cal["axes_sign"].update(raw.get("axes_sign") or {})
            return cal
        except Exception as exc:
            print(f"[cal] failed to parse {CAL_PATH}: {exc}")
    return default_cal()


def save_local(cal: dict) -> None:
    CAL_PATH.parent.mkdir(parents=True, exist_ok=True)
    CAL_PATH.write_text(json.dumps(cal, indent=2))


def show(cal: dict) -> None:
    print(json.dumps(cal, indent=2))


def parse_axis(token: str) -> tuple[str, int]:
    sign = 1
    if token.startswith("-"):
        sign = -1
        token = token[1:]
    if token not in ("x", "y", "z"):
        raise ValueError(f"axis must be x/y/z (with optional - prefix); got {token!r}")
    return token, sign


def cmd_pose() -> None:
    p = api("GET", "/pose")
    print(
        f"  xyz = ({p['x_mm']}, {p['y_mm']}, {p['z_mm']}) mm    "
        f"calibration: {p['calibration_source']}"
    )
    for sid, deg in p["joint_angles_deg"].items():
        print(f"    J{sid}  {deg:7.2f}°  ({p['joint_steps'][sid]} steps)")


def cmd_set_zero(cal: dict) -> None:
    p = api("GET", "/pose")
    for sid in JOINTS:
        steps = p["joint_steps"].get(str(sid))
        if steps is None:
            print(f"  J{sid} missing from /pose; skipped")
            continue
        cal["joints"][str(sid)]["zero_step"] = int(steps)
        print(f"  J{sid}.zero_step = {steps}")
    print("  (unsaved — `save` to persist)")


def cmd_flip_joint(cal: dict, arg: str) -> None:
    sid = int(arg)
    if sid not in JOINTS:
        raise ValueError(f"joint must be 1..5; got {sid}")
    j = cal["joints"][str(sid)]
    j["sign"] = -int(j.get("sign", 1))
    print(f"  J{sid}.sign = {j['sign']}")


def cmd_flip_axis(cal: dict, arg: str) -> None:
    if arg not in ("x", "y", "z"):
        raise ValueError(f"axis must be x/y/z; got {arg!r}")
    cal["axes_sign"][arg] = -int(cal["axes_sign"].get(arg, 1))
    print(f"  axes_sign.{arg} = {cal['axes_sign'][arg]}")


def cmd_axes(cal: dict, args: list[str]) -> None:
    if len(args) != 3:
        raise ValueError("usage: axes <right> <forward> <up>  (each one of x/y/z, optionally -prefixed)")
    for op_axis, tok in zip(("x", "y", "z"), args):
        target, sign = parse_axis(tok)
        cal["axes_map"][op_axis] = target
        cal["axes_sign"][op_axis] = sign
    print(f"  axes_map = {cal['axes_map']}    axes_sign = {cal['axes_sign']}")


def cmd_jog(args: list[str]) -> None:
    if len(args) != 2:
        raise ValueError("usage: jog <axis> <mm>  (e.g. `jog x 5`)")
    axis, mm = args[0], float(args[1])
    if axis not in ("x", "y", "z"):
        raise ValueError(f"axis must be x/y/z; got {axis!r}")
    body = {"dx_mm": 0.0, "dy_mm": 0.0, "dz_mm": 0.0}
    body[f"d{axis}_mm"] = mm
    r = api("POST", "/jog/cartesian", json=body)
    print(
        f"  jogged  before xyz=({r['before']['x_mm']}, {r['before']['y_mm']}, {r['before']['z_mm']})  "
        f"→ target=({r['after_target']['x_mm']}, {r['after_target']['y_mm']}, {r['after_target']['z_mm']})"
    )
    clamped = {k: v for k, v in r["clamped"].items() if v > 0}
    if clamped:
        print(f"  clamped: {clamped}")


def cmd_torque(args: list[str]) -> None:
    if not args or args[0] not in ("on", "off"):
        raise ValueError("usage: torque on|off")
    api("POST", "/torque", json={"enable": args[0] == "on"})
    print(f"  torque {args[0]}")


def cmd_save(cal: dict) -> None:
    save_local(cal)
    print(f"  wrote {CAL_PATH}")
    try:
        r = api("POST", "/jog/reload-calibration")
        print(f"  server reloaded: {r['calibration_source']}")
    except Exception as exc:
        print(f"  server reload failed (not fatal): {exc}")


def cmd_reload(cal: dict) -> dict:
    fresh = load_local()
    cal.clear()
    cal.update(fresh)
    print("  reloaded from disk")
    return cal


def repl() -> None:
    cal = load_local()
    dirty = False
    print(f"calibrate_jog — talking to {BASE_URL}")
    print(f"cal file:  {CAL_PATH}    (exists: {CAL_PATH.exists()})")
    print("type `help` for commands\n")
    while True:
        try:
            raw = input("cal> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            raw = "quit"
        if not raw:
            continue
        parts = raw.split()
        cmd, args = parts[0], parts[1:]
        try:
            if cmd in ("help", "?"):
                print(__doc__)
            elif cmd == "pose":
                cmd_pose()
            elif cmd == "set-zero":
                cmd_set_zero(cal); dirty = True
            elif cmd == "flip":
                cmd_flip_joint(cal, args[0]); dirty = True
            elif cmd == "flip-axis":
                cmd_flip_axis(cal, args[0]); dirty = True
            elif cmd == "axes":
                cmd_axes(cal, args); dirty = True
            elif cmd == "jog":
                cmd_jog(args)
            elif cmd == "torque":
                cmd_torque(args)
            elif cmd == "show":
                show(cal)
            elif cmd == "save":
                cmd_save(cal); dirty = False
            elif cmd == "reload":
                cmd_reload(cal); dirty = False
            elif cmd in ("quit", "exit", "q"):
                if dirty:
                    a = input("unsaved changes — quit anyway? [y/N] ").strip().lower()
                    if a != "y":
                        continue
                break
            else:
                print(f"unknown command: {cmd!r} (type `help`)")
        except Exception as exc:
            print(f"  error: {exc}")


if __name__ == "__main__":
    try:
        repl()
    except SystemExit:
        raise
    except Exception as exc:
        print(f"fatal: {exc}", file=sys.stderr)
        sys.exit(1)

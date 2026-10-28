#!/usr/bin/env python3
"""
Install the 2026-10-23 vision-quality changes onto the robot-arm service on arm-pi:

  cameras.py          _Frame.gray() (raw luma for the detector), wait_frame(), cameras.current(),
                      saved UVC controls re-applied on every device open
  apriltags.py        detects on the raw frame (no JPEG round trip), AprilTag corner refinement
                      by default, `frames` averaging with per-tag jitter_px
  depth.py            480p / 720p depth stream switch at runtime (GET/POST /depth/config),
                      measured fps + v4l2-ctl child CPU in status
  camera_controls.py  NEW: GET/POST /cameras/{name}/controls (exposure, gain, white balance ...)
                      with device-reported ranges, persisted to calibrations/camera_controls.json

Usage, from the robot-arm project root on arm-pi, with the new files staged in a directory
(e.g. `tar` them from the repo's services/robot-arm/src/server into ~/vision-staging):

    python3 scripts/install_vision_quality.py --src ~/vision-staging --check   # report only
    python3 scripts/install_vision_quality.py --src ~/vision-staging           # apply
    sudo systemctl restart robot-arm

Safety: each existing module is only replaced when its md5 is one this installer knows,
either the version it was written against (the Pi's files on 2026-10-23) or the new
version itself (re-run). Anything else means the Pi's file moved on since, and the
installer stops so a human can diff first. Backups: <file>.bak-pre-raw.

app.py edit (idempotent, same pattern as install_thermal_router.py):
  `from . import camera_controls` after the `from fastapi import ...` statement, and
  `app.include_router(camera_controls.router, dependencies=[_fastapi.Depends(require_api_key)])`
  at the end of the module. Refuses if `require_api_key` does not exist.

Afterwards (KEY = ROBOT_ARM_API_KEY from .env):
    curl -s -H "x-api-key: $KEY" localhost:8000/cameras/external/apriltags | python3 -m json.tool
        expect frame_source "raw", refine "apriltag"
    curl -s -H "x-api-key: $KEY" localhost:8000/cameras/external/controls | python3 -m json.tool
        expect available true and a controls list with min/max/step from the camera
    curl -s -H "x-api-key: $KEY" localhost:8000/depth/config
        expect mode 480p (the default) until BIMS switches it
    python3 scripts/measure_tag_jitter.py --n 30            # compare with the baseline table
"""

from __future__ import annotations

import argparse
import hashlib
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "src" / "server"
APP = SERVER / "app.py"

# md5 of the Pi's files when this installer was written (2026-10-23, identical to the
# repo's vendored copies at the time, except depth.py which was re-vendored from the Pi).
KNOWN_BEFORE = {
    "cameras.py": {"036d01e5bdd0cce71e50d71ad9df1ae0"},
    # second hash: the 2026-10-23 raw-frames version (installed by this script); frame stacking 2026-10-28 replaces it
    "apriltags.py": {"ecbd96c225886e926785c4b8a5b83d08", "d204c414bd8fd5bf852d042606bcb663"},
    # second hash: the first 2026-10-23 version (before the sampler's hole/edge gate)
    "depth.py": {"344326c7058dc24f6be4dcd9ef77c8d6", "c4f46771b999180091ae168808fc3fcb"},
}
MODULES = ("cameras.py", "apriltags.py", "depth.py", "camera_controls.py")
# camera_controls.py did not exist before; its first 2026-10-23 version may be replaced.
KNOWN_BEFORE["camera_controls.py"] = {"5ea2843b13b1ebf7e3375b615da6dd4e"}

IMPORT_LINE = "from . import camera_controls\n"
FASTAPI_ALIAS = "import fastapi as _fastapi\n"
INCLUDE_LINE = "app.include_router(camera_controls.router, dependencies=[_fastapi.Depends(require_api_key)])\n"
FASTAPI_IMPORT_RE = re.compile(r"^from fastapi import \([^)]*\)\n|^from fastapi import [^\n]*\n", re.M)
APP_CTOR_RE = re.compile(r"^app\s*=\s*FastAPI\(", re.M)


def md5(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="directory holding the new cameras.py, apriltags.py, depth.py, camera_controls.py")
    ap.add_argument("--check", action="store_true", help="report only")
    ap.add_argument("--force", action="store_true", help="replace modules whose current md5 is unknown (after you diffed them)")
    a = ap.parse_args()
    src = Path(a.src).expanduser().resolve()

    missing = [m for m in MODULES if not (src / m).exists()]
    if missing:
        print(f"missing in {src}: {', '.join(missing)}")
        return 2
    if not APP.exists():
        print(f"app.py not found at {APP}")
        return 2

    plan: list[tuple[str, str]] = []
    blocked = False
    for m in MODULES:
        new = src / m
        cur = SERVER / m
        if not cur.exists():
            plan.append((m, "new file"))
            continue
        h_cur, h_new = md5(cur), md5(new)
        if h_cur == h_new:
            plan.append((m, "already installed"))
        elif h_cur in KNOWN_BEFORE.get(m, set()):
            plan.append((m, "replace (known previous version)"))
        elif a.force:
            plan.append((m, f"replace (--force; current md5 {h_cur} unknown)"))
        else:
            plan.append((m, f"BLOCKED: current md5 {h_cur} is not a version this installer knows; diff it, then --force"))
            blocked = True
    for m, what in plan:
        print(f"[{m}] {what}")

    app_src = APP.read_text(encoding="utf-8")
    app_new = app_src
    if "import camera_controls" in app_src:
        print("[app.py] import: already present")
    else:
        mm = FASTAPI_IMPORT_RE.search(app_new)
        if not mm:
            print("[app.py] import: `from fastapi import ...` not found; add by hand: " + IMPORT_LINE.strip())
            blocked = True
        else:
            line = IMPORT_LINE + ("" if "import fastapi as _fastapi" in app_new else FASTAPI_ALIAS)
            app_new = app_new[: mm.end()] + line + app_new[mm.end():]
            print("[app.py] import: will add")
    if "include_router(camera_controls.router" in app_src:
        print("[app.py] include_router: already present")
    elif "def require_api_key" not in app_src:
        print("[app.py] include_router: require_api_key not found; refusing to expose camera controls unauthenticated")
        blocked = True
    elif not APP_CTOR_RE.search(app_src):
        print("[app.py] include_router: `app = FastAPI(` not found")
        blocked = True
    else:
        k = app_new.find("\nif __name__ ==")
        if k != -1:
            app_new = app_new[: k + 1] + INCLUDE_LINE + "\n" + app_new[k + 1:]
        else:
            app_new = app_new.rstrip("\n") + "\n\n" + INCLUDE_LINE
        print("[app.py] include_router: will add at end of module")

    if blocked:
        print("\nnot applied: resolve the BLOCKED/by-hand items above")
        return 1
    if a.check:
        print("\n--check: nothing written")
        return 0

    for m, what in plan:
        if what.startswith("replace") or what == "new file":
            cur = SERVER / m
            if cur.exists():
                shutil.copy2(cur, cur.with_suffix(".py.bak-pre-raw"))
            shutil.copy2(src / m, cur)
            print(f"wrote {cur}")
    if app_new != app_src:
        APP.with_suffix(".py.bak-camera-controls").write_text(app_src, encoding="utf-8", newline="\n")
        APP.write_text(app_new, encoding="utf-8", newline="\n")
        print(f"wrote {APP} (backup app.py.bak-camera-controls)")
    print("\nNow: sudo systemctl restart robot-arm")
    return 0


if __name__ == "__main__":
    sys.exit(main())

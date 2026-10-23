#!/usr/bin/env python3
"""
Measure AprilTag corner / distance jitter on a PARKED scene, through the live
service, so a camera or detector change can be judged in numbers.

Run on arm-pi from the robot-arm project root (reads ROBOT_ARM_API_KEY from .env):

    .venv/bin/python scripts/measure_tag_jitter.py                 # 30 detects, frames=1
    .venv/bin/python scripts/measure_tag_jitter.py --n 30 --frames 5
    .venv/bin/python scripts/measure_tag_jitter.py --out /tmp/after.json

Prints, per tag: how many detects saw it, the standard deviation of its centre
(px), the mean standard deviation of its 8 corner coordinates (px), the
standard deviation of the pose's z (mm, with every tag assumed --size mm, so
only RELATIVE to another run of this script), and the D415 depth's standard
deviation (mm). Plus mean detect time and the Pi's temperature before/after.

Baseline on 2026-10-23 (1080p, JPEG q80 path, subpix refine, upscale 2, sunlight):
corner sd 0.10-0.35 px, image-z sd 0.25-4.25 mm, depth sd 0-0.46 mm, 143 ms/detect.

Do not move the arm, the sheet or the lights between the runs you compare.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics as st
import sys
import time
import urllib.request
from pathlib import Path


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def call(base: str, key: str, path: str, body: dict | None = None, timeout: float = 20.0) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{base}{path}", data=data, method="POST" if body is not None else "GET",
                                 headers={"x-api-key": key, "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def thermal(base: str, key: str) -> str:
    try:
        d = call(base, key, "/health/thermal", timeout=5)
        return f"{d.get('temp_c')} C, service cpu {d.get('service_cpu_pct')} %"
    except Exception as e:  # pragma: no cover
        return f"(thermal unavailable: {e})"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=30, help="detect calls")
    ap.add_argument("--frames", type=int, default=1, help="frames averaged per detect (1..10)")
    ap.add_argument("--size", type=float, default=8.0, help="tag size assumed for every tag, mm (relative z only)")
    ap.add_argument("--camera", default="external")
    ap.add_argument("--base", default=os.environ.get("APRILTAG_SELF_URL", "http://127.0.0.1:8000"))
    ap.add_argument("--pause", type=float, default=0.25, help="seconds between detects")
    ap.add_argument("--out", help="save every raw response to this JSON file")
    a = ap.parse_args()

    load_env(Path(".env"))
    key = os.environ.get("ROBOT_ARM_API_KEY", "")
    if not key:
        print("ROBOT_ARM_API_KEY not set (run from the project root, or export it)")
        return 2

    print("thermal before:", thermal(a.base, key))
    runs = []
    t0 = time.time()
    for _ in range(a.n):
        runs.append(call(a.base, key, f"/cameras/{a.camera}/apriltags/detect",
                         {"default_size_mm": a.size, "frames": a.frames, "depth": True}))
        time.sleep(a.pause)
    wall = time.time() - t0
    ok = [r for r in runs if r.get("available")]
    if not ok:
        print("no successful detects:", runs[0].get("reason") if runs else "no runs")
        return 1
    first = ok[0]
    w, h = first["frame"]["width"], first["frame"]["height"]
    print(f"detects {len(ok)}/{a.n} in {wall:.1f} s | detector {first.get('detector')} refine {first.get('refine', '?')} "
          f"upscale {first.get('upscale', '?')} | frame {w}x{h} source {first.get('frame_source', 'jpeg (pre-2026-10-23)')} "
          f"frames/detect {first.get('frames_used', 1)} | elapsed_ms mean {st.mean(r['elapsed_ms'] for r in ok):.1f}")

    ids = sorted({t["id"] for r in ok for t in r["tags"]})
    sd = lambda v: f"{st.pstdev(v):.2f}" if len(v) > 1 else "-"
    mean = lambda v: f"{st.mean(v):.1f}" if v else "-"
    print(f"{'tag':>3} {'seen':>5} {'cx_sd_px':>9} {'cy_sd_px':>9} {'corner_sd_px':>12} {'z_sd_mm':>8} {'z_mean':>7} {'depth_sd':>9} {'depth_mean':>10} {'jitter_px':>9}")
    for tid in ids:
        obs = [t for r in ok for t in r["tags"] if t["id"] == tid]
        cx = [t["center"][0] * w for t in obs]
        cy = [t["center"][1] * h for t in obs]
        coords = [[c[0] * w for c in t["corners"]] + [c[1] * h for c in t["corners"]] for t in obs]
        corner_sd = st.mean(st.pstdev(col) for col in zip(*coords)) if len(obs) > 1 else 0.0
        z = [t["pose"]["t_mm"][2] for t in obs if t.get("pose")]
        d = [t["depth_mm"] for t in obs if t.get("depth_mm") is not None]
        jit = [t["jitter_px"] for t in obs if t.get("jitter_px") is not None]
        print(f"{tid:>3} {len(obs):>5} {sd(cx):>9} {sd(cy):>9} {corner_sd:>12.3f} {sd(z):>8} {mean(z):>7} {sd(d):>9} {mean(d):>10} {(f"{st.mean(jit):.3f}" if jit else '-'):>9}")
    print("thermal after: ", thermal(a.base, key))
    if a.out:
        Path(a.out).write_text(json.dumps(runs), encoding="utf-8")
        print("saved", a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())

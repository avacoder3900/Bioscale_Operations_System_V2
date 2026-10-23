"""
Depth from the RealSense D415 for the robot-arm service.

The D415 is active-IR stereo, not lidar: it reports a 16-bit depth image
(Z16, 1 unit = 1 mm at the factory depth scale) on its own V4L2 node, next
to the colour node that cameras.py streams. This module owns that depth
node and answers "how far away is this patch of the image", which BIMS
turns into a zero baseline and a live distance on the Control page.

ARM-05: apriltags.py calls `_rs.sample(points, radius)` (normalised colour-frame
points) to attach the depth at each tag centre; since 2026-10-23 that depth IS
the tag's distance in BIMS (image z only as fallback), so its resolution
matters. `_rs` at the bottom of this file keeps that name working.

Endpoints (auth is applied by app.py when the router is included):
  Depth-image coordinates (Control page: zero baseline + live distance)
    GET  /depth/status
    GET  /depth/measure?x=0.5&y=0.5&r=10&frames=5&mode=median|nearest
    GET  /depth/preview.jpg?x=0.5&y=0.5&r=10&min_mm=200&max_mm=1500
  Stream mode (2026-10-23; BIMS Vision tab "Depth stream")
    GET  /depth/config                  {mode, width, height, fps, modes, fps_choices, persisted, file, status}
    POST /depth/config                  {mode?: "480p"|"720p", fps?: 6|15|30, persist?: true}
  Colour-frame coordinates (ARM-04/05 tag vision, Vision tab)
    GET  /cameras/{name}/depth          {available, source, reason, depth_size, mode, aligned}
    POST /cameras/{name}/depth/sample   {points: [[x, y], ...], radius_px?: 3}
                                     -> {available, units: "mm", depth_mm: [n|null, ...], source, reason}
    A point comes back null when it is off the depth image, when fewer than
    30 % of its window are real returns (holes), or when the window's returns
    disagree by more than 20 mm (an edge): see _sample_points.

All x/y are fractions (0..1, origin top-left) of the image they refer to,
so a caller never needs to know either stream's resolution.

Stream modes
------------
480p = 848x480 (what this file always used) and 720p = 1280x720, the D415's
full depth resolution. The sensor computes depth at 1280x720 and decimates
for the smaller modes, so 720p is both finer (a 3 px sampling radius covers
a smaller patch of the tag) and natively cleaner. The cost is USB bandwidth
(1.8 MB per frame instead of 0.8 MB) and the v4l2-ctl child's copy work; the
status reports the child's CPU and the measured frame rate so the two modes
can be compared on the live Pi. The mode is switched at runtime (the stream
restarts in about a second) and remembered in DEPTH_CONFIG_FILE (default
calibrations/depth_config.json); env DEPTH_MODE / DEPTH_FPS are the defaults
when no file exists.

Colour -> depth alignment
-------------------------
Tags are found in the COLOUR frame, but depth comes from the IR stereo
pair, which has a wider field of view and sits ~15 mm to one side.
librealsense would project with factory extrinsics; without it we use an
affine map measured on this camera (scripts/calibrate_depth_alignment.py:
SIFT matches between the colour frame and the left-IR frame, which is
pixel-aligned with depth). Measured 2026-10-19 on arm-pi, 640x480 colour ->
848x480 depth: median residual 1.6 px. The leftover error is parallax,
roughly 20 px * (500 mm / distance - 1) at other depths, which the
sampling radius absorbs. Override with DEPTH_COLOR_AFFINE (six numbers, at
the 848x480 reference). For 720p the map is scaled per axis by
1280/848 and 720/480: the D415's depth modes are per-axis scalings of one
view, which is also how librealsense derives their intrinsics.

Why v4l2-ctl and not OpenCV
---------------------------
The pip opencv-python build on arm-pi refuses to open the Z16 node at all
("can't open camera by name/index"), while `v4l2-ctl --stream-mmap` reads
it fine (verified 2026-10-19, ~9 fps alongside the 30 fps colour stream on
USB 2). So one long-lived v4l2-ctl child streams raw frames to our stdout
pipe and a reader thread slices it into fixed-size frames. The child gets
PDEATHSIG so it can never outlive the service and hold /dev/videoN busy.

The worker starts on first request and stops after IDLE_STOP_S without
one, so depth only uses USB bandwidth while someone is looking at it.

Intrinsics are NOMINAL (D415 datasheet depth FOV 65 x 40 deg), not the
per-unit factory calibration, which only librealsense can read. Good to a
few percent for x/y; z is the sensor's own value. Every response says
intrinsics_source="nominal" so nobody mistakes it for calibrated.

Range: the D415 returns 0 ("no depth") for anything closer than ~30-45 cm
and for shiny, black or very thin surfaces. 0 is excluded, never averaged.

Config (env, ~/robot-arm/.env):
    DEPTH_MODE           "480p" (default) or "720p"; the config file wins when present
    DEPTH_FPS            6, 15 (default) or 30
    DEPTH_CONFIG_FILE    saved mode (default calibrations/depth_config.json)
    DEPTH_CAMERAS        BIMS camera names whose colour frame is this RealSense (default "external")
    DEPTH_COLOR_AFFINE   six numbers overriding the measured colour->depth map (848x480 reference)
"""

from __future__ import annotations

import ctypes
import json
import math
import os
import signal
import subprocess
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Optional

import numpy as np
from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, Field

from src.server.cameras import _v4l2_nodes

try:  # pragma: no cover - present on the Pi
    import cv2
except ImportError:  # pragma: no cover
    cv2 = None  # type: ignore[assignment]

MODES: dict[str, tuple[int, int]] = {"480p": (848, 480), "720p": (1280, 720)}
FPS_CHOICES = (6, 15, 30)
DEFAULT_MODE = "480p"
DEFAULT_FPS = 15
CONFIG_FILE = Path(os.environ.get("DEPTH_CONFIG_FILE", "calibrations/depth_config.json"))

MATCH = "RealSense"
IDLE_STOP_S = 60.0
STALE_AFTER_S = 3.0
MAX_VALID_MM = 6000  # beyond this the D415 is noise, not measurement
HFOV_DEG = 65.0
VFOV_DEG = 40.0

# Colour-frame pixel (at COLOR_REF_W x COLOR_REF_H) -> depth-frame pixel, 2x3 affine,
# measured at AFFINE_REF_W x AFFINE_REF_H depth (see module doc).
COLOR_REF_W = 640
COLOR_REF_H = 480
AFFINE_REF_W = 848
AFFINE_REF_H = 480
_DEFAULT_AFFINE = (1.0128, -0.0380, 89.1292, -0.0083, 0.9826, 12.9490)
# BIMS camera names whose colour frame comes from this RealSense ("*" = all).
DEPTH_CAMERAS = [c.strip() for c in os.environ.get("DEPTH_CAMERAS", "external").split(",") if c.strip()]
MAX_POINTS = 64

# No prefix: the routes span /depth/* and /cameras/{name}/depth*.
router = APIRouter(tags=["depth"])


# -- geometry -----------------------------------------------------------------

@dataclass(frozen=True)
class Geometry:
    mode: str
    width: int
    height: int
    fps: int

    @property
    def frame_bytes(self) -> int:
        return self.width * self.height * 2

    def intrinsics(self) -> dict[str, float]:
        return {
            "fx": (self.width / 2) / math.tan(math.radians(HFOV_DEG / 2)),
            "fy": (self.height / 2) / math.tan(math.radians(VFOV_DEG / 2)),
            "cx": (self.width - 1) / 2,
            "cy": (self.height - 1) / 2,
        }

    def as_dict(self) -> dict[str, Any]:
        return {"mode": self.mode, "width": self.width, "height": self.height, "fps": self.fps}


def _geometry(mode: str, fps: int) -> Geometry:
    if mode not in MODES:
        raise ValueError(f"mode must be one of {', '.join(MODES)}")
    if fps not in FPS_CHOICES:
        raise ValueError(f"fps must be one of {', '.join(map(str, FPS_CHOICES))}")
    w, h = MODES[mode]
    return Geometry(mode, w, h, int(fps))


def _env_or(key: str, default: str) -> str:
    v = os.environ.get(key, "").strip()
    return v or default


def _load_config() -> tuple[Geometry, bool]:
    """(geometry, from_file). File > env > defaults; anything invalid falls back."""
    try:
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        return _geometry(str(data["mode"]), int(data.get("fps", DEFAULT_FPS))), True
    except Exception:
        pass
    try:
        return _geometry(_env_or("DEPTH_MODE", DEFAULT_MODE), int(_env_or("DEPTH_FPS", str(DEFAULT_FPS)))), False
    except Exception:
        return _geometry(DEFAULT_MODE, DEFAULT_FPS), False


def _save_config(geom: Geometry) -> None:
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({**geom.as_dict(), "written_at": time.time()}, indent=2), encoding="utf-8")
    tmp.replace(CONFIG_FILE)


def _color_affine_ref() -> np.ndarray:
    raw = os.environ.get("DEPTH_COLOR_AFFINE", "").strip()
    vals = _DEFAULT_AFFINE
    if raw:
        try:
            parsed = tuple(float(v) for v in raw.split(","))
            if len(parsed) == 6:
                vals = parsed
        except ValueError:
            pass
    return np.array(vals, dtype=np.float64).reshape(2, 3)


_COLOR_AFFINE_REF = _color_affine_ref()


def _affine_for(width: int, height: int) -> np.ndarray:
    """The colour->depth map for a depth image of this size (see module doc)."""
    a = _COLOR_AFFINE_REF.copy()
    a[0, :] *= width / AFFINE_REF_W
    a[1, :] *= height / AFFINE_REF_H
    return a


def _has_z16(device: str) -> bool:
    # Not cameras._node_formats: its regex wants four word characters, and the
    # depth FOURCC is "Z16 " with a trailing space, so it never matches.
    try:
        out = subprocess.run(
            ["v4l2-ctl", "-d", device, "--list-formats"],
            capture_output=True, text=True, timeout=5, check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return "'Z16 '" in out


def resolve_depth_node() -> Optional[str]:
    """First RealSense V4L2 node that advertises Z16."""
    for device, card in _v4l2_nodes():
        if MATCH.lower() in card.lower() and _has_z16(device):
            return device
    return None


def _die_with_parent() -> None:  # pragma: no cover - Linux only
    try:
        ctypes.CDLL("libc.so.6").prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG
    except Exception:
        pass


def _proc_cpu_ticks(pid: int) -> Optional[int]:
    """utime + stime of a process in clock ticks, from /proc (None when gone)."""
    try:
        with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as f:
            parts = f.read().rsplit(")", 1)[1].split()
        return int(parts[11]) + int(parts[12])  # fields 14 and 15 of the full line
    except Exception:
        return None


class _DepthWorker:
    def __init__(self, geom: Geometry, persisted: bool) -> None:
        self.geom = geom
        self.persisted = persisted
        self._lock = threading.Lock()
        self._frames: deque[tuple[float, np.ndarray]] = deque(maxlen=30)
        self._thread: Optional[threading.Thread] = None
        self._proc: Optional[subprocess.Popen[bytes]] = None
        self._stop = threading.Event()
        self._restart = threading.Event()
        self._last_used = 0.0
        self._device: Optional[str] = None
        self._error: Optional[str] = None
        self._count = 0
        self._cpu_sample: Optional[tuple[float, int, int]] = None  # (time, pid, ticks)
        self._cpu_pct: Optional[float] = None

    def touch(self) -> None:
        self._last_used = time.time()
        with self._lock:
            if self._thread is None or not self._thread.is_alive():
                self._stop.clear()
                self._thread = threading.Thread(target=self._run, name="depth", daemon=True)
                self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        proc = self._proc
        if proc is not None and proc.poll() is None:
            proc.terminate()

    def set_geometry(self, geom: Geometry) -> None:
        """Switch mode/fps. A running stream restarts with the new format;
        the frame buffer is cleared so two sizes never mix."""
        with self._lock:
            self.geom = geom
            self._frames.clear()
            self._cpu_sample = None
            self._cpu_pct = None
        running = self._thread is not None and self._thread.is_alive()
        proc = self._proc
        if running and proc is not None and proc.poll() is None:
            self._restart.set()
            proc.terminate()

    def _run(self) -> None:
        while not self._stop.is_set():
            device = resolve_depth_node()
            if device is None:
                self._error = f"no {MATCH} node advertising Z16 depth"
                if self._stop.wait(2.0):
                    break
                continue
            self._device = device
            geom = self.geom
            cmd = [
                "v4l2-ctl", "-d", device,
                f"--set-fmt-video=width={geom.width},height={geom.height},pixelformat=Z16 ",
                f"--set-parm={geom.fps}",
                "--stream-mmap", "--stream-count=0", "--stream-to=-",
            ]
            try:
                self._proc = subprocess.Popen(
                    cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    bufsize=0, preexec_fn=_die_with_parent,
                )
            except OSError as exc:
                self._error = f"could not start v4l2-ctl: {exc}"
                if self._stop.wait(2.0):
                    break
                continue
            self._error = None
            self._read(self._proc, geom)
            if self._proc.poll() is None:
                self._proc.terminate()
            try:
                self._proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._proc.kill()
            self._proc = None
            if self._restart.is_set():
                self._restart.clear()  # mode change: straight back round with the new geometry
                continue
            if not self._stop.is_set():
                self._error = "depth stream ended; restarting"
                self._stop.wait(1.0)
        with self._lock:
            self._frames.clear()

    def _read(self, proc: subprocess.Popen[bytes], geom: Geometry) -> None:
        stdout = proc.stdout
        assert stdout is not None
        frame_bytes = geom.frame_bytes
        while not self._stop.is_set() and not self._restart.is_set():
            if time.time() - self._last_used > IDLE_STOP_S:
                self._stop.set()
                return
            buf = bytearray()
            while len(buf) < frame_bytes:
                chunk = stdout.read(frame_bytes - len(buf))
                if not chunk:
                    return
                buf += chunk
            frame = np.frombuffer(bytes(buf), dtype=np.uint16).reshape(geom.height, geom.width)
            with self._lock:
                if self.geom is geom:  # drop a frame that straddled a mode change
                    self._frames.append((time.time(), frame))
                    self._count += 1

    def recent(self, n: int, wait_s: float = 4.0) -> list[tuple[float, np.ndarray]]:
        """Up to n newest frames that are not stale, waiting briefly on a cold start."""
        self.touch()
        deadline = time.time() + wait_s
        while True:
            with self._lock:
                now = time.time()
                fresh = [f for f in self._frames if now - f[0] <= STALE_AFTER_S]
            if len(fresh) >= n or time.time() >= deadline:
                return fresh[-n:]
            time.sleep(0.05)

    def _child_cpu(self) -> Optional[float]:
        """v4l2-ctl child's CPU since the previous status call, % of one core."""
        proc = self._proc
        if proc is None or proc.poll() is not None:
            self._cpu_sample = None
            return None
        ticks = _proc_cpu_ticks(proc.pid)
        now = time.time()
        if ticks is None:
            return None
        prev = self._cpu_sample
        self._cpu_sample = (now, proc.pid, ticks)
        if prev is None or prev[1] != proc.pid or now - prev[0] < 0.5:
            return self._cpu_pct
        hz = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100
        self._cpu_pct = round(100.0 * (ticks - prev[2]) / hz / (now - prev[0]), 1)
        return self._cpu_pct

    def status(self) -> dict[str, Any]:
        with self._lock:
            geom = self.geom
            stamps = [t for t, _ in self._frames]
        last = stamps[-1] if stamps else None
        age = None if last is None else round(time.time() - last, 3)
        measured = round((len(stamps) - 1) / (stamps[-1] - stamps[0]), 1) if len(stamps) >= 2 and stamps[-1] > stamps[0] else None
        proc = self._proc
        return {
            "device": self._device,
            "running": bool(self._thread is not None and self._thread.is_alive()),
            "mode": geom.mode,
            "width": geom.width,
            "height": geom.height,
            "fps": geom.fps,
            "measured_fps": measured,
            "frame_bytes": geom.frame_bytes,
            "frames": self._count,
            "last_frame_age_s": age,
            "stale": age is None or age > STALE_AFTER_S,
            "child_pid": proc.pid if proc is not None and proc.poll() is None else None,
            "child_cpu_pct": self._child_cpu(),
            "error": self._error,
        }


_initial, _persisted = _load_config()
worker = _DepthWorker(_initial, _persisted)


def close() -> None:
    worker.stop()


def _box(shape: tuple[int, int], x: float, y: float, r: int) -> tuple[int, int, int, int, int, int]:
    h, w = shape
    u = min(w - 1, max(0, round(x * (w - 1))))
    v = min(h - 1, max(0, round(y * (h - 1))))
    return u, v, max(0, u - r), min(w, u + r + 1), max(0, v - r), min(h, v + r + 1)


def _measure_frame(
    depth: np.ndarray, x0: int, x1: int, y0: int, y1: int, mode: str
) -> Optional[tuple[float, float, float, float]]:
    """(distance_mm, u, v, valid_fraction) for one frame, or None when nothing valid."""
    patch = depth[y0:y1, x0:x1].astype(np.float32)
    valid = (patch > 0) & (patch < MAX_VALID_MM)
    frac = float(valid.mean()) if patch.size else 0.0
    if not valid.any():
        return None
    vals = patch[valid]
    if mode == "nearest":
        # 2nd percentile, not min: one flying pixel at an edge must not win.
        z = float(np.percentile(vals, 2))
        near = valid & (patch <= z + 5)
        ys, xs = np.nonzero(near)
        return z, float(xs.mean() + x0), float(ys.mean() + y0), frac
    return float(np.median(vals)), (x0 + x1 - 1) / 2, (y0 + y1 - 1) / 2, frac


@router.get("/depth/status")
def depth_status() -> dict[str, Any]:
    """Does not start the stream: polling status must not power on a sensor."""
    return {**worker.status(), "intrinsics": worker.geom.intrinsics(), "intrinsics_source": "nominal"}


# -- stream mode ---------------------------------------------------------------

class ConfigRequest(BaseModel):
    mode: Optional[Literal["480p", "720p"]] = None
    fps: Optional[int] = None
    persist: bool = True


def _config_payload(**extra: Any) -> dict[str, Any]:
    return {
        **worker.geom.as_dict(),
        "modes": {k: list(v) for k, v in MODES.items()},
        "fps_choices": list(FPS_CHOICES),
        "persisted": worker.persisted,
        "file": str(CONFIG_FILE),
        "status": worker.status(),
        **extra,
    }


@router.get("/depth/config")
def depth_config() -> dict[str, Any]:
    """Current depth stream mode and the choices. Does not start the stream."""
    return _config_payload()


@router.post("/depth/config")
def depth_set_config(body: ConfigRequest) -> dict[str, Any]:
    """Switch the depth stream between 480p and 720p (and 6/15/30 fps) at runtime."""
    cur = worker.geom
    try:
        geom = _geometry(body.mode or cur.mode, body.fps if body.fps is not None else cur.fps)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    changed = geom != cur
    if changed:
        worker.set_geometry(geom)
    if body.persist:
        try:
            _save_config(geom)
            worker.persisted = True
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"could not save {CONFIG_FILE}: {e}")
    # If someone is watching, wait briefly for the first frame in the new format
    # so the answer carries a measured frame rather than "stale".
    if changed and worker.status()["running"]:
        worker.recent(1, wait_s=3.0)
    return _config_payload(changed=changed)


@router.get("/depth/measure")
def depth_measure(
    x: float = Query(0.5, ge=0, le=1),
    y: float = Query(0.5, ge=0, le=1),
    r: int = Query(10, ge=1, le=200),
    frames: int = Query(5, ge=1, le=30),
    mode: Literal["median", "nearest"] = "median",
) -> dict[str, Any]:
    recent = worker.recent(frames)
    if not recent:
        st = worker.status()
        raise HTTPException(503, f"no depth frames ({st['error'] or 'stream starting'})")
    shape = recent[-1][1].shape
    u, v, x0, x1, y0, y1 = _box(shape, x, y, r)
    per = [m for _, d in recent if d.shape == shape and (m := _measure_frame(d, x0, x1, y0, y1, mode)) is not None]
    geom = worker.geom
    k = geom.intrinsics()
    base: dict[str, Any] = {
        "x": x, "y": y, "r": r, "mode": mode,
        "frames_used": len(recent),
        "frames_valid": len(per),
        "captured_at": recent[-1][0],
        "width": int(shape[1]), "height": int(shape[0]), "stream_mode": geom.mode,
        "intrinsics_source": "nominal",
    }
    if not per:
        return {**base, "distance_mm": None, "valid_fraction": 0.0, "point_mm": None,
                "spread_mm": None, "pixel": [u, v]}
    zs = np.array([p[0] for p in per])
    z = float(np.median(zs))
    pu = float(np.median([p[1] for p in per]))
    pv = float(np.median([p[2] for p in per]))
    return {
        **base,
        "distance_mm": round(z, 1),
        # Frame-to-frame jitter of the patch value: the noise floor to judge a delta against.
        "spread_mm": round(float(np.percentile(zs, 90) - np.percentile(zs, 10)), 1),
        "valid_fraction": round(float(np.mean([p[3] for p in per])), 3),
        "pixel": [round(pu, 1), round(pv, 1)],
        # Camera frame: +x right, +y down, +z away from the camera.
        "point_mm": {
            "x": round((pu - k["cx"]) * z / k["fx"], 1),
            "y": round((pv - k["cy"]) * z / k["fy"], 1),
            "z": round(z, 1),
        },
    }


@router.get("/depth/preview.jpg")
def depth_preview(
    x: Optional[float] = Query(None, ge=0, le=1),
    y: Optional[float] = Query(None, ge=0, le=1),
    r: int = Query(10, ge=1, le=200),
    min_mm: int = Query(250, ge=0, le=10000),
    max_mm: int = Query(1500, ge=1, le=10000),
) -> Response:
    if cv2 is None:
        raise HTTPException(503, "opencv is not installed on this host")
    recent = worker.recent(1)
    if not recent:
        st = worker.status()
        raise HTTPException(503, f"no depth frames ({st['error'] or 'stream starting'})")
    depth = recent[-1][1]
    hi = max(max_mm, min_mm + 1)
    norm = np.clip((depth.astype(np.float32) - min_mm) / (hi - min_mm), 0, 1)
    # Near = warm, far = cool; 0 (no depth) is painted black so gaps are obvious.
    img = cv2.applyColorMap((255 - norm * 255).astype(np.uint8), cv2.COLORMAP_TURBO)
    img[depth == 0] = (0, 0, 0)
    if x is not None and y is not None:
        _, _, x0, x1, y0, y1 = _box(depth.shape, x, y, r)
        cv2.rectangle(img, (x0, y0), (x1 - 1, y1 - 1), (255, 255, 255), 2)
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
    if not ok:
        raise HTTPException(500, "jpeg encode failed")
    return Response(
        content=buf.tobytes(),
        media_type="image/jpeg",
        headers={"Cache-Control": "no-store"},
    )


# --- ARM-04/05: depth at colour-frame points ----------------------------------


def color_to_depth_pixel(x: float, y: float, width: int, height: int) -> tuple[float, float]:
    """Normalised colour-frame point -> pixel of a width x height depth image."""
    u, v = _affine_for(width, height) @ np.array([x * COLOR_REF_W, y * COLOR_REF_H, 1.0])
    return float(u), float(v)


def _has_depth(name: str) -> bool:
    return "*" in DEPTH_CAMERAS or name in DEPTH_CAMERAS


def _source() -> str:
    g = worker.geom
    return f"v4l2:{worker.status()['device'] or '?'} RealSense D415 (Z16 {g.width}x{g.height} {g.mode} @{g.fps})"


class SampleRequest(BaseModel):
    points: list[list[float]] = Field(..., max_length=MAX_POINTS)
    radius_px: int = Field(3, ge=0, le=15)


@router.get("/cameras/{name}/depth")
def camera_depth_status(name: str) -> dict[str, Any]:
    """Whether this camera has depth, and from what. Starts the stream to find out."""
    if not _has_depth(name):
        return {"available": False, "source": None, "reason": f"camera {name!r} is not in DEPTH_CAMERAS", "depth_size": None}
    if not worker.recent(1):
        return {"available": False, "source": _source(), "reason": worker.status()["error"] or "no depth frame yet", "depth_size": None}
    g = worker.geom
    return {"available": True, "source": _source(), "reason": None, "depth_size": [g.width, g.height], "mode": g.mode, "fps": g.fps, "aligned": "affine"}


@router.post("/cameras/{name}/depth/sample")
def camera_depth_sample(name: str, body: SampleRequest) -> dict[str, Any]:
    """Depth in mm at normalised colour-frame points (null where there is no valid return)."""
    for p in body.points:
        if len(p) != 2 or not all(0.0 <= float(v) <= 1.0 for v in p):
            raise HTTPException(status_code=422, detail="points are normalised [x, y] pairs in 0..1")
    nulls: list[Optional[float]] = [None] * len(body.points)
    if not _has_depth(name):
        return {"available": False, "units": "mm", "depth_mm": nulls, "source": None, "reason": f"camera {name!r} has no depth configured"}
    recent = worker.recent(1)
    if not recent:
        return {"available": False, "units": "mm", "depth_mm": nulls, "source": _source(), "reason": worker.status()["error"] or "no depth frame yet"}
    out = _sample_points(recent[-1][1], body.points, body.radius_px)
    return {"available": True, "units": "mm", "depth_mm": out, "source": _source(), "reason": None}


# A sample window must be mostly real returns, and they must agree, or the
# reading is refused. Probed 2026-10-23 on arm-pi: at 720p the D415 leaves
# holes (0) over some tag faces that 480p's decimation fills in, and a 7x7
# window on such a tag held only a few valid pixels, all from the surface
# BEHIND the tag (420 mm instead of 381). Better no depth (the caller falls
# back to the image) than the background's depth.
MIN_VALID_FRACTION = 0.3
MAX_SPREAD_MM = 20.0


def _sample_points(data: np.ndarray, points: list[list[float]], r: int) -> list[Optional[float]]:
    h, w = data.shape
    # The radius is given in 848x480 pixels (what callers were tuned on);
    # cover the same physical patch at a finer depth resolution.
    r_eff = max(0, int(round(r * w / AFFINE_REF_W)))
    out: list[Optional[float]] = []
    for x, y in points:
        fu, fv = color_to_depth_pixel(float(x), float(y), w, h)
        u, v = int(round(fu)), int(round(fv))
        if not (0 <= u < w and 0 <= v < h):
            out.append(None)  # outside the depth sensor's view
            continue
        win = data[max(0, v - r_eff): v + r_eff + 1, max(0, u - r_eff): u + r_eff + 1]
        valid = win[(win > 0) & (win < MAX_VALID_MM)]
        if not valid.size or valid.size < MIN_VALID_FRACTION * win.size:
            out.append(None)  # holes: the sensor has no reading for this patch
            continue
        if valid.size > 4 and float(np.percentile(valid, 90) - np.percentile(valid, 10)) > MAX_SPREAD_MM:
            out.append(None)  # the window straddles an edge; which surface is the tag?
            continue
        # Median of the valid returns: a tag edge or a dropout pixel must not pull the reading.
        out.append(round(float(np.median(valid)), 1))
    return out


class _RealSenseCompat:
    """ARM-05 apriltags.py calls `_depth._rs.sample(points, radius)` for its
    per-tag depth; keep that name working on top of `worker`."""

    def sample(self, points: list[list[float]], radius: int) -> list[Optional[float]]:
        recent = worker.recent(1)
        if not recent:
            raise RuntimeError(worker.status()["error"] or "no depth frame yet")
        return _sample_points(recent[-1][1], points, radius)


_rs = _RealSenseCompat()

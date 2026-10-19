"""
Depth (lidar) for the robot-arm cameras — ARM-04 marker vision.

BIMS tracks coloured sticker markers in the colour frame served by
cameras.py. To also check each marker's distance from the camera, it asks
this router for the depth at the points where it found them. Points are
NORMALISED [x, y] (0..1) on the colour frame, so BIMS never needs to know the
depth sensor's own resolution or how it is aligned.

Endpoints (auth is applied by app.py when the router is included):
    GET  /cameras/{name}/depth          {available, source, reason, depth_size}
    POST /cameras/{name}/depth/sample   {points: [[x, y], ...], radius_px?: 3}
                                     -> {available, units: "mm", depth_mm: [n|null, ...], source, reason}

Backend: Intel RealSense via pyrealsense2 (the L515 is sold as a "LiDAR
camera"; the D4xx family works the same way through this API). Only the DEPTH
stream is opened — cameras.py may already hold the colour node over V4L2, and
librealsense opens each sensor separately. A colour point is mapped onto the
depth image with rs2_project_color_pixel_to_depth_pixel, using the colour
sensor's factory intrinsics/extrinsics at DEPTH_COLOR_WIDTH x DEPTH_COLOR_HEIGHT
(set these to the resolution cameras.py streams). If the device has no colour
sensor, or DEPTH_ALIGN=naive, the normalised point is scaled straight onto the
depth image — only right when both views share a field of view.

Config (env, ~/robot-arm/.env):
    DEPTH_CAMERAS        comma list of BIMS camera names that have depth; "*" = all (default "*")
    DEPTH_SERIAL         RealSense serial to use when several are attached (default: first)
    DEPTH_WIDTH/HEIGHT   depth stream size (default 640x480; L515: 640x480 or 1024x768)
    DEPTH_FPS            default 30
    DEPTH_COLOR_WIDTH/HEIGHT  colour resolution the points refer to (default 640x480)
    DEPTH_ALIGN          "project" (default) or "naive"
    DEPTH_IDLE_S         stop the depth stream after this long without a request (default 60)

Without pyrealsense2 or a device, every response is available=false with a
reason — BIMS then checks the markers on the picture alone.

Deps on the Pi (inside the uv project):  uv add pyrealsense2 numpy
(pyrealsense2 wheels for aarch64 may need building from librealsense source.)
NOT yet exercised against hardware (2026-10-19).
"""

from __future__ import annotations

import os
import threading
import time
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/cameras", tags=["depth"])

try:  # optional hardware deps
    import numpy as np  # type: ignore
    import pyrealsense2 as rs  # type: ignore
except Exception as _imp_err:  # pragma: no cover - depends on the Pi
    np = None  # type: ignore
    rs = None  # type: ignore
    _IMPORT_ERROR: Optional[str] = f"pyrealsense2/numpy not importable: {_imp_err}"
else:
    _IMPORT_ERROR = None


def _env_int(key: str, default: int) -> int:
    try:
        return int(os.environ.get(key, default))
    except ValueError:
        return default


CAMERAS = [c.strip() for c in os.environ.get("DEPTH_CAMERAS", "*").split(",") if c.strip()]
SERIAL = os.environ.get("DEPTH_SERIAL") or None
DEPTH_W = _env_int("DEPTH_WIDTH", 640)
DEPTH_H = _env_int("DEPTH_HEIGHT", 480)
DEPTH_FPS = _env_int("DEPTH_FPS", 30)
COLOR_W = _env_int("DEPTH_COLOR_WIDTH", 640)
COLOR_H = _env_int("DEPTH_COLOR_HEIGHT", 480)
ALIGN = os.environ.get("DEPTH_ALIGN", "project").strip().lower()
IDLE_S = _env_int("DEPTH_IDLE_S", 60)
MAX_POINTS = 64


class _RealSense:
    """One depth-only pipeline, started on first use and stopped when idle.

    A reader thread keeps the latest depth frame as a numpy array, so a
    request never waits on the sensor beyond the first start.
    """

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.pipe = None
        self.thread: Optional[threading.Thread] = None
        self.latest = None  # numpy uint16 HxW
        self.latest_at = 0.0
        self.last_request = 0.0
        self.scale_m = 0.00025
        self.depth_intr = None
        self.color_intr = None
        self.d2c = None
        self.c2d = None
        self.source: Optional[str] = None
        self.error: Optional[str] = None

    def _start(self) -> None:
        ctx = rs.context()
        devices = list(ctx.query_devices())
        if not devices:
            raise RuntimeError("no RealSense device attached")
        dev = next((d for d in devices if d.get_info(rs.camera_info.serial_number) == SERIAL), None) if SERIAL else devices[0]
        if dev is None:
            raise RuntimeError(f"RealSense {SERIAL} not attached")
        serial = dev.get_info(rs.camera_info.serial_number)
        self.source = f"realsense:{dev.get_info(rs.camera_info.name)} {serial}"

        cfg = rs.config()
        cfg.enable_device(serial)
        cfg.enable_stream(rs.stream.depth, DEPTH_W, DEPTH_H, rs.format.z16, DEPTH_FPS)
        pipe = rs.pipeline()
        profile = pipe.start(cfg)
        depth_sensor = profile.get_device().first_depth_sensor()
        self.scale_m = depth_sensor.get_depth_scale()
        dprof = profile.get_stream(rs.stream.depth).as_video_stream_profile()
        self.depth_intr = dprof.get_intrinsics()

        # Colour intrinsics/extrinsics from the device's stream profiles —
        # no colour stream is opened, so cameras.py keeps the colour node.
        self.color_intr = self.d2c = self.c2d = None
        if ALIGN == "project":
            for sensor in dev.query_sensors():
                for sp in sensor.get_stream_profiles():
                    if sp.stream_type() != rs.stream.color:
                        continue
                    vp = sp.as_video_stream_profile()
                    if vp.width() == COLOR_W and vp.height() == COLOR_H:
                        self.color_intr = vp.get_intrinsics()
                        self.d2c = dprof.get_extrinsics_to(vp)
                        self.c2d = vp.get_extrinsics_to(dprof)
                        break
                if self.color_intr is not None:
                    break

        self.pipe = pipe
        self.thread = threading.Thread(target=self._read, name="depth-reader", daemon=True)
        self.thread.start()

    def _read(self) -> None:
        while True:
            pipe = self.pipe
            if pipe is None:
                return
            if time.monotonic() - self.last_request > IDLE_S:
                with self.lock:
                    self._stop_locked()
                return
            try:
                frames = pipe.wait_for_frames(1000)
                d = frames.get_depth_frame()
                if d:
                    self.latest = np.asanyarray(d.get_data()).copy()
                    self.latest_at = time.monotonic()
                    self.error = None
            except Exception as e:  # pragma: no cover - hardware
                self.error = str(e)
                time.sleep(0.2)

    def _stop_locked(self) -> None:
        pipe, self.pipe = self.pipe, None
        self.latest = None
        if pipe is not None:
            try:
                pipe.stop()
            except Exception:
                pass

    def frame(self, wait_s: float = 2.0):
        """Latest depth image (starting the stream if needed), or raise."""
        if _IMPORT_ERROR:
            raise RuntimeError(_IMPORT_ERROR)
        self.last_request = time.monotonic()
        with self.lock:
            if self.pipe is None:
                self._start()
        deadline = time.monotonic() + wait_s
        while time.monotonic() < deadline:
            if self.latest is not None and time.monotonic() - self.latest_at < 1.0:
                return self.latest
            time.sleep(0.03)
        raise RuntimeError(self.error or "no depth frame yet")

    def to_depth_pixel(self, data, x: float, y: float):
        h, w = data.shape
        if self.color_intr is not None:
            cx, cy = x * COLOR_W, y * COLOR_H
            px = rs.rs2_project_color_pixel_to_depth_pixel(
                data.tobytes(), self.scale_m, 0.1, 10.0,
                self.depth_intr, self.color_intr, self.c2d, self.d2c, [cx, cy],
            )
            if px[0] < 0 or px[1] < 0:
                return None
            return px[0], px[1]
        return x * (w - 1), y * (h - 1)

    def sample(self, points: List[List[float]], radius: int) -> List[Optional[float]]:
        data = self.frame()
        h, w = data.shape
        out: List[Optional[float]] = []
        for x, y in points:
            p = self.to_depth_pixel(data, x, y)
            if p is None:
                out.append(None)
                continue
            u, v = int(round(p[0])), int(round(p[1]))
            if not (0 <= u < w and 0 <= v < h):
                out.append(None)
                continue
            win = data[max(0, v - radius): v + radius + 1, max(0, u - radius): u + radius + 1]
            valid = win[win > 0]
            # Median of the valid returns: a sticker edge or a lidar dropout
            # pixel must not pull the reading.
            out.append(round(float(np.median(valid)) * self.scale_m * 1000.0, 1) if valid.size else None)
        return out


_rs = _RealSense()


def _has_depth(name: str) -> bool:
    return "*" in CAMERAS or name in CAMERAS


class SampleRequest(BaseModel):
    points: List[List[float]] = Field(..., max_length=MAX_POINTS)
    radius_px: int = Field(3, ge=0, le=15)


@router.get("/{name}/depth")
def depth_status(name: str):
    """Whether this camera has depth, and from what. Starts the stream to find out."""
    if not _has_depth(name):
        return {"available": False, "source": None, "reason": f"camera {name!r} is not in DEPTH_CAMERAS", "depth_size": None}
    try:
        data = _rs.frame()
        return {"available": True, "source": _rs.source, "reason": None, "depth_size": [int(data.shape[1]), int(data.shape[0])],
                "aligned": "project" if _rs.color_intr is not None else "naive"}
    except Exception as e:
        return {"available": False, "source": _rs.source, "reason": str(e), "depth_size": None}


@router.post("/{name}/depth/sample")
def depth_sample(name: str, body: SampleRequest):
    """Depth in mm at normalised colour-frame points (null where there is no valid return)."""
    for p in body.points:
        if len(p) != 2 or not all(0.0 <= float(v) <= 1.0 for v in p):
            raise HTTPException(status_code=422, detail="points are normalised [x, y] pairs in 0..1")
    nulls = [None] * len(body.points)
    if not _has_depth(name):
        return {"available": False, "units": "mm", "depth_mm": nulls, "source": None, "reason": f"camera {name!r} has no depth configured"}
    try:
        depth = _rs.sample(body.points, body.radius_px)
        return {"available": True, "units": "mm", "depth_mm": depth, "source": _rs.source, "reason": None}
    except Exception as e:
        return {"available": False, "units": "mm", "depth_mm": nulls, "source": _rs.source, "reason": str(e)}

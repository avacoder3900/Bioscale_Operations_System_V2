"""
AprilTag detection for the robot-arm cameras — ARM-05 tag vision.

Replaces ARM-04's coloured stickers. The tags are the printed AprilTag 36h11
sheet (calibration/apriltag-sheet.html, IDs 0-53). Every tag carries its own
ID, so there is no colour matching and no "which blob is which": BIMS asks
this router what the camera sees and gets back, per tag, where it is on the
picture and — given the tag's printed size and the camera's intrinsics — its
full pose relative to the camera in millimetres.

Endpoints (auth is applied by app.py when the router is included):
    GET  /cameras/{name}/apriltags          detector + intrinsics status
    POST /cameras/{name}/apriltags/detect   {tag_sizes_mm?, default_size_mm?, include_frame?, depth?}
        -> {available, reason, family, detector, frame: {width, height},
            intrinsics: {fx, fy, cx, cy, dist, source},
            tags: [{id, center, corners, size_mm, pose: {t_mm, R, reproj_px} | null,
                    depth_mm, margin}],
            frame_jpeg_b64?, elapsed_ms}

Coordinates: `center` and `corners` are NORMALISED to the frame (0..1), so
BIMS never depends on the stream resolution. Corners are in the tag's own
order (top-left, top-right, bottom-right, bottom-left as printed). `pose` is
the tag in the camera frame (OpenCV convention: x right, y down, z out of the
lens): `t_mm` the tag centre, `R` the 3x3 rotation row-major. Pose needs the
tag's printed size (edge of the BLACK square): BIMS sends its registry's sizes
in `tag_sizes_mm`; a tag with no known size comes back with pose null.

Frames: this module does NOT open the camera. cameras.py owns the colour
device (and differs between the Pi and the repo), so frames are fetched from
the service's own snapshot route over loopback — the same JPEG BIMS would get.
That keeps this file independent of cameras.py internals.

Intrinsics, best first:
    1. the RealSense colour stream profile at the frame's resolution (factory
       calibration, read through pyrealsense2 without opening a stream);
    2. APRILTAG_FX / APRILTAG_FY / APRILTAG_CX / APRILTAG_CY env overrides;
    3. a nominal D415 estimate (source "nominal") — fine for "did it move",
       not for absolute millimetres.

Depth: when depth.py is installed alongside, the D415's depth at each tag
centre is attached (`depth_mm`) as an independent cross-check of `t_mm[2]`.

Config (env, ~/robot-arm/.env):
    APRILTAG_SELF_URL      loopback base of this service (default http://127.0.0.1:8000)
    APRILTAG_FX/FY/CX/CY   intrinsics override, pixels at the streamed resolution
    APRILTAG_REFINE        "subpix" (default), "apriltag" (slower, sharper) or "none"
    ROBOT_ARM_API_KEY      read to call the snapshot route (already set for the service)

Deps on the Pi (inside the uv project): OpenCV >= 4.7 with the aruco module
(`uv add opencv-python-headless` if `import cv2; cv2.aruco` fails) and numpy.
NOT yet exercised against hardware (written 2026-10-20 without Pi access).
"""

from __future__ import annotations

import base64
import os
import threading
import time
from typing import Dict, List, Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/cameras", tags=["apriltags"])

try:  # optional deps
    import cv2  # type: ignore
    import numpy as np  # type: ignore

    _ARUCO = getattr(cv2, "aruco", None)
    if _ARUCO is None:
        raise ImportError("cv2 has no aruco module (install opencv-python-headless >= 4.7)")
except Exception as _imp_err:  # pragma: no cover - depends on the Pi
    cv2 = None  # type: ignore
    np = None  # type: ignore
    _ARUCO = None
    _IMPORT_ERROR: Optional[str] = f"OpenCV aruco not importable: {_imp_err}"
else:
    _IMPORT_ERROR = None

try:  # optional: RealSense factory intrinsics
    import pyrealsense2 as rs  # type: ignore
except Exception:  # pragma: no cover
    rs = None  # type: ignore

try:  # optional: depth cross-check from depth.py (ARM-04)
    from . import depth as _depth  # type: ignore
except Exception:  # pragma: no cover
    _depth = None  # type: ignore

SELF_URL = os.environ.get("APRILTAG_SELF_URL", "http://127.0.0.1:8000").rstrip("/")
REFINE = os.environ.get("APRILTAG_REFINE", "subpix").strip().lower()
MAX_SIZES = 600  # 36h11 has 587 IDs


def _env_float(key: str) -> Optional[float]:
    try:
        v = os.environ.get(key)
        return float(v) if v else None
    except ValueError:
        return None


# ── detector ─────────────────────────────────────────────────────────────

_detector = None
_detect_lock = threading.Lock()


def _get_detector():
    """OpenCV's aruco detector for tag36h11, across the 4.7+ and older APIs."""
    global _detector
    if _detector is not None:
        return _detector
    dictionary = _ARUCO.getPredefinedDictionary(_ARUCO.DICT_APRILTAG_36h11)
    if hasattr(_ARUCO, "DetectorParameters"):
        params = _ARUCO.DetectorParameters()
    else:  # < 4.7
        params = _ARUCO.DetectorParameters_create()
    params.cornerRefinementMethod = {
        "apriltag": _ARUCO.CORNER_REFINE_APRILTAG,
        "none": _ARUCO.CORNER_REFINE_NONE,
    }.get(REFINE, _ARUCO.CORNER_REFINE_SUBPIX)
    if hasattr(_ARUCO, "ArucoDetector"):
        det = _ARUCO.ArucoDetector(dictionary, params)
        _detector = ("opencv-aruco " + cv2.__version__, lambda gray: det.detectMarkers(gray))
    else:
        _detector = (
            "opencv-aruco-legacy " + cv2.__version__,
            lambda gray: _ARUCO.detectMarkers(gray, dictionary, parameters=params),
        )
    return _detector


# ── intrinsics ───────────────────────────────────────────────────────────

_intr_cache: Dict[tuple, dict] = {}


def _realsense_intrinsics(w: int, h: int) -> Optional[dict]:
    if rs is None:
        return None
    try:
        ctx = rs.context()
        for dev in ctx.query_devices():
            for sensor in dev.query_sensors():
                for sp in sensor.get_stream_profiles():
                    if sp.stream_type() != rs.stream.color:
                        continue
                    vp = sp.as_video_stream_profile()
                    if vp.width() == w and vp.height() == h:
                        i = vp.get_intrinsics()
                        return {"fx": i.fx, "fy": i.fy, "cx": i.ppx, "cy": i.ppy,
                                "dist": [float(c) for c in i.coeffs], "source": "realsense"}
    except Exception:
        return None
    return None


def _intrinsics(w: int, h: int) -> dict:
    key = (w, h)
    if key in _intr_cache:
        return _intr_cache[key]
    intr = _realsense_intrinsics(w, h)
    if intr is None:
        fx, fy, cx, cy = (_env_float(k) for k in ("APRILTAG_FX", "APRILTAG_FY", "APRILTAG_CX", "APRILTAG_CY"))
        if fx and fy:
            intr = {"fx": fx, "fy": fy, "cx": cx if cx is not None else w / 2, "cy": cy if cy is not None else h / 2,
                    "dist": [0.0] * 5, "source": "env"}
        else:
            # D415 colour: ~1380 px focal at 1920x1080 (16:9). The 4:3 modes
            # crop the sides, so 640x480 is ~615 px (0.96 W); 16:9 modes ~0.72 W.
            f = (0.96 if abs(w / h - 4 / 3) < 0.05 else 0.72) * w
            intr = {"fx": f, "fy": f, "cx": w / 2, "cy": h / 2, "dist": [0.0] * 5, "source": "nominal"}
    # Only a factory reading is worth caching for good; the others are cheap.
    if intr["source"] == "realsense":
        _intr_cache[key] = intr
    return intr


# ── frames ───────────────────────────────────────────────────────────────

def _grab_jpeg(name: str) -> bytes:
    key = os.environ.get("ROBOT_ARM_API_KEY", "")
    headers = {"x-api-key": key} if key else {}
    last = None
    for attempt in range(2):
        try:
            r = httpx.get(f"{SELF_URL}/cameras/{name}/snapshot.jpg", headers=headers, timeout=4.0)
            if r.status_code == 200 and r.content:
                return r.content
            last = f"snapshot {r.status_code}"
        except Exception as e:  # pragma: no cover - network
            last = str(e)
        time.sleep(0.8)  # a camera nobody is viewing may need its worker started
    raise RuntimeError(f"no frame from camera {name!r}: {last}")


# ── detection ────────────────────────────────────────────────────────────

class DetectRequest(BaseModel):
    tag_sizes_mm: Dict[str, float] = Field(default_factory=dict)
    default_size_mm: Optional[float] = Field(None, gt=0, lt=1000)
    include_frame: bool = False
    depth: bool = True


def _pose(corners, size: float, K, dist):
    s = size / 2.0
    # SOLVEPNP_IPPE_SQUARE wants exactly this order, matching aruco's corners.
    obj = np.array([[-s, s, 0], [s, s, 0], [s, -s, 0], [-s, -s, 0]], dtype=np.float64)
    ok, rvec, tvec = cv2.solvePnP(obj, corners.astype(np.float64), K, dist, flags=cv2.SOLVEPNP_IPPE_SQUARE)
    if not ok:
        return None
    proj, _ = cv2.projectPoints(obj, rvec, tvec, K, dist)
    err = float(np.sqrt(np.mean(np.sum((proj.reshape(-1, 2) - corners) ** 2, axis=1))))
    R, _ = cv2.Rodrigues(rvec)
    return {"t_mm": [round(float(v), 2) for v in tvec.reshape(3)],
            "R": [round(float(v), 6) for v in R.reshape(9)],
            "reproj_px": round(err, 3)}


def _detect(name: str, body: DetectRequest) -> dict:
    t0 = time.monotonic()
    jpeg = _grab_jpeg(name)
    img = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError("the snapshot could not be decoded")
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # One detector object is shared; FastAPI runs sync routes on a thread
    # pool, so a live view and a home check can arrive together.
    with _detect_lock:
        label, detect = _get_detector()
        corners_list, ids, _rej = detect(gray)

    intr = _intrinsics(w, h)
    K = np.array([[intr["fx"], 0, intr["cx"]], [0, intr["fy"], intr["cy"]], [0, 0, 1]], dtype=np.float64)
    dist = np.array(intr["dist"], dtype=np.float64)

    tags = []
    if ids is not None:
        for c, tid in zip(corners_list, ids.reshape(-1)):
            pts = c.reshape(4, 2).astype(np.float64)
            tid = int(tid)
            size = body.tag_sizes_mm.get(str(tid), body.default_size_mm)
            pose = None
            if size and size > 0:
                try:
                    pose = _pose(pts, float(size), K, dist)
                except Exception:
                    pose = None
            cx, cy = pts.mean(axis=0)
            tags.append({
                "id": tid,
                "center": [round(float(cx) / w, 5), round(float(cy) / h, 5)],
                "corners": [[round(float(x) / w, 5), round(float(y) / h, 5)] for x, y in pts],
                "size_mm": float(size) if size else None,
                "pose": pose,
                "depth_mm": None,
                "margin": None,
            })
    tags.sort(key=lambda t: t["id"])

    if body.depth and tags and _depth is not None:
        try:
            if _depth._has_depth(name):
                d = _depth._rs.sample([t["center"] for t in tags], 3)
                for t, v in zip(tags, d):
                    t["depth_mm"] = v
        except Exception:
            pass  # depth is a cross-check, never a reason to fail

    out = {
        "available": True,
        "reason": None,
        "family": "tag36h11",
        "detector": label,
        "frame": {"width": w, "height": h},
        "intrinsics": intr,
        "tags": tags,
        "elapsed_ms": round((time.monotonic() - t0) * 1000),
    }
    if body.include_frame:
        out["frame_jpeg_b64"] = base64.b64encode(jpeg).decode("ascii")
    return out


@router.get("/{name}/apriltags")
def apriltag_status(name: str):
    """Whether detection is possible here, and the intrinsics it would use."""
    if _IMPORT_ERROR:
        return {"available": False, "reason": _IMPORT_ERROR, "detector": None, "intrinsics": None}
    label, _ = _get_detector()
    try:
        jpeg = _grab_jpeg(name)
        img = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
        h, w = img.shape[:2]
        return {"available": True, "reason": None, "detector": label, "frame": {"width": w, "height": h},
                "intrinsics": _intrinsics(w, h), "depth": _depth is not None}
    except Exception as e:
        return {"available": False, "reason": str(e), "detector": label, "intrinsics": None}


@router.post("/{name}/apriltags/detect")
def apriltag_detect(name: str, body: DetectRequest):
    """Every tag36h11 tag in the camera's current frame, with pose where its size is known."""
    if len(body.tag_sizes_mm) > MAX_SIZES:
        raise HTTPException(status_code=422, detail=f"at most {MAX_SIZES} tag sizes")
    for k, v in body.tag_sizes_mm.items():
        if not k.isdigit() or not (0 < float(v) < 1000):
            raise HTTPException(status_code=422, detail="tag_sizes_mm maps tag id -> size in mm (0..1000)")
    if _IMPORT_ERROR:
        return {"available": False, "reason": _IMPORT_ERROR, "tags": []}
    try:
        return _detect(name, body)
    except Exception as e:
        return {"available": False, "reason": str(e), "tags": []}

"""USB camera bridge for the Pi station — aiortc VideoStreamTrack backed by OpenCV.

Opens /dev/video0 via cv2.VideoCapture with MJPG at 1280x720. If the camera
isn't present, `is_available()` returns False and /health surfaces
camera_ok=False — the agent stays up so the scanner / LED can still work.

WebRTC frame budget on Pi 4: ~720p at 15 fps (see PRD §5.3). Downsampling
to that ceiling and the recv() fps cap live in this module; task #14 hardens
both paths.
"""

from __future__ import annotations

import asyncio
import logging
import re
import shutil
import subprocess
import threading
import time
from fractions import Fraction
from typing import Optional

import cv2
from aiortc import VideoStreamTrack
from aiortc.contrib.media import MediaRelay
from av import VideoFrame

log = logging.getLogger("bims-capture-agent.camera")

# Resolution + fps choice (PRD §5.3): the Pi 4 hardware H264 encoder can
# sustain 720p comfortably at ~10-15 fps while leaving CPU headroom for
# aiortc, the OS, and (eventually) inference. 1080p doubles the pixel
# budget for marginal QC value at this distance — operators are aligning
# a cartridge, not reading fine print. We *ask* the driver for MJPG at
# 1280x720, but cheap USB cameras often ignore the request and serve a
# higher native resolution; recv() resizes down defensively. The fps cap
# uses an asyncio.sleep on the remaining slot time so a slow camera
# doesn't bunch frames and a fast camera doesn't burn the CPU.
_CAMERA_INDEX = 0
_TARGET_WIDTH = 1280
_TARGET_HEIGHT = 720
_TARGET_FPS = 15
_FRAME_INTERVAL = 1.0 / _TARGET_FPS

# Friendly-name → (cv2.CAP_PROP_*, value-type, [min, max], rough-typical-range)
# Operators send {prop: "exposure", value: -5}; we map to the cv2 enum here
# so the WS protocol stays human-readable. Min/max are advisory — different
# USB cameras advertise wildly different ranges, so we clamp here just for
# UI safety and let the camera reject out-of-range values silently.
CAMERA_PROPS: dict[str, tuple[int, str, float, float]] = {
    "brightness": (cv2.CAP_PROP_BRIGHTNESS, "int", 0, 255),
    "contrast": (cv2.CAP_PROP_CONTRAST, "int", 0, 255),
    "saturation": (cv2.CAP_PROP_SATURATION, "int", 0, 255),
    "hue": (cv2.CAP_PROP_HUE, "int", -180, 180),
    "gain": (cv2.CAP_PROP_GAIN, "int", 0, 255),
    "exposure": (cv2.CAP_PROP_EXPOSURE, "int", -13, 0),
    "auto_exposure": (cv2.CAP_PROP_AUTO_EXPOSURE, "int", 1, 3),  # 1=manual, 3=auto
    "autofocus": (cv2.CAP_PROP_AUTOFOCUS, "int", 0, 1),
    "focus": (cv2.CAP_PROP_FOCUS, "int", 0, 255),
    "auto_wb": (cv2.CAP_PROP_AUTO_WB, "int", 0, 1),
    "wb_temperature": (cv2.CAP_PROP_WB_TEMPERATURE, "int", 2800, 6500),
    "sharpness": (cv2.CAP_PROP_SHARPNESS, "int", 0, 255),
    "gamma": (cv2.CAP_PROP_GAMMA, "int", 1, 500),
}

# V4L2 control name → our friendly key. `v4l2-ctl --list-ctrls` reports the
# camera's *real* min/max/step/default per control, which the advisory ranges
# in CAMERA_PROPS only guess at. Control names drift across kernel versions
# (exposure_absolute vs exposure_time_absolute, focus_auto vs
# focus_automatic_continuous, white_balance_temperature_auto vs
# white_balance_automatic), so we accept every spelling we've seen.
_V4L2_TO_FRIENDLY: dict[str, str] = {
    "brightness": "brightness",
    "contrast": "contrast",
    "saturation": "saturation",
    "hue": "hue",
    "gain": "gain",
    "gamma": "gamma",
    "sharpness": "sharpness",
    "exposure_absolute": "exposure",
    "exposure_time_absolute": "exposure",
    "auto_exposure": "auto_exposure",
    "exposure_auto": "auto_exposure",
    "exposure_automatic": "auto_exposure",
    "focus_absolute": "focus",
    "focus_auto": "autofocus",
    "focus_automatic_continuous": "autofocus",
    "white_balance_temperature": "wb_temperature",
    "white_balance_temperature_auto": "auto_wb",
    "white_balance_automatic": "auto_wb",
}

_track_lock = threading.Lock()
_track: Optional["CameraTrack"] = None
_relay: Optional[MediaRelay] = None
_camera_ok = False
# Cached result of _query_v4l2_ranges(). None = not queried yet; {} = queried
# but nothing usable (no v4l2-ctl, or parse miss) → callers fall back to the
# advisory CAMERA_PROPS ranges. Control ranges are fixed for a given camera so
# a one-time query is enough.
_v4l2_ranges_cache: Optional[dict] = None


class CameraTrack(VideoStreamTrack):
    """aiortc track that pulls frames off cv2.VideoCapture."""

    kind = "video"

    def __init__(self) -> None:
        super().__init__()
        self._cap = cv2.VideoCapture(_CAMERA_INDEX)
        self._native_w = _TARGET_WIDTH
        self._native_h = _TARGET_HEIGHT
        self._next_deadline = 0.0
        if self._cap.isOpened():
            self._cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
            self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, _TARGET_WIDTH)
            self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, _TARGET_HEIGHT)
            self._cap.set(cv2.CAP_PROP_FPS, _TARGET_FPS)
            self._native_w = int(self._cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or _TARGET_WIDTH
            self._native_h = int(self._cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or _TARGET_HEIGHT
            log.info(
                "camera opened: %dx%d native, target %dx%d @ %d fps",
                self._native_w,
                self._native_h,
                _TARGET_WIDTH,
                _TARGET_HEIGHT,
                _TARGET_FPS,
            )
        else:
            log.warning("cv2.VideoCapture(%d) failed to open", _CAMERA_INDEX)

    def is_open(self) -> bool:
        return bool(self._cap and self._cap.isOpened())

    async def recv(self) -> VideoFrame:
        # Pace frames to _TARGET_FPS. Sleeping based on a monotonic deadline
        # avoids drift from cumulative scheduler jitter.
        now = time.monotonic()
        if self._next_deadline == 0.0:
            self._next_deadline = now + _FRAME_INTERVAL
        else:
            wait = self._next_deadline - now
            if wait > 0:
                await asyncio.sleep(wait)
            self._next_deadline += _FRAME_INTERVAL
            # If we fell badly behind (e.g. slow camera read), reset the
            # deadline so we don't burn through accumulated debt at full speed.
            if self._next_deadline < time.monotonic() - _FRAME_INTERVAL:
                self._next_deadline = time.monotonic() + _FRAME_INTERVAL

        pts, time_base = await self.next_timestamp()
        ok, frame_bgr = self._cap.read() if self.is_open() else (False, None)
        if not ok or frame_bgr is None:
            # Black frame keeps the track alive when the camera glitches —
            # the client sees blank video rather than a torn-down connection.
            import numpy as np

            frame_rgb = np.zeros((_TARGET_HEIGHT, _TARGET_WIDTH, 3), dtype="uint8")
        else:
            h, w = frame_bgr.shape[:2]
            if w > _TARGET_WIDTH or h > _TARGET_HEIGHT:
                # AREA is the cheap, high-quality downsampler — good for
                # 1080p -> 720p shrink. Skip the resize when the camera
                # already honored our requested 1280x720.
                frame_bgr = cv2.resize(
                    frame_bgr,
                    (_TARGET_WIDTH, _TARGET_HEIGHT),
                    interpolation=cv2.INTER_AREA,
                )
            frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)

        video_frame = VideoFrame.from_ndarray(frame_rgb, format="rgb24")
        video_frame.pts = pts
        video_frame.time_base = time_base if isinstance(time_base, Fraction) else Fraction(time_base)
        return video_frame

    def close(self) -> None:
        if self._cap is not None:
            try:
                self._cap.release()
            finally:
                self._cap = None

    # ---------------- camera parameter set/get -------------------------
    def get_param(self, name: str) -> Optional[float]:
        """Read one CAP_PROP value from the underlying cv2 capture."""
        if self._cap is None or name not in CAMERA_PROPS:
            return None
        cv_prop, _, _, _ = CAMERA_PROPS[name]
        try:
            return float(self._cap.get(cv_prop))
        except Exception:
            log.exception("camera get_param(%s) failed", name)
            return None

    def get_all_params(self) -> dict[str, float]:
        """Read every known CAP_PROP. Returns name → value. Skips props
        the driver reports as 0 AND known to be camera-specific (some
        drivers silently return 0 for unsupported properties)."""
        out: dict[str, float] = {}
        for name in CAMERA_PROPS:
            val = self.get_param(name)
            if val is not None:
                out[name] = val
        return out

    def set_param(self, name: str, value: float) -> Optional[float]:
        """Write one CAP_PROP and return the value the camera reports back
        after the set (which may be clamped or rejected). Returns None if
        the prop isn't recognized or the cv2 call failed."""
        if self._cap is None or name not in CAMERA_PROPS:
            return None
        cv_prop, _, lo, hi = CAMERA_PROPS[name]
        # Prefer the camera's real V4L2 range so we don't squeeze the value into
        # our advisory guess before the driver ever sees it (the bug behind
        # "the slider won't reach the shown limit"). Falls back to CAMERA_PROPS.
        real = get_camera_ranges().get(name)
        if real:
            lo, hi = real["min"], real["max"]
        clamped = max(lo, min(hi, value))
        try:
            self._cap.set(cv_prop, clamped)
            actual = float(self._cap.get(cv_prop))
            log.info("camera set %s=%s (actual=%s)", name, clamped, actual)
            return actual
        except Exception:
            log.exception("camera set_param(%s, %s) failed", name, value)
            return None


def _ensure_source_track() -> Optional[CameraTrack]:
    """Lazy singleton source track — only one cv2.VideoCapture handle is
    ever opened, since /dev/video0 can't be opened concurrently. New PCs
    get fresh proxies from the MediaRelay below."""
    global _track, _relay, _camera_ok
    with _track_lock:
        if _track is None:
            try:
                candidate = CameraTrack()
            except Exception as exc:
                log.exception("failed to construct CameraTrack: %s", exc)
                _camera_ok = False
                return None
            if not candidate.is_open():
                candidate.close()
                _camera_ok = False
                return None
            _track = candidate
            _relay = MediaRelay()
            _camera_ok = True
        return _track


def get_camera_track():
    """Return a fresh subscriber track from the MediaRelay, suitable for
    pc.addTrack(). Each call returns a NEW track wrapping the singleton
    cv2 source — fixes the wedge where re-adding the singleton track to
    a new PC produced a "live" but muted track with no RTP flow.

    Per aiortc docs (https://aiortc.readthedocs.io/en/latest/helpers.html):
        Subscribers can be added by calling .subscribe() and the relay
        will forward media to each one.

    Returns None when the camera failed to open.
    """
    source = _ensure_source_track()
    if source is None or _relay is None:
        return None
    return _relay.subscribe(source)


def is_available() -> bool:
    """True after a successful camera open; used by /health."""
    return _camera_ok


def probe() -> bool:
    """Open the camera once at startup so /health can answer accurately."""
    _ensure_source_track()
    return _camera_ok


# ----------------- module-level param helpers -----------------------
def get_camera_params() -> dict[str, float]:
    """Snapshot of every known camera parameter as a name → value dict.
    Used by the BIMS UI to populate slider defaults on first open."""
    source = _ensure_source_track()
    if source is None:
        return {}
    return source.get_all_params()


def set_camera_param(name: str, value: float) -> Optional[float]:
    """Adjust one camera parameter. Returns the value the camera reports
    back (which may differ from what was requested due to driver clamping).
    Returns None if the prop name is unknown or the set failed."""
    source = _ensure_source_track()
    if source is None:
        return None
    return source.set_param(name, value)


def known_param_names() -> list[str]:
    """List of friendly-name keys the UI can offer as sliders."""
    return list(CAMERA_PROPS.keys())


def _query_v4l2_ranges() -> dict[str, dict]:
    """Read the camera's real per-control ranges via `v4l2-ctl --list-ctrls`.

    Returns {friendly_name: {"min", "max", "step", "default"?}}. Best-effort:
    returns {} if v4l2-ctl isn't installed, the call fails, or nothing parses,
    in which case callers fall back to the advisory CAMERA_PROPS ranges. Linux
    only — on a dev box without v4l2-ctl this is simply a no-op.

    Example lines parsed:
        brightness 0x00980900 (int)    : min=-64 max=64 step=1 default=0 value=0
        white_balance_automatic 0x0098090c (bool)   : default=1 value=1
        exposure_time_absolute 0x009a0902 (int)  : min=1 max=5000 step=1 default=157 value=157 flags=inactive
    """
    if shutil.which("v4l2-ctl") is None:
        log.info("v4l2-ctl not found — using advisory camera ranges")
        return {}
    device = f"/dev/video{_CAMERA_INDEX}"
    try:
        proc = subprocess.run(
            ["v4l2-ctl", "--device", device, "--list-ctrls"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        log.exception("v4l2-ctl --list-ctrls failed")
        return {}

    line_re = re.compile(r"^\s*(\w+)\s+0x[0-9a-fA-F]+\s+\((\w+)\)\s*:\s*(.*)$")
    ranges: dict[str, dict] = {}
    for line in proc.stdout.splitlines():
        m = line_re.match(line)
        if not m:
            continue
        v4l2_name, ctype, rest = m.group(1), m.group(2), m.group(3)
        friendly = _V4L2_TO_FRIENDLY.get(v4l2_name)
        if friendly is None:
            continue
        fields = {k: int(v) for k, v in re.findall(r"(\w+)=(-?\d+)", rest)}
        if "min" in fields and "max" in fields:
            lo, hi = float(fields["min"]), float(fields["max"])
        elif ctype == "bool":
            lo, hi = 0.0, 1.0
        else:
            continue  # menu/button without explicit bounds — skip, use fallback
        entry: dict = {"min": lo, "max": hi, "step": float(fields.get("step", 1)) or 1.0}
        if "default" in fields:
            entry["default"] = float(fields["default"])
        ranges[friendly] = entry
    if ranges:
        log.info("v4l2 ranges resolved for %d controls", len(ranges))
    return ranges


def get_camera_ranges() -> dict[str, dict]:
    """Real editable range per known parameter, for the BIMS slider UI.

    Merges the camera's actual V4L2 ranges (preferred) with the advisory
    CAMERA_PROPS bounds (fallback). Each entry carries a `source` of "v4l2"
    (the camera's true range) or "fallback" (our guess) so the UI can label
    it. Cached after the first query — control ranges don't change at runtime.
    """
    global _v4l2_ranges_cache
    if _v4l2_ranges_cache is None:
        _v4l2_ranges_cache = _query_v4l2_ranges()
    out: dict[str, dict] = {}
    for name, (_, _, lo, hi) in CAMERA_PROPS.items():
        real = _v4l2_ranges_cache.get(name)
        if real:
            out[name] = {**real, "source": "v4l2"}
        else:
            out[name] = {"min": float(lo), "max": float(hi), "step": 1.0, "source": "fallback"}
    return out

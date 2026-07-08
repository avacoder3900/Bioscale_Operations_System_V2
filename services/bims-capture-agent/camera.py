"""USB camera bridge for the Pi station — aiortc VideoStreamTrack backed by OpenCV.

Opens a UVC camera via cv2.VideoCapture with MJPG. The device is selectable
(CAMERA_DEVICE env — index, /dev path, or case-insensitive name substring) and
a tuning preset is selectable (CAMERA_PROFILE env — 'default' or 'microscope').
If the camera isn't present, `is_available()` returns False and /health surfaces
camera_ok=False — the agent stays up so the scanner / LED can still work.

WebRTC frame budget on Pi 4: ~720p at 15 fps (see PRD §5.3). The WebRTC track is
downsampled to that ceiling in recv(); `grab_still()` returns a full-resolution
frame from the *same* capture handle for the timed microscope sequence (see
sequence.py), so the two never open the device twice.

Windows dev mode: opens with the DSHOW backend and a numeric index (name-based
device selection is not available through OpenCV on Windows — see _resolve_device).
"""

from __future__ import annotations

import asyncio
import glob
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from fractions import Fraction
from typing import Optional

import cv2
from aiortc import VideoStreamTrack
from aiortc.contrib.media import MediaRelay
from av import VideoFrame

log = logging.getLogger("bims-capture-agent.camera")

_IS_WINDOWS = sys.platform == "win32"

# Streaming ceiling + fps (PRD §5.3): the Pi 4 hardware H264 encoder can
# sustain 720p comfortably at ~10-15 fps while leaving CPU headroom for
# aiortc, the OS, and (eventually) inference. recv() downsamples anything
# larger than this ceiling for the live WebRTC track; the fps cap uses an
# asyncio.sleep on the remaining slot time so a slow camera doesn't bunch
# frames and a fast camera doesn't burn the CPU. Full-resolution stills for
# the microscope sequence bypass this ceiling via grab_still().
# Env-tunable per station (latency work): STREAM_WIDTH / STREAM_HEIGHT /
# STREAM_FPS — smaller/slower stream = less encode time = lower lag.
def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


_STREAM_WIDTH = _env_int("STREAM_WIDTH", 1280)
_STREAM_HEIGHT = _env_int("STREAM_HEIGHT", 720)
_TARGET_FPS = _env_int("STREAM_FPS", 15)
_FRAME_INTERVAL = 1.0 / max(1, _TARGET_FPS)

# Latency-bench hook: STAMP_FRAMES=1 embeds a millisecond timestamp as pixel
# blocks into every live frame (see latency_stamp.py) so a receiver on the
# same clock can measure capture→delivery latency through any transport.
_STAMP_FRAMES = os.environ.get("STAMP_FRAMES", "") == "1"

# CAMERA_PROFILE presets applied after the capture opens. 'default' keeps the
# historical 1280x720 behavior; 'microscope' targets the sensor's full
# 1920x1080, kills autofocus + auto-exposure (fixed optics → consistent timed
# stills), and applies no LIZA-style color pipeline (there is none in this
# module today — microscope optics have their own illumination and must not
# inherit the cartridge-rig color defaults if any are ever added here).
_CAMERA_PROFILE = os.environ.get("CAMERA_PROFILE", "default").strip().lower() or "default"
_PROFILE_DIMS: dict[str, tuple[int, int]] = {
    "default": (1280, 720),
    "microscope": (1920, 1080),
}

# Raw CAMERA_DEVICE spec (index "0", path "/dev/video2", or name "celestron").
# Resolved once, lazily, to an OpenCV-openable source (int index or str path).
_CAMERA_DEVICE_ENV = os.environ.get("CAMERA_DEVICE", "").strip()
_resolved_source: Optional[object] = None

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


# ----------------- device selection (CAMERA_DEVICE) -----------------
def _device_yields_frames(index: int) -> bool:
    """Open /dev/videoN briefly and check it actually reads a frame.

    Many UVC cameras expose a second /dev/videoN node (metadata / still-capture)
    that opens cleanly but never yields video frames. Used to prefer the lowest
    working node when resolving a device by name.
    """
    cap = cv2.VideoCapture(index)
    try:
        if not cap.isOpened():
            return False
        ok, frame = cap.read()
        return bool(ok and frame is not None)
    finally:
        cap.release()


def _resolve_device_by_name(substr: str) -> Optional[str]:
    """Map a case-insensitive name substring to a /dev/videoN path (Linux only).

    Scans /sys/class/video4linux/*/name. Prefers the lowest node index that
    yields frames (see _device_yields_frames). Returns None if nothing matches
    or when running on Windows (OpenCV can't enumerate DirectShow names).
    """
    if _IS_WINDOWS:
        log.warning(
            "CAMERA_DEVICE name matching (%r) is not available on Windows via "
            "OpenCV — use a numeric index instead; falling back to index 0",
            substr,
        )
        return None
    substr_l = substr.lower()
    matches: list[int] = []
    for name_path in sorted(glob.glob("/sys/class/video4linux/video*/name")):
        try:
            with open(name_path) as fh:
                cam_name = fh.read().strip()
        except OSError:
            continue
        if substr_l in cam_name.lower():
            node = os.path.basename(os.path.dirname(name_path))  # 'videoN'
            try:
                matches.append(int(node.replace("video", "")))
            except ValueError:
                continue
    if not matches:
        return None
    for n in sorted(matches):
        if _device_yields_frames(n):
            return f"/dev/video{n}"
    # None yielded a frame on probe — return the lowest so open() still tries.
    return f"/dev/video{min(matches)}"


def _resolve_device() -> object:
    """Resolve CAMERA_DEVICE to an OpenCV source: an int index or a str path.

    Accepts an integer index ("0"), a device path ("/dev/video2"), or a
    case-insensitive name substring ("celestron"). Unset → index 0 (the
    historical /dev/video0 default). A name that can't be resolved (or Windows,
    where name matching is unsupported) falls back to index 0.
    """
    spec = _CAMERA_DEVICE_ENV
    if not spec:
        return 0
    if spec.isdigit():
        return int(spec)
    if spec.startswith("/dev/") or (not _IS_WINDOWS and os.path.exists(spec)):
        return spec
    resolved = _resolve_device_by_name(spec)
    if resolved is not None:
        return resolved
    log.warning("CAMERA_DEVICE=%r unresolved — falling back to index 0", spec)
    return 0


def _camera_source() -> object:
    """Lazily resolve + cache the OpenCV source for CAMERA_DEVICE."""
    global _resolved_source
    if _resolved_source is None:
        _resolved_source = _resolve_device()
        log.info(
            "camera source resolved to %r (CAMERA_DEVICE=%r, profile=%s)",
            _resolved_source,
            _CAMERA_DEVICE_ENV or "<unset>",
            _CAMERA_PROFILE,
        )
    return _resolved_source


def _open_capture(source: object) -> "cv2.VideoCapture":
    """Open a capture with the platform-appropriate backend.

    Windows: DSHOW (fast startup, prop support). Linux: CAP_V4L2 explicitly —
    the auto backend resolves to GStreamer on Pi OS, which silently ignores
    FOURCC/width/height sets and pins UVC cams at their 640x480 default
    (verified on the Celestron: auto → 640x480, V4L2 → full 1920x1080).
    """
    if _IS_WINDOWS:
        return cv2.VideoCapture(source, cv2.CAP_DSHOW)
    return cv2.VideoCapture(source, cv2.CAP_V4L2)


def _profile_dims() -> tuple[int, int]:
    """Capture (not streaming) resolution for the active CAMERA_PROFILE."""
    return _PROFILE_DIMS.get(_CAMERA_PROFILE, _PROFILE_DIMS["default"])


class CameraTrack(VideoStreamTrack):
    """aiortc track that pulls frames off cv2.VideoCapture."""

    kind = "video"

    def __init__(self) -> None:
        super().__init__()
        source = _camera_source()
        cap_w, cap_h = _profile_dims()
        # Serializes cv2 reads between the WebRTC recv() (event loop) and
        # grab_still() (sequence thread) — cv2.VideoCapture.read() is not
        # thread-safe, and both share this single handle.
        self._read_lock = threading.Lock()
        self._cap = _open_capture(source)
        self._native_w = cap_w
        self._native_h = cap_h
        self._next_deadline = 0.0
        if self._cap.isOpened():
            self._cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
            self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, cap_w)
            self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, cap_h)
            self._cap.set(cv2.CAP_PROP_FPS, _TARGET_FPS)
            # Depth-1 capture buffer: read() always hands back the NEWEST
            # frame. The OpenCV default (~4 frames) serves stale frames,
            # which reads as ~250ms of extra display lag at 15 fps.
            self._cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            if _CAMERA_PROFILE == "microscope":
                # Fixed optics: disable autofocus + auto-exposure so a timed
                # run of stills is consistent shot-to-shot. Values remain live-
                # adjustable via set_param() from the /capture tuning sliders.
                self._cap.set(cv2.CAP_PROP_AUTOFOCUS, 0)
                self._cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 1)  # 1 = manual (UVC)
            self._native_w = int(self._cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or cap_w
            self._native_h = int(self._cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or cap_h
            log.info(
                "camera opened: source=%r %dx%d native, profile=%s, stream ceiling "
                "%dx%d @ %d fps",
                source,
                self._native_w,
                self._native_h,
                _CAMERA_PROFILE,
                _STREAM_WIDTH,
                _STREAM_HEIGHT,
                _TARGET_FPS,
            )
        else:
            log.warning("cv2.VideoCapture(%r) failed to open", source)

    def is_open(self) -> bool:
        return bool(self._cap and self._cap.isOpened())

    def grab_still(self) -> Optional["object"]:
        """Return a fresh full-resolution BGR frame from the shared capture.

        Reads one frame under the same lock the WebRTC recv() uses, so the
        sequence engine and the live stream never call cv2.read() concurrently
        (unsafe) and only one cv2.VideoCapture handle is ever opened. At the
        sequence interval (seconds) this "steals" a single frame from the live
        track — invisible at 15 fps. Returns the un-downsampled frame (full
        1920x1080 under the microscope profile); returns None if the read fails.
        """
        if self._cap is None:
            return None
        with self._read_lock:
            if not self.is_open():
                return None
            ok, frame_bgr = self._cap.read()
        if not ok or frame_bgr is None:
            return None
        return frame_bgr

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
        if self.is_open():
            with self._read_lock:
                ok, frame_bgr = self._cap.read()
        else:
            ok, frame_bgr = False, None
        if not ok or frame_bgr is None:
            # Black frame keeps the track alive when the camera glitches —
            # the client sees blank video rather than a torn-down connection.
            import numpy as np

            frame_rgb = np.zeros((_STREAM_HEIGHT, _STREAM_WIDTH, 3), dtype="uint8")
        else:
            h, w = frame_bgr.shape[:2]
            if w > _STREAM_WIDTH or h > _STREAM_HEIGHT:
                # AREA is the cheap, high-quality downsampler — good for
                # 1080p -> 720p shrink. Skip the resize when the camera
                # already fits the streaming ceiling.
                frame_bgr = cv2.resize(
                    frame_bgr,
                    (_STREAM_WIDTH, _STREAM_HEIGHT),
                    interpolation=cv2.INTER_AREA,
                )
            if _STAMP_FRAMES:
                from latency_stamp import stamp_frame

                stamp_frame(frame_bgr)
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


def grab_still() -> Optional["object"]:
    """Full-resolution BGR frame from the shared camera, or None if unavailable.

    Used by the sequence engine (sequence.py) for timed microscope stills. Shares
    the singleton capture handle with the WebRTC track — no second device open.
    """
    source = _ensure_source_track()
    if source is None:
        return None
    return source.grab_still()


def profile() -> str:
    """Active CAMERA_PROFILE ('default' or 'microscope'). For /health + logging."""
    return _CAMERA_PROFILE


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
    # Derive the V4L2 node from the resolved CAMERA_DEVICE source: an int index
    # → /dev/videoN, an explicit /dev path passes through, anything else → the
    # historical /dev/video0.
    src = _camera_source()
    if isinstance(src, int):
        device = f"/dev/video{src}"
    elif isinstance(src, str) and src.startswith("/dev/"):
        device = src
    else:
        device = "/dev/video0"
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

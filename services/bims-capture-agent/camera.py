"""USB camera bridge for the Pi station — aiortc VideoStreamTrack backed by OpenCV.

Opens a UVC camera via cv2.VideoCapture with MJPG. The device is selectable
(CAMERA_DEVICE env — index, /dev path, or case-insensitive name substring) and
a tuning preset is selectable (CAMERA_PROFILE env — 'default' or 'microscope').
If the camera isn't present, `is_available()` returns False and /health surfaces
camera_ok=False — the agent stays up so the scanner / LED can still work.

A station may have several cameras physically attached (e.g. an overview cam
plus a Celestron microscope) — describe them in the CAMERAS env var and switch
between them at runtime with switch_camera(). Exactly ONE is open at a time:
the device can't be opened concurrently, and dual JPEG encode is what browned
out a station PSU (see preview.py + the single-encoder rule). CAMERAS unset is
the historical single-camera behavior, synthesized from CAMERA_DEVICE /
CAMERA_PROFILE so pre-existing stations need no config change.

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
import json
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

# CAMERAS: optional JSON array describing every camera attached to this station:
#   [{"id":"overview","role":"overview","label":"Overview",
#     "device":"/dev/v4l/by-id/usb-HD_USB_Camera_HD_USB_Camera-video-index0",
#     "profile":"default"},
#    {"id":"scope","role":"microscope","label":"Microscope",
#     "device":"celestron","profile":"microscope","sequence":true}]
#
# `device` takes the same spec as CAMERA_DEVICE (index / /dev path / name
# substring). Prefer a /dev/v4l/by-id/... path: the kernel already keys those by
# USB vendor+product, so they stay correct across reboots and re-plugging even
# though the /dev/videoN numbering does not. Name substrings ("celestron") work
# too and are resolved by _resolve_device_by_name, which skips the phantom
# metadata node UVC cameras expose alongside the real one.
_CAMERAS_ENV = os.environ.get("CAMERAS", "").strip()


def _normalize_camera(raw: object, index: int) -> Optional[dict]:
    """Coerce one CAMERAS entry into the internal spec shape, or None if junk."""
    if not isinstance(raw, dict):
        log.warning("CAMERAS[%d] is not an object — ignoring", index)
        return None
    cam_id = str(raw.get("id") or "").strip() or f"cam{index}"
    profile = str(raw.get("profile") or "default").strip().lower() or "default"
    if profile not in _PROFILE_DIMS:
        log.warning("camera %r: unknown profile %r — using 'default'", cam_id, profile)
        profile = "default"
    default_role = "microscope" if profile == "microscope" else "overview"
    role = str(raw.get("role") or default_role).strip().lower() or default_role
    device = raw.get("device")
    return {
        "id": cam_id,
        "role": role,
        "label": str(raw.get("label") or cam_id),
        "device": ("" if device is None else str(device).strip()),
        "profile": profile,
        # The timed grid-sequence engine only makes sense through fixed optics,
        # so it defaults on for microscope-role cameras and off for the rest.
        "sequence": bool(raw.get("sequence", role == "microscope")),
    }


def _load_camera_specs() -> list[dict]:
    """Parse CAMERAS, or synthesize the historical single-camera arrangement.

    The fallback keeps sequence=True regardless of profile: the agent has always
    advertised the sequence capability unconditionally, and silently revoking it
    from a default-profile station that uses timed runs would be a regression.
    Per-camera gating therefore only applies once CAMERAS is explicitly set.
    """
    if _CAMERAS_ENV:
        try:
            parsed = json.loads(_CAMERAS_ENV)
        except ValueError:
            log.exception("CAMERAS is not valid JSON — falling back to CAMERA_DEVICE")
            parsed = None
        if isinstance(parsed, list):
            specs: list[dict] = []
            seen: set[str] = set()
            for i, raw in enumerate(parsed):
                spec = _normalize_camera(raw, i)
                if spec is None:
                    continue
                if spec["id"] in seen:
                    log.warning("duplicate camera id %r in CAMERAS — ignoring", spec["id"])
                    continue
                seen.add(spec["id"])
                specs.append(spec)
            if specs:
                return specs
            log.warning("CAMERAS yielded no usable entries — falling back to CAMERA_DEVICE")
        elif parsed is not None:
            log.warning("CAMERAS must be a JSON array — falling back to CAMERA_DEVICE")
    is_scope = _CAMERA_PROFILE == "microscope"
    return [
        {
            "id": "microscope" if is_scope else "default",
            "role": "microscope" if is_scope else "overview",
            "label": "Microscope" if is_scope else "Camera",
            "device": _CAMERA_DEVICE_ENV,
            "profile": _CAMERA_PROFILE,
            "sequence": True,
        }
    ]


_CAMERA_SPECS: list[dict] = _load_camera_specs()
# Which camera is currently open. In-memory only: env is read at import and
# systemd re-reads EnvironmentFile on restart, so a restart intentionally
# returns the station to its configured default.
_active_camera_id: str = _CAMERA_SPECS[0]["id"]


def _camera_spec(camera_id: Optional[str] = None) -> dict:
    """The spec for `camera_id`, or the active one. Falls back to the first."""
    target = camera_id or _active_camera_id
    for spec in _CAMERA_SPECS:
        if spec["id"] == target:
            return spec
    return _CAMERA_SPECS[0]

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


def _resolve_device(spec: Optional[str] = None) -> object:
    """Resolve a device spec to an OpenCV source: an int index or a str path.

    Accepts an integer index ("0"), a device path ("/dev/video2", or a stable
    "/dev/v4l/by-id/usb-..." symlink), or a case-insensitive name substring
    ("celestron"). Empty/unset → index 0 (the historical /dev/video0 default).
    A name that can't be resolved (or Windows, where name matching is
    unsupported) falls back to index 0.

    `spec` defaults to the active camera's device so existing callers that
    passed nothing keep resolving the camera that is actually open.
    """
    if spec is None:
        spec = _camera_spec()["device"]
    spec = (spec or "").strip()
    if not spec:
        return 0
    if spec.isdigit():
        return int(spec)
    if spec.startswith("/dev/") or (not _IS_WINDOWS and os.path.exists(spec)):
        return spec
    resolved = _resolve_device_by_name(spec)
    if resolved is not None:
        return resolved
    log.warning("camera device spec %r unresolved — falling back to index 0", spec)
    return 0


def _camera_source() -> object:
    """Lazily resolve + cache the OpenCV source for the ACTIVE camera.

    Cleared by switch_camera() so the next resolve targets the new device.
    """
    global _resolved_source
    if _resolved_source is None:
        spec = _camera_spec()
        _resolved_source = _resolve_device(spec["device"])
        log.info(
            "camera source resolved to %r (camera=%s, device=%r, profile=%s)",
            _resolved_source,
            spec["id"],
            spec["device"] or "<unset>",
            spec["profile"],
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


def _profile_dims(profile: Optional[str] = None) -> tuple[int, int]:
    """Capture (not streaming) resolution for a profile — active one by default."""
    if profile is None:
        profile = _camera_spec()["profile"]
    return _PROFILE_DIMS.get(profile, _PROFILE_DIMS["default"])


class CameraTrack(VideoStreamTrack):
    """aiortc track that pulls frames off cv2.VideoCapture."""

    kind = "video"

    def __init__(self, source: Optional[object] = None, profile: Optional[str] = None) -> None:
        super().__init__()
        # Both default to the active camera. Passing them explicitly is what
        # lets switch_camera() build a track for a DIFFERENT camera without
        # mutating module state until the new handle is known-good.
        if source is None:
            source = _camera_source()
        if profile is None:
            profile = _camera_spec()["profile"]
        self._profile = profile
        # LIVE/STILL SPLIT: the shared handle runs at the STREAM resolution so
        # the live pipeline (decode → encode) costs the same as a plain webcam
        # (~0.9 MP/frame at 720p, vs 2 MP when we captured 1080p and shrank
        # every frame). grab_still() renegotiates the sensor to the profile's
        # full still resolution per shot and restores — ~100-300 ms per still,
        # invisible at multi-second sequence intervals.
        still_w, still_h = _profile_dims(profile)
        cap_w = min(still_w, _STREAM_WIDTH)
        cap_h = min(still_h, _STREAM_HEIGHT)
        self._still_w, self._still_h = still_w, still_h
        self._live_w, self._live_h = cap_w, cap_h
        # >0 while a sequence run holds the sensor at still resolution —
        # renegotiation on this camera costs ~4s, so we switch once per RUN,
        # not per shot. recv()'s resize branch downsizes live frames meanwhile.
        self._still_mode = 0
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
            if profile == "microscope":
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
                profile,
                _STREAM_WIDTH,
                _STREAM_HEIGHT,
                _TARGET_FPS,
            )
        else:
            log.warning("cv2.VideoCapture(%r) failed to open", source)

    def is_open(self) -> bool:
        return bool(self._cap and self._cap.isOpened())

    def grab_live(self) -> Optional["object"]:
        """One fresh frame at the LIVE (stream) resolution — no renegotiation.

        Used by the MJPEG preview: cheap, safe to call every frame.
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

    def enter_still_mode(self) -> None:
        """Hold the sensor at the profile's STILL resolution (sequence run).

        Renegotiation costs ~4s on the Celestron, so a run switches once at
        start and once at end instead of per shot. Nested calls refcount.
        """
        if (self._still_w, self._still_h) == (self._live_w, self._live_h):
            return
        with self._read_lock:
            if not self.is_open():
                return
            self._still_mode += 1
            if self._still_mode == 1:
                self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, self._still_w)
                self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self._still_h)
                self._cap.read()  # flush the transition frame

    def exit_still_mode(self) -> None:
        """Restore the LIVE (stream) resolution once no run holds still mode."""
        if (self._still_w, self._still_h) == (self._live_w, self._live_h):
            return
        with self._read_lock:
            if not self.is_open() or self._still_mode == 0:
                return
            self._still_mode -= 1
            if self._still_mode == 0:
                self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, self._live_w)
                self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self._live_h)
                self._cap.read()  # flush back

    def grab_still(self) -> Optional["object"]:
        """Return a fresh FULL-RESOLUTION BGR frame from the shared capture.

        Inside still mode (sequence runs) this is a plain read — the sensor is
        already at still resolution. Outside it, it renegotiates for a single
        shot (slow on this camera: ~4s round trip) and restores — acceptable
        for one-off grabs, never for per-frame use (that's grab_live()).
        """
        if self._cap is None:
            return None
        with self._read_lock:
            if not self.is_open():
                return None
            in_still_mode = self._still_mode > 0
            needs_switch = (
                not in_still_mode
                and (self._still_w, self._still_h) != (self._live_w, self._live_h)
            )
            if needs_switch:
                self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, self._still_w)
                self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self._still_h)
                self._cap.read()  # flush the transition frame
            ok, frame_bgr = self._cap.read()
            if needs_switch:
                self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, self._live_w)
                self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self._live_h)
                self._cap.read()  # flush back
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
        # The open-check must happen INSIDE the lock: checking outside it and
        # dereferencing inside leaves a window where close() can release the
        # handle in between (switch_camera closes live handles).
        with self._read_lock:
            if self._cap is not None and self._cap.isOpened():
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
        """Release the capture handle.

        Takes _read_lock: calling release() while another thread sits inside
        self._cap.read() is a use-after-free on the V4L2 capture object inside
        OpenCV — not a Python exception anything can catch. That was latent
        while close() only ever ran on a failed open; switch_camera() closes
        live handles, so the lock is now load-bearing.
        """
        with self._read_lock:
            if self._cap is not None:
                try:
                    self._cap.release()
                finally:
                    self._cap = None

    # ---------------- camera parameter set/get -------------------------
    def get_param(self, name: str) -> Optional[float]:
        """Read one CAP_PROP value from the underlying cv2 capture."""
        if name not in CAMERA_PROPS:
            return None
        cv_prop, _, _, _ = CAMERA_PROPS[name]
        # Same lock as the reads — a cv2 get() against a handle close() is
        # releasing is the same use-after-free as a read().
        with self._read_lock:
            if self._cap is None:
                return None
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
        if name not in CAMERA_PROPS:
            return None
        cv_prop, _, lo, hi = CAMERA_PROPS[name]
        # Prefer the camera's real V4L2 range so we don't squeeze the value into
        # our advisory guess before the driver ever sees it (the bug behind
        # "the slider won't reach the shown limit"). Falls back to CAMERA_PROPS.
        # Resolved BEFORE taking _read_lock: on a cold cache this shells out to
        # v4l2-ctl for up to 5s, which would stall every reader if held.
        real = get_camera_ranges().get(name)
        if real:
            lo, hi = real["min"], real["max"]
        clamped = max(lo, min(hi, value))
        with self._read_lock:
            if self._cap is None:
                return None
            try:
                self._cap.set(cv_prop, clamped)
                actual = float(self._cap.get(cv_prop))
            except Exception:
                log.exception("camera set_param(%s, %s) failed", name, value)
                return None
        log.info("camera set %s=%s (actual=%s)", name, clamped, actual)
        return actual


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


def list_cameras() -> list[dict]:
    """Every configured camera, with the active one flagged. For /health + UI."""
    return [
        {
            "id": spec["id"],
            "role": spec["role"],
            "label": spec["label"],
            "profile": spec["profile"],
            "sequence": spec["sequence"],
            "active": spec["id"] == _active_camera_id,
        }
        for spec in _CAMERA_SPECS
    ]


def active_camera_id() -> str:
    """Id of the camera currently open."""
    return _active_camera_id


def active_camera() -> dict:
    """Spec of the camera currently open (id/role/label/profile/sequence)."""
    spec = _camera_spec()
    return {
        "id": spec["id"],
        "role": spec["role"],
        "label": spec["label"],
        "profile": spec["profile"],
        "sequence": spec["sequence"],
    }


def switch_camera(camera_id: str) -> tuple[bool, str]:
    """Hand the single capture handle over to `camera_id`. Returns (ok, message).

    Exactly one camera is open at a time — the device can't be opened twice,
    and two simultaneous JPEG encoders is the load that browned out a station
    PSU. The new camera is opened BEFORE the old one is closed so a failed
    switch leaves the station exactly as it was rather than off the air; the
    two handles overlap only for the duration of the open, and only one of
    them is ever read.

    Callers must reject this while a sequence run is in flight — swapping
    optics mid-run would produce a split-optics set under one sequenceId with
    nothing recording which camera shot which frame.
    """
    global _track, _relay, _camera_ok, _resolved_source, _v4l2_ranges_cache
    global _active_camera_id

    target: Optional[dict] = None
    for spec in _CAMERA_SPECS:
        if spec["id"] == camera_id:
            target = spec
            break
    if target is None:
        return False, f"unknown camera {camera_id!r}"

    with _track_lock:
        if camera_id == _active_camera_id and _track is not None and _track.is_open():
            return True, "already active"
        previous_id = _active_camera_id
        previous = _track
        source = _resolve_device(target["device"])
        # Two specs can legitimately resolve to the same node (e.g. an operator
        # defined two profiles over one lens). Opening it twice would fail, so
        # release first and accept the brief gap.
        if previous is not None and _resolved_source is not None and source == _resolved_source:
            previous.close()
            previous = None
        try:
            candidate: Optional[CameraTrack] = CameraTrack(
                source=source, profile=target["profile"]
            )
        except Exception:
            log.exception("switch_camera(%s): failed to construct track", camera_id)
            candidate = None
        if candidate is not None and not candidate.is_open():
            candidate.close()
            candidate = None
        if candidate is None:
            if previous is not None:
                return False, f"camera {camera_id!r} failed to open"
            # The old handle is already gone (same-device case) — the station
            # has no camera now, so report it rather than claiming success.
            _track = None
            _camera_ok = False
            return False, f"camera {camera_id!r} failed to open and the previous one was released"
        if previous is not None:
            previous.close()
        _track = candidate
        # Fresh relay: existing WebRTC subscribers are bound to the old track
        # and would starve. Browsers recover with webrtc_stop + a new offer;
        # the MJPEG station view needs nothing, since preview.py calls the
        # module-level grab_live() per frame rather than holding a track.
        _relay = MediaRelay()
        _camera_ok = True
        _active_camera_id = camera_id
        _resolved_source = source
        # Control ranges are per-DEVICE, but this cache is per-process and
        # set_param() clamps against it — leaving it stale would silently
        # squeeze values into the previous camera's range before the driver
        # ever saw them. Callers should re-warm it off the event loop.
        _v4l2_ranges_cache = None

    log.info(
        "camera switched: %s -> %s (source=%r, profile=%s)",
        previous_id,
        camera_id,
        source,
        target["profile"],
    )
    return True, "ok"


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

    Used by the sequence engine (sequence.py) for timed microscope stills —
    renegotiates the sensor to still resolution per shot (live/still split).
    Do NOT call per-frame; use grab_live() for previews.
    """
    source = _ensure_source_track()
    if source is None:
        return None
    return source.grab_still()


def grab_live() -> Optional["object"]:
    """One frame at the live stream resolution — cheap, preview-safe."""
    source = _ensure_source_track()
    if source is None:
        return None
    return source.grab_live()


def enter_still_mode() -> None:
    """Hold the sensor at still resolution for a sequence run (refcounted)."""
    source = _ensure_source_track()
    if source is not None:
        source.enter_still_mode()


def exit_still_mode() -> None:
    """Release the still-resolution hold; live resolution restores at zero."""
    source = _ensure_source_track()
    if source is not None:
        source.exit_still_mode()


def profile() -> str:
    """Active camera's profile ('default' or 'microscope'). For /health + logging."""
    return _camera_spec()["profile"]


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

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

_track_lock = threading.Lock()
_track: Optional["CameraTrack"] = None
_relay: Optional[MediaRelay] = None
_camera_ok = False


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

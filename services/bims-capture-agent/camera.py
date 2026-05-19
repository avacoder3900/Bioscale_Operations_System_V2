"""USB camera bridge for the Pi station — aiortc VideoStreamTrack backed by OpenCV.

Opens /dev/video0 via cv2.VideoCapture with MJPG at 1280x720. If the camera
isn't present, `is_available()` returns False and /health surfaces
camera_ok=False — the agent stays up so the scanner / LED can still work.

WebRTC frame budget on Pi 4: ~720p at 15 fps (see PRD §5.3). Downsampling
to that ceiling and the recv() fps cap live in this module; task #14 hardens
both paths.
"""

from __future__ import annotations

import logging
import threading
from fractions import Fraction
from typing import Optional

import cv2
from aiortc import VideoStreamTrack
from av import VideoFrame

log = logging.getLogger("bims-capture-agent.camera")

_CAMERA_INDEX = 0
_TARGET_WIDTH = 1280
_TARGET_HEIGHT = 720
_TARGET_FPS = 15

_track_lock = threading.Lock()
_track: Optional["CameraTrack"] = None
_camera_ok = False


class CameraTrack(VideoStreamTrack):
    """aiortc track that pulls frames off cv2.VideoCapture."""

    kind = "video"

    def __init__(self) -> None:
        super().__init__()
        self._cap = cv2.VideoCapture(_CAMERA_INDEX)
        if self._cap.isOpened():
            self._cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
            self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, _TARGET_WIDTH)
            self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, _TARGET_HEIGHT)
            self._cap.set(cv2.CAP_PROP_FPS, _TARGET_FPS)
            log.info(
                "camera opened: %dx%d @ %d fps",
                int(self._cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
                int(self._cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
                int(self._cap.get(cv2.CAP_PROP_FPS) or _TARGET_FPS),
            )
        else:
            log.warning("cv2.VideoCapture(%d) failed to open", _CAMERA_INDEX)

    def is_open(self) -> bool:
        return bool(self._cap and self._cap.isOpened())

    async def recv(self) -> VideoFrame:
        pts, time_base = await self.next_timestamp()
        ok, frame_bgr = self._cap.read() if self.is_open() else (False, None)
        if not ok or frame_bgr is None:
            # Black frame keeps the track alive when the camera glitches —
            # the client sees blank video rather than a torn-down connection.
            import numpy as np

            frame_rgb = np.zeros((_TARGET_HEIGHT, _TARGET_WIDTH, 3), dtype="uint8")
        else:
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


def get_camera_track() -> Optional[CameraTrack]:
    """Lazy singleton — first call opens the camera, later calls reuse it."""
    global _track, _camera_ok
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
            _camera_ok = True
        return _track


def is_available() -> bool:
    """True after a successful get_camera_track(); used by /health."""
    return _camera_ok


def probe() -> bool:
    """Open the camera once at startup so /health can answer accurately."""
    get_camera_track()
    return _camera_ok

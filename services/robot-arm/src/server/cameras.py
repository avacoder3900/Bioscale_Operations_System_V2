"""Live camera capture and MJPEG streaming for remote arm observation.

Why this module exists
----------------------
Teleop and replay are driven over the serial bus, which
:class:`~src.server.sessions.SessionManager` guards with a single-session
lock. Video is deliberately kept *outside* that lock: a camera is a
``/dev/videoN`` character device, not a BusLinker, so streaming contends
with nothing. That is the whole point — the feed must stay live *while*
the arm is moving, which is exactly when the operator needs to see it.

Device selection
----------------
Do not trust a fixed device index. On arm-pi the RealSense D415 exposes
six V4L2 nodes and only one of them carries colour:

    /dev/video0  Z16   16-bit depth
    /dev/video2  GREY/UYVY/Y8I  infrared stereo
    /dev/video4  YUYV  <- colour, the one we want

``EXTERNAL_CAM_INDEX=0`` in the shipped ``.env`` therefore pointed at the
*depth* node and would have produced a black or garbage feed. Worse,
``/dev/v4l/by-id`` has no symlink for the colour node at all (it maps
index0->video0, index1->video5, index2->video2, index3->video3 and skips
video4), so there is no stable path to hardcode either, and the numbering
can shift across replug or reboot.

So we resolve the node *by capability* at open time: enumerate the V4L2
nodes and pick the first that advertises a colour capture format. This
survives renumbering and needs neither a udev rule nor root.

Fan-out
-------
A V4L2 capture device cannot be opened twice — a second reader gets
EBUSY. One :class:`_CameraWorker` thread per camera therefore owns the
``VideoCapture`` and publishes the newest frame into a single slot that
any number of HTTP subscribers read. Slow clients cannot stall the
pipeline; they simply skip frames, which is the correct behaviour for a
live view where latency matters more than completeness.

Lazy encoding (2026-10-21)
--------------------------
The capture thread used to colour-convert and JPEG-encode EVERY frame the
camera delivered, whether or not anyone was watching. At 1920x1080 that is
~25 ms per frame, i.e. most of a core at 30 fps, and the fanless Pi 5 sat
at 80-85 °C with the firmware's soft temperature limit active. Now the
thread only copies the raw frame (YUYV straight from the driver when
OpenCV lets us skip its RGB conversion) into the slot; the YUYV->BGR
conversion and the JPEG happen on first use, once per frame, cached on
the frame object. Consumers pay for exactly the frames they take:
nobody watching = a few percent of a core; one BIMS viewer pulling
``snapshot.jpg?w=960`` at 5 fps = five small encodes a second; AprilTag
detection = one full-quality encode per detect.
"""

from __future__ import annotations

import os
import re
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

try:  # pragma: no cover - exercised on the Pi, not in CI
    import cv2
except ImportError:  # pragma: no cover
    cv2 = None  # type: ignore[assignment]

# V4L2 FOURCCs that represent a usable *colour* stream. Depth (Z16) and
# the infrared nodes (GREY, Y8I, UYVY on the IR pair) are excluded on
# purpose — see the module docstring.
_COLOUR_FORMATS = ("YUYV", "MJPG", "RGB3", "BGR3", "NV12", "YU12")

# Frames older than this are considered stale: the capture thread has
# stopped producing (camera unplugged, USB reset, driver wedged). We
# surface that to callers rather than serving a frozen image, because a
# frozen frame during arm motion is actively dangerous to trust.
_PEEK_TTL_S = 30.0
_STALE_AFTER_S = 5.0


@dataclass
class CameraSpec:
    """Static description of one camera we intend to stream."""

    name: str
    device: str | None = None  # None => resolve by capability at open time
    width: int = 640
    height: int = 480
    fps: int = 30
    quality: int = 80  # JPEG quality; 80 ~= 22 KB/frame at 640x480 on the D415
    match: str | None = None  # substring of the V4L2 card name, e.g. "RealSense"


class _Frame:
    """One captured frame. Colour conversion and JPEG encoding are deferred
    to first use and cached, so an unwatched camera costs almost nothing
    and N viewers of one frame share one encode (see module docstring)."""

    __slots__ = ("_raw", "_fmt", "_quality", "seq", "captured_at", "shape", "_lock", "_bgr", "_jpeg")

    def __init__(self, raw: Any, fmt: str, quality: int, seq: int, captured_at: float, shape: tuple[int, int]) -> None:
        self._raw = raw
        self._fmt = fmt  # "bgr" or "yuyv"
        self._quality = quality
        self.seq = seq
        self.captured_at = captured_at
        self.shape = shape  # (width, height)
        self._lock = threading.Lock()
        self._bgr: Any = None
        self._jpeg: bytes | None = None

    def bgr(self) -> Any:
        """The frame as a BGR array (converted once)."""
        with self._lock:
            if self._bgr is None:
                if self._fmt == "yuyv":
                    raw = self._raw
                    w, h = self.shape
                    if raw.ndim == 2:  # (h, 2w) bytes -> (h, w, 2)
                        raw = raw.reshape(h, w, 2)
                    self._bgr = cv2.cvtColor(raw, cv2.COLOR_YUV2BGR_YUYV)
                else:
                    self._bgr = self._raw
                self._raw = None  # the raw copy is no longer needed
            return self._bgr

    @property
    def jpeg(self) -> bytes:
        """Full-size JPEG at the camera's configured quality (encoded once)."""
        with self._lock:
            cached = self._jpeg
        if cached is not None:
            return cached
        img = self.bgr()
        ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), int(self._quality)])
        data = buf.tobytes() if ok else b""
        with self._lock:
            if self._jpeg is None:
                self._jpeg = data
            return self._jpeg

    def encode(self, q: int | None = None, w: int | None = None) -> bytes:
        """A lighter JPEG straight from the BGR frame (no decode of the
        full JPEG first): ``q`` 30..95, ``w`` 160..1920 = max width, only ever
        downscaled. Not cached — each viewer size is a one-off."""
        if q is None and w is None:
            return self.jpeg
        img = self.bgr()
        width, height = self.shape
        if w is not None:
            target = max(160, min(1920, int(w)))
            if target < width:
                img = cv2.resize(img, (target, max(1, round(height * target / width))), interpolation=cv2.INTER_AREA)
        quality = max(30, min(95, int(q))) if q is not None else int(self._quality)
        ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
        return buf.tobytes() if ok else self.jpeg


def _v4l2_nodes() -> list[tuple[str, str]]:
    """Return ``[(device, card_name), ...]`` for every V4L2 node present.

    Read from sysfs rather than shelling out, so this works even on a
    stripped image where ``v4l2-ctl`` is absent.
    """
    nodes: list[tuple[str, str]] = []
    root = Path("/sys/class/video4linux")
    if not root.is_dir():
        return nodes
    for entry in sorted(root.iterdir(), key=lambda p: _natural_key(p.name)):
        device = f"/dev/{entry.name}"
        try:
            card = (entry / "name").read_text(encoding="utf-8").strip()
        except OSError:
            card = ""
        nodes.append((device, card))
    return nodes


def _natural_key(name: str) -> tuple[int, str]:
    """Sort ``video2`` before ``video10`` (lexical sort gets this wrong)."""
    match = re.search(r"(\d+)$", name)
    return (int(match.group(1)) if match else 1 << 30, name)


def _node_formats(device: str) -> list[str]:
    """Return the FOURCCs a node advertises, via ``v4l2-ctl`` when available.

    Returns an empty list if ``v4l2-ctl`` is missing or errors, which the
    caller treats as "unknown" and falls back to probing with OpenCV.
    """
    try:
        out = subprocess.run(
            ["v4l2-ctl", "-d", device, "--list-formats"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    # Lines look like: "	[0]: 'YUYV' (YUYV 4:2:2)"
    return re.findall(r"'(\w{4})'", out)


def resolve_device(spec: CameraSpec, probe: bool = True) -> str | None:
    """Pick the V4L2 node for ``spec``, preferring an explicit device.

    Order of preference:

    1. ``spec.device`` if it exists on disk (operator override wins).
    2. The first node advertising a colour FOURCC, optionally filtered by
       ``spec.match`` against the V4L2 card name.
    3. ``None`` — no camera. Callers surface this rather than guessing.

    ``probe=False`` (status reporting) stops after sysfs + v4l2-ctl and
    never opens a node with OpenCV: a status poll must not power the
    sensor, however often BIMS asks.
    """
    if spec.device and Path(spec.device).exists():
        return spec.device

    candidates = _v4l2_nodes()
    if spec.match:
        needle = spec.match.lower()
        candidates = [(d, c) for d, c in candidates if needle in c.lower()]

    # Prefer nodes we can positively identify as colour.
    for device, _card in candidates:
        formats = _node_formats(device)
        if any(fmt in _COLOUR_FORMATS for fmt in formats):
            return device

    # v4l2-ctl unavailable: fall back to probing each node with OpenCV and
    # keeping the first that yields a real 3-channel frame.
    if probe and cv2 is not None:
        for device, _card in candidates:
            if _probe_colour(device):
                return device
    return None


def _probe_colour(device: str) -> bool:
    """Best-effort check that ``device`` yields a 3-channel colour frame."""
    cap = None
    try:
        cap = cv2.VideoCapture(device, cv2.CAP_V4L2)
        if not cap.isOpened():
            return False
        ok, frame = cap.read()
        return (
            bool(ok) and frame is not None and frame.ndim == 3 and frame.shape[2] == 3
        )
    except Exception:
        return False
    finally:
        if cap is not None:
            cap.release()


class _CameraWorker:
    """Owns one ``VideoCapture`` and republishes frames as JPEG.

    The thread runs for as long as the camera is enabled. Subscribers do
    not touch the capture device; they only read :attr:`latest`.
    """

    def __init__(self, spec: CameraSpec) -> None:
        self.spec = spec
        self._lock = threading.Lock()
        self._latest: _Frame | None = None
        self._seq = 0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._device: str | None = None
        self._error: str | None = None
        self._started_at: float | None = None
        # Device the spec resolves to, found WITHOUT starting the worker, so
        # status can say "idle at /dev/video4" instead of "device null"
        # before the first viewer (2026-10-22: that null was misread as a
        # USB dropout). Re-checked every _PEEK_TTL_S while nothing was found,
        # so a camera plugged in later shows up.
        self._peeked: str | None = None
        self._peeked_at: float | None = None

    # -- lifecycle ---------------------------------------------------

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        if cv2 is None:
            self._error = "opencv-python is not installed on this host"
            return
        self._stop.clear()
        self._error = None
        self._started_at = time.time()
        self._thread = threading.Thread(
            target=self._run,
            name=f"camera-{self.spec.name}",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=3.0)
        self._thread = None
        with self._lock:
            self._latest = None

    # -- capture loop ------------------------------------------------

    def _open(self) -> Any | None:
        device = resolve_device(self.spec)
        if device is None:
            self._error = "no colour capture node found" + (
                f" matching {self.spec.match!r}" if self.spec.match else ""
            )
            return None
        cap = cv2.VideoCapture(device, cv2.CAP_V4L2)
        if not cap.isOpened():
            self._error = f"{device} could not be opened (in use by another process?)"
            cap.release()
            return None
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.spec.width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.spec.height)
        cap.set(cv2.CAP_PROP_FPS, self.spec.fps)
        # Keep the driver queue shallow. Without this the reader can fall
        # several frames behind during a busy replay, which shows up as
        # the arm on screen lagging the real arm — the one failure mode
        # that makes a live feed worse than useless.
        #
        # 2 rather than 1: with a single buffer the driver has nowhere to
        # put the next frame while this thread handles the previous one,
        # so every other frame is lost (1080p@30 arrived at exactly 15 fps,
        # measured 2026-10-21). A second buffer keeps the camera fed; the
        # backlog is still at most one frame (33 ms).
        try:
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 2)
        except Exception:
            pass  # not supported by every backend; harmless
        # Skip OpenCV's per-frame YUYV->BGR conversion: the raw frame is
        # stored and converted lazily (see _Frame). If the backend ignores
        # the flag we simply get BGR frames, which _Frame handles too.
        try:
            cap.set(cv2.CAP_PROP_CONVERT_RGB, 0)
        except Exception:
            pass

        # Warm-up. Fresh USB cameras routinely hand back a few black
        # frames before auto-exposure settles; the BIMS capture stations
        # were mis-diagnosed as a WebRTC fault for exactly this reason.
        for _ in range(10):
            cap.read()
        self._device = device
        self._error = None
        return cap

    @staticmethod
    def _classify(frame: Any, want_w: int, want_h: int) -> tuple[str, tuple[int, int]] | None:
        """What the capture handed back: ("bgr"|"yuyv", (width, height)), or
        None for a shape this worker does not understand."""
        if frame.ndim == 3 and frame.shape[2] == 3:
            return "bgr", (int(frame.shape[1]), int(frame.shape[0]))
        if frame.ndim == 3 and frame.shape[2] == 2:
            return "yuyv", (int(frame.shape[1]), int(frame.shape[0]))
        if frame.ndim == 2 and frame.shape[1] % 2 == 0:
            # A flat (h, 2w) byte plane: YUYV packed, 2 bytes per pixel.
            return "yuyv", (int(frame.shape[1] // 2), int(frame.shape[0]))
        return None

    def _run(self) -> None:
        cap = self._open()
        if cap is None:
            return
        failures = 0
        unknown_shape_logged = False
        try:
            while not self._stop.is_set():
                ok, frame = cap.read()
                if not ok or frame is None:
                    failures += 1
                    # Tolerate transient hiccups, but a sustained failure
                    # means the device went away (USB reset / unplug).
                    # Drop the handle and try to reopen rather than
                    # spinning on a dead descriptor.
                    if failures >= 30:
                        self._error = "capture failed repeatedly; reopening device"
                        cap.release()
                        time.sleep(1.0)
                        cap = self._open()
                        if cap is None:
                            return
                        failures = 0
                    else:
                        time.sleep(0.02)
                    continue
                failures = 0
                kind = self._classify(frame, self.spec.width, self.spec.height)
                if kind is None:
                    if not unknown_shape_logged:
                        self._error = f"unexpected frame shape {tuple(frame.shape)}; re-enabling RGB conversion"
                        unknown_shape_logged = True
                        try:
                            cap.set(cv2.CAP_PROP_CONVERT_RGB, 1)
                        except Exception:
                            pass
                    continue
                fmt, shape = kind
                # Copy: the driver reuses its mmap buffers, and a lazily
                # converted frame must not change under a reader.
                with self._lock:
                    self._seq += 1
                    self._latest = _Frame(frame.copy(), fmt, int(self.spec.quality), self._seq, time.time(), shape)
        finally:
            if cap is not None:
                cap.release()

    # -- consumer API ------------------------------------------------

    @property
    def latest(self) -> _Frame | None:
        with self._lock:
            return self._latest

    def peek_device(self) -> str | None:
        """The node this worker would open, read from sysfs/v4l2-ctl only.

        Cached once found (the RealSense keeps its node for the life of the
        boot); re-resolved at most every _PEEK_TTL_S while None.
        """
        now = time.time()
        if self._peeked is None and (self._peeked_at is None or now - self._peeked_at > _PEEK_TTL_S):
            self._peeked = resolve_device(self.spec, probe=False)
            self._peeked_at = now
        return self._peeked

    def status(self) -> dict[str, Any]:
        frame = self.latest
        age = None if frame is None else round(time.time() - frame.captured_at, 3)
        running = bool(self._thread is not None and self._thread.is_alive())
        device = self._device if running and self._device else self.peek_device()
        if running:
            state = "running"
        elif self._error:
            state = "error"
        elif device:
            state = "idle"
        else:
            state = "absent"
        return {
            "name": self.spec.name,
            "device": device,
            # idle = found a node, worker not started yet (it starts on the
            # first snapshot/stream request, never on a status poll);
            # absent = no colour node matches the spec; error = see `error`.
            "state": state,
            "running": running,
            "requested": {
                "width": self.spec.width,
                "height": self.spec.height,
                "fps": self.spec.fps,
                "quality": self.spec.quality,
            },
            "actual_size": None if frame is None else list(frame.shape),
            "frames": self._seq,
            "last_frame_age_s": age,
            "stale": bool(age is None or age > _STALE_AFTER_S),
            "error": self._error,
        }

    def frames(self, max_fps: float | None = None) -> Iterator[_Frame]:
        """Yield frames as they arrive, skipping any the consumer missed.

        Blocks briefly between polls instead of signalling across the
        thread/event-loop boundary — simpler, and at 30 fps the added
        latency is under a frame interval.
        """
        interval = 1.0 / (max_fps or self.spec.fps or 30)
        last_seq = -1
        idle_since = time.time()
        while not self._stop.is_set():
            frame = self.latest
            if frame is not None and frame.seq != last_seq:
                last_seq = frame.seq
                idle_since = time.time()
                yield frame
            elif time.time() - idle_since > _STALE_AFTER_S:
                # Producer is dead; end the response so the client can
                # retry rather than hanging on an open socket forever.
                return
            time.sleep(interval)


class CameraManager:
    """Registry of configured cameras. Workers start lazily on first use."""

    def __init__(self, specs: list[CameraSpec] | None = None) -> None:
        self._workers: dict[str, _CameraWorker] = {}
        self._lock = threading.Lock()
        for spec in specs or []:
            self._workers[spec.name] = _CameraWorker(spec)

    @classmethod
    def from_config(cls, config: dict[str, Any] | None) -> "CameraManager":
        """Build from the ``cameras:`` block of ``hardware.yaml``.

        Unresolved ``${VAR}`` placeholders and blank values are treated as
        "not configured" and fall back to capability-based detection.
        """
        specs: list[CameraSpec] = []
        block = (config or {}).get("cameras") or {}
        for name, raw in block.items():
            entry: dict[str, Any] = raw if isinstance(raw, dict) else {"device": raw}
            device = _clean(entry.get("device"))
            specs.append(
                CameraSpec(
                    name=str(name),
                    device=device,
                    width=int(entry.get("width", 640) or 640),
                    height=int(entry.get("height", 480) or 480),
                    fps=int(entry.get("fps", 30) or 30),
                    quality=int(entry.get("quality", 80) or 80),
                    match=_clean(entry.get("match")),
                )
            )
        if not specs:
            specs = [CameraSpec(name="external")]
        return cls(specs)

    def names(self) -> list[str]:
        return list(self._workers)

    def get(self, name: str) -> _CameraWorker | None:
        with self._lock:
            worker = self._workers.get(name)
            if worker is not None:
                worker.start()  # idempotent
            return worker

    def status(self) -> list[dict[str, Any]]:
        # Deliberately does *not* start workers — polling status should
        # never power on a camera as a side effect.
        return [w.status() for w in self._workers.values()]

    def stop_all(self) -> None:
        for worker in self._workers.values():
            worker.stop()


def _clean(value: Any) -> str | None:
    """Normalise a config value, rejecting unresolved ``${VAR}`` templates."""
    if value is None:
        return None
    text = str(value).strip()
    if not text or (text.startswith("${") and text.endswith("}")):
        return None
    # An env placeholder that *was* resolved to a bare index (e.g. "0")
    # is ambiguous on a multi-node device like the D415, so ignore it and
    # let capability detection decide. See module docstring.
    if text.isdigit():
        return None
    return text


def env_int(name: str, default: int) -> int:
    """Read an int from the environment, tolerating blank/garbage values."""
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default

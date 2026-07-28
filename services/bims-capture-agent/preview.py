"""Low-latency live-preview transports (CV-MICROSCOPE latency work).

Two deliverables:

1. MJPEG HTTP stream — `attach_mjpeg_route(app, get_frame, authenticate)`
   adds GET /preview.mjpg to the agent's aiohttp app. Each frame is
   JPEG-encoded and pushed as multipart/x-mixed-replace, which every browser
   renders natively with no WebRTC negotiation and no VP8 encode. Benched on
   a Pi 4 at 35ms mean vs 261ms for the WebRTC track (see progress.txt).
   Auth: the same station JWT the /ws endpoint takes (?token=<jwt> — an
   <img> tag can't set headers). Remote-tunable per request from the BIMS
   capture page: ?fps=1..30 and ?q=30..95 override the env defaults.

2. Local HDMI preview — `run_local_preview(get_frame)` renders frames
   full-screen on the Pi's own display (PREVIEW=local in the agent env):
   sensor → screen with no encode and no network, i.e. the latency floor —
   the desktop-capture.py experience at the station.
"""
import asyncio
import os
import threading
import time
from typing import Callable, Optional

import cv2
from aiohttp import web

GetFrame = Callable[[], Optional["object"]]
GetActiveCamera = Callable[[], str]

_MJPEG_FPS = int(os.environ.get("PREVIEW_FPS", "15") or 15)
_MJPEG_QUALITY = int(os.environ.get("PREVIEW_JPEG_QUALITY", "80") or 80)
_STAMP = os.environ.get("STAMP_FRAMES", "") == "1"


def _encode_jpeg(frame, quality: int) -> Optional[bytes]:
    if _STAMP:
        from latency_stamp import stamp_frame

        stamp_frame(frame)
    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    return buf.tobytes() if ok else None


def _clamped_int(raw: Optional[str], default: int, lo: int, hi: int) -> int:
    try:
        return max(lo, min(hi, int(raw))) if raw else default
    except ValueError:
        return default


def _assert_camera(
    request: web.Request, get_active_camera: Optional[GetActiveCamera]
) -> None:
    """409 if ?camera= names anything other than the camera that is open.

    A station holds ONE capture handle; changing it is an explicit operation
    (the select_camera WS command), never an implicit side effect of asking for
    a frame. So a request that names a camera is asserting which optics it
    expects, and a mismatch has to fail loudly — silently serving frames from
    the wrong sensor is how a microscope shot ends up filed as an overview one.
    Requests with no ?camera= are unaffected, which keeps older pages working.
    """
    wanted = request.query.get("camera")
    if not wanted or get_active_camera is None:
        return
    active = get_active_camera()
    if wanted != active:
        raise web.HTTPConflict(
            text=f"camera {wanted!r} is not active on this station (active: {active!r})"
        )


def attach_mjpeg_route(
    app: web.Application,
    get_frame: GetFrame,
    authenticate: Callable[[web.Request], bool],
    get_active_camera: Optional[GetActiveCamera] = None,
) -> None:
    async def handler(request: web.Request) -> web.StreamResponse:
        if not authenticate(request):
            raise web.HTTPUnauthorized(text="bad or missing ?token=")
        _assert_camera(request, get_active_camera)

        # Remote-tunable per request — the BIMS capture page controls these.
        fps = _clamped_int(request.query.get("fps"), _MJPEG_FPS, 1, 30)
        quality = _clamped_int(request.query.get("q"), _MJPEG_QUALITY, 30, 95)

        resp = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "multipart/x-mixed-replace; boundary=frame",
                "Cache-Control": "no-store",
            },
        )
        await resp.prepare(request)
        interval = 1.0 / max(1, fps)
        loop = asyncio.get_running_loop()
        try:
            while True:
                t0 = time.monotonic()
                frame = await loop.run_in_executor(None, get_frame)
                if frame is not None:
                    jpeg = await loop.run_in_executor(None, _encode_jpeg, frame, quality)
                    if jpeg:
                        await resp.write(
                            b"--frame\r\nContent-Type: image/jpeg\r\n"
                            + f"Content-Length: {len(jpeg)}\r\n\r\n".encode()
                            + jpeg
                            + b"\r\n"
                        )
                slack = interval - (time.monotonic() - t0)
                if slack > 0:
                    await asyncio.sleep(slack)
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        return resp

    app.router.add_get("/preview.mjpg", handler)


def attach_snapshot_route(
    app: web.Application,
    get_frame: GetFrame,
    authenticate: Callable[[web.Request], bool],
    get_active_camera: Optional[GetActiveCamera] = None,
) -> None:
    """GET /snapshot.jpg — one live frame as a plain JPEG.

    Lets the capture page take photos while it watches the MJPEG pathway with
    WebRTC torn down (single-encoder mode — see the PSU-brownout note in
    progress.txt): the browser fetches this instead of drawing the <video>
    element to a canvas. CORS is open because the page fetches cross-origin
    (BIMS on vercel.app → station on ts.net); auth is the same station JWT
    as /ws and /preview.mjpg, so the header discloses nothing.
    """

    async def handler(request: web.Request) -> web.Response:
        if not authenticate(request):
            raise web.HTTPUnauthorized(text="bad or missing ?token=")
        _assert_camera(request, get_active_camera)
        quality = _clamped_int(request.query.get("q"), 92, 30, 95)
        loop = asyncio.get_running_loop()
        frame = await loop.run_in_executor(None, get_frame)
        if frame is None:
            raise web.HTTPServiceUnavailable(text="camera not available")
        jpeg = await loop.run_in_executor(None, _encode_jpeg, frame, quality)
        if not jpeg:
            raise web.HTTPInternalServerError(text="jpeg encode failed")
        return web.Response(
            body=jpeg,
            content_type="image/jpeg",
            headers={
                "Cache-Control": "no-store",
                "Access-Control-Allow-Origin": "*",
            },
        )

    app.router.add_get("/snapshot.jpg", handler)


def run_local_preview(get_frame: GetFrame) -> threading.Thread:
    """Full-screen local render on the station's own display (daemon thread)."""

    def loop() -> None:
        window = "BIMS Microscope"
        cv2.namedWindow(window, cv2.WND_PROP_FULLSCREEN)
        cv2.setWindowProperty(window, cv2.WND_PROP_FULLSCREEN, cv2.WINDOW_FULLSCREEN)
        while True:
            frame = get_frame()
            if frame is not None:
                cv2.imshow(window, frame)
            # ~30 fps pump; also services the GUI event loop.
            if cv2.waitKey(33) & 0xFF == 27:  # ESC hides preview, agent keeps running
                cv2.destroyWindow(window)
                return

    t = threading.Thread(target=loop, name="local-preview", daemon=True)
    t.start()
    return t

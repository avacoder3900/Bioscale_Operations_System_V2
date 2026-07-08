"""Low-latency live-preview transports (CV-MICROSCOPE latency work).

Two deliverables:

1. MJPEG HTTP stream — `attach_mjpeg_route(app, get_frame, api_key)` adds
   GET /preview.mjpg to the agent's aiohttp app. Each frame is JPEG-encoded
   (q80) and pushed as multipart/x-mixed-replace, which every browser renders
   natively with no WebRTC negotiation and no VP8 encode. On a Pi 4 this is
   typically 2-4x lower latency than the WebRTC track.
   Auth: ?key=<STATION_AGENT_KEY> query param (the <img> tag can't set headers).

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

_MJPEG_FPS = int(os.environ.get("PREVIEW_FPS", "15") or 15)
_MJPEG_QUALITY = int(os.environ.get("PREVIEW_JPEG_QUALITY", "80") or 80)
_STAMP = os.environ.get("STAMP_FRAMES", "") == "1"


def _encode_jpeg(frame) -> Optional[bytes]:
    if _STAMP:
        from latency_stamp import stamp_frame

        stamp_frame(frame)
    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), _MJPEG_QUALITY])
    return buf.tobytes() if ok else None


def attach_mjpeg_route(app: web.Application, get_frame: GetFrame, api_key: str) -> None:
    async def handler(request: web.Request) -> web.StreamResponse:
        if api_key and request.query.get("key") != api_key:
            raise web.HTTPUnauthorized(text="bad or missing ?key=")

        resp = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "multipart/x-mixed-replace; boundary=frame",
                "Cache-Control": "no-store",
            },
        )
        await resp.prepare(request)
        interval = 1.0 / max(1, _MJPEG_FPS)
        loop = asyncio.get_running_loop()
        try:
            while True:
                t0 = time.monotonic()
                frame = await loop.run_in_executor(None, get_frame)
                if frame is not None:
                    jpeg = await loop.run_in_executor(None, _encode_jpeg, frame)
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

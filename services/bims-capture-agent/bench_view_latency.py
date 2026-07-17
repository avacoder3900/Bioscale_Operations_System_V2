"""Head-to-head live-view latency bench for the microscope station.

Measures capture→delivery latency of three preview transports, all in ONE
process on the Pi (same clock — no sync error), same camera, same 720p frame:

  local   frame read + ready-to-display (the HDMI-preview floor; a monitor
          adds one display refresh ~8-16ms on top)
  mjpeg   in-process aiohttp /preview.mjpg server + HTTP client on loopback
  webrtc  in-process aiortc peer pair (the agent's real CameraTrack recv()
          path: pace → read → resize → stamp → VP8 encode → RTP → decode)

Timestamps ride inside the pixels (latency_stamp.py), so each transport is
measured end-to-end through its own encode/transport/decode.

Run on the Pi (agent stopped, so the camera is free):
    STAMP_FRAMES=1 CAMERA_PROFILE=microscope .venv/bin/python bench_view_latency.py [frames_per_mode]
"""
import asyncio
import os
import statistics
import sys
import time

os.environ.setdefault("STAMP_FRAMES", "1")

import cv2  # noqa: E402
from aiohttp import ClientSession, web  # noqa: E402

import camera as camera_mod  # noqa: E402
from latency_stamp import latency_ms, stamp_frame  # noqa: E402
from preview import attach_mjpeg_route  # noqa: E402

N = int(sys.argv[1]) if len(sys.argv) > 1 else 60
PORT = 8899


def summarize(name: str, samples: list[int]) -> str:
    if not samples:
        return f"{name:8s} NO SAMPLES"
    s = sorted(samples)
    return (
        f"{name:8s} n={len(s):3d}  mean={statistics.fmean(s):6.1f}ms  "
        f"p50={s[len(s)//2]:4d}ms  p95={s[int(len(s)*0.95)-1]:4d}ms  max={s[-1]:4d}ms"
    )


async def bench_local(track) -> list[int]:
    """Floor: read a frame, downscale to stream size, stamp, decode stamp."""
    samples = []
    loop = asyncio.get_running_loop()
    for _ in range(N):
        def grab_and_measure():
            frame = track.grab_still()
            if frame is None:
                return None
            h, w = frame.shape[:2]
            if w > 1280:
                frame = cv2.resize(frame, (1280, 720), interpolation=cv2.INTER_AREA)
            stamp_frame(frame)
            return latency_ms(frame)
        lat = await loop.run_in_executor(None, grab_and_measure)
        if lat is not None and lat < 60_000:
            samples.append(lat)
        await asyncio.sleep(1 / 15)
    return samples


async def bench_mjpeg(track) -> list[int]:
    app = web.Application()
    attach_mjpeg_route(app, track.grab_still, api_key="bench")
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", PORT)
    await site.start()

    samples: list[int] = []
    try:
        import numpy as np

        async with ClientSession() as session:
            async with session.get(f"http://127.0.0.1:{PORT}/preview.mjpg?key=bench") as resp:
                buf = b""
                while len(samples) < N:
                    chunk = await resp.content.read(65536)
                    if not chunk:
                        break
                    buf += chunk
                    while True:
                        start = buf.find(b"\xff\xd8")
                        end = buf.find(b"\xff\xd9", start + 2)
                        if start == -1 or end == -1:
                            break
                        jpeg = buf[start:end + 2]
                        buf = buf[end + 2:]
                        frame = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
                        if frame is not None:
                            lat = latency_ms(frame)
                            if lat is not None and lat < 60_000:
                                samples.append(lat)
    finally:
        await runner.cleanup()
    return samples


async def bench_webrtc(track) -> list[int]:
    from aiortc import RTCPeerConnection

    sender_pc = RTCPeerConnection()
    receiver_pc = RTCPeerConnection()
    sender_pc.addTrack(track)

    samples: list[int] = []
    done = asyncio.Event()

    # Must be registered BEFORE setRemoteDescription — aiortc fires the
    # track event during SDP handling.
    @receiver_pc.on("track")
    def on_track(remote):
        async def pump():
            while len(samples) < N:
                try:
                    frame = await asyncio.wait_for(remote.recv(), timeout=10)
                except Exception:
                    break
                bgr = frame.to_ndarray(format="bgr24")
                lat = latency_ms(bgr)
                if lat is not None and lat < 60_000:
                    samples.append(lat)
            done.set()

        asyncio.ensure_future(pump())

    offer = await sender_pc.createOffer()
    await sender_pc.setLocalDescription(offer)
    await receiver_pc.setRemoteDescription(sender_pc.localDescription)
    answer = await receiver_pc.createAnswer()
    await receiver_pc.setLocalDescription(answer)
    await sender_pc.setRemoteDescription(receiver_pc.localDescription)

    try:
        await asyncio.wait_for(done.wait(), timeout=max(60, N))
    except asyncio.TimeoutError:
        pass
    await sender_pc.close()
    await receiver_pc.close()
    return samples


async def main() -> None:
    track = camera_mod.CameraTrack()
    if not track.is_open():
        sys.exit("camera failed to open — is the agent stopped?")
    # Warm-up: flush startup frames.
    for _ in range(10):
        track.grab_still()

    print(f"benchmarking {N} frames per mode on {os.uname().nodename} ...")
    local = await bench_local(track)
    print(summarize("local", local))
    mjpeg = await bench_mjpeg(track)
    print(summarize("mjpeg", mjpeg))
    webrtc = await bench_webrtc(track)
    print(summarize("webrtc", webrtc))
    print("\nnote: 'local' excludes the monitor's own refresh (~8-16ms).")
    print("mjpeg/webrtc measured on loopback — add network RTT/2 for a remote viewer.")


if __name__ == "__main__":
    asyncio.run(main())

"""Windows bench harness for the microscope sequence engine (CV-MICROSCOPE-01).

Runs SequenceManager against a real camera (Celestron via DirectShow) and a
real BIMS server — no WebRTC, no evdev, no aiortc needed. Prints every WS-style
event the engine would broadcast to the browser.

Usage (from services/bims-capture-agent):
    python bench_sequence.py <cartridgeId> [cameraIndex] [count] [intervalMs]

Env (or inherited): BIMS_URL (e.g. http://localhost:5173), AGENT_API_KEY.
Grid/count/interval envs behave exactly as on the Pi.
"""
import asyncio
import json
import os
import sys

import cv2

import sequence


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("usage: python bench_sequence.py <cartridgeId> [cameraIndex] [count] [intervalMs]")
    cartridge_id = sys.argv[1]
    cam_index = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    count = int(sys.argv[3]) if len(sys.argv) > 3 else None
    interval_ms = int(sys.argv[4]) if len(sys.argv) > 4 else None

    backend = cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_V4L2
    cap = cv2.VideoCapture(cam_index, backend)
    if not cap.isOpened():
        sys.exit(f"could not open camera {cam_index}")
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
    for _ in range(10):  # warm-up: first UVC frames are often black
        cap.read()
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    print(f"camera {cam_index} open at {w}x{h}; BIMS_URL={os.environ.get('BIMS_URL')}")

    def grab_still():
        # A couple of reads so we hand back the freshest frame, not a buffered one.
        cap.read()
        ok, frame = cap.read()
        return frame if ok else None

    async def broadcast(event: dict) -> None:
        print("EVENT:", json.dumps(event, default=str))

    async def run() -> None:
        mgr = sequence.SequenceManager()
        ok, result = await mgr.start(
            cartridge_id=cartridge_id,
            count=count,
            interval_ms=interval_ms,
            grab_still=grab_still,
            broadcast=broadcast,
        )
        if not ok:
            sys.exit(f"start rejected: {result}")
        print(f"sequence {result} started")
        while mgr.is_running():
            await asyncio.sleep(0.5)

    try:
        asyncio.run(run())
    finally:
        cap.release()


if __name__ == "__main__":
    main()

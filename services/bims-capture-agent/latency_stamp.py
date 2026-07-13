"""Pixel-embedded millisecond timestamps for glass-to-glass latency benches.

stamp_frame() writes the current time (ms, 32-bit wraparound) as a strip of
32 solid 24x24 px blocks along the top-left of a BGR frame — big enough to
survive JPEG/VP8 compression. read_stamp() recovers it on the receiving side.
Sender and receiver must share a clock (run both on the same host), then
latency = now_ms() - read_stamp(frame).
"""
import time

BLOCK = 24
BITS = 32


def now_ms() -> int:
    return time.monotonic_ns() // 1_000_000 & 0xFFFFFFFF


def stamp_frame(frame_bgr) -> None:
    """Draw the timestamp blocks in place (top-left strip)."""
    ms = now_ms()
    h, w = frame_bgr.shape[:2]
    if w < BITS * BLOCK or h < BLOCK:
        return
    for i in range(BITS):
        bit = (ms >> (BITS - 1 - i)) & 1
        x0 = i * BLOCK
        frame_bgr[0:BLOCK, x0:x0 + BLOCK] = 255 if bit else 0


def read_stamp(frame_bgr) -> int | None:
    """Decode the block strip back to the ms value; None if unreadable."""
    h, w = frame_bgr.shape[:2]
    if w < BITS * BLOCK or h < BLOCK:
        return None
    mid = BLOCK // 2
    ms = 0
    for i in range(BITS):
        px = frame_bgr[mid, i * BLOCK + mid]
        # Grayscale-ish threshold on the mean of BGR.
        val = int(px[0]) + int(px[1]) + int(px[2])
        ms = (ms << 1) | (1 if val > 3 * 128 else 0)
    return ms


def latency_ms(frame_bgr) -> int | None:
    ms = read_stamp(frame_bgr)
    if ms is None:
        return None
    return (now_ms() - ms) & 0xFFFFFFFF

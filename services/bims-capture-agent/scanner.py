"""USB barcode scanner reader for the Pi station.

Waveshare GW-Barcode (VID 0218 / PID 0210) presents as a USB HID
keyboard: each scan is typed character-by-character and terminated by
ENTER. We grab() the device so the keystrokes don't leak to the system
console, assemble characters into a buffer, and emit one event per
ENTER. Downstream (agent.py) broadcasts to connected WebSocket peers.

If no matching device is plugged in we leave scanner_ok=False on /health
and skip the background task — the agent must run camera + LED without
a scanner.
"""

from __future__ import annotations

import asyncio
import glob
import logging
import os
from typing import List, Optional

try:
    import evdev
    from evdev import categorize, ecodes
except ImportError:  # pragma: no cover — non-Linux dev machines
    evdev = None  # type: ignore[assignment]

log = logging.getLogger("bims-capture-agent.scanner")

_VID = 0x0218
_PID = 0x0210

# HID keyboard scancodes → ASCII. Covers the printable set the Waveshare
# emits on a Code 128 / QR payload; non-listed keys are dropped.
_KEYMAP_UNSHIFTED = {
    "KEY_A": "a", "KEY_B": "b", "KEY_C": "c", "KEY_D": "d", "KEY_E": "e",
    "KEY_F": "f", "KEY_G": "g", "KEY_H": "h", "KEY_I": "i", "KEY_J": "j",
    "KEY_K": "k", "KEY_L": "l", "KEY_M": "m", "KEY_N": "n", "KEY_O": "o",
    "KEY_P": "p", "KEY_Q": "q", "KEY_R": "r", "KEY_S": "s", "KEY_T": "t",
    "KEY_U": "u", "KEY_V": "v", "KEY_W": "w", "KEY_X": "x", "KEY_Y": "y",
    "KEY_Z": "z",
    "KEY_1": "1", "KEY_2": "2", "KEY_3": "3", "KEY_4": "4", "KEY_5": "5",
    "KEY_6": "6", "KEY_7": "7", "KEY_8": "8", "KEY_9": "9", "KEY_0": "0",
    "KEY_MINUS": "-", "KEY_EQUAL": "=", "KEY_LEFTBRACE": "[",
    "KEY_RIGHTBRACE": "]", "KEY_BACKSLASH": "\\", "KEY_SEMICOLON": ";",
    "KEY_APOSTROPHE": "'", "KEY_GRAVE": "`", "KEY_COMMA": ",",
    "KEY_DOT": ".", "KEY_SLASH": "/", "KEY_SPACE": " ",
}
_KEYMAP_SHIFTED = {
    **{f"KEY_{c}": c for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"},
    "KEY_1": "!", "KEY_2": "@", "KEY_3": "#", "KEY_4": "$", "KEY_5": "%",
    "KEY_6": "^", "KEY_7": "&", "KEY_8": "*", "KEY_9": "(", "KEY_0": ")",
    "KEY_MINUS": "_", "KEY_EQUAL": "+", "KEY_LEFTBRACE": "{",
    "KEY_RIGHTBRACE": "}", "KEY_BACKSLASH": "|", "KEY_SEMICOLON": ":",
    "KEY_APOSTROPHE": '"', "KEY_GRAVE": "~", "KEY_COMMA": "<",
    "KEY_DOT": ">", "KEY_SLASH": "?",
}

_SHIFT_KEYS = {"KEY_LEFTSHIFT", "KEY_RIGHTSHIFT"}


_scanner_ok = False
_event_queue: "asyncio.Queue[str]" = asyncio.Queue()


def is_available() -> bool:
    """Used by /health for scanner_ok."""
    return _scanner_ok


def event_queue() -> "asyncio.Queue[str]":
    """Downstream broadcast (task #16) awaits items off this queue."""
    return _event_queue


def drain_pending() -> int:
    """Discard every scan currently sitting in the queue; return the count
    dropped.

    Called when an operator arms a fresh trigger (Space on the capture page).
    A barcode the scanner read seconds earlier — an ambient sighting, a
    double-read — must not satisfy the new request, so we flush the queue
    and let the *next* physical read be the one that fires scan → capture.
    """
    dropped = 0
    while True:
        try:
            _event_queue.get_nowait()
        except asyncio.QueueEmpty:
            break
        dropped += 1
    return dropped


def _find_device() -> Optional["evdev.InputDevice"]:
    if evdev is None:
        return None

    # Preferred: /dev/input/by-id/ has stable, human-readable symlinks.
    # Waveshare names include the VID/PID hex, so a filename substring
    # match is the cheapest way to find the right node.
    for path in glob.glob("/dev/input/by-id/*"):
        name = os.path.basename(path).lower()
        if "0218" in name and "0210" in name:
            try:
                return evdev.InputDevice(path)
            except OSError:
                log.exception("could not open %s", path)

    # Fallback: enumerate all /dev/input/event* and match VID/PID.
    for path in evdev.list_devices():
        try:
            dev = evdev.InputDevice(path)
        except OSError:
            continue
        if dev.info.vendor == _VID and dev.info.product == _PID:
            return dev
        dev.close()

    return None


async def _read_loop(device: "evdev.InputDevice") -> None:
    buf: List[str] = []
    shift = False
    log.info(
        "scanner reading from %s (%s)",
        device.path,
        device.name,
    )
    try:
        async for ev in device.async_read_loop():
            if ev.type != ecodes.EV_KEY:
                continue
            key = categorize(ev)
            keycode = key.keycode if isinstance(key.keycode, str) else (
                key.keycode[0] if key.keycode else ""
            )
            # key.key_down = 1, key_up = 0, key_hold = 2. We only act on press.
            if key.keystate == key.key_up:
                if keycode in _SHIFT_KEYS:
                    shift = False
                continue
            if key.keystate != key.key_down:
                continue

            if keycode in _SHIFT_KEYS:
                shift = True
                continue
            if keycode == "KEY_ENTER":
                if buf:
                    code = "".join(buf)
                    buf.clear()
                    await _event_queue.put(code)
                    log.debug("scanned %r", code)
                continue

            ch = (_KEYMAP_SHIFTED if shift else _KEYMAP_UNSHIFTED).get(keycode)
            if ch is not None:
                buf.append(ch)
    except OSError:
        log.exception("scanner device disappeared")
    finally:
        try:
            device.ungrab()
        except Exception:
            pass
        try:
            device.close()
        except Exception:
            pass


async def start() -> None:
    """Open the scanner (if present) and spawn the read loop.

    Safe to call once at agent startup. No-op when no scanner is plugged
    in or when evdev isn't installed (dev on non-Linux).
    """
    global _scanner_ok
    device = _find_device()
    if device is None:
        log.info("no Waveshare scanner found — scanner_ok stays false")
        _scanner_ok = False
        return
    try:
        device.grab()
    except OSError:
        log.exception("could not grab() scanner — another process is reading it")
        device.close()
        _scanner_ok = False
        return
    _scanner_ok = True
    asyncio.create_task(_read_loop(device), name="bims-scanner")

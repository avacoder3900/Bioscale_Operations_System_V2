"""
Chute barcode scanner for the robot-arm service (Waveshare Barcode Scanner
Module, SKU 14810, USB id 0218:0210 "USBScn Module").

Purpose (2026-11-16): read the cartridge label right after the trapdoor
solenoids drop it from the chute, before the arm grabs it. The OT-2's own
barcode scan stays the check that the cartridge is really in the slot.

The scanner is triggered by command, not by its button:
  * Its output interface must be "USB Virtual Port" (register 0x000D bits 1-0
    = 11). That is set once by scanning the setup code on page 18 of the
    Setting Manual V2.1. In the factory "USB PC keyboard" mode it shows up as
    /dev/input/by-id/*USBScn*-event-kbd instead, and nothing can be sent to it.
  * Its scan mode must be "Command mode" (register 0x0000 bits 1-0 = 01).
    POST /barcode/command-mode sets that over the serial link and saves it to
    the scanner's flash.

Protocol (Setting Manual V2.1, pp. 76-87), CRC bytes 0xAB 0xCD = "no check":
    trigger  7E 00 08 01 00 02 01 AB CD   -> ack 02 00 00 01 00 33 31, then
             the label as pure data ending in CR (register 0x0060 default)
    stop     7E 00 08 01 00 02 00 AB CD
    read     7E 00 07 01 <addr hi> <addr lo> <count> AB CD
             -> 02 00 00 <len> <data...> <crc hi> <crc lo>
    write    7E 00 08 01 <addr hi> <addr lo> <value> AB CD -> ack
    save     7E 00 09 01 00 00 00 DE C8 -> ack

Endpoints (auth is applied by app.py when the router is included):
    GET  /barcode/status        {interface, port, busy, last, ...}
    POST /barcode/scan          {timeout_ms: 3000} -> {ok, code, label, elapsed_ms, at}
    GET  /barcode/recent?n=20   the last scans, newest first
    POST /barcode/command-mode  set scan mode = Command and save to flash

Rules:
  * One serial exchange at a time (a lock); a second /scan while one runs gets 409.
  * A scan that reads nothing in timeout_ms sends the stop command, so the
    scanner's light goes off and it does not answer late into the next scan.
  * `label` is true only for a whole cartridge label (36-char UUID or
    CART-nnnnnn, the same rule as BIMS isCartBarcode). Partial or glued codes
    are returned with label=false and must not be used to name a cartridge.
  * The servo bus is never touched; this is its own USB device.

scan_blocking() is the same scan for other Pi modules (fires/replay) to call
from a worker thread after a trapdoor fire.
"""

from __future__ import annotations

import glob
import os
import re
import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/barcode", tags=["barcode"])

# ---------------------------------------------------------------- config

PORT_GLOB = os.environ.get("BARCODE_PORT_GLOB", "/dev/serial/by-id/*USBScn*")
KEYBOARD_GLOB = "/dev/input/by-id/*USBScn*event-kbd"
PORT_OVERRIDE = os.environ.get("BARCODE_PORT") or None
BAUD = 9600  # a USB CDC port ignores it; the scanner's UART default
MIN_TIMEOUT_MS = 200
MAX_TIMEOUT_MS = 26000  # the scanner's own single-scan limit is 25.5 s
DEFAULT_TIMEOUT_MS = 3000

ACK = bytes.fromhex("02 00 00 01 00 33 31")
TRIGGER = bytes.fromhex("7E 00 08 01 00 02 01 AB CD")
STOP = bytes.fromhex("7E 00 08 01 00 02 00 AB CD")
SAVE = bytes.fromhex("7E 00 09 01 00 00 00 DE C8")

LABEL_RE = re.compile(r"^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|CART-\d{6})$", re.I)

SCAN_MODES = {0: "manual", 1: "command", 2: "continuous", 3: "sensing"}
INTERFACES = {0: "uart", 1: "usb_keyboard", 2: "reserved", 3: "usb_virtual_port"}


def is_label(code: str) -> bool:
    return bool(LABEL_RE.match((code or "").strip()))


def read_cmd(addr: int, count: int = 1) -> bytes:
    return bytes([0x7E, 0x00, 0x07, 0x01, (addr >> 8) & 0xFF, addr & 0xFF, count & 0xFF, 0xAB, 0xCD])


def write_cmd(addr: int, value: int) -> bytes:
    return bytes([0x7E, 0x00, 0x08, 0x01, (addr >> 8) & 0xFF, addr & 0xFF, value & 0xFF, 0xAB, 0xCD])


def split_scan_reply(buf: bytes) -> tuple[bool, Optional[str]]:
    """(acked, code) from what the scanner sent after a trigger.

    The ack may be missing (some firmware skips it) or arrive in pieces; the
    code is whatever follows it up to the first CR/LF. None until a CR/LF has
    arrived, so a half-read label is never returned.
    """
    acked = False
    i = buf.find(ACK)
    if i != -1:
        acked = True
        buf = buf[:i] + buf[i + len(ACK):]
    for end in (b"\r", b"\n"):
        j = buf.find(end)
        if j != -1:
            text = buf[:j].decode("ascii", errors="replace").strip()
            return acked, text
    return acked, None


# ---------------------------------------------------------------- port

def find_port() -> Optional[str]:
    if PORT_OVERRIDE:
        return PORT_OVERRIDE if os.path.exists(PORT_OVERRIDE) else None
    hits = sorted(glob.glob(PORT_GLOB))
    return hits[0] if hits else None


def interface() -> str:
    """What the Pi sees: usb_virtual_port (ready), usb_keyboard (setup code not scanned) or missing."""
    if find_port():
        return "usb_virtual_port"
    if glob.glob(KEYBOARD_GLOB):
        return "usb_keyboard"
    return "missing"


class ScannerError(RuntimeError):
    pass


_lock = threading.Lock()
_recent: deque = deque(maxlen=50)


def _open():
    port = find_port()
    if not port:
        if interface() == "usb_keyboard":
            raise ScannerError("the scanner is in USB keyboard mode; scan the USB Virtual Port setup code (Setting Manual page 18)")
        raise ScannerError("barcode scanner not found on USB")
    import serial  # type: ignore  # pyserial, already in the uv project for the servo bus

    s = serial.Serial(port, BAUD, timeout=0.05, write_timeout=1.0)
    s.reset_input_buffer()
    return s


def _read_for(s, seconds: float, until=None) -> bytes:
    buf = b""
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        chunk = s.read(256)
        if chunk:
            buf += chunk
            if until is not None and until(buf):
                break
    return buf


def _exchange(s, cmd: bytes, expect_len: int, seconds: float = 1.0) -> bytes:
    s.write(cmd)
    buf = _read_for(s, seconds, until=lambda b: len(b) >= expect_len)
    if len(buf) < expect_len or buf[:2] != b"\x02\x00" or buf[2] != 0x00:
        raise ScannerError(f"no valid answer to {cmd.hex(' ')}: got {buf.hex(' ') or 'nothing'}")
    return buf


def _read_reg(s, addr: int) -> int:
    buf = _exchange(s, read_cmd(addr), 7)
    return buf[4]


def _write_reg(s, addr: int, value: int) -> None:
    buf = _exchange(s, write_cmd(addr, value), len(ACK))
    if buf[: len(ACK)] != ACK:
        raise ScannerError(f"write 0x{addr:04X} not acknowledged: {buf.hex(' ')}")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def scan_blocking(timeout_ms: int = DEFAULT_TIMEOUT_MS, source: str = "api", wait_s: float = 0.0) -> dict:
    """Trigger one scan and wait for the label. Never raises; ok=false says why."""
    timeout_ms = max(MIN_TIMEOUT_MS, min(MAX_TIMEOUT_MS, int(timeout_ms)))
    got = _lock.acquire(timeout=wait_s) if wait_s > 0 else _lock.acquire(blocking=False)
    if not got:
        return {"ok": False, "busy": True, "error": "a barcode scan is already running"}
    t0 = time.monotonic()
    result: dict
    try:
        s = _open()
        try:
            s.write(TRIGGER)
            buf = _read_for(s, timeout_ms / 1000.0, until=lambda b: split_scan_reply(b)[1] is not None)
            acked, code = split_scan_reply(buf)
            elapsed = int((time.monotonic() - t0) * 1000)
            if code:
                result = {"ok": True, "code": code, "label": is_label(code), "acked": acked, "elapsed_ms": elapsed}
            else:
                try:
                    s.write(STOP)
                    _read_for(s, 0.2, until=lambda b: ACK in b)
                except Exception:
                    pass
                result = {
                    "ok": False,
                    "acked": acked,
                    "elapsed_ms": elapsed,
                    "error": "no barcode read" if acked else "the scanner did not answer the trigger (is it in Command mode?)",
                }
        finally:
            s.close()
    except ScannerError as exc:
        result = {"ok": False, "error": str(exc), "elapsed_ms": int((time.monotonic() - t0) * 1000)}
    except Exception as exc:  # serial errors: unplugged mid-scan, permissions...
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}", "elapsed_ms": int((time.monotonic() - t0) * 1000)}
    finally:
        _lock.release()
    result.update({"at": _now_iso(), "source": source, "timeout_ms": timeout_ms})
    _recent.appendleft(result)
    print(f"[barcode] {source}: {result.get('code') or result.get('error')} ({result['elapsed_ms']} ms)", flush=True)
    return result


def read_settings() -> dict:
    with _lock:
        s = _open()
        try:
            r0 = _read_reg(s, 0x0000)
            r0d = _read_reg(s, 0x000D)
            r06 = _read_reg(s, 0x0006)
        finally:
            s.close()
    return {
        "scan_mode": SCAN_MODES[r0 & 0x03],
        "interface": INTERFACES[r0d & 0x03],
        "single_scan_s": r06 / 10.0,
        "reg_0000": r0,
        "reg_000D": r0d,
    }


def set_command_mode() -> dict:
    """Register 0x0000 bits 1-0 := 01 (Command mode), keeping its light/sound bits; save to flash."""
    with _lock:
        s = _open()
        try:
            before = _read_reg(s, 0x0000)
            after = (before & ~0x03) | 0x01
            if after != before:
                _write_reg(s, 0x0000, after)
            s.write(SAVE)
            saved = _read_for(s, 1.0, until=lambda b: ACK in b)
            check = _read_reg(s, 0x0000)
        finally:
            s.close()
    return {
        "before": SCAN_MODES[before & 0x03],
        "after": SCAN_MODES[check & 0x03],
        "changed": after != before,
        "saved": ACK in saved,
        "reg_0000_before": before,
        "reg_0000_after": check,
    }


# ---------------------------------------------------------------- routes

class ScanRequest(BaseModel):
    timeout_ms: int = Field(DEFAULT_TIMEOUT_MS, ge=MIN_TIMEOUT_MS, le=MAX_TIMEOUT_MS)


@router.get("/status")
def barcode_status() -> dict:
    out = {
        "interface": interface(),
        "port": find_port(),
        "busy": _lock.locked(),
        "last": _recent[0] if _recent else None,
    }
    if out["interface"] == "usb_virtual_port" and not out["busy"]:
        try:
            out["settings"] = read_settings()
        except Exception as exc:
            out["settings_error"] = str(exc)
    return out


@router.post("/scan")
def barcode_scan(req: ScanRequest) -> dict:
    # A sync route: FastAPI runs it in a worker thread, so the serial wait
    # does not block the event loop.
    r = scan_blocking(req.timeout_ms, source="api")
    if r.get("busy"):
        raise HTTPException(status_code=409, detail=r["error"])
    return r


@router.get("/recent")
def barcode_recent(n: int = 20) -> dict:
    n = max(1, min(_recent.maxlen or 50, n))
    return {"scans": list(_recent)[:n]}


@router.post("/command-mode")
def barcode_command_mode() -> dict:
    if _lock.locked():
        raise HTTPException(status_code=409, detail="a barcode scan is running")
    try:
        return set_command_mode()
    except ScannerError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

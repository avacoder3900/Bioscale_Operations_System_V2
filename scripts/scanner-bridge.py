#!/usr/bin/env python3
"""
Waveshare Barcode Scanner Module ↔ BIMS bridge daemon.

Runs on the Lab Mac (or any host with the scanner plugged in over USB-CDC).
Polls BIMS for trigger commands, fires the scanner, posts decoded payloads
back to BIMS. Heartbeats every 10s so the test page can show online status.

Configuration (env vars):
  SCANNER_DEVICE_ID    Logical device name (default: lab-mac-scanner-1)
  SCANNER_SERIAL_PORT  e.g. /dev/tty.usbmodem14101  (required)
  SCANNER_BAUD         default 9600
  BIMS_BASE_URL        e.g. https://bims.brevitest.com  (required)
  BIMS_AGENT_API_KEY   AGENT_API_KEY value from BIMS env  (required)
  POLL_INTERVAL_MS     default 500 (trigger queue poll)
  HEARTBEAT_INTERVAL_S default 10
  SCAN_TIMEOUT_S       default 3 (max wait for serial response after trigger)

Dependencies:
  pip install pyserial requests

Run:
  python3 scripts/scanner-bridge.py
"""

import os
import sys
import time
import json
import logging
import threading
from typing import Optional

try:
    import serial  # pyserial
except ImportError:
    print("ERROR: pyserial not installed. Run: pip install pyserial requests", file=sys.stderr)
    sys.exit(1)

try:
    import requests
except ImportError:
    print("ERROR: requests not installed. Run: pip install pyserial requests", file=sys.stderr)
    sys.exit(1)


# Waveshare GM-class trigger command (returns decoded payload over serial).
# 0x7E 0x00 0x08 0x01 0x00 0x02 0x01 0xAB 0xCD
TRIGGER_BYTES = bytes([0x7E, 0x00, 0x08, 0x01, 0x00, 0x02, 0x01, 0xAB, 0xCD])

# Fixed ACK packet the scanner emits in response to TRIGGER_BYTES (manual page 25).
# Always prepended to the decoded barcode bytes — strip it before returning text.
TRIGGER_ACK = bytes([0x02, 0x00, 0x00, 0x01, 0x00, 0x33, 0x31])

# Configuration ---------------------------------------------------------------
DEVICE_ID = os.environ.get("SCANNER_DEVICE_ID", "lab-mac-scanner-1")
SERIAL_PORT = os.environ.get("SCANNER_SERIAL_PORT", "")
BAUD = int(os.environ.get("SCANNER_BAUD", "9600"))
BIMS_BASE_URL = os.environ.get("BIMS_BASE_URL", "").rstrip("/")
API_KEY = os.environ.get("BIMS_AGENT_API_KEY", "")
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL_MS", "500")) / 1000.0
HEARTBEAT_INTERVAL = int(os.environ.get("HEARTBEAT_INTERVAL_S", "10"))
SCAN_TIMEOUT = float(os.environ.get("SCAN_TIMEOUT_S", "3"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("scanner-bridge")


def require_env() -> None:
    missing = [k for k in ("SCANNER_SERIAL_PORT", "BIMS_BASE_URL", "BIMS_AGENT_API_KEY")
               if not os.environ.get(k)]
    if missing:
        log.error("Missing required env vars: %s", ", ".join(missing))
        sys.exit(2)


# BIMS HTTP helpers -----------------------------------------------------------
def _post_event(payload: dict) -> bool:
    try:
        r = requests.post(
            f"{BIMS_BASE_URL}/api/agent/scanner/event",
            headers={"x-agent-api-key": API_KEY, "Content-Type": "application/json"},
            data=json.dumps(payload),
            timeout=5,
        )
        if r.status_code >= 400:
            log.warning("event POST %s: %s", r.status_code, r.text[:200])
            return False
        return True
    except Exception as e:
        log.warning("event POST failed: %s", e)
        return False


def _claim_triggers(max_n: int = 5) -> list:
    try:
        r = requests.post(
            f"{BIMS_BASE_URL}/api/agent/scanner/triggers",
            headers={"x-agent-api-key": API_KEY, "Content-Type": "application/json"},
            data=json.dumps({"deviceId": DEVICE_ID, "max": max_n}),
            timeout=5,
        )
        if r.status_code >= 400:
            log.warning("trigger poll %s: %s", r.status_code, r.text[:200])
            return []
        body = r.json() or {}
        return body.get("triggers", []) or []
    except Exception as e:
        log.warning("trigger poll failed: %s", e)
        return []


# Serial port management ------------------------------------------------------
class ScannerPort:
    """Thin wrapper that auto-reconnects on failure."""

    def __init__(self, port: str, baud: int):
        self.port = port
        self.baud = baud
        self.ser: Optional[serial.Serial] = None
        self.lock = threading.Lock()

    def open(self) -> None:
        try:
            self.ser = serial.Serial(self.port, self.baud, timeout=SCAN_TIMEOUT)
            log.info("Opened serial port %s @ %d baud", self.port, self.baud)
        except Exception as e:
            self.ser = None
            log.warning("Cannot open %s: %s", self.port, e)

    def is_open(self) -> bool:
        return self.ser is not None and self.ser.is_open

    def close(self) -> None:
        if self.ser:
            try:
                self.ser.close()
            except Exception:
                pass
            self.ser = None

    def trigger_and_read(self) -> tuple[Optional[str], Optional[str], Optional[str]]:
        """
        Fire the scanner; return (decoded_text, raw_hex, error).
        Caller is responsible for calling .open() if not already open.
        """
        with self.lock:
            if not self.is_open():
                return None, None, "serial port not open"
            try:
                assert self.ser is not None
                self.ser.reset_input_buffer()
                self.ser.write(TRIGGER_BYTES)
                self.ser.flush()
                # Read whatever the scanner returns within SCAN_TIMEOUT.
                # GM-class engines typically respond with the raw decoded
                # bytes terminated by CRLF (or just the bytes for empty reads).
                deadline = time.time() + SCAN_TIMEOUT
                buf = bytearray()
                while time.time() < deadline:
                    chunk = self.ser.read(256)
                    if chunk:
                        buf.extend(chunk)
                        # Settle: keep reading briefly in case payload arrives in pieces
                        time.sleep(0.05)
                    elif buf:
                        break
                if not buf:
                    return None, None, "no response within timeout"

                raw_hex = buf.hex()
                # Strip the fixed trigger ACK if it leads the response — without
                # this, the ACK's last bytes ("31") leak into the decoded text.
                payload = buf[len(TRIGGER_ACK):] if buf.startswith(TRIGGER_ACK) else buf
                text = payload.decode("utf-8", errors="replace").strip()
                text = text.rstrip("\r\n")
                if not text:
                    return None, raw_hex, "empty payload (ACK only)"
                return text, raw_hex, None
            except serial.SerialException as e:
                self.close()
                return None, None, f"serial error: {e}"
            except Exception as e:
                return None, None, f"unexpected error: {e}"


# Main loops ------------------------------------------------------------------
def heartbeat_loop(port: ScannerPort, stop: threading.Event) -> None:
    while not stop.is_set():
        _post_event({
            "deviceId": DEVICE_ID,
            "eventType": "heartbeat",
            "source": "test",
            "metadata": {
                "serialOpen": port.is_open(),
                "serialPort": port.port,
                "baud": port.baud,
            }
        })
        stop.wait(HEARTBEAT_INTERVAL)


def trigger_loop(port: ScannerPort, stop: threading.Event) -> None:
    while not stop.is_set():
        if not port.is_open():
            port.open()
            if not port.is_open():
                stop.wait(2.0)
                continue

        triggers = _claim_triggers(max_n=5)
        for t in triggers:
            trigger_id = t.get("_id")
            source = t.get("source") or "test"
            ctx = t.get("contextRef")
            log.info("Trigger %s (source=%s)", trigger_id, source)

            text, raw, err = port.trigger_and_read()
            if err:
                _post_event({
                    "deviceId": DEVICE_ID,
                    "eventType": "error",
                    "source": source,
                    "contextRef": ctx,
                    "errorMessage": err,
                    "rawPayload": raw,
                    "metadata": {"triggerId": trigger_id}
                })
                log.warning("Scan failed: %s", err)
            else:
                _post_event({
                    "deviceId": DEVICE_ID,
                    "eventType": "scan",
                    "barcode": text,
                    "rawPayload": raw,
                    "source": source,
                    "contextRef": ctx,
                    "metadata": {"triggerId": trigger_id}
                })
                log.info("Scan: %s", text)

        stop.wait(POLL_INTERVAL)


def main() -> None:
    require_env()
    log.info("scanner-bridge starting")
    log.info("  device=%s  port=%s  bims=%s", DEVICE_ID, SERIAL_PORT, BIMS_BASE_URL)

    port = ScannerPort(SERIAL_PORT, BAUD)
    port.open()

    stop = threading.Event()
    hb = threading.Thread(target=heartbeat_loop, args=(port, stop), daemon=True)
    tl = threading.Thread(target=trigger_loop, args=(port, stop), daemon=True)
    hb.start()
    tl.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        log.info("Shutting down")
        stop.set()
        port.close()
        hb.join(timeout=2)
        tl.join(timeout=2)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
OT-2 unified bridge daemon (OT2-BRIDGE-1 + OT2-BRIDGE-2).

REPLACES scripts/scanner-bridge.py. Runs on the OT-2's internal Pi at
/data/ot2-bridge/. Outbound-only: the robot polls BIMS, BIMS never dials in.

Three loops (threads):
  1. Command long-poll  — POST /api/agent/ot2/poll, executes claimed commands:
       kind 'http'      → relay request to the local robot HTTP API (:31950)
       kind 'sweep'     → full on-robot scanner sweep (maintenance run + serial
                          scanner), per-slot progress POSTs, pause/cancel honored
       kind 'deck_scan' → single-position move + scan, barcode in the result
     Only ONE command executes at a time; the long-poll resumes afterwards.
  2. Legacy scanner trigger loop — identical to scanner-bridge.py (poll
     /api/agent/scanner/triggers, serial scan, POST /api/agent/scanner/event)
     so per-slot rescans + teach test-scans keep working untouched.
  3. Heartbeat every HEARTBEAT_INTERVAL_S with metadata.health = the robot's
     local GET /health snapshot.

Configuration (env vars; run.sh sources .env):
  BIMS_BASE_URL             e.g. https://bims.brevitest.com         (required)
  BIMS_AGENT_API_KEY        AGENT_API_KEY value from BIMS env       (required)
  BRIDGE_DEVICE_ID          e.g. ot2-b07-bridge                     (required)
  SCANNER_DEVICE_ID         legacy trigger-loop identity, e.g. ot2-b07-scanner
                            (default: BRIDGE_DEVICE_ID with -bridge → -scanner)
  SCANNER_SERIAL_PORT       e.g. /dev/ttyACM0                       (required)
  SCANNER_BAUD              default 9600
  OT2_BASE_URL              default http://localhost:31950
  POLL_WAIT_MS              default 18000 (server-side long-poll hold)
  TRIGGER_POLL_INTERVAL_MS  default 500 (legacy trigger queue poll)
  HEARTBEAT_INTERVAL_S      default 10
  SCAN_TIMEOUT_S            default 3 (max wait for serial response)

Dependencies (Python 3.7+):
  pip install pyserial requests

Run:
  python3 ot2-bridge.py     (normally via run.sh / ot2-bridge.service)
"""

import os
import sys
import time
import json
import base64
import signal
import logging
import threading
import subprocess
from typing import Optional, Tuple

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


VERSION = "ot2-bridge/1.0"

# Waveshare GM-class trigger command (returns decoded payload over serial).
# 0x7E 0x00 0x08 0x01 0x00 0x02 0x01 0xAB 0xCD
TRIGGER_BYTES = bytes([0x7E, 0x00, 0x08, 0x01, 0x00, 0x02, 0x01, 0xAB, 0xCD])

# Fixed ACK packet the scanner emits in response to TRIGGER_BYTES (manual page 25).
# Always prepended to the decoded barcode bytes — strip it before returning text.
TRIGGER_ACK = bytes([0x02, 0x00, 0x00, 0x01, 0x00, 0x33, 0x31])

# Configuration ---------------------------------------------------------------
BIMS_BASE_URL = os.environ.get("BIMS_BASE_URL", "").rstrip("/")
API_KEY = os.environ.get("BIMS_AGENT_API_KEY", "")
BRIDGE_DEVICE_ID = os.environ.get("BRIDGE_DEVICE_ID", "")


def _default_scanner_device_id(bridge_id: str) -> str:
    if bridge_id.endswith("-bridge"):
        return bridge_id[: -len("-bridge")] + "-scanner"
    return (bridge_id + "-scanner") if bridge_id else "unknown-scanner"


SCANNER_DEVICE_ID = os.environ.get("SCANNER_DEVICE_ID", "") or _default_scanner_device_id(BRIDGE_DEVICE_ID)
SERIAL_PORT = os.environ.get("SCANNER_SERIAL_PORT", "")
BAUD = int(os.environ.get("SCANNER_BAUD", "9600"))
OT2_BASE_URL = os.environ.get("OT2_BASE_URL", "http://localhost:31950").rstrip("/")
POLL_WAIT_MS = int(os.environ.get("POLL_WAIT_MS", "18000"))
TRIGGER_POLL_INTERVAL = int(os.environ.get("TRIGGER_POLL_INTERVAL_MS", "500")) / 1000.0
HEARTBEAT_INTERVAL = int(os.environ.get("HEARTBEAT_INTERVAL_S", "10"))
SCAN_TIMEOUT = float(os.environ.get("SCAN_TIMEOUT_S", "3"))

# How long the BIMS long-poll HTTP request may take end-to-end. Must exceed
# POLL_WAIT_MS (server holds up to 20s) plus network/cold-start headroom.
POLL_HTTP_TIMEOUT_S = 25
# Relay timeout for kind:'http' commands against the local robot API —
# matches proxy.ts's default AbortSignal of 30s.
RELAY_TIMEOUT_S = 30
# Error-backoff for every loop.
ERROR_BACKOFF_S = 2.0
# Pause idle-loop re-post interval (sweep).
PAUSE_POLL_S = 2.0

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("ot2-bridge")


def require_env() -> None:
    missing = [k for k in ("BIMS_BASE_URL", "BIMS_AGENT_API_KEY", "BRIDGE_DEVICE_ID", "SCANNER_SERIAL_PORT")
               if not os.environ.get(k)]
    if missing:
        log.error("Missing required env vars: %s", ", ".join(missing))
        sys.exit(2)


# BIMS HTTP helpers -----------------------------------------------------------
def _bims_headers() -> dict:
    return {"x-agent-api-key": API_KEY, "Content-Type": "application/json"}


def _post_event(payload: dict) -> bool:
    try:
        r = requests.post(
            "{}/api/agent/scanner/event".format(BIMS_BASE_URL),
            headers=_bims_headers(),
            data=json.dumps(payload),
            timeout=10,
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
            "{}/api/agent/scanner/triggers".format(BIMS_BASE_URL),
            headers=_bims_headers(),
            data=json.dumps({"deviceId": SCANNER_DEVICE_ID, "max": max_n}),
            timeout=10,
        )
        if r.status_code >= 400:
            log.warning("trigger poll %s: %s", r.status_code, r.text[:200])
            return []
        body = r.json() or {}
        return body.get("triggers", []) or []
    except Exception as e:
        log.warning("trigger poll failed: %s", e)
        return []


def _poll_command() -> Optional[dict]:
    """Long-poll BIMS for the next command. Raises on network failure."""
    r = requests.post(
        "{}/api/agent/ot2/poll".format(BIMS_BASE_URL),
        headers=_bims_headers(),
        data=json.dumps({"deviceId": BRIDGE_DEVICE_ID, "waitMs": POLL_WAIT_MS}),
        timeout=POLL_HTTP_TIMEOUT_S,
    )
    if r.status_code >= 400:
        log.warning("command poll %s: %s", r.status_code, r.text[:200])
        return None
    body = r.json() or {}
    return body.get("command")


def _post_result(command_id: str, payload: dict) -> bool:
    """Complete/fail a command. Retries a couple of times — losing a result
    leaves the BIMS caller hanging until its own timeout."""
    url = "{}/api/agent/ot2/commands/{}/result".format(BIMS_BASE_URL, command_id)
    for attempt in range(3):
        try:
            r = requests.post(url, headers=_bims_headers(), data=json.dumps(payload), timeout=10)
            if r.status_code < 500:
                if r.status_code >= 400:
                    # 404/409 = command already terminal (expired) — stop retrying.
                    log.warning("result POST %s for %s: %s", r.status_code, command_id, r.text[:200])
                return r.status_code < 400
        except Exception as e:
            log.warning("result POST failed (attempt %d): %s", attempt + 1, e)
        time.sleep(2)
    return False


def _post_progress(command_id: str, payload: dict) -> Tuple[bool, bool]:
    """POST sweep progress; returns (pauseRequested, cancelRequested) echoed
    by BIMS. A 409 means the command went terminal server-side — treat as
    cancel. Network blips return (False, False) so one drop doesn't abort."""
    url = "{}/api/agent/ot2/commands/{}/progress".format(BIMS_BASE_URL, command_id)
    try:
        r = requests.post(url, headers=_bims_headers(), data=json.dumps(payload), timeout=10)
        try:
            body = r.json() or {}
        except Exception:
            body = {}
        if r.status_code >= 400:
            log.warning("progress POST %s: %s", r.status_code, r.text[:200])
            return bool(body.get("pauseRequested")), bool(body.get("cancelRequested", True))
        return bool(body.get("pauseRequested")), bool(body.get("cancelRequested"))
    except Exception as e:
        log.warning("progress POST failed: %s", e)
        return False, False


# OT-2 local HTTP API ----------------------------------------------------------
class RobotCommandError(Exception):
    pass


def ot2_request(method: str, path: str, body=None, timeout: float = RELAY_TIMEOUT_S):
    """Issue a request against the local robot API with the opentrons-version
    header (the robot rejects unversioned requests)."""
    if not path.startswith("/"):
        path = "/" + path
    headers = {"opentrons-version": "3"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body)
    return requests.request(method.upper(), OT2_BASE_URL + path, headers=headers, data=data, timeout=timeout)


def robot_health() -> Optional[dict]:
    try:
        r = ot2_request("GET", "/health", timeout=5)
        if r.status_code >= 400:
            return None
        return r.json()
    except Exception:
        return None


def engine_health() -> dict:
    """Readiness probe BEYOND /health. /health stays 200 even when the run
    engine is hung (a gantry command blocked at the hardware level), so we poke
    the run endpoints with short timeouts — a timeout/5xx here is the signal of
    a hung server, and we report any non-idle run so the UI can show 'busy'.

    Returns: {engineOk, protocolRun: status|None, maintenanceRun: status|None}.
    engineOk=False means the engine did not answer promptly = needs a restart."""
    out = {"engineOk": True, "protocolRun": None, "maintenanceRun": None}
    try:
        r = ot2_request("GET", "/runs", timeout=5)
        if r.status_code < 400:
            body = r.json() or {}
            href = ((body.get("links") or {}).get("current") or {}).get("href") or ""
            cid = href.rsplit("/", 1)[-1] if href else None
            if cid:
                for run in (body.get("data") or []):
                    if run.get("id") == cid:
                        out["protocolRun"] = run.get("status")
        else:
            out["engineOk"] = False
    except Exception:
        out["engineOk"] = False
    try:
        r = ot2_request("GET", "/maintenance_runs/current", timeout=5)
        if r.status_code == 404:
            out["maintenanceRun"] = None
        elif r.status_code < 400:
            out["maintenanceRun"] = ((r.json() or {}).get("data") or {}).get("status", "open")
        else:
            out["engineOk"] = False
    except Exception:
        out["engineOk"] = False
    return out


_last_restart_at = 0.0
RESTART_COOLDOWN_S = 120.0


def restart_robot_server(reason: str = "", force: bool = False) -> bool:
    """Restart the OT-2's opentrons-robot-server (the uvicorn process that runs
    the protocol/maintenance engine). This is the reliable fix when the engine
    is hung. Cooldown-guarded so an auto-heal loop can't thrash; force=True (the
    manual UI button) bypasses the cooldown."""
    global _last_restart_at
    if not force and (time.time() - _last_restart_at) < RESTART_COOLDOWN_S:
        log.warning("robot-server restart suppressed (cooldown %.0fs) — reason: %s",
                    RESTART_COOLDOWN_S - (time.time() - _last_restart_at), reason)
        return False
    _last_restart_at = time.time()
    log.warning("RESTARTING opentrons-robot-server — reason: %s", reason)
    try:
        subprocess.run(["systemctl", "restart", "opentrons-robot-server"],
                       timeout=90, check=False)
    except Exception as e:
        log.error("robot-server restart command failed: %s", e)
        return False
    for _ in range(45):  # ~90s for the server to come back
        try:
            r = ot2_request("GET", "/health", timeout=4)
            if r.status_code < 400:
                log.info("robot-server back up after restart")
                time.sleep(3)  # let the hardware controller settle
                return True
        except Exception:
            pass
        time.sleep(2)
    log.error("robot-server did not come back within timeout after restart")
    return False


def clear_stale_maintenance_run() -> Optional[dict]:
    """Delete a leftover maintenance run that's blocking a new one. Best-effort
    — if the server is hung this DELETE will also time out (the restart ladder
    handles that case)."""
    try:
        r = ot2_request("GET", "/maintenance_runs/current", timeout=5)
    except Exception:
        return None
    if r.status_code == 404 or r.status_code >= 500:
        return None
    mid = ((r.json() or {}).get("data") or {}).get("id") if r.status_code < 400 else None
    if not mid:
        return None
    log.warning("clearing stale maintenance run %s", mid)
    try:
        ot2_request("DELETE", "/maintenance_runs/{}".format(mid), timeout=10)
    except Exception as e:
        log.warning("delete maintenance run %s failed: %s", mid, e)
    return {"id": mid, "action": "cleared"}


# A protocol run that never reached a terminal state (commonly a `paused` run
# left over from the off-deck initial pause) keeps holding the OT-2 run engine,
# so the robot refuses new maintenance runs with this error. We auto-clear it.
PROTOCOL_RUN_CONFLICT = "protocol run is active"
ACTIVE_RUN_STATES = {"running", "finishing"}
TERMINAL_RUN_STATES = {"stopped", "failed", "succeeded"}


def _current_protocol_run() -> Optional[dict]:
    """Return {'id','status'} for the robot's current protocol run, or None."""
    try:
        r = ot2_request("GET", "/runs", timeout=8)
        if r.status_code >= 400:
            return None
        body = r.json() or {}
    except Exception:
        return None
    href = ((body.get("links") or {}).get("current") or {}).get("href") or ""
    cur_id = href.rsplit("/", 1)[-1] if href else None
    if not cur_id:
        return None
    for run in (body.get("data") or []):
        if run.get("id") == cur_id:
            return {"id": cur_id, "status": run.get("status")}
    return {"id": cur_id, "status": None}


def clear_stale_protocol_run() -> Optional[dict]:
    """Free the run engine when a non-terminal protocol run is blocking a
    maintenance run. Returns a dict describing what was cleared, or None if
    nothing was blocking. Raises RobotCommandError if the blocking run is
    genuinely ACTIVE (running/finishing) — we never silently kill a live run."""
    run = _current_protocol_run()
    if not run:
        return None
    status = (run.get("status") or "").lower()
    if status in TERMINAL_RUN_STATES:
        return None  # terminal-but-current doesn't block a new run
    if status in ACTIVE_RUN_STATES:
        raise RobotCommandError(
            "Robot has an ACTIVE protocol run (status={}) — refusing to "
            "auto-clear it. Stop that run before scanning.".format(status))
    # Stale: paused / idle / blocked-by-open-door / stop-requested / awaiting-recovery
    run_id = run["id"]
    log.warning("clearing stale protocol run %s (status=%s) blocking maintenance op",
                run_id, status)
    try:
        ot2_request("POST", "/runs/{}/actions".format(run_id),
                    {"data": {"actionType": "stop"}}, timeout=10)
    except Exception as e:
        log.warning("stop action on %s failed: %s", run_id, e)
    for _ in range(12):  # ~6s for stop to reach terminal
        cur = _current_protocol_run()
        if not cur or (cur.get("status") or "").lower() in TERMINAL_RUN_STATES:
            break
        time.sleep(0.5)
    try:
        ot2_request("DELETE", "/runs/{}".format(run_id), timeout=10)
    except Exception as e:
        log.warning("delete run %s failed: %s", run_id, e)
    return {"id": run_id, "priorStatus": status, "action": "cleared"}


# Conflict hints that mean a leftover run is blocking a new maintenance run.
MAINT_CONFLICT_HINTS = ("protocol run is active", "not idle or stopped", "run is not idle")


# Maintenance-run helpers — mirrors src/lib/server/opentrons/maintenance.ts ----
def open_maintenance_run(_attempt: int = 0) -> str:
    """Open a maintenance run, with a 3-tier auto-heal ladder:
      attempt 0: on a run-conflict, clear stale protocol + maintenance runs, retry
      attempt 1: still conflicting, or the POST itself hung -> restart the
                 robot-server (it's wedged), retry
      attempt 2: give up and raise.
    A genuinely-ACTIVE protocol run is never auto-killed (clear_stale_protocol_run
    raises) — that surfaces as a loud error instead."""
    # JSON:API style — requires the `data` envelope even with no attributes.
    try:
        r = ot2_request("POST", "/maintenance_runs", {"data": {}})
    except Exception as e:
        # The HTTP call itself failed (server hung / unreachable) — restart once.
        if _attempt <= 1 and restart_robot_server("maintenance POST failed: {}".format(e)):
            return open_maintenance_run(_attempt=2)
        raise RobotCommandError("robot server unreachable: {}".format(e))

    body = {}
    try:
        body = r.json() or {}
    except Exception:
        pass
    if r.status_code >= 400:
        detail = _first_error_detail(body) or "Robot returned {} on /maintenance_runs".format(r.status_code)
        low = (detail or "").lower()
        is_conflict = any(h in low for h in MAINT_CONFLICT_HINTS)
        if _attempt == 0 and is_conflict:
            # Tier 1 — clear leftover runs (protocol then maintenance) and retry.
            clear_stale_protocol_run()  # raises if genuinely active
            clear_stale_maintenance_run()
            log.info("auto-recovered (cleared stale runs) before maintenance run")
            return open_maintenance_run(_attempt=1)
        if _attempt <= 1 and (is_conflict or r.status_code >= 500):
            # Tier 2 — still wedged: the server is hung, restart it and retry.
            if restart_robot_server("maintenance-run conflict persists: {}".format(detail)):
                return open_maintenance_run(_attempt=2)
        raise RobotCommandError(detail)
    run_id = (body.get("data") or {}).get("id")
    if not run_id:
        raise RobotCommandError("Robot did not return a maintenance run id")
    return run_id


def close_maintenance_run(run_id: str) -> None:
    """Best-effort — does not raise on 404."""
    r = ot2_request("DELETE", "/maintenance_runs/{}".format(run_id))
    if r.status_code >= 400 and r.status_code != 404:
        body = {}
        try:
            body = r.json() or {}
        except Exception:
            pass
        detail = _first_error_detail(body) or "Robot returned {} on close maintenance run".format(r.status_code)
        raise RobotCommandError(detail)


def _first_error_detail(body: dict) -> Optional[str]:
    try:
        errors = body.get("errors") or []
        if errors and isinstance(errors[0], dict):
            return errors[0].get("detail")
    except Exception:
        pass
    return None


def send_maintenance_command(run_id: str, command_type: str, params: dict,
                             timeout_s: float = 30.0) -> dict:
    """POST a setup-intent command with waitUntilComplete=true.

    CRITICAL OT-2 gotcha: the robot returns HTTP 201 even when the inner
    command FAILED — the per-command status lives at body.data.status. A
    'failed' status with no http error is the difference between a sweep that
    silently no-ops the gantry and one that fails loudly. Detect it.
    """
    qs = "waitUntilComplete=true&timeout={}".format(int(timeout_s * 1000))
    path = "/maintenance_runs/{}/commands?{}".format(run_id, qs)
    r = ot2_request("POST", path,
                    {"data": {"commandType": command_type, "intent": "setup", "params": params}},
                    timeout=timeout_s + 10)
    body = {}
    try:
        body = r.json() or {}
    except Exception:
        pass
    if r.status_code >= 400:
        detail = _first_error_detail(body) or "Robot returned {} on command {}".format(r.status_code, command_type)
        raise RobotCommandError(detail)
    inner = (body.get("data") or {})
    if inner.get("status") == "failed":
        err = inner.get("error") or {}
        detail = err.get("detail") or err.get("errorType") or "unknown command failure"
        prefix = "[{}] ".format(err["errorType"]) if err.get("errorType") else ""
        raise RobotCommandError("{} failed: {}{}".format(command_type, prefix, detail))
    return body


def discover_pipette(preferred_mount: Optional[str]) -> Optional[Tuple[str, str]]:
    """Resolve the canonical pipette name from the live robot. Returns
    (pipetteName, mount) or None. Prefers `name` over `model` like
    maintenance.ts discoverPipette."""
    try:
        r = ot2_request("GET", "/pipettes", timeout=10)
        if r.status_code >= 400:
            return None
        body = r.json() or {}
    except Exception as e:
        log.warning("discover_pipette failed: %s", e)
        return None
    if preferred_mount == "right":
        mounts = ["right", "left"]
    else:
        mounts = ["left", "right"]
    for key in ("name", "model"):
        for m in mounts:
            entry = body.get(m) or {}
            if isinstance(entry, dict) and entry.get(key):
                return entry[key], m
    return None


def load_pipette_in_run(run_id: str, pipette_name: str, mount: str) -> str:
    body = send_maintenance_command(run_id, "loadPipette",
                                    {"pipetteName": pipette_name, "mount": mount})
    pid = ((body.get("data") or {}).get("result") or {}).get("pipetteId")
    if not pid:
        raise RobotCommandError("loadPipette did not return a pipetteId")
    return pid


# Skip redundant re-homes: the OT-2 keeps absolute position across maintenance
# runs, so a deck-scan immediately followed by a cartridge sweep does not need
# to home again between them (each home is ~30-60s; back-to-back scans were
# costing ~2 min). Track the last home and skip if still fresh. _last_home_at
# starts at 0 so a fresh deck-scan / standalone sweep / daemon-restart homes.
_last_home_at = 0.0
HOME_FRESH_S = 180.0


def home_gantry(run_id: str, force: bool = False) -> None:
    global _last_home_at
    age = time.time() - _last_home_at
    if not force and age < HOME_FRESH_S:
        log.info("Skipping home — gantry homed %.0fs ago (still fresh)", age)
        return
    send_maintenance_command(run_id, "home", {}, timeout_s=60.0)
    _last_home_at = time.time()


def move_to_coordinates(run_id: str, pipette_id: str, x: float, y: float, z: float) -> None:
    # forceDirect — sweeps carry no tips/liquid; direct point-to-point cuts
    # ~0.5-1s off every slot transition (same rationale as maintenance.ts).
    send_maintenance_command(run_id, "moveToCoordinates",
                             {"pipetteId": pipette_id,
                              "coordinates": {"x": x, "y": y, "z": z},
                              "forceDirect": True},
                             timeout_s=30.0)


# Serial port management ------------------------------------------------------
class ScannerPort:
    """Thin wrapper that auto-reconnects on failure. The internal lock is the
    shared guard between the legacy trigger loop and the sweep/deck-scan
    executor — the two never use the scanner simultaneously."""

    def __init__(self, port: str, baud: int):
        self.port = port
        self.baud = baud
        self.ser = None  # type: Optional[serial.Serial]
        self.lock = threading.Lock()

    def open(self) -> None:
        try:
            # Short read timeout; trigger_and_read enforces the overall
            # deadline itself so it can honor per-command scanTimeoutS.
            self.ser = serial.Serial(self.port, self.baud, timeout=0.2)
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

    def trigger_and_read(self, timeout_s: Optional[float] = None) -> Tuple[Optional[str], Optional[str], Optional[str]]:
        """Fire the scanner; return (decoded_text, raw_hex, error)."""
        wait_s = timeout_s if timeout_s and timeout_s > 0 else SCAN_TIMEOUT
        with self.lock:
            if not self.is_open():
                self.open()
            if not self.is_open():
                return None, None, "serial port not open"
            try:
                assert self.ser is not None
                self.ser.reset_input_buffer()
                self.ser.write(TRIGGER_BYTES)
                self.ser.flush()
                # Read whatever the scanner returns within the deadline.
                # GM-class engines typically respond with the raw decoded
                # bytes terminated by CRLF (or just the bytes for empty reads).
                deadline = time.time() + wait_s
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
                return None, None, "serial error: {}".format(e)
            except Exception as e:
                return None, None, "unexpected error: {}".format(e)


def scan_with_retry(port: ScannerPort, timeout_s: float, retry_once: bool) -> dict:
    """One trigger+read, retried once on failure when retry_once. Returns
    {barcode, rawPayload, error, attempts}."""
    text, raw, err = port.trigger_and_read(timeout_s)
    attempts = 1
    if (err or not text) and retry_once:
        log.info("Scan attempt 1 failed (%s) — retrying", err or "no barcode")
        text, raw, err = port.trigger_and_read(timeout_s)
        attempts = 2
    return {"barcode": text, "rawPayload": raw, "error": err, "attempts": attempts}


# Command executors -----------------------------------------------------------
def execute_http(command_id: str, request_spec: dict) -> None:
    method = (request_spec.get("method") or "GET").upper()
    path = request_spec.get("path") or "/"
    body = request_spec.get("body")
    log.info("http command %s: %s %s", command_id, method, path)
    try:
        r = ot2_request(method, path, body, timeout=RELAY_TIMEOUT_S)
        try:
            parsed = r.json()
        except Exception:
            parsed = None
        _post_result(command_id, {"ok": True, "status": r.status_code, "body": parsed})
        log.info("http command %s done: robot %s", command_id, r.status_code)
    except Exception as e:
        log.warning("http command %s failed: %s", command_id, e)
        _post_result(command_id, {"ok": False, "error": str(e)})


# How long to wait for on-robot protocol analysis after an upload (OT2-BRIDGE-3).
UPLOAD_ANALYSIS_TIMEOUT_S = 60


def execute_upload_protocol(command_id: str, payload: dict) -> None:
    """OT2-BRIDGE-3: receive a base64 .py over the bridge, multipart-upload it to
    the local robot /protocols, then poll the on-robot analysis (the daemon is
    local so this is fast) and return the protocol id + analyzed metadata."""
    file_name = payload.get("fileName") or "protocol.py"
    file_b64 = payload.get("fileB64") or ""
    log.info("upload_protocol %s: %s (%d b64 chars)", command_id, file_name, len(file_b64))
    try:
        file_bytes = base64.b64decode(file_b64)
        # The .py first, then every bundled custom-labware .json under the same
        # multipart field "files" (a list of tuples — dict can't repeat a key).
        files = [("files", (file_name, file_bytes, "text/x-python"))]
        for lw in (payload.get("labware") or []):
            try:
                lw_bytes = base64.b64decode(lw.get("b64") or "")
                files.append(("files", (lw.get("fileName") or "labware.json", lw_bytes, "application/json")))
            except Exception:
                pass
        log.info("upload_protocol %s: bundling %d labware def(s)", command_id, len(files) - 1)
        r = requests.post(
            OT2_BASE_URL + "/protocols",
            headers={"opentrons-version": "*"},
            files=files,
            timeout=120,
        )
        if r.status_code >= 400:
            _post_result(command_id, {"ok": False, "error": "robot upload {}: {}".format(r.status_code, r.text[:300])})
            return
        pid = (((r.json() or {}).get("data")) or {}).get("id")
        if not pid:
            _post_result(command_id, {"ok": False, "error": "robot returned no protocol id"})
            return

        analysis_status = "pending"
        params = labware = pipettes = None
        deadline = time.time() + UPLOAD_ANALYSIS_TIMEOUT_S
        while time.time() < deadline:
            time.sleep(2)
            try:
                ar = ot2_request("GET", "/protocols/{}/analyses".format(pid), timeout=15)
                analyses = (ar.json() or {}).get("data") or []
            except Exception:
                continue
            if not analyses:
                continue
            latest = analyses[-1]
            if not isinstance(latest, dict):
                continue
            st = latest.get("status")
            if st == "completed":
                detail = latest
                try:
                    dr = ot2_request("GET", "/protocols/{}/analyses/{}".format(pid, latest.get("id")), timeout=15)
                    dd = (dr.json() or {}).get("data")
                    if isinstance(dd, dict):
                        detail = dd
                except Exception:
                    pass
                # The analysis fields (runTimeParameters/labware/pipettes) are at
                # the TOP LEVEL; `result` is a string verdict, not a nested object.
                res = detail.get("result")
                body = res if isinstance(res, dict) else detail
                params = body.get("runTimeParameters")
                labware = body.get("labware")
                pipettes = body.get("pipettes")
                analysis_status = "completed"
                break
            if st == "failed":
                analysis_status = "failed"
                break

        _post_result(command_id, {"ok": True, "status": 200, "body": {
            "opentronsProtocolId": pid,
            "analysisStatus": analysis_status,
            "parametersSchema": params,
            "labwareDefinitions": labware,
            "pipettesRequired": pipettes,
        }})
        log.info("upload_protocol %s done: id=%s analysis=%s", command_id, pid, analysis_status)
    except Exception as e:
        log.warning("upload_protocol %s failed: %s", command_id, e)
        _post_result(command_id, {"ok": False, "error": str(e)})


def _setup_pipette(run_id: str, payload: dict) -> str:
    """Discover + load the pipette for a sweep/deck-scan run; returns the
    run-scoped pipetteId."""
    preferred_mount = payload.get("pipetteMount")
    discovered = discover_pipette(preferred_mount)
    if not discovered and payload.get("pipetteName") and preferred_mount:
        # Live discovery failed but BIMS supplied a name — try it as-is.
        discovered = (payload["pipetteName"], preferred_mount)
    if not discovered:
        raise RobotCommandError(
            "No pipette mounted on the robot — sweep requires a pipette as the "
            "motion reference axis. Mount a pipette on the OT-2 first."
        )
    pipette_name, mount = discovered
    log.info("Pipette: %s on %s mount", pipette_name, mount)
    pipette_id = load_pipette_in_run(run_id, pipette_name, mount)
    return pipette_id


def execute_sweep(command_id: str, payload: dict, port: ScannerPort) -> None:
    sweep_run_id = payload.get("sweepRunId")
    positions = sorted(payload.get("positions") or [], key=lambda p: p.get("slotIndex", 0))
    scan_timeout = float(payload.get("scanTimeoutS") or SCAN_TIMEOUT)
    retry_once = bool(payload.get("retryOnce", True))

    log.info("sweep command %s: run=%s slots=%d", command_id, sweep_run_id, len(positions))

    maint_run_id = None
    slots_done = 0
    scan_count = 0
    error_count = 0
    abort_reason = None  # type: Optional[str]
    cancelled = False
    pause_req = False
    cancel_req = False

    def progress(extra: dict) -> Tuple[bool, bool]:
        body = {"sweepRunId": sweep_run_id, "slotsDone": slots_done}
        body.update(extra)
        return _post_progress(command_id, body)

    try:
        maint_run_id = open_maintenance_run()
        log.info("Maintenance run open: %s", maint_run_id)
        pipette_id = _setup_pipette(maint_run_id, payload)
        log.info("Homing gantry before sweep")
        home_gantry(maint_run_id)
        pause_req, cancel_req = progress({"log": [
            {"level": "info", "message": "Bridge: maintenance run {} open, pipette loaded, home complete. Walking taught positions.".format(maint_run_id)}
        ]})

        for pos in positions:
            slot_index = int(pos.get("slotIndex", 0))

            # Honor pause / cancel between slots (flags echoed on the last
            # progress POST).
            if cancel_req:
                cancelled = True
                break
            while pause_req and not cancel_req:
                log.info("Paused — idling (slot %d next)", slot_index + 1)
                time.sleep(PAUSE_POLL_S)
                pause_req, cancel_req = progress({"currentSlotIndex": slot_index})
            if cancel_req:
                cancelled = True
                break

            log.info("Slot %d: moving to (%.1f, %.1f, %.1f)", slot_index + 1,
                     pos.get("x", 0), pos.get("y", 0), pos.get("z", 0))
            try:
                move_to_coordinates(maint_run_id, pipette_id, pos["x"], pos["y"], pos["z"])
            except Exception as e:
                msg = "move-to failed: {}".format(e)
                log.warning("Slot %d: %s", slot_index + 1, msg)
                error_count += 1
                slots_done += 1
                pause_req, cancel_req = progress({
                    "currentSlotIndex": slot_index,
                    "slotError": {"slotIndex": slot_index, "message": msg, "attempts": 0}
                })
                continue

            scan = scan_with_retry(port, scan_timeout, retry_once)
            slots_done += 1
            if scan["barcode"]:
                scan_count += 1
                log.info("Slot %d: scanned \"%s\" (%d attempt%s)", slot_index + 1,
                         scan["barcode"], scan["attempts"], "" if scan["attempts"] == 1 else "s")
                pause_req, cancel_req = progress({
                    "currentSlotIndex": slot_index,
                    "scan": {
                        "slotIndex": slot_index,
                        "barcode": scan["barcode"],
                        "rawPayload": scan["rawPayload"],
                        "x": pos.get("x"), "y": pos.get("y"), "z": pos.get("z"),
                        "attempts": scan["attempts"]
                    }
                })
            else:
                msg = "{} (after {} attempts)".format(scan["error"] or "unknown scanner failure", scan["attempts"])
                log.warning("Slot %d: %s", slot_index + 1, msg)
                error_count += 1
                pause_req, cancel_req = progress({
                    "currentSlotIndex": slot_index,
                    "slotError": {"slotIndex": slot_index, "message": msg, "attempts": scan["attempts"]}
                })
    except Exception as e:
        abort_reason = str(e)
        log.error("Sweep aborted: %s", abort_reason)

    # Wind down: close the maintenance run regardless of outcome. No wind-down
    # home — the protocol run that follows homes at its own start, so homing
    # here just added dead time.
    if maint_run_id:
        try:
            close_maintenance_run(maint_run_id)
            log.info("Maintenance run closed")
        except Exception as e:
            log.warning("close maintenance run failed: %s", e)

    if cancelled:
        final = {"status": "cancelled", "abortReason": "cancelled by operator"}
    elif abort_reason:
        final = {"status": "errored", "abortReason": abort_reason}
    else:
        final = {"status": "completed"}
    progress({
        "final": final,
        "log": [{"level": "info" if final["status"] == "completed" else "warn",
                 "message": "Sweep {}. {} scan(s), {} error(s).".format(final["status"], scan_count, error_count)}]
    })

    if abort_reason and not cancelled:
        _post_result(command_id, {"ok": False, "error": abort_reason})
    else:
        _post_result(command_id, {"ok": True, "status": 200, "body": {
            "slotsDone": slots_done,
            "scanCount": scan_count,
            "errorCount": error_count,
            "status": final["status"]
        }})
    log.info("sweep command %s finished: %s (%d scans, %d errors)",
             command_id, final["status"], scan_count, error_count)


def execute_deck_scan(command_id: str, payload: dict, port: ScannerPort) -> None:
    pos = payload.get("position") or {}
    scan_timeout = float(payload.get("scanTimeoutS") or SCAN_TIMEOUT)
    log.info("deck_scan command %s: position=(%.1f, %.1f, %.1f)", command_id,
             pos.get("x", 0), pos.get("y", 0), pos.get("z", 0))

    maint_run_id = None
    try:
        maint_run_id = open_maintenance_run()
        pipette_id = _setup_pipette(maint_run_id, payload)
        # Force a home at the start of a deck scan — it's the entry point of the
        # deck->sweep flow, so this is the one home for the whole sequence; the
        # following sweep skips its home (gantry still fresh).
        home_gantry(maint_run_id, force=True)
        move_to_coordinates(maint_run_id, pipette_id, pos["x"], pos["y"], pos["z"])
        scan = scan_with_retry(port, scan_timeout, True)
        if scan["barcode"]:
            _post_result(command_id, {"ok": True, "status": 200, "body": {
                "barcode": scan["barcode"],
                "rawPayload": scan["rawPayload"]
            }})
            log.info("deck_scan command %s: scanned \"%s\"", command_id, scan["barcode"])
        else:
            err = "{} (after {} attempts)".format(scan["error"] or "unknown scanner failure", scan["attempts"])
            _post_result(command_id, {"ok": False, "error": err})
            log.warning("deck_scan command %s failed: %s", command_id, err)
    except Exception as e:
        log.warning("deck_scan command %s failed: %s", command_id, e)
        _post_result(command_id, {"ok": False, "error": str(e)})
    finally:
        if maint_run_id:
            # No wind-down home here — a cartridge sweep (or the protocol run)
            # follows immediately and will home if needed. Homing between the
            # deck scan and the cartridge scan was the redundant ~1-2 min delay.
            try:
                close_maintenance_run(maint_run_id)
            except Exception as e:
                log.warning("close maintenance run failed: %s", e)


def execute_restart_robot_server(command_id: str) -> None:
    """Manual recovery (UI button): restart the OT-2 robot-server and wait for
    it to come back. Bypasses the auto-heal cooldown."""
    log.info("restart_robot_server command %s: restarting on operator request", command_id)
    ok = restart_robot_server("manual restart via BIMS", force=True)
    if ok:
        _post_result(command_id, {"ok": True, "status": 200, "body": {"restarted": True}})
        log.info("restart_robot_server command %s: server back up", command_id)
    else:
        _post_result(command_id, {"ok": False, "error": "robot server did not come back after restart"})


def execute_command(cmd: dict, port: ScannerPort) -> None:
    command_id = cmd.get("_id")
    kind = cmd.get("kind")
    if not command_id:
        log.warning("Claimed command without _id: %s", json.dumps(cmd)[:200])
        return
    if kind == "http":
        execute_http(command_id, cmd.get("request") or {})
    elif kind == "sweep":
        execute_sweep(command_id, cmd.get("payload") or {}, port)
    elif kind == "deck_scan":
        execute_deck_scan(command_id, cmd.get("payload") or {}, port)
    elif kind == "upload_protocol":
        execute_upload_protocol(command_id, cmd.get("payload") or {})
    elif kind == "restart_robot_server":
        execute_restart_robot_server(command_id)
    else:
        log.warning("Unknown command kind '%s' (id=%s)", kind, command_id)
        _post_result(command_id, {"ok": False, "error": "unknown command kind: {}".format(kind)})


# Main loops ------------------------------------------------------------------
def command_loop(port: ScannerPort, stop: threading.Event) -> None:
    """Single worker: one command executes at a time; the long-poll resumes
    after completion."""
    while not stop.is_set():
        try:
            cmd = _poll_command()
            if cmd:
                execute_command(cmd, port)
        except Exception as e:
            log.warning("command loop error: %s", e)
            stop.wait(ERROR_BACKOFF_S)


def trigger_loop(port: ScannerPort, stop: threading.Event) -> None:
    """Legacy scanner-bridge behavior — per-slot rescans + teach test-scans."""
    while not stop.is_set():
        try:
            if not port.is_open():
                port.open()
                if not port.is_open():
                    stop.wait(ERROR_BACKOFF_S)
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
                        "deviceId": SCANNER_DEVICE_ID,
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
                        "deviceId": SCANNER_DEVICE_ID,
                        "eventType": "scan",
                        "barcode": text,
                        "rawPayload": raw,
                        "source": source,
                        "contextRef": ctx,
                        "metadata": {"triggerId": trigger_id}
                    })
                    log.info("Scan: %s", text)

            stop.wait(TRIGGER_POLL_INTERVAL)
        except Exception as e:
            log.warning("trigger loop error: %s", e)
            stop.wait(ERROR_BACKOFF_S)


def heartbeat_loop(port: ScannerPort, stop: threading.Event) -> None:
    while not stop.is_set():
        try:
            _post_event({
                "deviceId": BRIDGE_DEVICE_ID,
                "eventType": "heartbeat",
                "metadata": {
                    "health": robot_health(),
                    "engine": engine_health(),
                    "version": VERSION,
                    "serialOpen": port.is_open(),
                    "serialPort": port.port
                }
            })
        except Exception as e:
            log.warning("heartbeat loop error: %s", e)
        stop.wait(HEARTBEAT_INTERVAL)


def main() -> None:
    require_env()
    log.info("%s starting", VERSION)
    log.info("  bridge=%s  scanner=%s  port=%s  bims=%s  robot=%s",
             BRIDGE_DEVICE_ID, SCANNER_DEVICE_ID, SERIAL_PORT, BIMS_BASE_URL, OT2_BASE_URL)

    port = ScannerPort(SERIAL_PORT, BAUD)
    port.open()

    stop = threading.Event()

    def _shutdown(signum, _frame):
        log.info("Signal %s — shutting down", signum)
        stop.set()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    threads = [
        threading.Thread(target=command_loop, args=(port, stop), name="command", daemon=True),
        threading.Thread(target=trigger_loop, args=(port, stop), name="trigger", daemon=True),
        threading.Thread(target=heartbeat_loop, args=(port, stop), name="heartbeat", daemon=True),
    ]
    for t in threads:
        t.start()

    try:
        while not stop.is_set():
            time.sleep(0.5)
    except KeyboardInterrupt:
        stop.set()

    log.info("Shutting down")
    port.close()
    for t in threads:
        t.join(timeout=2)
    log.info("Stopped")


if __name__ == "__main__":
    main()

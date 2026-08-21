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
import glob
import re
import time
import json
import base64
import signal
import logging
import threading
import subprocess
from datetime import datetime, timezone
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


def _decoded_payload(buf: bytearray) -> bytes:
    """Bytes after the fixed trigger ACK, whitespace/CRLF-stripped. Empty means
    the scanner ACKed the trigger but hasn't sent the decoded barcode YET — the
    decode lags the ACK by tens of ms, so the read loop must keep waiting until
    this is non-empty (or the deadline), NOT break on the ACK alone."""
    p = buf[len(TRIGGER_ACK):] if buf.startswith(TRIGGER_ACK) else buf
    return bytes(p).strip()

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
# Read window per scan. MUST be >= the scanner's "Single Scanning Time" (5s
# default, see manual Appendix A). In Command Mode each trigger makes the
# scanner scan for up to that long; a 3s window cut off decodes that landed at
# 3-5s (marginally-aimed positions) and reported them as "empty (ACK only)".
SCAN_TIMEOUT = float(os.environ.get("SCAN_TIMEOUT_S", "5.5"))

# A scanner USB re-enumeration (bumped cable, flaky hub) invalidates the open
# file handle. Reads/writes on the dead fd raise termios.error/OSError — NOT
# serial.SerialException — so they must not be treated as "scan didn't decode":
# the handle is dead and udev has likely pointed /dev/scanner at a NEW ttyACM
# node. Any device-level failure therefore drops the handle and reopens. The
# observed disconnect->re-enumerate gap is ~2s, so the ladder spans that.
PORT_OPEN_ATTEMPTS = int(os.environ.get("SCANNER_PORT_OPEN_ATTEMPTS", "3"))
PORT_REOPEN_DELAY_S = float(os.environ.get("SCANNER_PORT_REOPEN_DELAY_S", "1.0"))
# Marks a scan that failed because the PORT is down, as opposed to a scan that
# ran fine but decoded nothing. The two demand opposite responses: a no-decode
# is worth rastering the gantry for, a dead port never is.
PORT_ERROR_PREFIX = "scanner port error: "

# The real "is a maintenance run open" endpoint. NOT "/maintenance_runs/current"
# — that string is captured by the /maintenance_runs/{runId} route as a run
# literally named "current", so it always 404s ("Run current was not found")
# whether or not a run is open. Using it made stale-run detection permanently
# blind, which is how a stuck maintenance run escalated to a wedged engine.
MAINT_CURRENT_RUN = "/maintenance_runs/current_run"

# Search-raster fallback: when the on-point scan fails (barcode placement varies
# + the acrylic deck has optical imperfections), the gantry rasters a small grid
# around the taught point, scanning at each stop (scanner keeps re-triggering).
# First hit wins. dz is applied as z - dz (CLOSER = better focus through acrylic).
# Order = focus-only first (acrylic optics often just need a nearer focus,
# operator-confirmed), then a 3x3 grid in x/y for placement drift. Env-tunable.
SEARCH_STEP_MM = int(os.environ.get("SEARCH_STEP_MM", "4"))      # +/- grid step (x and y)
SEARCH_DWELL_S = float(os.environ.get("SEARCH_DWELL_S", "1.8"))  # listen per grid stop


def _build_search_offsets(step: int) -> list:
    grid = [(dx, dy) for dy in (-step, 0, step) for dx in (-step, 0, step)
            if not (dx == 0 and dy == 0)]  # 8 points around center
    offs = [(0, 0, 8), (0, 0, 16)]              # focus closer, on-center
    offs += [(dx, dy, 0) for (dx, dy) in grid]  # 3x3 grid at taught z
    offs += [(dx, dy, 8) for (dx, dy) in grid]  # 3x3 grid one focus-step closer
    return offs


SEARCH_OFFSETS = _build_search_offsets(SEARCH_STEP_MM)

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
        r = ot2_request("GET", MAINT_CURRENT_RUN, timeout=5)
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
        r = ot2_request("GET", MAINT_CURRENT_RUN, timeout=5)
    except Exception:
        return None
    if r.status_code == 404 or r.status_code >= 500:
        return None
    mid = ((r.json() or {}).get("data") or {}).get("id") if r.status_code < 400 else None
    if not mid:
        return None
    log.warning("clearing stale maintenance run %s", mid)
    try:
        close_maintenance_run(mid)  # retries while the run is still winding down
    except Exception as e:
        log.warning("delete maintenance run %s failed: %s", mid, e)
    return {"id": mid, "action": "cleared"}


# A protocol run that never reached a terminal state (commonly a `paused` run
# left over from the off-deck initial pause) keeps holding the OT-2 run engine,
# so the robot refuses new maintenance runs with this error. We auto-clear it.
PROTOCOL_RUN_CONFLICT = "protocol run is active"
ACTIVE_RUN_STATES = {"running", "finishing"}
TERMINAL_RUN_STATES = {"stopped", "failed", "succeeded"}


def _run_actions(run_data: dict) -> list:
    """The run's action log — the play/pause/stop COMMANDS issued against it."""
    return (run_data or {}).get("actions") or []


def pause_was_commanded(run_data: dict) -> bool:
    """True if the run is paused because somebody asked for it.

    This is the one reliable way to tell the two kinds of `paused` apart:

      - The engine's own start-of-run pause (off-deck labware, "confirm deck
        loaded") is a protocol-level wait. Nothing appears in run.actions except
        the `play` that started the run.
      - An operator pressing Pause in BIMS goes out as POST /runs/<id>/actions
        with actionType 'pause'. The OT-2 API documents run.actions as
        "client-initiated run control actions, ordered oldest to newest", so
        that — and only that — lands in the log.

    We look at the LATEST action rather than "has ever been paused", because the
    log is append-only: a run that was paused and then resumed would otherwise
    stay flagged for the rest of its life, and a genuinely stale off-deck pause
    later in that run could never be cleared. Latest action 'pause' means the
    operator's most recent instruction was stop; anything else means it was go.
    """
    for action in reversed(_run_actions(run_data)):
        kind = (action.get("actionType") or "").lower()
        if kind in ("play", "pause", "stop"):
            return kind == "pause"
    return False


def _fetch_run(run_id: str, timeout: float = 6) -> Optional[dict]:
    """GET /runs/<id> -> the `data` object, or None if it can't be read."""
    try:
        r = ot2_request("GET", "/runs/{}".format(run_id), timeout=timeout)
        if r.status_code >= 400:
            return None
        return ((r.json() or {}).get("data")) or None
    except Exception:
        return None


def _current_protocol_run() -> Optional[dict]:
    """Return {'id','status','pauseCommanded'} for the current protocol run."""
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
            return {"id": cur_id, "status": run.get("status"),
                    "pauseCommanded": pause_was_commanded(run)}
    return {"id": cur_id, "status": None, "pauseCommanded": False}


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
    if status == "paused" and run.get("pauseCommanded"):
        # A deliberately-paused fill is not a leftover. It looks identical to the
        # start-of-run off-deck pause by status alone, which is how paused fills
        # were getting silently stopped when someone started a deck scan.
        raise RobotCommandError(
            "Robot has a protocol run that was deliberately PAUSED — refusing to "
            "auto-clear it. Resume it, or stop it explicitly, before scanning.")
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


# The robot refuses to DELETE a maintenance run while a command is still in
# flight: "Run is currently active. Allow the run to finish or stop it with a
# `stop` action". There is no stop action to take — the robot's own OpenAPI spec
# exposes only GET and DELETE on /maintenance_runs/{runId} — so the only recourse
# is to let the in-flight command land and re-DELETE. This matters: a maintenance
# run we fail to delete wedges the run engine, and every later maintenance op
# 500s with RunConflictError until someone restarts the robot-server by hand.
CLOSE_ACTIVE_HINTS = ("currently active", "not idle", "allow the run to finish")
CLOSE_ATTEMPTS = int(os.environ.get("MAINT_CLOSE_ATTEMPTS", "6"))
CLOSE_RETRY_DELAY_S = float(os.environ.get("MAINT_CLOSE_RETRY_DELAY_S", "2.0"))


def close_maintenance_run(run_id: str) -> None:
    """Delete a maintenance run. Does not raise on 404. Retries while the run is
    still active — see CLOSE_ACTIVE_HINTS above for why giving up here is what
    wedges the engine."""
    detail = None
    for attempt in range(CLOSE_ATTEMPTS):
        r = ot2_request("DELETE", "/maintenance_runs/{}".format(run_id))
        if r.status_code < 400 or r.status_code == 404:
            return
        body = {}
        try:
            body = r.json() or {}
        except Exception:
            pass
        detail = _first_error_detail(body) or "Robot returned {} on close maintenance run".format(r.status_code)
        if not any(h in (detail or "").lower() for h in CLOSE_ACTIVE_HINTS):
            raise RobotCommandError(detail)  # a real failure, not a wind-down race
        if attempt < CLOSE_ATTEMPTS - 1:
            log.warning("maintenance run %s still active — re-deleting in %.0fs (%d/%d)",
                        run_id, CLOSE_RETRY_DELAY_S, attempt + 1, CLOSE_ATTEMPTS)
            time.sleep(CLOSE_RETRY_DELAY_S)
    raise RobotCommandError(detail or "could not close maintenance run {}".format(run_id))


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


def move_to_coordinates(run_id: str, pipette_id: str, x: float, y: float, z: float,
                        speed: Optional[float] = None, force_direct: bool = True) -> None:
    # forceDirect — sweeps carry no tips/liquid; direct point-to-point cuts
    # ~0.5-1s off every slot transition (same rationale as maintenance.ts).
    # speed (mm/s) lets the tip-calibration probe creep slowly onto the limit
    # switch; omitted = the robot's default (fast) gantry speed for sweeps/scans.
    params = {"pipetteId": pipette_id,
              "coordinates": {"x": x, "y": y, "z": z},
              "forceDirect": force_direct}
    if speed is not None:
        params["speed"] = speed
    send_maintenance_command(run_id, "moveToCoordinates", params, timeout_s=30.0)


def get_current_position(run_id: str, pipette_id: str) -> dict:
    """Read the pipette's current gantry position (savePosition)."""
    body = send_maintenance_command(run_id, "savePosition", {"pipetteId": pipette_id})
    pos = ((body.get("data") or {}).get("result") or {}).get("position") or {}
    return {"x": pos.get("x"), "y": pos.get("y"), "z": pos.get("z")}


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

    def _scan_window(self, wait_s: float) -> Tuple[Optional[str], Optional[str], Optional[str]]:
        """One scan window against the currently-open handle. Returns the same
        (text, raw, error) triple as trigger_and_read for scan outcomes, and
        RAISES for device-level failures so the caller can reopen the port."""
        assert self.ser is not None
        SETTLE_S = 0.15          # rest before each (re)trigger so the engine resets
        RETRIGGER_EVERY_S = 1.0  # listen this long per burst before re-poking
        deadline = time.time() + wait_s
        last_raw: Optional[str] = None
        got_any = False
        while time.time() < deadline:
            # Rest, flush, fire one burst.
            time.sleep(SETTLE_S)
            self.ser.reset_input_buffer()
            self.ser.write(TRIGGER_BYTES)
            self.ser.flush()
            burst_deadline = min(deadline, time.time() + RETRIGGER_EVERY_S)
            buf = bytearray()
            while time.time() < burst_deadline:
                chunk = self.ser.read(256)
                if chunk:
                    got_any = True
                    buf.extend(chunk)
                    time.sleep(0.03)  # let a piecewise payload finish arriving
                    if _decoded_payload(buf):
                        break
                elif _decoded_payload(buf):
                    break
            if buf:
                last_raw = buf.hex()
            decoded = _decoded_payload(buf)
            if decoded:
                return decoded.decode("utf-8", errors="replace").strip(), last_raw, None
            # else: this burst only ACKed (or was silent) — re-poke.
        if not got_any:
            return None, None, "no response within timeout"
        return None, last_raw, "empty payload (ACK only)"

    def trigger_and_read(self, timeout_s: Optional[float] = None, clamp: bool = True) -> Tuple[Optional[str], Optional[str], Optional[str]]:
        """Fire the scanner repeatedly until it decodes or the window expires;
        return (decoded_text, raw_hex, error). Reopens the port and retries if
        the device errors out mid-scan (see PORT_OPEN_ATTEMPTS).

        In Command Mode ONE trigger = ONE short scan burst (the module's
        "Single Scanning Time"), then it ACKs and goes idle. A single trigger +
        passive wait therefore reports "empty (ACK only)" whenever the decode
        didn't land in that one burst — which is exactly the intermittent
        per-slot failure we saw. So instead we RE-TRIGGER (re-poke) every
        ~RETRIGGER_EVERY_S across the whole window, with a short rest before each
        poke so the scanner settles after the previous burst / gantry move.
        Each burst gets a clean buffer (reset before the trigger) so stale ACKs
        from a prior poke can't masquerade as a payload."""
        wait_s = timeout_s if timeout_s and timeout_s > 0 else SCAN_TIMEOUT
        if clamp:
            wait_s = max(wait_s, SCAN_TIMEOUT)   # on-point scans get the full window
        with self.lock:
            detail = None
            for attempt in range(PORT_OPEN_ATTEMPTS):
                if not self.is_open():
                    self.open()
                if not self.is_open():
                    detail = "cannot open {}".format(self.port)
                else:
                    try:
                        return self._scan_window(wait_s)
                    except Exception as e:
                        # serial.SerialException, OSError, or the bare
                        # termios.error that a re-enumerated USB node throws from
                        # reset_input_buffer(). All of them mean the same thing:
                        # this handle is dead. Drop it — is_open() would happily
                        # keep reporting True — so the next attempt opens whatever
                        # /dev/scanner points at NOW.
                        self.close()
                        detail = str(e) or e.__class__.__name__
                if attempt < PORT_OPEN_ATTEMPTS - 1:
                    log.warning("scanner port %s failed (%s) — reopening (%d/%d)",
                                self.port, detail, attempt + 2, PORT_OPEN_ATTEMPTS)
                    time.sleep(PORT_REOPEN_DELAY_S)
            return None, None, PORT_ERROR_PREFIX + (detail or "unknown")


def is_port_error(err: Optional[str]) -> bool:
    """True when a scan failed because the serial port is DOWN, as opposed to a
    scan that ran fine and simply decoded nothing. Callers use this to skip the
    gantry raster: moving the head around cannot fix a dead scanner."""
    return bool(err) and err.startswith(PORT_ERROR_PREFIX)


def scan_with_retry(port: ScannerPort, timeout_s: float, retry_once: bool) -> dict:
    """One trigger+read, retried once on failure when retry_once. Returns
    {barcode, rawPayload, error, attempts}."""
    text, raw, err = port.trigger_and_read(timeout_s)
    attempts = 1
    # A port error already exhausted the reopen ladder inside trigger_and_read;
    # an immediate re-scan would just repeat it. Only retry a genuine no-decode.
    if (err or not text) and retry_once and not is_port_error(err):
        log.info("Scan attempt 1 failed (%s) — retrying", err or "no barcode")
        text, raw, err = port.trigger_and_read(timeout_s)
        attempts = 2
    return {"barcode": text, "rawPayload": raw, "error": err, "attempts": attempts}


def search_scan(port: ScannerPort, run_id: str, pipette_id: str,
                x: float, y: float, z: float) -> dict:
    """Fallback when the on-point scan fails: raster SEARCH_OFFSETS around the
    taught point, scanning (short dwell, scanner re-triggering) at each stop.
    Compensates for barcode-placement variance and acrylic-deck optics. Returns
    a scan dict; the first stop that decodes wins."""
    last = {"barcode": None, "rawPayload": None, "error": "search found nothing", "attempts": 0}
    for i, (dx, dy, dz) in enumerate(SEARCH_OFFSETS):
        try:
            move_to_coordinates(run_id, pipette_id, x + dx, y + dy, z - dz)
        except Exception as e:
            log.warning("search move (dx=%+d dy=%+d dz=-%d) failed: %s", dx, dy, dz, e)
            continue
        text, raw, err = port.trigger_and_read(SEARCH_DWELL_S, clamp=False)
        last = {"barcode": text, "rawPayload": raw, "error": err, "attempts": 1}
        if text:
            log.info("search hit at dx=%+d dy=%+d dz=-%d", dx, dy, dz)
            return last
        if is_port_error(err):
            # The scanner is down, not mis-aimed. Every remaining stop would be a
            # gantry move feeding a dead port — minutes of motion that cannot
            # succeed, while the single command worker blocks everything behind it.
            log.warning("search aborted after %d/%d stop(s) — scanner port is down (%s)",
                        i + 1, len(SEARCH_OFFSETS), err)
            return last
    return last


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
            # On failure, raster a small grid around the taught point (placement
            # variance + acrylic optics) — first stop that decodes wins. But only
            # when the scanner actually WORKED and just didn't decode; rastering a
            # dead port is pure dead time.
            if not scan["barcode"] and not is_port_error(scan["error"]):
                log.info("Slot %d: on-point scan failed — searching grid", slot_index + 1)
                scan = search_scan(port, maint_run_id, pipette_id, pos["x"], pos["y"], pos["z"])
                if scan["barcode"]:
                    log.info("Slot %d: recovered via grid search", slot_index + 1)
            elif not scan["barcode"]:
                log.warning("Slot %d: scanner port is down (%s) — skipping grid search",
                            slot_index + 1, scan["error"])
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
        # Same grid-search fallback as the sweep if the deck QR didn't decode —
        # and, as there, only when the scanner itself is alive.
        if not scan["barcode"] and not is_port_error(scan["error"]):
            log.info("deck_scan: on-point scan failed — searching grid")
            scan = search_scan(port, maint_run_id, pipette_id, pos["x"], pos["y"], pos["z"])
        elif not scan["barcode"]:
            log.warning("deck_scan: scanner port is down (%s) — skipping grid search", scan["error"])
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


AUTO_RESUME_TIMEOUT_S = float(os.environ.get("AUTO_RESUME_TIMEOUT_S", "75"))


def execute_auto_resume_run(command_id: str, payload: dict) -> None:
    """Auto-resume the protocol's initial off-deck / 'confirm deck loaded' pause
    so the operator can start the scan and walk away (they're routed to the
    gallery, not the run page). Waits for the FIRST pause after play and resumes
    it once with 'play' (the OT-2 has no 'resume' action). Leaves any later pause
    or error-recovery state alone."""
    run_id = (payload or {}).get("runId")
    if not run_id:
        _post_result(command_id, {"ok": False, "error": "auto_resume_run: no runId"})
        return
    log.info("auto_resume_run %s: watching run %s for the initial pause", command_id, run_id)
    deadline = time.time() + AUTO_RESUME_TIMEOUT_S
    resumed = False
    declined = False
    while time.time() < deadline:
        time.sleep(1.0)
        data = _fetch_run(run_id)
        if data is None:
            continue
        status = data.get("status")
        if status == "paused":
            # Only the engine's own start-of-run pause is ours to clear. If the
            # pause was COMMANDED, an operator asked for it — leave it alone.
            # Without this the daemon would undo a Pause pressed inside the
            # AUTO_RESUME_TIMEOUT_S window, which is the same bug the browser had.
            if pause_was_commanded(data):
                declined = True
                log.info("auto_resume_run %s: run %s was paused on purpose — not resuming",
                         command_id, run_id)
                break
            try:
                ot2_request("POST", "/runs/{}/actions".format(run_id),
                            {"data": {"actionType": "play"}}, timeout=10)
                resumed = True
                log.info("auto_resume_run %s: resumed initial pause on %s", command_id, run_id)
            except Exception as e:
                log.warning("auto_resume_run %s: resume failed: %s", command_id, e)
            break
        if status in ("succeeded", "failed", "stopped"):
            log.info("auto_resume_run %s: run %s ended (%s) before pausing", command_id, run_id, status)
            break
        # 'running' / 'idle' / None -> keep waiting for the initial pause
    _post_result(command_id, {"ok": True, "status": 200,
                              "body": {"resumed": resumed, "declined": declined}})


# Tip calibration (NATIVE-CALIBRATION-SYSTEM PRD 4) -------------------------
# Replicates the protocols' pick_up_and_calibrate_tip(): pick up a tip, touch it
# against the calibrator's limit switches over serial, and return the per-tip
# {x,y} "adjust" (how far the bent tip is off nominal). BIMS triggers this BEFORE
# jog-tuning so captured geometry is tip-zeroed, and applies the adjust to every
# subsequent move-to during tuning.
#
# The motion is driven over the maintenance API (move_to_coordinates, forceDirect
# like the .py); the serial probe + the offset math are carried VERBATIM from
# Wax_Filling_GEN7_Cartridge.py. Two things are robot-validation-gated and noted
# inline: (a) the calibrator serial fixture is a SECOND /dev/ttyACM device (not
# the scanner on SCANNER_SERIAL_PORT); (b) the carriage-frame constants
# (150.536 / 177.0) and the calibrator nominal (125.181, 173.247) are the .py's —
# absolute probe points are derived by translating the .py recipe onto the
# BIMS-supplied absolute calibrator point, so adjust stays frame-independent.
CAL_NOMINAL_X = 125.181  # .py calibrator approach point in the carriage frame
CAL_NOMINAL_Y = 173.247

# The X probe does NOT start from the same place in the two fill protocols, and
# the measured adjust is a function of how far the tip travels before it trips
# the switch — so the start point is part of the measurement, not a detail.
#
#   Wax_Filling_GEN7_Cartridge.py:697   x_pos = cal_x - 0.6 ; y_pos = cal_y - 6.5
#   Reagent_Filling_GEN7.py:617         x_pos = cal_x - 1.4 ; y_pos = cal_y - 7.0
#
# This daemon used to hardcode the WAX numbers for every profile. The Studio
# therefore taught every deck — wax holes AND reagent holes — against the wax
# probe, while a reagent fill measured against the reagent probe. Starting 0.8mm
# further left means 0.8mm less travel to the switch, so the fill's adjust came
# out ~0.8mm less negative than the one the deck was taught with, and every
# reagent hole landed ~0.8mm to the RIGHT. Hole radius is 0.9mm, so it missed.
# (Wax was self-consistent by accident: its recipe *is* the hardcoded one.)
#
# Deltas are held relative to the nominal point so they translate onto whatever
# absolute calibrator location BIMS supplies, exactly like the .py does.
CAL_PROBE_RECIPES = {
    "wax":     {"x_dx": -0.6, "x_dy": -6.5},
    "reagent": {"x_dx": -1.4, "x_dy": -7.0},
}
CAL_PROBE_Y_DX = 8.829   # Y probe start — identical in both protocols
CAL_PROBE_Y_DY = -7.5


def _resolve_cal_profile(payload: dict, tip: dict) -> str:
    """Which fill's probe recipe to use: 'wax' or 'reagent'.

    Prefers the explicit profile BIMS sends. Falls back to the tiprack loadName,
    which is unambiguous (20uL rack = wax / p20, 200uL Biotix = reagent / p300).
    Deliberately does NOT infer from z_cal: B07's zCalWax is 40.15, close enough
    to reagent's 40.8 to guess wrong.
    """
    explicit = str((payload or {}).get("profile") or "").strip().lower()
    if explicit in CAL_PROBE_RECIPES:
        return explicit
    load_name = str((tip or {}).get("loadName") or "").lower()
    if "200ul" in load_name or "biotix" in load_name:
        return "reagent"
    if "20ul" in load_name:
        return "wax"
    return "wax"  # historical default


_BEND_RE = re.compile(rb"(-?\d+(?:\.\d+)?)\s*:\s*(-?\d+(?:\.\d+)?)")


def _parse_bend(raw: bytes):
    """Parse the calibrator's 'C' reply → {x,y} or None. Regex, not positional
    slicing: some calibrator fixtures prefix the value (B07 answers
    b'= -0.2:2.3\\r\\n' where R04/B14 answer bare b'-4.5:0.8\\r\\n'), and the
    old str(bytes)[2:] slicing choked on the prefix — so the daemon skipped the
    real calibrator and reported "fixture not found" with it plugged in fine."""
    if not raw:
        return None
    m = _BEND_RE.search(raw)
    if not m:
        return None
    try:
        return {"x": float(m.group(1)), "y": float(m.group(2))}
    except Exception:
        return None


def _open_calibrator_serial():
    """Find + open the calibrator limit-switch fixture by PROBING each /dev/ttyACM
    with 'C' — the calibrator replies with its bend string ('x:y'); the barcode
    scanner (and anything else) does not. This is robust to port ordering and to
    SCANNER_SERIAL_PORT being a udev symlink (e.g. /dev/scanner → ttyACMn), which
    the old raw-string compare missed — so it was opening the SCANNER, the arm
    bytes went nowhere, and the probe never saw a limit hit. Skips the scanner's
    resolved device. Returns (serial, bend_dict) or (None, None)."""
    try:
        scanner_real = os.path.realpath(SERIAL_PORT) if SERIAL_PORT else None
    except Exception:
        scanner_real = None
    for dev in sorted(glob.glob("/dev/ttyACM?")):
        try:
            if scanner_real and os.path.realpath(dev) == scanner_real:
                log.info("calibrate_tip: %s is the scanner — skipping", dev)
                continue
        except Exception:
            pass
        try:
            s = serial.Serial(port=dev, baudrate=115200, timeout=0.5)
            time.sleep(0.2)
            s.reset_input_buffer()
            s.reset_output_buffer()
            s.write(b"C")
            s.flush()
            time.sleep(0.2)
            bend = _parse_bend(s.readline())
            if bend is not None:
                log.info("calibrate_tip: calibrator found on %s (bend x=%s y=%s)", dev, bend["x"], bend["y"])
                return s, bend
            log.info("calibrate_tip: %s did not answer 'C' — not the calibrator", dev)
            s.close()
        except Exception as e:
            log.warning("calibrate_tip: probe %s failed: %s", dev, e)
    return None, None


def _cal_write(s: "serial.Serial", data: bytes, retries: int = 3) -> None:
    last = None
    for _ in range(retries):
        try:
            s.reset_output_buffer()
            s.write(data)
            s.flush()
            return
        except serial.SerialException as e:
            last = e
            time.sleep(0.1)
    raise serial.SerialException("calibrator write failed: {}".format(last))


def register_labware_definition(run_id: str, definition: dict) -> None:
    r = ot2_request("POST", "/maintenance_runs/{}/labware_definitions".format(run_id),
                    {"data": definition}, timeout=20)
    if r.status_code >= 400:
        body = {}
        try:
            body = r.json() or {}
        except Exception:
            pass
        raise RobotCommandError(_first_error_detail(body) or
                                "Robot returned {} registering labware def".format(r.status_code))


def load_labware_in_run(run_id: str, namespace: str, load_name: str, version: int, slot: str) -> str:
    body = send_maintenance_command(run_id, "loadLabware", {
        "location": {"slotName": str(slot)},
        "loadName": load_name,
        "namespace": namespace,
        "version": int(version or 1),
    })
    lid = ((body.get("data") or {}).get("result") or {}).get("labwareId")
    if not lid:
        raise RobotCommandError("loadLabware did not return a labwareId")
    return lid


def pick_up_tip_in_run(run_id: str, pipette_id: str, labware_id: str, well: str) -> None:
    send_maintenance_command(run_id, "pickUpTip", {
        "pipetteId": pipette_id, "labwareId": labware_id, "wellName": well,
        "wellLocation": {"origin": "top", "offset": {"x": 0, "y": 0, "z": 0}},
    })


def drop_tip_in_run(run_id: str, pipette_id: str, labware_id: str, well: str) -> None:
    try:
        send_maintenance_command(run_id, "dropTip", {
            "pipetteId": pipette_id, "labwareId": labware_id, "wellName": well,
        })
    except Exception as e:
        log.warning("calibrate_tip: drop tip failed (continuing): %s", e)


# Tip-calibration motion speeds (mm/s) — ~1/3 of the .py's (approach 20, probe 5)
# so the operator can watch the probe creep onto the limit switch. Tune here.
CAL_APPROACH_SPEED = 7.0
CAL_PROBE_SPEED = 2.0


def _probe_axis(run_id: str, pipette_id: str, ser: "serial.Serial",
                axis: str, start_x: float, start_y: float, z: float,
                arm_byte: bytes) -> Tuple[float, bool]:
    """Step the tip 0.1mm/iter along `axis` (-x or -y) until the limit switch
    replies arm_byte, mirroring the .py. Returns (shift_at_limit, reached)."""
    move_to_coordinates(run_id, pipette_id, start_x, start_y, z, speed=CAL_APPROACH_SPEED)
    _cal_write(ser, arm_byte)
    shift = 0.1
    reached = False
    while not reached:
        if axis == "x":
            move_to_coordinates(run_id, pipette_id, start_x - shift, start_y, z, speed=CAL_PROBE_SPEED)
        else:
            move_to_coordinates(run_id, pipette_id, start_x, start_y - shift, z, speed=CAL_PROBE_SPEED)
        shift += 0.1
        if shift > 5:
            log.warning("calibrate_tip: %s axis hit 5mm travel without limit", axis)
            break
        original = ser.timeout
        ser.timeout = 0.01
        try:
            reached = ser.read(1) == arm_byte
        finally:
            ser.timeout = original
    return shift, reached


# ── Live limit-switch watch (calibrator_watch) ────────────────────────────────
# The operator hand-jogs the tip onto the calibrator while this listens; every
# switch closure is reported to BIMS with its timestamp and the pipette position
# at that moment. That is what LOCATES the fixture.
#
# Deliberately the mirror image of execute_calibrate_tip: that routine drives the
# gantry itself in a closed loop and returns one net adjust{x,y}, measuring a TIP
# against a fixture whose position is already known. This one COMMANDS NO MOTION
# AT ALL — the operator drives — and reports individual trips instead of a net
# number, because "where did the switch close" is the measurement wanted here.
#
# ATTACHED-ONLY, and that is a safety property rather than a convenience: it runs
# inside the Studio's open maintenance run and only ever READS position. A watch
# that opened its own run could move an arm the operator has their hands on.
WATCH_POLL_S = 0.02        # serial read timeout while listening for a trip
WATCH_HEARTBEAT_S = 3.0    # how often to ask BIMS "am I still wanted?"
WATCH_REARM_S = 0.35       # settle time before re-arming a switch after a trip
WATCH_MAX_DURATION_S = 1800


def _post_switch_event(command_id: str, payload: dict) -> bool:
    """POST one trip (or a heartbeat) — returns True when BIMS wants us to STOP.

    Fails SAFE in the direction of continuing: a network blip returns False so
    one dropped request cannot silently end a watch the operator is mid-jog on.
    Only an explicit cancelRequested (or a terminal status, which the endpoint
    reports as a 409) stops it.
    """
    url = "{}/api/agent/ot2/commands/{}/switch-event".format(BIMS_BASE_URL, command_id)
    try:
        r = requests.post(url, headers=_bims_headers(), data=json.dumps(payload), timeout=10)
        try:
            body = r.json() or {}
        except Exception:
            body = {}
        if r.status_code == 409:
            log.info("calibrator_watch: BIMS says the watch is over (%s)", body.get("status"))
            return True
        if r.status_code >= 400:
            log.warning("switch-event POST %s: %s", r.status_code, r.text[:200])
            return False
        return bool(body.get("cancelRequested"))
    except Exception as e:
        log.warning("switch-event POST failed: %s", e)
        return False


def execute_calibrator_watch(command_id: str, payload: dict) -> None:
    """Arm the calibrator's limit switches and report each trip until stopped.

    payload:
      runId / pipetteId  — the Studio's OPEN maintenance run (both required)
      durationMs         — how long to stay armed
    """
    run_id = (payload or {}).get("runId")
    pipette_id = (payload or {}).get("pipetteId")
    if not run_id or not pipette_id:
        _post_result(command_id, {"ok": False,
                                  "error": "calibrator_watch: runId + pipetteId required "
                                           "(the watch attaches to the studio's run)"})
        return

    try:
        duration_s = min(float((payload or {}).get("durationMs") or 600000) / 1000.0,
                         WATCH_MAX_DURATION_S)
    except Exception:
        duration_s = 600.0

    ser, bend = _open_calibrator_serial()
    if not ser:
        _post_result(command_id, {"ok": False,
                                  "error": "calibrator fixture not found — no /dev/ttyACM device "
                                           "answered the 'C' bend query (scanner skipped)"})
        return
    if bend is None:
        bend = {"x": 0.0, "y": 0.0}

    log.info("calibrator_watch %s: armed on run %s (%.0fs, bend x=%s y=%s)",
             command_id, run_id, duration_s, bend["x"], bend["y"])

    deadline = time.time() + duration_s
    last_beat = time.time()
    trips = 0
    stop_reason = "duration elapsed"
    # Hoisted above the try so a failure part-way through can still report which
    # switch was live when it happened — that is the whole diagnosis.
    first_axis = b"Y" if str((payload or {}).get("firstAxis") or "").lower() == "y" else b"X"
    armed = first_axis
    failure = None

    try:
        # ONE axis armed at a time, in the order the switches are actually
        # touched — X first, then Y.
        #
        # This mirrors _probe_axis, the only code proven against this fixture: it
        # arms a single axis, waits for that byte, and moves on. Arming both at
        # once was never demonstrated to work, and if the fixture's arming is
        # EXCLUSIVE the second arm byte silently disarms the first — half the
        # trips would vanish with nothing on screen to say so. Sequential arming
        # is correct under BOTH readings of the hardware, so it removes the
        # question instead of betting on the answer.
        #
        # X first because that is the order both fill protocols probe in
        # (CAL_PROBE_RECIPES does the X probe, then the Y probe), so it is the
        # switch a normal approach reaches first. Overridable per command via
        # `firstAxis` for a fixture or approach that runs the other way round —
        # a config change, not a redeploy.
        _cal_write(ser, armed)
        log.info("calibrator_watch %s: armed %s (one axis at a time)",
                 command_id, armed.decode())

        ser.timeout = WATCH_POLL_S
        while time.time() < deadline:
            got = b""
            try:
                got = ser.read(1)
            except Exception as e:
                log.warning("calibrator_watch: serial read failed: %s", e)
                stop_reason = "serial read failed: {}".format(e)
                break

            # Only the ARMED axis is a real trip. Anything else on the wire is
            # a stale byte from a previous arm or a bounce, and crediting it
            # would stamp a position the operator was never at.
            if got == armed:
                # Timestamp FIRST, before the position round-trip: the trip is the
                # moment the switch closed, not the moment the robot got round to
                # answering. That gap is small, but it is exactly the quantity the
                # operator is being shown.
                tripped_at = datetime.now(timezone.utc).isoformat()
                axis = "x" if got == b"X" else "y"
                pos = None
                try:
                    pos = get_current_position(run_id, pipette_id)
                except Exception as e:
                    # A trip with no position is still worth reporting: it tells
                    # the operator the switch works and when it closed. Staying
                    # silent would look identical to the switch never firing.
                    log.warning("calibrator_watch: position read failed: %s", e)

                trips += 1
                log.info("calibrator_watch %s: %s switch tripped at %s", command_id, axis, pos)
                cancel = _post_switch_event(command_id, {
                    "axis": axis,
                    "trippedAt": tripped_at,
                    "position": pos,
                    "bend": bend,
                })
                if cancel:
                    stop_reason = "stopped from BIMS"
                    break

                # Hand off to the OTHER axis: that switch is the next one the
                # approach reaches, and after it fires we come back round to the
                # first. One armed at a time, cycling, so the operator can touch
                # off X → Y as many times as it takes to be happy.
                armed = b"Y" if armed == b"X" else b"X"
                time.sleep(WATCH_REARM_S)
                try:
                    # Drop anything that arrived during the settle window — it
                    # belongs to the switch we just read, not the one being armed.
                    ser.reset_input_buffer()
                    _cal_write(ser, armed)
                except Exception as e:
                    log.warning("calibrator_watch: arming %s after the %s trip failed: %s",
                                armed.decode(), axis, e)
                last_beat = time.time()
                continue

            # No trip. Trips are the only other traffic on this channel, so an
            # operator who presses Stop without touching a switch produces none —
            # without this the port would stay held until the deadline.
            if time.time() - last_beat >= WATCH_HEARTBEAT_S:
                last_beat = time.time()
                if _post_switch_event(command_id, {"heartbeat": True}):
                    stop_reason = "stopped from BIMS"
                    break
    except Exception as e:
        # Without this the command would sit at 'claimed' with no result and the
        # Studio would poll "waiting for bridge" forever — a hang the operator
        # cannot tell apart from a daemon that is simply busy. Same contract as
        # execute_calibrate_tip: every exit posts something.
        failure = str(e)
        log.error("calibrator_watch %s failed: %s", command_id, e)
    finally:
        try:
            ser.close()
        except Exception:
            pass

    if failure:
        _post_result(command_id, {"ok": False, "error": "calibrator_watch: {} (armed {} at the time, "
                                                        "{} trip(s) recorded)".format(
                                      failure, armed.decode(), trips)})
        return

    log.info("calibrator_watch %s: ended (%s) after %d trip(s)", command_id, stop_reason, trips)
    # ok:true even when the operator stopped it early — a watch that listened and
    # was told to stand down did its job. Only a fixture we could never open, or a
    # missing run, is a failure; both return above.
    _post_result(command_id, {"ok": True, "status": 200, "body": {
        "trips": trips,
        "stopReason": stop_reason,
        "bend": bend,
        "attached": True,
        # Which switch was still waiting when this ended — the first thing to look
        # at when an operator says "it stopped seeing my touches".
        "armedAtEnd": armed.decode() if armed else None,
        "firstAxis": first_axis.decode(),
    }})


def execute_calibrate_tip(command_id: str, payload: dict) -> None:
    """PRD 4: probe the tip on the calibrator, return adjust{x,y}. KEEPS the tip on.

    Two modes:
      ATTACHED (payload has runId + pipetteId): probe inside the STUDIO's existing
        maintenance run with the tip already picked up there — the tip + run stay
        live afterward so the operator tunes the deck with that same calibrated tip.
        We do NOT pick up, drop, home, or close in this mode.
      STANDALONE (no runId): open our own run, pick up a tip, probe, keep the tip,
        close the run. (Used if ever triggered outside the studio.)

    payload:
      runId / pipetteId                — studio session to probe inside (ATTACHED)
      pipetteMount / pipetteName       — pipette selection (STANDALONE)
      tiprack: { definition, namespace, loadName, version, slot, tipWell }
      calibrator: { x, y, z }          — ABSOLUTE approach point (BIMS fixture);
                                         z is the per-tip z_cal (34.491 wax / 40.8 reagent)
    """
    cal = (payload or {}).get("calibrator") or {}
    tip = (payload or {}).get("tiprack") or {}
    cal_profile = _resolve_cal_profile(payload, tip)
    try:
        cal_x = float(cal["x"]); cal_y = float(cal["y"]); z_cal = float(cal["z"])
    except Exception:
        _post_result(command_id, {"ok": False, "error": "calibrate_tip: calibrator {x,y,z} required"})
        return


    attached_run = (payload or {}).get("runId")
    attached_pip = (payload or {}).get("pipetteId")
    attached = bool(attached_run and attached_pip)

    run_id = None
    own_run = not attached  # only close a run we opened ourselves
    ser = None
    try:
        if attached:
            run_id = attached_run
            pipette_id = attached_pip
            log.info("calibrate_tip %s: ATTACHED to studio run %s (tip already on)", command_id, run_id)
        else:
            run_id = open_maintenance_run()
            log.info("calibrate_tip %s: STANDALONE run %s", command_id, run_id)
            pipette_id = _setup_pipette(run_id, payload)
            home_gantry(run_id)
            if tip.get("definition"):
                register_labware_definition(run_id, tip["definition"])
            lid = load_labware_in_run(run_id, tip.get("namespace", ""), tip.get("loadName", ""),
                                      tip.get("version", 1), tip.get("slot", "11"))
            pick_up_tip_in_run(run_id, pipette_id, lid, tip.get("tipWell", "A1"))

        # Find + open the calibrator fixture by probing 'C' (returns its bend).
        ser, bend = _open_calibrator_serial()
        if not ser:
            raise RobotCommandError("calibrator fixture not found — no /dev/ttyACM device "
                                    "answered the 'C' bend query (scanner skipped)")
        if bend is None:
            bend = {"x": 0.0, "y": 0.0}
        log.info("calibrate_tip: bend x=%s y=%s", bend["x"], bend["y"])

        # Where to probe from. ATTACHED: keep the tip's CURRENT X/Y as the
        # reference (the operator may have jogged onto the fixture) but ALWAYS
        # probe at the fill's z_cal for this mount (reagent 40.8 / wax 34.491).
        # Probing at the tip's current Z instead (e.g. the studio's 38.5 park
        # height) pressed the switch levers 2.3mm+ away from where every fill
        # probes them, biasing the measured adjust between the teach frame and
        # the fill frame — a persistent studio-vs-fill offset no amount of deck
        # re-teaching could remove. STANDALONE: saved point, approach first.
        if attached:
            cur = get_current_position(run_id, pipette_id)
            ref_x = cur["x"] if cur["x"] is not None else cal_x
            ref_y = cur["y"] if cur["y"] is not None else cal_y
            z_probe = z_cal
            if cur["z"] is None or abs(cur["z"] - z_cal) > 1e-6:
                move_to_coordinates(run_id, pipette_id, ref_x, ref_y, z_cal, speed=CAL_APPROACH_SPEED)
            log.info("calibrate_tip: probing from x=%s y=%s at z_cal=%s (tip was at z=%s)",
                     ref_x, ref_y, z_cal, cur["z"])
        else:
            ref_x, ref_y, z_probe = cal_x, cal_y, z_cal
            move_to_coordinates(run_id, pipette_id, cal_x, cal_y, z_cal, speed=CAL_APPROACH_SPEED)

        # Translate the .py probe recipe onto the start reference.
        ptx = ref_x - CAL_NOMINAL_X
        pty = ref_y - CAL_NOMINAL_Y

        # X probe — start point comes from THIS fill's recipe, not a hardcoded
        # one. Using the wax start for a reagent tip biases the adjust by 0.8mm,
        # which is wider than a 1.8mm hole's radius. See CAL_PROBE_RECIPES.
        recipe = CAL_PROBE_RECIPES[cal_profile]
        x_start = CAL_NOMINAL_X + recipe["x_dx"] + ptx
        y_start = CAL_NOMINAL_Y + recipe["x_dy"] + pty
        log.info("calibrate_tip: %s recipe — X probe from x=%.3f y=%.3f",
                 cal_profile, x_start, y_start)
        x_shift, x_ok = _probe_axis(run_id, pipette_id, ser, "x",
                                    x_start, y_start, z_probe, b"X")
        # adjust = (calibrator C-string baseline) - travel-to-switch. The old
        # hardcoded position constant (150.536/177.0) that produced a ~32mm jump
        # is GONE — the C string is now the baseline the operator dials in.
        x_offset = round(bend["x"] - x_shift, 1)

        # Y probe — identical recipe in both protocols (cal_x + 8.829, cal_y - 7.5).
        y_shift, y_ok = _probe_axis(run_id, pipette_id, ser, "y",
                                    CAL_NOMINAL_X + CAL_PROBE_Y_DX + ptx,
                                    CAL_NOMINAL_Y + CAL_PROBE_Y_DY + pty, z_probe, b"Y")
        y_offset = round(bend["y"] - y_shift, 1)

        # Retract (slow, lift off the fixture). KEEP THE TIP ON — the operator
        # uses it to tune the deck next. (No drop_tip.)
        move_to_coordinates(run_id, pipette_id, 127.181 + ptx, 174.247 + pty, z_probe + 20, speed=CAL_APPROACH_SPEED)

        # If an axis never tripped its limit switch, the probe is INVALID — the
        # computed offset is garbage (full 5mm travel). Fail loudly so BIMS does
        # NOT store/apply a bogus adjust to the deck tuning.
        if not (x_ok and y_ok):
            bad = ", ".join(a for a, ok in (("X", x_ok), ("Y", y_ok)) if not ok)
            raise RobotCommandError(
                "tip calibration failed: {} limit switch not reached within 5mm — "
                "tip didn't contact the fixture (check z_cal / calibrator position). "
                "No adjust applied.".format(bad)
            )

        result = {
            "adjust": {"x": x_offset, "y": y_offset},
            "bend": bend,
            "limitReached": {"x": x_ok, "y": y_ok},
            "zCal": z_cal,
            "tipKept": True,
            "attached": attached,
        }
        log.info("calibrate_tip %s: adjust x=%s y=%s (limit x=%s y=%s, attached=%s, tip kept)",
                 command_id, x_offset, y_offset, x_ok, y_ok, attached)
        _post_result(command_id, {"ok": True, "status": 200, "body": result})
    except Exception as e:
        log.error("calibrate_tip %s failed: %s", command_id, e)
        _post_result(command_id, {"ok": False, "error": str(e)})
    finally:
        if ser:
            try:
                ser.close()
            except Exception:
                pass
        # Leave the studio's run open in ATTACHED mode (tip stays on for tuning).
        if own_run and run_id:
            try:
                close_maintenance_run(run_id)
            except Exception as e:
                log.warning("calibrate_tip: close run failed: %s", e)


TIP_SWAP_REQUEST_PATH = "/data/ot2-bridge/tip-swap-request.json"


def execute_tip_swap_request(command_id: str, payload: dict) -> None:
    """Operator pressed "Swap tip" on the BIMS wax run page. The running wax
    protocol polls TIP_SWAP_REQUEST_PATH before every dispense; when it finds
    the file it empties the tip into the source, swaps the tip (mode 'rack' =
    robot takes the next tracked tip; 'hand' = pauses for the operator to push
    one on), re-probes it on the calibrator, re-aspirates and continues at the
    very well it was about to fill. The protocol deletes the file when it acts.
    payload: { mode: 'rack'|'hand', cancel?: bool }"""
    try:
        if payload.get("cancel"):
            try:
                os.remove(TIP_SWAP_REQUEST_PATH)
                log.info("tip_swap_request %s: cancelled (file removed)", command_id)
            except FileNotFoundError:
                pass
            _post_result(command_id, {"ok": True, "status": 200, "body": {"cancelled": True}})
            return
        mode = "hand" if str(payload.get("mode") or "rack") == "hand" else "rack"
        os.makedirs(os.path.dirname(TIP_SWAP_REQUEST_PATH), exist_ok=True)
        tmp = TIP_SWAP_REQUEST_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"mode": mode, "requestedAt": time.time(),
                       "requestedBy": payload.get("requestedBy"), "runId": payload.get("runId")}, f)
        os.replace(tmp, TIP_SWAP_REQUEST_PATH)
        log.info("tip_swap_request %s: mode=%s written to %s", command_id, mode, TIP_SWAP_REQUEST_PATH)
        _post_result(command_id, {"ok": True, "status": 200, "body": {"mode": mode, "path": TIP_SWAP_REQUEST_PATH}})
    except Exception as e:
        log.error("tip_swap_request %s failed: %s", command_id, e)
        _post_result(command_id, {"ok": False, "error": str(e)})


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
    elif kind == "auto_resume_run":
        execute_auto_resume_run(command_id, cmd.get("payload") or {})
    elif kind == "calibrate_tip":
        execute_calibrate_tip(command_id, cmd.get("payload") or {})
    elif kind == "calibrator_watch":
        execute_calibrator_watch(command_id, cmd.get("payload") or {})
    elif kind == "tip_swap_request":
        execute_tip_swap_request(command_id, cmd.get("payload") or {})
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

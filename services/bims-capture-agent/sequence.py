"""Auto-capture sequence engine for the microscope capture station.

After a cartridge is scanned/locked, the operator (or an auto-start-on-scan
toggle in the browser) triggers a timed run of full-resolution stills. This
module owns that run: on a timer it grabs a still from the *shared* camera
handle (camera.grab_still — no second device open), JPEG-encodes it, spools it
to disk for power-loss resilience, and uploads it to BIMS via the existing
agent-keyed ingest endpoint POST /api/cv/capture-ingest. Progress is streamed
back to the browser over the agent WebSocket.

Grid: each shot slot (1..count) is pre-stamped with a named grid location
(row 'A'.., col 1..) per GRID_ROWS × GRID_COLS in GRID_ORDER, so photos can be
labeled by physical position later. rows*cols must equal count; on a mismatch
the run still captures but omits location rather than stamping wrong slots.

Config (env, all with defaults):
  SEQUENCE_COUNT=15        default shot count (per-run overridable)
  SEQUENCE_INTERVAL_MS=2000 ms between shots (per-run overridable)
  GRID_ROWS=3, GRID_COLS=5  grid shape; rows*cols must equal count for location
  GRID_ORDER=row-major     'row-major' | 'serpentine'
  SPOOL_DIR=~/bims-spool   local spool root
  BIMS_URL                 ingest base URL (reused from the agent)
  AGENT_API_KEY            ingest auth (falls back to STATION_AGENT_KEY) — see
                           _ingest_api_key for the header/key mismatch note.
"""

from __future__ import annotations

import asyncio
import logging
import os
import random
import time
from pathlib import Path
from typing import Awaitable, Callable, Optional

import aiohttp
import cv2

log = logging.getLogger("bims-capture-agent.sequence")

# Async callback that fans a JSON-serializable event out to the connected
# browser(s). Injected by agent.py so this module stays decoupled from the
# WebSocket client set.
Broadcast = Callable[[dict], Awaitable[None]]

# Blocking accessor returning the latest full-resolution BGR frame (numpy
# array) or None. Injected by agent.py (camera.grab_still).
GrabStill = Callable[[], Optional[object]]

_JPEG_QUALITY = 92
_UPLOAD_BACKOFFS = (1, 3, 9)  # seconds; 3 retries after the initial attempt


# ----------------------------- config -------------------------------
def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "").strip())
    except (TypeError, ValueError):
        return default


def _coerce_int(value: object, default: int) -> int:
    """Coerce an optional per-run override (may be None / str / float) to int."""
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _grid_config() -> tuple[int, int, str]:
    rows = _env_int("GRID_ROWS", 3)
    cols = _env_int("GRID_COLS", 5)
    order = os.environ.get("GRID_ORDER", "row-major").strip().lower() or "row-major"
    if order not in ("row-major", "serpentine"):
        log.warning("unknown GRID_ORDER=%r — defaulting to row-major", order)
        order = "row-major"
    return rows, cols, order


def _spool_root() -> Path:
    raw = os.environ.get("SPOOL_DIR", "").strip()
    if raw:
        return Path(os.path.expanduser(raw))
    return Path(os.path.expanduser("~")) / "bims-spool"


def _spool_path(sequence_id: str, index: int) -> Path:
    return _spool_root() / sequence_id / f"{index:02d}.jpg"


def _ingest_api_key() -> str:
    """Key sent to /api/cv/capture-ingest.

    The ingest endpoint authenticates via requireAgentApiKey(), which matches
    the BIMS env AGENT_API_KEY and reads the header x-agent-api-key. That is a
    DIFFERENT secret from STATION_AGENT_KEY (heartbeat/registration, header
    x-station-agent-key). We prefer AGENT_API_KEY and fall back to
    STATION_AGENT_KEY for fleets that provision only the fleet key and set the
    two equal. See the deviation note in the task report.
    """
    return (
        os.environ.get("AGENT_API_KEY", "").strip()
        or os.environ.get("STATION_AGENT_KEY", "").strip()
    )


def _new_sequence_id() -> str:
    return f"seq_{int(time.time() * 1000)}_{random.randint(0, 0xFFFF):04x}"


# --------------------------- grid mapping ---------------------------
def grid_location(
    index: int, count: int, rows: int, cols: int, order: str
) -> Optional[dict]:
    """Map a 1-based shot slot to a {'row': 'A'.., 'col': 1..} grid location.

    Returns None when rows*cols != count (caller omits location) or when index
    is out of range. row-major fills A1..A5, B1..B5, ...; serpentine reverses
    the column direction on every other row (A left→right, B right→left, ...).
    """
    if rows * cols != count:
        return None
    if index < 1 or index > count:
        return None
    zero = index - 1
    row_idx = zero // cols
    col_in_row = zero % cols
    if order == "serpentine" and row_idx % 2 == 1:
        col_in_row = cols - 1 - col_in_row
    return {"row": chr(ord("A") + row_idx), "col": col_in_row + 1}


# --------------------------- capture/upload -------------------------
def _capture_jpeg(grab_still: GrabStill) -> Optional[bytes]:
    """Grab a full-res still and JPEG-encode it. Runs in a worker thread."""
    frame = grab_still()
    if frame is None:
        return None
    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), _JPEG_QUALITY])
    if not ok:
        return None
    return buf.tobytes()


async def _upload_still(
    session: aiohttp.ClientSession,
    base_url: str,
    api_key: str,
    cartridge_id: str,
    sequence_id: str,
    index: int,
    location: Optional[dict],
    jpeg: bytes,
) -> Optional[str]:
    """Multipart-upload one still to /api/cv/capture-ingest with retry/backoff.

    Returns the imageId on success (HTTP 201), else None after all attempts.
    """
    url = f"{base_url}/api/cv/capture-ingest"
    # SvelteKit's CSRF guard 403s any form-content POST whose Origin header is
    # absent or mismatched — native clients send none by default, which is why
    # ingest worked against `vite dev` (guard disabled in dev) but failed
    # against every production build. Sending our own base URL as Origin makes
    # the request same-origin.
    headers = {"x-agent-api-key": api_key, "Origin": base_url}
    attempts = len(_UPLOAD_BACKOFFS) + 1  # initial + 3 retries
    for attempt in range(attempts):
        try:
            form = aiohttp.FormData()
            form.add_field(
                "file",
                jpeg,
                filename=f"{sequence_id}_{index:02d}.jpg",
                content_type="image/jpeg",
            )
            form.add_field("qrCode", cartridge_id)
            form.add_field("photoType", "microscope")
            form.add_field("sequenceId", sequence_id)
            form.add_field("sequenceIndex", str(index))
            if location is not None:
                form.add_field("locationRow", str(location["row"]))
                form.add_field("locationCol", str(location["col"]))
            async with session.post(url, data=form, headers=headers) as resp:
                if resp.status == 201:
                    data = await resp.json()
                    return data.get("imageId")
                text = await resp.text()
                log.warning(
                    "capture-ingest shot %d HTTP %d: %s",
                    index,
                    resp.status,
                    text[:200],
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # network / timeout / encode
            log.warning(
                "capture-ingest shot %d upload error (attempt %d/%d): %s",
                index,
                attempt + 1,
                attempts,
                exc,
            )
        if attempt < len(_UPLOAD_BACKOFFS):
            await asyncio.sleep(_UPLOAD_BACKOFFS[attempt])
    return None


# --------------------------- the runner -----------------------------
class SequenceManager:
    """Owns the single in-flight sequence run for this agent process."""

    def __init__(self) -> None:
        self._task: Optional[asyncio.Task] = None
        self._abort = asyncio.Event()
        self._current_id: Optional[str] = None
        # Optional live/still-split hooks (camera.enter/exit_still_mode) —
        # hold the sensor at still resolution for the whole run.
        self._still_enter: Optional[Callable[[], None]] = None
        self._still_exit: Optional[Callable[[], None]] = None

    def is_running(self) -> bool:
        return self._task is not None and not self._task.done()

    @property
    def current_id(self) -> Optional[str]:
        return self._current_id if self.is_running() else None

    async def start(
        self,
        *,
        cartridge_id: object,
        count: object,
        interval_ms: object,
        grab_still: GrabStill,
        broadcast: Broadcast,
        still_enter: "Optional[Callable[[], None]]" = None,
        still_exit: "Optional[Callable[[], None]]" = None,
    ) -> tuple[bool, str]:
        """Start a run. Returns (True, sequenceId) or (False, error_message)."""
        if self.is_running():
            return False, "a sequence is already running"
        if not cartridge_id or not str(cartridge_id).strip():
            return False, "cartridgeId is required"
        cid = str(cartridge_id).strip()
        n = _coerce_int(count, _env_int("SEQUENCE_COUNT", 15))
        interval = _coerce_int(interval_ms, _env_int("SEQUENCE_INTERVAL_MS", 2000))
        if n < 1:
            return False, "count must be >= 1"

        self._abort.clear()
        self._current_id = _new_sequence_id()
        self._still_enter = still_enter
        self._still_exit = still_exit
        self._task = asyncio.create_task(
            self._run(cid, n, interval, grab_still, broadcast),
            name="bims-sequence",
        )
        return True, self._current_id

    def abort(self) -> None:
        self._abort.set()

    async def shutdown(self) -> None:
        """Abort and await the run — for agent cleanup."""
        self.abort()
        if self._task is not None:
            try:
                await self._task
            except Exception:
                pass

    async def _run(
        self,
        cartridge_id: str,
        count: int,
        interval_ms: int,
        grab_still: GrabStill,
        broadcast: Broadcast,
    ) -> None:
        sequence_id = self._current_id or _new_sequence_id()
        base_url = os.environ.get("BIMS_URL", "").rstrip("/")
        api_key = _ingest_api_key()
        if not base_url or not api_key:
            await broadcast(
                {
                    "event": "sequence_error",
                    "message": "BIMS_URL or agent API key not configured",
                }
            )
            return

        rows, cols, order = _grid_config()
        grid_ok = rows * cols == count
        if not grid_ok:
            log.warning(
                "sequence %s: grid %dx%d (=%d) != count %d — locations omitted",
                sequence_id,
                rows,
                cols,
                rows * cols,
                count,
            )

        interval_s = max(0.0, interval_ms / 1000.0)
        uploaded = 0
        failed = 0
        aborted = False

        log.info(
            "sequence %s start: cartridge=%s count=%d interval=%dms grid=%dx%d/%s",
            sequence_id,
            cartridge_id,
            count,
            interval_ms,
            rows,
            cols,
            order,
        )

        # Live/still split: hold the sensor at still resolution for the WHOLE
        # run (renegotiation costs seconds on some cameras — never per shot).
        if self._still_enter is not None:
            try:
                await asyncio.to_thread(self._still_enter)
            except Exception:
                log.exception("still_enter hook failed — continuing at live res")

        try:
            timeout = aiohttp.ClientTimeout(total=30)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                for index in range(1, count + 1):
                    if self._abort.is_set():
                        aborted = True
                        break

                    location = (
                        grid_location(index, count, rows, cols, order)
                        if grid_ok
                        else None
                    )
                    jpeg = await asyncio.to_thread(_capture_jpeg, grab_still)
                    image_id: Optional[str] = None
                    ok_upload = False

                    if jpeg is None:
                        log.warning(
                            "sequence %s: no frame for shot %d", sequence_id, index
                        )
                        failed += 1
                    else:
                        spool_path = _spool_path(sequence_id, index)
                        try:
                            spool_path.parent.mkdir(parents=True, exist_ok=True)
                            spool_path.write_bytes(jpeg)
                        except OSError:
                            log.exception(
                                "sequence %s: spool write failed for shot %d",
                                sequence_id,
                                index,
                            )
                            spool_path = None
                        image_id = await _upload_still(
                            session,
                            base_url,
                            api_key,
                            cartridge_id,
                            sequence_id,
                            index,
                            location,
                            jpeg,
                        )
                        ok_upload = image_id is not None
                        if ok_upload:
                            uploaded += 1
                            if spool_path is not None:
                                try:
                                    spool_path.unlink()
                                except OSError:
                                    pass
                        else:
                            # Keep the spool file for post-hoc recovery.
                            failed += 1

                    await broadcast(
                        {
                            "event": "sequence_progress",
                            "sequenceId": sequence_id,
                            "index": index,
                            "count": count,
                            "imageId": image_id,
                            "uploaded": ok_upload,
                            "location": location,
                        }
                    )

                    # Interval wait that stays responsive to an abort.
                    if index < count:
                        try:
                            await asyncio.wait_for(
                                self._abort.wait(), timeout=interval_s
                            )
                            aborted = True
                            break
                        except asyncio.TimeoutError:
                            pass
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.exception("sequence %s crashed", sequence_id)
            await broadcast(
                {"event": "sequence_error", "message": str(exc)}
            )
            return
        finally:
            # Always restore the live resolution, even on crash/abort/cancel.
            if self._still_exit is not None:
                try:
                    await asyncio.to_thread(self._still_exit)
                except Exception:
                    log.exception("still_exit hook failed")

        log.info(
            "sequence %s done: uploaded=%d failed=%d aborted=%s",
            sequence_id,
            uploaded,
            failed,
            aborted,
        )
        await broadcast(
            {
                "event": "sequence_done",
                "sequenceId": sequence_id,
                "count": count,
                "uploaded": uploaded,
                "failed": failed,
                "aborted": aborted,
            }
        )


# Process-wide singleton — one sequence run at a time per agent.
manager = SequenceManager()

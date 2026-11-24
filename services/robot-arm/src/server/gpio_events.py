"""
Every change of the arm Pi's GPIO output pins, kept so BIMS can always tell
whether a trapdoor (GPIO 17 / 27) or the conveyor belt (GPIO 22 = Pin 15) was
on, when, and what turned it on (2026-11-24).

Why: on 2026-11-24 the Teach page showed Trapdoor A (GPIO 17) high while the
operator says nothing was pulsing. BIMS only logged the pulses it asked for,
and GET /gpio/status only gives the state at that instant, so it could not be
checked. Now gpio.py and conveyor.py report each write here.

    GET /gpio/events?since=<iso>&limit=500     (route lives in gpio.py)
        {events: [...oldest first], boot_id, now, pins: {"17": 0, ...}, last: {"17": {...}}}

Each event: {id, at (ISO, UTC), pin, state (0|1), source, ms?, held_ms?,
run_id?, loop_id?, note?}. Sources:
    bims-pulse    a REST pulse (/gpio/pulse, /gpio/sequence, /conveyor/pulse)
    replay-fire   a replay's or /fires/play's fire timer (run_id = the Pi's run)
    loop-driver   a replay fire while the wax-fill loop driver runs (loop_id)
    all-off       e-stop, /conveyor/stop, /conveyor/off
    shutdown      service exit
    boot          the pin as found when the service started (read, not written)
    unknown       the pin changed with no write from this service (watcher)

The chute barcode scanner drives no pin: its scan runs after a replay fire,
which is logged as replay-fire.

Only transitions are kept (a write that leaves the pin as it was is not an
event). A watcher thread reads the pins once a second and records any change
this service did not make, so a local script or `pinctrl set` shows as
"unknown". Writes and the watcher share one lock so a pulse is never mistaken
for an outside change.

Bounded: RING_SIZE events in memory, and a JSONL file in ~/.bims-arm that is
rotated at LOG_MAX_BYTES (one old copy kept). The ring is refilled from the
file at start, so a restart does not lose the history.

Stdlib only, so gpio.py and conveyor.py import it with a fallback.
"""

from __future__ import annotations

import contextlib
import contextvars
import json
import os
import re
import subprocess
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, Iterator, List, Optional

RING_SIZE = int(os.environ.get("GPIO_EVENTS_RING", "2000"))
LOG_PATH = Path(os.environ.get("GPIO_EVENTS_LOG", str(Path.home() / ".bims-arm" / "gpio-events.jsonl")))
LOG_MAX_BYTES = int(os.environ.get("GPIO_EVENTS_LOG_MAX_BYTES", str(512 * 1024)))
WATCH_S = float(os.environ.get("GPIO_WATCH_S", "1.0"))

SOURCES = ("bims-pulse", "replay-fire", "loop-driver", "all-off", "shutdown", "boot", "unknown")

BOOT_ID = uuid.uuid4().hex[:8]

#: Held around every pin write and its record, and around each watcher read.
write_lock = threading.RLock()

_ring: deque = deque(maxlen=RING_SIZE)
_seq = 0
_last_state: Dict[int, int] = {}
_last_on_at: Dict[int, float] = {}
_readers: Dict[int, Callable[[], Optional[int]]] = {}
_watcher: Optional[threading.Thread] = None

_ctx: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar("gpio_event_source", default=None)


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@contextlib.contextmanager
def source(name: str, **meta) -> Iterator[None]:
    """Writes inside this block are recorded with this source (and ms / run_id / note)."""
    tok = _ctx.set({"source": name, **{k: v for k, v in meta.items() if v is not None}})
    try:
        yield
    finally:
        _ctx.reset(tok)


def _loop_id() -> Optional[str]:
    try:
        from src.server.loop_driver import DRIVER  # type: ignore

        st = DRIVER.state
        return st.get("loop_id") if st.get("running") else None
    except Exception:
        return None


def _infer() -> dict:
    """Where a write came from when the caller did not say: the thread it runs on."""
    ctx = _ctx.get()
    if ctx:
        return dict(ctx)
    th = threading.current_thread()
    if th.name == "replay-fire":
        meta: dict = {"source": "replay-fire", "run_id": getattr(th, "run_id", None)}
        loop_id = _loop_id()
        if loop_id:
            meta.update(source="loop-driver", loop_id=loop_id)
        return meta
    return {"source": "unknown", "note": f"thread {th.name}"}


def _append_disk(ev: dict) -> None:
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        if LOG_PATH.exists() and LOG_PATH.stat().st_size > LOG_MAX_BYTES:
            LOG_PATH.replace(LOG_PATH.with_suffix(".jsonl.1"))
        with LOG_PATH.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(ev, separators=(",", ":")) + "\n")
    except Exception as exc:  # a full or read-only disk must never stop a pulse
        print(f"[gpio_events] disk log failed: {exc}", flush=True)


def _add(ev: dict) -> dict:
    global _seq
    _seq += 1
    ev = {"id": f"{BOOT_ID}-{_seq}", **{k: v for k, v in ev.items() if v is not None}}
    _ring.append(ev)
    _append_disk(ev)
    return ev


def record(pin: int, state: int, ms: Optional[int] = None, **meta) -> Optional[dict]:
    """A write that drove `pin` to `state`. Kept only when the pin changed. Never raises."""
    try:
        with write_lock:
            state = 1 if state else 0
            if _last_state.get(pin) == state:
                return None
            now = time.time()
            info = _infer()
            info.update({k: v for k, v in meta.items() if v is not None})
            ev: dict = {"at": _iso(now), "pin": pin, "state": state, **info}
            if state == 1:
                if ms is not None:
                    ev["ms"] = int(ms)
                elif "ms" in info:
                    ev["ms"] = int(info["ms"])
                _last_on_at[pin] = now
            else:
                ev.pop("ms", None)
                if pin in _last_on_at:
                    ev["held_ms"] = int((now - _last_on_at.pop(pin)) * 1000)
            _last_state[pin] = state
            return _add(ev)
    except Exception as exc:
        print(f"[gpio_events] record failed: {exc}", flush=True)
        return None


def _pinctrl_levels(pins: List[int]) -> Dict[int, dict]:
    """`pinctrl get` (Pi 5): each pin's mode and level, read without claiming it. {} when unavailable."""
    out: Dict[int, dict] = {}
    try:
        r = subprocess.run(["pinctrl", "get", ",".join(str(p) for p in pins)], capture_output=True, text=True, timeout=2)
    except Exception:
        return out
    # "17: op dl pd | lo // GPIO17 = output"
    for line in r.stdout.splitlines():
        m = re.match(r"\s*(\d+):\s*(\S+).*\|\s*(hi|lo)\b", line)
        if m:
            out[int(m.group(1))] = {"mode": m.group(2), "state": 1 if m.group(3) == "hi" else 0}
    return out


def note_boot(pins: List[int]) -> None:
    """Record each pin as this service found it at start (before it claims anything)."""
    found = _pinctrl_levels(pins)
    with write_lock:
        for p in pins:
            f = found.get(p)
            if f is None:
                _add({"at": _iso(time.time()), "pin": p, "state": None, "source": "boot", "note": "not read (no pinctrl)"})
            else:
                _add({"at": _iso(time.time()), "pin": p, "state": f["state"], "source": "boot", "note": f"mode {f['mode']}"})
                _last_state[p] = f["state"]
                if f["state"] == 1:
                    _last_on_at[p] = time.time()


def register(pin: int, reader: Callable[[], Optional[int]]) -> None:
    """The owner of `pin` hands over how to read it (None = not claimed yet), and the watcher starts."""
    global _watcher
    _readers[pin] = reader
    if WATCH_S > 0 and (_watcher is None or not _watcher.is_alive()):
        _watcher = threading.Thread(target=_watch, name="gpio-watch", daemon=True)
        _watcher.start()


def _read(pin: int) -> Optional[int]:
    r = _readers.get(pin)
    if r is None:
        return None
    try:
        return r()
    except Exception:
        return None


def _watch() -> None:
    ticks = 0
    while True:
        time.sleep(WATCH_S)
        ticks += 1
        try:
            unclaimed: List[int] = []
            with write_lock:
                for pin in list(_readers):
                    level = _read(pin)
                    if level is None:
                        unclaimed.append(pin)
                        continue
                    if pin in _last_state and _last_state[pin] != level:
                        record(pin, level, source="unknown", note="changed with no write from this service")
                    elif pin not in _last_state:
                        _last_state[pin] = level
            if unclaimed and ticks % 10 == 0:
                # Not claimed by this service yet: pinctrl can still see an outside driver.
                found = _pinctrl_levels(unclaimed)
                with write_lock:
                    for pin, f in found.items():
                        if pin in _last_state and _last_state[pin] != f["state"]:
                            record(pin, f["state"], source="unknown", note=f"pin not claimed by this service; mode {f['mode']}")
        except Exception as exc:
            print(f"[gpio_events] watcher: {exc}", flush=True)


def _load_disk() -> None:
    """Refill the ring from the file, so a restart keeps the history."""
    try:
        lines: List[str] = []
        old = LOG_PATH.with_suffix(".jsonl.1")
        for p in (old, LOG_PATH):
            if p.exists():
                lines += p.read_text(encoding="utf-8", errors="replace").splitlines()
        for line in lines[-RING_SIZE:]:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if isinstance(ev, dict) and "at" in ev and "pin" in ev:
                _ring.append(ev)
    except Exception as exc:
        print(f"[gpio_events] history not loaded: {exc}", flush=True)


def events(since: Optional[str] = None, limit: int = 500) -> List[dict]:
    """Oldest first, after `since` (ISO), at most `limit` (the newest ones when cut)."""
    limit = max(1, min(int(limit), RING_SIZE))
    rows = list(_ring)
    if since:
        rows = [e for e in rows if str(e.get("at", "")) > _norm(since)]
    return rows[-limit:]


def _norm(iso: str) -> str:
    """The ISO form events use, so string order is time order (…T12:00:00.000Z)."""
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return _iso(dt.timestamp())
    except ValueError:
        return iso


def last(pin: int) -> Optional[dict]:
    """The newest event for `pin`, boot included."""
    for e in reversed(_ring):
        if e.get("pin") == pin:
            return e
    return None


def last_on(pin: int) -> Optional[dict]:
    """The newest event that turned `pin` on (or found it on at boot)."""
    for e in reversed(_ring):
        if e.get("pin") == pin and e.get("state") == 1:
            return e
    return None


def now_iso() -> str:
    return _iso(time.time())


_load_disk()

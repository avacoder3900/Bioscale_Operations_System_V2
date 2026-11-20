"""
The arm Pi drives the robot-arm wax-fill loop (2026-11-06) — OPTIONAL.

Off unless BIMS's Setup switch "Arm Pi Drives The Loop" is on: then BIMS's
startLoop calls POST /ot2/loop-driver/start and this thread runs the SAME
sequence of steps the Run tab's browser runs (drive() in
src/routes/manufacturing/cart-mfg/robot-arm/run/+page.svelte), one BIMS step
at a time, through POST {bims}/api/robot-arm/wax-fill/drive. Every gate, every
check (parked, collision rule, arrival) stays in BIMS, unchanged; this only
removes the browser's hops and polling:
  * a play's end is seen HERE, on the Pi (GET /sessions/active on our own
    service, every 0.1 s), not by the browser's 0.5 s poll through BIMS;
  * the next step is asked for the moment the previous one returns.
The browser only watches (GET /ot2/loop-driver/status, through BIMS).

    POST /ot2/loop-driver/start {loop_id, bims_url}   (key)  checks BIMS answers, then starts the thread
    POST /ot2/loop-driver/stop  {loop_id?}             (key)  stops driving after the current step (no motion)
    GET  /ot2/loop-driver/status                       (key)  running, loop, step, last note, error, recent events

2026-11-10: every step carries a request id (x-drive-req) that BIMS logs on
its "received" and "answered" Movement Log rows; each event here keeps that id,
the HTTP status, Vercel's x-vercel-id and the Pi's Wi-Fi, and the drive's
events go to BIMS (action driveLog) when the drive ends — so a step whose
answer never arrived shows on both sides.

2026-11-20: a wait step's answer held ~85 s was lost on the Wi-Fi (BIMS answered
at 86 s, the Pi timed out at 130 s, 2026-11-19). BIMS now answers the Pi's waits
within ~25 s, and a wait that times out here is asked again (same request id,
x-drive-attempt 2, 3). And a drive stopped while a step is in flight no longer
blocks the next loop: start() takes over from a drive that was stopped, or whose
loop BIMS says is no longer running; the old thread ends on its own after that
step and touches nothing of the new drive.

A step BIMS refuses ends the drive with failLoop, as the browser does; an
arrival miss ("ARM DID NOT ARRIVE:") ends the drive WITHOUT failing the loop
(the operator resumes it from the Run tab). Stop / STOP RUN stay on the Run
tab: BIMS stops this driver first.
"""

from __future__ import annotations

import os
import threading
import time
import uuid
from collections import deque
from typing import Any, Callable, Optional

import httpx

STEP_TIMEOUT_S = 130.0      # a BIMS step's maxDuration is 120 s
#: The read-only waits: BIMS answers these within ~25 s (DRIVE_WAIT_BUDGET_MS); a timeout is asked again.
WAIT_ACTIONS = frozenset({"loopState", "awaitParked", "cycleScanRead", "cycleFillWait", "cycleFailPrepare", "cycleSkipAhead", "playback"})
WAIT_TIMEOUT_S = 60.0
WAIT_ATTEMPTS = 3
RETRY_STATUSES = frozenset({0, 502, 503, 504})
RETRY_PAUSE_S = 1.0
PLAY_POLL_S = 0.1
PLAY_GRACE_S = 20.0
SELF_URL = os.environ.get("ARM_SELF_URL", "http://127.0.0.1:8000")
LOG_TIMEOUT_S = 15.0


def wifi() -> Optional[dict]:
    """The Wi-Fi link right now, from /proc/net/wireless (no subprocess); None when there is none."""
    try:
        with open("/proc/net/wireless", encoding="ascii") as f:
            lines = f.read().splitlines()[2:]
        for line in lines:
            name, _, rest = line.partition(":")
            parts = rest.split()
            if len(parts) >= 3:
                return {"iface": name.strip(), "link": float(parts[1].rstrip(".")), "level": float(parts[2].rstrip("."))}
    except Exception:
        return None
    return None


class DriveStopped(Exception):
    pass


class DriveFailed(Exception):
    def __init__(self, step: str, error: str, arrival_miss: bool = False):
        super().__init__(error)
        self.step = step
        self.error = error
        self.arrival_miss = arrival_miss


class LoopDriver:
    def __init__(self, call: Optional[Callable[[str, dict], dict]] = None, session_active: Optional[Callable[[], bool]] = None, clock=time.monotonic, sleep=time.sleep):
        self.lock = threading.Lock()
        self.thread: Optional[threading.Thread] = None
        self.loop_id: Optional[str] = None
        self.bims_url: Optional[str] = None
        self.stop_flag = threading.Event()
        self.state: dict[str, Any] = {"running": False, "loop_id": None, "step": None, "note": None, "error": None, "started_at": None, "ended_at": None}
        self.events: deque = deque(maxlen=300)
        self._call = call
        self._session_active = session_active
        self._clock = clock
        self._sleep = sleep
        self._wifi = wifi
        self._seq = 0
        self._run_tag = ""
        self._drive_from = 0.0
        self._gen = 0
        self._local = threading.local()

    # ---- which drive this thread is ----
    def _mine(self) -> tuple[Optional[str], int]:
        """(loop id, generation) of the drive the calling thread runs; the current one outside a drive thread."""
        return getattr(self._local, "loop_id", self.loop_id), getattr(self._local, "gen", self._gen)

    def _stale(self) -> bool:
        """This thread's drive was taken over by a newer one."""
        return getattr(self._local, "gen", self._gen) != self._gen

    def _stopped(self) -> bool:
        return self.stop_flag.is_set() or self._stale()

    # ---- outside ----
    def status(self) -> dict:
        with self.lock:
            return {**self.state, "events": list(reversed(self.events))[:60]}

    def _old_loop_running(self, old_id: str) -> bool:
        """BIMS says the drive's loop is still running (unknown counts as running)."""
        r = self.step("loopState", loop_id=old_id)
        if not r.get("ok"):
            return r.get("status") != 404
        return ((r.get("data") or {}).get("loop") or {}).get("status") == "running"

    def start(self, loop_id: str, bims_url: str) -> dict:
        with self.lock:
            alive = bool(self.thread and self.thread.is_alive())
            old_id, stopped = self.loop_id, self.stop_flag.is_set()
            if alive and old_id == loop_id and not stopped:
                return {"ok": True, "already": True}
            if not self.bims_url:
                self.bims_url = bims_url.rstrip("/")
        took_over = None
        if alive:
            # A step still in flight for a stopped drive (or a loop that ended under it) must not block this one.
            if not stopped and old_id and self._old_loop_running(old_id):
                raise RuntimeError(f"already driving loop {old_id}")
            took_over = old_id
        with self.lock:
            if took_over:
                self.events.append({"at": time.time(), "note": f"took over from the drive of loop {took_over} (its step still in flight ends on its own)", "loop_id": loop_id})
            self._gen += 1
            self.stop_flag = threading.Event()
            self.loop_id = loop_id
            self.bims_url = bims_url.rstrip("/")
            self.stop_flag.clear()
            self._seq = 0
            self._run_tag = uuid.uuid4().hex[:6]
            self._drive_from = time.time()
            self.state = {"running": True, "loop_id": loop_id, "step": None, "note": "starting", "error": None, "started_at": time.time(), "ended_at": None}
        # BIMS must answer before we take the loop over; else the browser drives.
        first = self.step("loopState")
        if not first.get("ok"):
            with self.lock:
                self.state.update(running=False, error=f"BIMS did not answer: {first.get('error')}", ended_at=time.time())
            raise RuntimeError(f"BIMS did not answer the drive endpoint: {first.get('error')}")
        self.thread = threading.Thread(target=self._drive, args=(first["data"]["loop"], loop_id, self._gen, self._drive_from), name="loop-driver", daemon=True)
        self.thread.start()
        return {"ok": True, **({"tookOver": took_over} if took_over else {})}

    def _drive(self, loop: dict, loop_id: str, gen: int, since: float) -> None:
        self._local.loop_id = loop_id
        self._local.gen = gen
        self._local.since = since
        self._run(loop)

    def stop(self, loop_id: Optional[str] = None) -> dict:
        if loop_id and self.loop_id and loop_id != self.loop_id:
            return {"ok": True, "other": self.loop_id}
        self.stop_flag.set()
        self.note("stop asked: driving ends after the current step")
        return {"ok": True}

    # ---- helpers ----
    def note(self, text: str, **kw: Any) -> None:
        loop_id, _ = self._mine()
        with self.lock:
            # A drive that was taken over keeps its notes in the events only; the status is the new drive's.
            if not self._stale():
                self.state["note"] = text
            self.events.append({"at": time.time(), "note": text, "loop_id": loop_id, **kw})

    def _post(self, action: str, body: dict, req: str, attempt: int) -> tuple[dict, Optional[str]]:
        if self._call:
            return self._call(action, body), None
        try:
            key = os.environ.get("ROBOT_ARM_API_KEY", "")
            headers = {"x-api-key": key, "x-drive-req": req, "x-drive-attempt": str(attempt)}
            timeout = LOG_TIMEOUT_S if action == "driveLog" else WAIT_TIMEOUT_S if action in WAIT_ACTIONS else STEP_TIMEOUT_S
            res = httpx.post(f"{self.bims_url}/api/robot-arm/wax-fill/drive", json=body, headers=headers, timeout=timeout)
            try:
                payload = res.json()
            except Exception:
                payload = {"error": res.text[:200]}
            r = {"ok": True, "data": payload, "status": res.status_code} if res.status_code < 400 else {"ok": False, "error": str(payload.get("error") or f"HTTP {res.status_code}"), "status": res.status_code}
            return r, res.headers.get("x-vercel-id")
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}", "status": 0}, None

    def step(self, action: str, extra: Optional[dict] = None, loop_id: Optional[str] = None) -> dict:
        """One BIMS step: {ok, data} or {ok: False, error, status}. A wait that times out is asked again (same req)."""
        mine, _ = self._mine()
        body = {"loopId": loop_id or mine, "action": action, **(extra or {})}
        with self.lock:
            self._seq += 1
            req = f"{self._run_tag}-{self._seq}"
        attempts = WAIT_ATTEMPTS if action in WAIT_ACTIONS else 1
        r: dict = {}
        for attempt in range(1, attempts + 1):
            sent_at = time.time()
            t0 = time.perf_counter()
            r, vercel_id = self._post(action, body, req, attempt)
            if action != "driveLog":
                with self.lock:
                    self.events.append({
                        "at": time.time(), "sent_at": sent_at, "action": action, "ok": r.get("ok"),
                        "ms": round((time.perf_counter() - t0) * 1000), "error": r.get("error"),
                        "req": req, "attempt": attempt, "status": r.get("status"), "vercel_id": vercel_id, "wifi": self._wifi(),
                        "loop_id": body["loopId"],
                    })
            if r.get("ok") or r.get("status") not in RETRY_STATUSES or attempt == attempts or self._stopped():
                break
            self._sleep(RETRY_PAUSE_S)
        return r

    def send_log(self) -> None:
        """This drive's events to BIMS's Movement Log (one call; on failure they stay in /ot2/loop-driver/status)."""
        loop_id, _ = self._mine()
        with self.lock:
            since = getattr(self._local, "since", self._drive_from)
            events = [e for e in self.events if e.get("at", 0) >= since and e.get("loop_id", loop_id) == loop_id]
        if not events:
            return
        r = self.step("driveLog", {"events": events})
        # An event, not the note: the note keeps the drive's outcome ("grab failed: ...") for the Run tab.
        with self.lock:
            self.events.append({"at": time.time(), "log": "sent to BIMS" if r.get("ok") else f"not sent: {r.get('error')}", "loop_id": loop_id})

    def must(self, step_name: str, action: str, extra: Optional[dict] = None) -> dict:
        if self._stopped():
            raise DriveStopped()
        with self.lock:
            if not self._stale():
                self.state["step"] = action
        r = self.step(action, extra)
        if self._stale():
            raise DriveStopped()
        if not r.get("ok"):
            err = str(r.get("error") or "failed")
            raise DriveFailed(step_name, err, arrival_miss=err.startswith("ARM DID NOT ARRIVE:"))
        return r["data"]

    def active(self) -> bool:
        if self._session_active:
            return self._session_active()
        key = os.environ.get("ROBOT_ARM_API_KEY", "")
        r = httpx.get(f"{SELF_URL}/sessions/active", headers={"x-api-key": key}, timeout=3.0)
        return bool((r.json() or {}).get("active"))

    def play(self, step_name: str, action: str) -> None:
        """Start the play through BIMS, wait for it to end HERE, then BIMS's settle (torque back on if dropped)."""
        data = self.must(step_name, action)
        play = data.get("play") or {}
        run_id = play.get("runId")
        limit = float(play.get("durationS") or 0) + float(play.get("leadInS") or 0) + PLAY_GRACE_S
        t0 = self._clock()
        seen = False
        while True:
            try:
                on = self.active()
            except Exception:
                on = True
            seen = seen or on
            if not on and (seen or self._clock() - t0 > 2.0):
                break
            if self._clock() - t0 > limit:
                raise DriveFailed(step_name, f"the {step_name} play did not end within {limit:.0f} s")
            self._sleep(PLAY_POLL_S)
        if self._stopped():
            raise DriveStopped()
        if run_id:
            self.step("settle", {"runId": run_id})
        self.note(f"{step_name} play ended after {self._clock() - t0:.1f} s")

    def until_done(self, step_name: str, action: str, key: str, want: bool) -> dict:
        """Repeat a bounded BIMS wait until data[key] == want (awaitParked done / *Read pending False)."""
        while True:
            data = self.must(step_name, action)
            loop = data.get("loop") or {}
            if loop.get("status") != "running":
                return data
            if bool(data.get(key)) == want:
                return data

    # ---- the drive (mirrors the Run tab's drive()) ----
    def _run(self, loop: dict) -> None:
        try:
            while loop and loop.get("status") == "running":
                cycles = loop.get("cycles") or []
                if not cycles:
                    break
                c = cycles[-1]
                step = c.get("step")
                tag = f"Loop {c.get('index')}/{loop.get('requestedRuns')}"
                if step == "grab":
                    self.note(f"{tag}: waiting for the OT-2 to park, then grab")
                    d = self.until_done("grab", "awaitParked", "done", True)
                    if (d.get("loop") or {}).get("status") != "running":
                        loop = d.get("loop")
                        break
                    self.play("grab", "cycleGrab")
                    loop = self.must("grab", "cycleGrabDone")["loop"]
                elif step == "scan":
                    if not c.get("scanSeq"):
                        d = self.until_done("scan", "awaitParked", "done", True)
                        if (d.get("loop") or {}).get("status") != "running":
                            loop = d.get("loop")
                            break
                        self.note(f"{tag}: sending the OT-2 to the scan position")
                        self.must("scan", "cycleScanStart")
                    loop = self.until_done("scan", "cycleScanRead", "pending", False)["loop"]
                elif step == "decide":
                    if c.get("index") == 1 and loop.get("startStep") == "decide" and not c.get("fillSeq"):
                        d = self.until_done("decide", "awaitParked", "done", True)
                        if (d.get("loop") or {}).get("status") != "running":
                            loop = d.get("loop")
                            break
                    self.note(f"{tag}: telling the OT-2 to fill {c.get('barcode') or ''}")
                    loop = self.must("decide", "cycleDecide")["loop"]
                elif step == "fill":
                    self.note(f"{tag}: the OT-2 is filling")
                    loop = self.until_done("fill", "cycleFillWait", "pending", False)["loop"]
                elif step == "withdraw":
                    if c.get("index") == 1 and loop.get("startStep") == "withdraw":
                        if not c.get("skipSeq"):
                            self.until_done("withdraw", "awaitParked", "done", True)
                        loop = self.until_done("withdraw", "cycleSkipAhead", "pending", False)["loop"]
                        if loop.get("status") != "running":
                            break
                    self.note(f"{tag}: withdraw")
                    self.play("withdraw", "cycleWithdraw")
                    loop = self.must("withdraw", "cycleWithdrawDone")["loop"]
                elif step == "fail":
                    self.note(f"{tag}: fail route")
                    self.until_done("fail", "cycleFailPrepare", "pending", False)
                    self.play("fail", "cycleFail")
                    loop = self.must("fail", "cycleFailDone")["loop"]
                else:
                    loop = self.must("state", "loopState")["loop"]
                    break
            if loop and loop.get("ending") and not loop.get("runFinished"):
                for _ in range(40):
                    d = self.must("finish", "loopFinish")
                    loop = d.get("loop") or loop
                    if d.get("done"):
                        break
            self.note(f"loop {loop.get('status') if loop else 'gone'}: driving ended")
        except DriveStopped:
            self.note("stopped: no further steps")
        except DriveFailed as e:
            with self.lock:
                if not self._stale():
                    self.state["error"] = e.error
            if self._stale():
                self.note(f"{e.step} failed after this drive was taken over: {e.error}")
            elif e.arrival_miss:
                self.note(f"{e.error} — the loop stays where it is; resume it from the Run tab")
            else:
                # A Stop / STOP RUN on the Run tab ends the loop under us: then the refusal is
                # expected and the loop is not ours to fail.
                cur = self.step("loopState")
                still = cur.get("ok") and ((cur.get("data") or {}).get("loop") or {}).get("status") == "running"
                if still:
                    self.note(f"{e.step} failed: {e.error}")
                    self.step("failLoop", {"step": e.step, "error": e.error})
                else:
                    self.note(f"the loop ended while {e.step} was being driven: {e.error}")
        except Exception as e:
            with self.lock:
                if not self._stale():
                    self.state["error"] = f"{type(e).__name__}: {e}"
            self.note(f"driver error: {type(e).__name__}: {e}")
        finally:
            try:
                self.send_log()
            except Exception as e:
                with self.lock:
                    self.events.append({"at": time.time(), "log": f"not sent: {type(e).__name__}: {e}"})
            with self.lock:
                if not self._stale():
                    self.state.update(running=False, ended_at=time.time())


DRIVER = LoopDriver()

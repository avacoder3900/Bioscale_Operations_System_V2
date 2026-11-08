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

A step BIMS refuses ends the drive with failLoop, as the browser does; an
arrival miss ("ARM DID NOT ARRIVE:") ends the drive WITHOUT failing the loop
(the operator resumes it from the Run tab). Stop / STOP RUN stay on the Run
tab: BIMS stops this driver first.
"""

from __future__ import annotations

import os
import threading
import time
from collections import deque
from typing import Any, Callable, Optional

import httpx

STEP_TIMEOUT_S = 130.0      # a BIMS wait step holds up to ~85 s (its maxDuration is 120)
PLAY_POLL_S = 0.1
PLAY_GRACE_S = 20.0
SELF_URL = os.environ.get("ARM_SELF_URL", "http://127.0.0.1:8000")


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

    # ---- outside ----
    def status(self) -> dict:
        with self.lock:
            return {**self.state, "events": list(reversed(self.events))[:60]}

    def start(self, loop_id: str, bims_url: str) -> dict:
        with self.lock:
            if self.thread and self.thread.is_alive():
                if self.loop_id == loop_id:
                    return {"ok": True, "already": True}
                raise RuntimeError(f"already driving loop {self.loop_id}")
            self.loop_id = loop_id
            self.bims_url = bims_url.rstrip("/")
            self.stop_flag.clear()
            self.state = {"running": True, "loop_id": loop_id, "step": None, "note": "starting", "error": None, "started_at": time.time(), "ended_at": None}
        # BIMS must answer before we take the loop over; else the browser drives.
        first = self.step("loopState")
        if not first.get("ok"):
            with self.lock:
                self.state.update(running=False, error=f"BIMS did not answer: {first.get('error')}", ended_at=time.time())
            raise RuntimeError(f"BIMS did not answer the drive endpoint: {first.get('error')}")
        self.thread = threading.Thread(target=self._run, args=(first["data"]["loop"],), name="loop-driver", daemon=True)
        self.thread.start()
        return {"ok": True}

    def stop(self, loop_id: Optional[str] = None) -> dict:
        if loop_id and self.loop_id and loop_id != self.loop_id:
            return {"ok": True, "other": self.loop_id}
        self.stop_flag.set()
        self.note("stop asked: driving ends after the current step")
        return {"ok": True}

    # ---- helpers ----
    def note(self, text: str, **kw: Any) -> None:
        with self.lock:
            self.state["note"] = text
            self.events.append({"at": time.time(), "note": text, **kw})

    def step(self, action: str, extra: Optional[dict] = None) -> dict:
        """One BIMS step: {ok, data} or {ok: False, error, status}."""
        body = {"loopId": self.loop_id, "action": action, **(extra or {})}
        t0 = time.perf_counter()
        if self._call:
            r = self._call(action, body)
        else:
            try:
                key = os.environ.get("ROBOT_ARM_API_KEY", "")
                res = httpx.post(f"{self.bims_url}/api/robot-arm/wax-fill/drive", json=body, headers={"x-api-key": key}, timeout=STEP_TIMEOUT_S)
                try:
                    payload = res.json()
                except Exception:
                    payload = {"error": res.text[:200]}
                r = {"ok": True, "data": payload} if res.status_code < 400 else {"ok": False, "error": str(payload.get("error") or f"HTTP {res.status_code}"), "status": res.status_code}
            except Exception as e:
                r = {"ok": False, "error": f"{type(e).__name__}: {e}", "status": 0}
        with self.lock:
            self.events.append({"at": time.time(), "action": action, "ok": r.get("ok"), "ms": round((time.perf_counter() - t0) * 1000), "error": r.get("error")})
        return r

    def must(self, step_name: str, action: str, extra: Optional[dict] = None) -> dict:
        if self.stop_flag.is_set():
            raise DriveStopped()
        with self.lock:
            self.state["step"] = action
        r = self.step(action, extra)
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
        if self.stop_flag.is_set():
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
                self.state["error"] = e.error
            if e.arrival_miss:
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
                self.state["error"] = f"{type(e).__name__}: {e}"
            self.note(f"driver error: {type(e).__name__}: {e}")
        finally:
            with self.lock:
                self.state.update(running=False, ended_at=time.time())


DRIVER = LoopDriver()

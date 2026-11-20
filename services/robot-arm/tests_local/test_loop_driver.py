"""Unit tests for loop_driver.py (the OPTIONAL arm-Pi loop driver). Stdlib only:

    python -I services/robot-arm/tests_local/test_loop_driver.py
"""
import importlib.util
import os
import sys
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if "httpx" not in sys.modules:
    try:
        import httpx  # noqa: F401
    except ImportError:
        sys.modules["httpx"] = types.ModuleType("httpx")
spec = importlib.util.spec_from_file_location("loop_driver", os.path.join(HERE, "..", "src", "server", "loop_driver.py"))
ld = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ld)


def loop(step, index=1, runs=1, status="running", **cycle):
    return {"_id": "L1", "status": status, "requestedRuns": runs, "startStep": "grab", "ending": False, "runFinished": False,
            "cycles": [{"index": index, "step": step, **cycle}]}


class Fake:
    """A scripted BIMS: each action answers from a list; records the order."""

    def __init__(self, script):
        self.script = {k: list(v) for k, v in script.items()}
        self.calls = []
        self.logs = []

    def __call__(self, action, body):
        if action == "driveLog":  # the drive's own log, sent when it ends (kept apart from the step order)
            self.logs.append(body.get("events") or [])
            return {"ok": True, "data": {"rows": len(self.logs[-1])}}
        self.calls.append(action)
        q = self.script.get(action)
        if not q:
            return {"ok": False, "error": f"unexpected {action}", "status": 500}
        r = q.pop(0) if len(q) > 1 else q[0]
        return r


class Clock:
    def __init__(self):
        self.t = 0.0

    def now(self):
        return self.t

    def sleep(self, s):
        self.t += s


def run_driver(script, active=lambda: False):
    fake = Fake(script)
    clock = Clock()
    d = ld.LoopDriver(call=fake, session_active=active, clock=clock.now, sleep=clock.sleep)
    d.loop_id = "L1"
    first = fake("loopState", {})["data"]["loop"]
    d._run(first)
    return d, fake


ok = lambda **data: {"ok": True, "data": data}


class LoopDriverTests(unittest.TestCase):
    def test_one_cart_in_the_browser_order(self):
        filled = loop("withdraw")
        ended = dict(loop("done", status="completed"), ending=True)
        d, f = run_driver({
            "loopState": [ok(loop=loop("grab"))],
            "awaitParked": [ok(done=False, loop=loop("grab")), ok(done=True, loop=loop("grab"))],
            "cycleGrab": [ok(play={"runId": "p1", "durationS": 3})],
            "settle": [ok(settle={})],
            "cycleGrabDone": [ok(loop=loop("scan"))],
            "cycleScanStart": [ok(loop=loop("scan", scanSeq=2))],
            "cycleScanRead": [ok(pending=True, loop=loop("scan", scanSeq=2)), ok(pending=False, loop=loop("decide", barcode="abc"))],
            "cycleDecide": [ok(loop=loop("fill"))],
            "cycleFillWait": [ok(pending=False, loop=filled)],
            "cycleWithdraw": [ok(play={"runId": "p2", "durationS": 2})],
            "cycleWithdrawDone": [ok(loop=ended, next=False)],
            "loopFinish": [ok(done=True, status="succeeded", loop=dict(ended, runFinished=True))],
        })
        self.assertEqual(f.calls, ["loopState", "awaitParked", "awaitParked", "cycleGrab", "settle", "cycleGrabDone",
                                   "awaitParked", "cycleScanStart", "cycleScanRead", "cycleScanRead", "cycleDecide",
                                   "cycleFillWait", "cycleWithdraw", "settle", "cycleWithdrawDone", "loopFinish"])
        self.assertIsNone(d.state["error"])

    def test_arrival_miss_ends_the_drive_without_failing_the_loop(self):
        d, f = run_driver({
            "loopState": [ok(loop=loop("grab"))],
            "awaitParked": [ok(done=True, loop=loop("grab"))],
            "cycleGrab": [ok(play={"runId": "p1", "durationS": 1})],
            "settle": [ok(settle={})],
            "cycleGrabDone": [{"ok": False, "error": "ARM DID NOT ARRIVE: shoulder 40 steps off", "status": 409}],
        })
        self.assertNotIn("failLoop", f.calls)
        self.assertIn("ARM DID NOT ARRIVE", d.state["error"])

    def test_a_refused_step_fails_the_loop_like_the_browser(self):
        d, f = run_driver({
            "loopState": [ok(loop=loop("fill"))],
            "cycleFillWait": [{"ok": False, "error": "the OT-2 run could not be read", "status": 502}],
            "failLoop": [ok(loop=loop("fill", status="failed"))],
        })
        self.assertEqual(f.calls[-1], "failLoop")

    def test_a_loop_stopped_under_the_driver_is_not_failed(self):
        d, f = run_driver({
            "loopState": [ok(loop=loop("fill")), ok(loop=loop("fill", status="stopped"))],
            "cycleFillWait": [{"ok": False, "error": "loop is not running", "status": 409}],
        })
        self.assertNotIn("failLoop", f.calls)

    def test_a_play_that_never_ends_fails(self):
        d, f = run_driver({
            "loopState": [ok(loop=loop("grab"))],
            "awaitParked": [ok(done=True, loop=loop("grab"))],
            "cycleGrab": [ok(play={"runId": "p1", "durationS": 1})],
            "failLoop": [ok(loop=loop("grab", status="failed"))],
        }, active=lambda: True)
        self.assertIn("did not end", d.state["error"])
        self.assertNotIn("cycleGrabDone", f.calls)

    def test_stop_flag_stops_before_the_next_step(self):
        fake = Fake({"loopState": [ok(loop=loop("grab"))]})
        clock = Clock()
        d = ld.LoopDriver(call=fake, session_active=lambda: False, clock=clock.now, sleep=clock.sleep)
        d.loop_id = "L1"
        d.stop_flag.set()
        d._run(loop("grab"))
        self.assertEqual(fake.calls, [])
        self.assertIn("stopped", d.state["note"])


    def test_the_drive_log_goes_to_bims_once_with_request_ids(self):
        d, f = run_driver({
            "loopState": [ok(loop=loop("grab"))],
            "awaitParked": [{"ok": False, "error": "ReadTimeout: The read operation timed out", "status": 0}],
            "failLoop": [ok(loop=loop("grab", status="failed"))],
        })
        self.assertEqual(len(f.logs), 1)
        steps = [e for e in f.logs[0] if e.get("action")]
        # A timed-out wait is asked twice more under the same request id.
        self.assertEqual([e["action"] for e in steps], ["awaitParked"] * 3 + ["loopState", "failLoop"])
        self.assertEqual([e["attempt"] for e in steps[:3]], [1, 2, 3])
        self.assertEqual(len({e["req"] for e in steps}), 3)
        self.assertFalse(steps[0]["ok"])
        self.assertIn("ReadTimeout", steps[0]["error"])
        self.assertLessEqual(steps[0]["sent_at"], steps[0]["at"])
        self.assertTrue(any("grab failed" in (e.get("note") or "") for e in f.logs[0]))
        self.assertIn("grab failed", d.state["note"])
        self.assertEqual(d.events[-1].get("log"), "sent to BIMS")

    def test_a_timed_out_wait_is_asked_again(self):
        d, f = run_driver({
            "loopState": [ok(loop=loop("fill"))],
            "cycleFillWait": [{"ok": False, "error": "ReadTimeout", "status": 0}, ok(pending=False, loop=loop("done", status="completed"))],
        })
        self.assertEqual(f.calls, ["loopState", "cycleFillWait", "cycleFillWait"])
        self.assertIsNone(d.state["error"])

    def test_a_play_step_is_never_asked_twice(self):
        d, f = run_driver({
            "loopState": [ok(loop=loop("grab")), ok(loop=loop("grab"))],
            "awaitParked": [ok(done=True, loop=loop("grab"))],
            "cycleGrab": [{"ok": False, "error": "ReadTimeout", "status": 0}],
            "failLoop": [ok(loop=loop("grab", status="failed"))],
        })
        self.assertEqual(f.calls.count("cycleGrab"), 1)

    def test_a_stopped_drive_with_a_step_in_flight_is_taken_over(self):
        import threading
        release = threading.Event()
        in_flight = threading.Event()

        def call(action, body):
            if action == "driveLog":
                return {"ok": True, "data": {}}
            if body["loopId"] == "A":
                if action == "loopState":
                    return ok(loop=loop("fill"))
                in_flight.set()
                release.wait(5)
                return ok(pending=True, loop=loop("fill"))
            if action == "loopState":
                return ok(loop=dict(loop("done", status="completed"), _id="B"))
            return {"ok": False, "error": "unexpected", "status": 500}

        d = ld.LoopDriver(call=call, session_active=lambda: False)
        d.start("A", "http://bims")
        self.assertTrue(in_flight.wait(5))
        d.stop("A")
        r = d.start("B", "http://bims")
        self.assertEqual(r.get("tookOver"), "A")
        self.assertEqual(d.loop_id, "B")
        release.set()
        d.thread.join(5)
        self.assertFalse(d.stop_flag.is_set())
        self.assertNotEqual(d.state.get("error"), "unexpected")

    def test_a_running_drive_of_a_running_loop_is_not_taken_over(self):
        import threading
        release = threading.Event()
        in_flight = threading.Event()

        def call(action, body):
            if action == "driveLog":
                return {"ok": True, "data": {}}
            if action == "loopState":
                return ok(loop=loop("fill"))
            in_flight.set()
            release.wait(5)
            return ok(pending=False, loop=loop("done", status="completed"))

        d = ld.LoopDriver(call=call, session_active=lambda: False)
        d.start("A", "http://bims")
        self.assertTrue(in_flight.wait(5))
        with self.assertRaises(RuntimeError):
            d.start("B", "http://bims")
        release.set()
        d.thread.join(5)


if __name__ == "__main__":
    unittest.main()

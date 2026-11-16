"""The replay's fire timer starts a chute scan after a trapdoor fire with `scan` (2026-11-16). Stdlib only:

    python -I services/robot-arm/tests_local/test_fire_scan.py
"""
import importlib.util
import os
import sys
import threading
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("replay_settle", os.path.join(HERE, "..", "src", "hardware", "replay_settle.py"))
rs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rs)

calls = []
fake_barcode = types.ModuleType("src.server.barcode")
fake_barcode.scan_after_fire = lambda **k: calls.append(k)
src = types.ModuleType("src")
server = types.ModuleType("src.server")
server.barcode = fake_barcode
src.server = server
sys.modules.update({"src": src, "src.server": server, "src.server.barcode": fake_barcode})


def frames(scan):
    return [{"t": 0.0, "fire": {"pin": 17, "ms": 100, "solenoid": "A", **({"scan": True, "scan_delay_ms": 250} if scan else {})}}, {"t": 0.5}]


class TestFireScan(unittest.TestCase):
    def setUp(self):
        calls.clear()

    def play(self, scan, ok=True):
        t = rs.FireTimer(rs.fire_schedule(frames(scan)), 0.0, threading.Event(), lambda pin, ms, stop_event=None: {"ok": ok}, 1, run_id="R1", title="Drop A")
        t.t0 = __import__("time").perf_counter()
        t.start()
        t.join(5)
        return t

    def test_schedule_carries_scan(self):
        self.assertTrue(rs.fire_schedule(frames(True))[0]["scan"])
        self.assertFalse(rs.fire_schedule(frames(False))[0]["scan"])

    def test_scan_after_a_good_fire(self):
        t = self.play(True)
        self.assertEqual(calls, [{"solenoid": "A", "pin": 17, "run_id": "R1", "title": "Drop A", "delay_ms": 250}])
        self.assertEqual(t.results[0]["scan"], "started")

    def test_bad_delay_is_zero(self):
        self.assertEqual(rs._scan_delay({"scan_delay_ms": "x"}), 0)
        self.assertEqual(rs._scan_delay({"scan_delay_ms": 99999}), 10000)
        self.assertEqual(rs._scan_delay({}), 0)

    def test_no_scan_without_the_flag(self):
        self.play(False)
        self.assertEqual(calls, [])

    def test_no_scan_when_the_fire_failed(self):
        self.play(True, ok=False)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)

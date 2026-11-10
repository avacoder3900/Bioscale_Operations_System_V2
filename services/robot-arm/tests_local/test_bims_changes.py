"""Unit tests for bims_changes.py's unclean-end report (2026-11-10). Stdlib only:

    python -I services/robot-arm/tests_local/test_bims_changes.py
"""
import importlib.util
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
os.environ["BIMS_ARM_SERVICE_LIFE"] = os.path.join(tempfile.mkdtemp(), "service-life.json")
os.environ["BIMS_ARM_CHANGES_PENDING"] = os.path.join(tempfile.mkdtemp(), "pending.jsonl")
spec = importlib.util.spec_from_file_location("bims_changes", os.path.join(HERE, "..", "src", "server", "bims_changes.py"))
bc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bc)

STARTED = "2026-11-10T15:22:01+00:00 alejandrospi3 systemd[1]: Started robot-arm.service - Robot arm."


class PreviousEndTests(unittest.TestCase):
    def test_a_clean_stop_reports_nothing(self):
        prev = {"clean_stop": True, "last_alive": 100.0}
        self.assertIsNone(bc.previous_end(prev, 50.0, ["... Deactivated successfully."]))
        self.assertIsNone(bc.previous_end(None, 50.0, []))

    def test_power_loss_is_a_boot_after_the_last_heartbeat(self):
        prev = {"clean_stop": False, "last_alive": 100.0}
        self.assertEqual(bc.previous_end(prev, 200.0, []), "Pi lost power or rebooted without stopping the service")

    def test_a_kill_is_no_clean_stop_within_the_same_boot(self):
        prev = {"clean_stop": False, "last_alive": 300.0}
        self.assertEqual(bc.previous_end(prev, 200.0, []), "service process was killed (no clean shutdown)")

    def test_a_new_boot_id_is_a_power_loss_even_when_the_clock_came_back_early(self):
        # No clock battery: after power-up the time is the last saved one, earlier than the last heartbeat.
        prev = {"clean_stop": False, "last_alive": 900.0, "boot_id": "aaa"}
        self.assertEqual(bc.previous_end(prev, 100.0, [], "bbb"), "Pi lost power or rebooted without stopping the service")
        self.assertEqual(bc.previous_end(prev, 1000.0, [], "aaa"), "service process was killed (no clean shutdown)")

    def test_a_crash_names_the_exception(self):
        prev = {"clean_stop": True, "crash": "Traceback (most recent call last):\n  File x\nRuntimeError: bus gone\n"}
        self.assertEqual(bc.previous_end(prev, 0, []), "service crashed: RuntimeError: bus gone")

    def test_a_failed_exit_in_the_journal_counts(self):
        prev = {"clean_stop": True, "last_alive": 100.0}
        seg = ["... robot-arm.service: Main process exited, code=exited, status=1/FAILURE"]
        self.assertEqual(bc.previous_end(prev, 50.0, seg), "service exited with an error")
        ok = ["... robot-arm.service: Main process exited, code=exited, status=0/SUCCESS"]
        self.assertIsNone(bc.previous_end(prev, 50.0, ok))

    def test_the_segment_is_the_previous_run_only(self):
        lines = ["old 1", STARTED.replace("15:22", "09:00"), "run A 1", "run A 2", "Stopping robot-arm.service", STARTED, "now 1"]
        self.assertEqual(bc.journal_segment(lines), [STARTED.replace("15:22", "09:00"), "run A 1", "run A 2", "Stopping robot-arm.service"])
        self.assertEqual(bc.journal_segment(["a", "b"]), ["a", "b"])


class UncleanRowTests(unittest.TestCase):
    def setUp(self):
        self._rj, self._bt = bc.read_journal, bc.boot_time

    def tearDown(self):
        bc.read_journal, bc.boot_time = self._rj, self._bt

    def test_power_loss_row_carries_the_previous_boot_journal(self):
        bc.boot_time = lambda: 500.0
        calls = []

        def rj(previous_boot=False):
            calls.append(previous_boot)
            return (["prev boot line"], None) if previous_boot else ([STARTED], None)

        bc.read_journal = rj
        rows = bc.unclean_end_rows({"pid": 7, "started_at": 10.0, "last_alive": 400.0, "clean_stop": False})
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual(r["key"], "pi.service.unclean_stop")
        self.assertEqual(r["hardware"], "pi")
        self.assertTrue(r["newValue"].startswith("Pi lost power"))
        self.assertEqual(r["details"]["journal"], ["prev boot line"])
        self.assertEqual(calls, [False, True])
        self.assertIn("last alive", r["note"])

    def test_no_journal_from_before_the_boot_is_said(self):
        bc.boot_time = lambda: 100.0
        bid = bc.boot_id
        bc.boot_id = lambda: "new"
        try:
            bc.read_journal = lambda previous_boot=False: ([], None) if previous_boot else ([STARTED], None)
            r = bc.unclean_end_rows({"last_alive": 400.0, "clean_stop": False, "boot_id": "old"})[0]
        finally:
            bc.boot_id = bid
        self.assertTrue(r["newValue"].startswith("Pi lost power"))
        self.assertEqual(r["details"]["journal"], [])
        self.assertIn("not kept across boots", r["details"]["journalNote"])
        self.assertEqual(r["details"]["previousBootId"], "old")

    def test_an_unreadable_journal_is_said_not_hidden(self):
        bc.boot_time = lambda: 100.0
        bc.read_journal = lambda previous_boot=False: ([], "journal not readable by this user")
        rows = bc.unclean_end_rows({"last_alive": 400.0, "clean_stop": False})
        self.assertEqual(rows[0]["details"]["journalNote"], "journal not readable by this user")

    def test_a_clean_previous_run_gives_no_row(self):
        bc.boot_time = lambda: 100.0
        bc.read_journal = lambda previous_boot=False: ([STARTED], None)
        self.assertEqual(bc.unclean_end_rows({"last_alive": 400.0, "clean_stop": True}), [])
        self.assertEqual(bc.unclean_end_rows(None), [])


class LifeTests(unittest.TestCase):
    def test_track_life_returns_the_previous_record_and_writes_a_new_one(self):
        import json
        from pathlib import Path

        Path(bc.LIFE).write_text(json.dumps({"pid": 1, "clean_stop": False, "last_alive": 5.0}), encoding="utf-8")
        prev = bc.track_life()
        self.assertEqual(prev["pid"], 1)
        now = json.loads(Path(bc.LIFE).read_text(encoding="utf-8"))
        self.assertEqual(now["pid"], os.getpid())
        self.assertFalse(now["clean_stop"])
        bc._on_exit()
        self.assertTrue(json.loads(Path(bc.LIFE).read_text(encoding="utf-8"))["clean_stop"])


if __name__ == "__main__":
    unittest.main()

"""Unit tests for barcode.py (chute barcode scanner). No scanner needed:

    python -I services/robot-arm/tests_local/test_barcode.py

A fake serial port answers like the Waveshare module (Setting Manual V2.1).
"""
import importlib.util
import os
import sys
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))

# Stand-ins so the module imports without fastapi/pydantic installed.
if "fastapi" not in sys.modules:
    try:
        import fastapi  # noqa: F401
    except ImportError:
        fa = types.ModuleType("fastapi")

        class _Router:
            def __init__(self, *a, **k):
                pass

            def _deco(self, *a, **k):
                return lambda f: f

            get = post = _deco

        class HTTPException(Exception):
            def __init__(self, status_code=500, detail=""):
                super().__init__(detail)
                self.status_code = status_code
                self.detail = detail

        fa.APIRouter = _Router
        fa.HTTPException = HTTPException
        sys.modules["fastapi"] = fa
if "pydantic" not in sys.modules:
    try:
        import pydantic  # noqa: F401
    except ImportError:
        pd = types.ModuleType("pydantic")
        pd.BaseModel = object
        pd.Field = lambda default=None, **k: default
        sys.modules["pydantic"] = pd

spec = importlib.util.spec_from_file_location("barcode", os.path.join(HERE, "..", "src", "server", "barcode.py"))
bc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bc)

LABEL = "9bfb7605-291f-43a6-a028-72234c15f19f"


class FakeSerial:
    """Answers trigger / stop / read / write / save the way the module does."""

    regs = {0x0000: 0b11010100, 0x000D: 0x03, 0x0006: 50}
    reply_code = LABEL  # what the next trigger reads; None = nothing in view
    chunk = 5  # bytes per read(), to exercise labels arriving in pieces
    writes = []

    def __init__(self, *a, **k):
        self.out = b""
        self.closed = False

    def reset_input_buffer(self):
        self.out = b""

    def write(self, data):
        FakeSerial.writes.append(bytes(data))
        if data == bc.TRIGGER:
            self.out += bc.ACK
            if FakeSerial.reply_code is not None:
                self.out += FakeSerial.reply_code.encode() + b"\r"
        elif data == bc.STOP or data == bc.SAVE:
            self.out += bc.ACK
        elif data[2] == 0x07:
            addr = (data[4] << 8) | data[5]
            self.out += bytes([0x02, 0x00, 0x00, 0x01, FakeSerial.regs.get(addr, 0), 0x00, 0x00])
        elif data[2] == 0x08:
            FakeSerial.regs[(data[4] << 8) | data[5]] = data[6]
            self.out += bc.ACK

    def read(self, n):
        n = min(n, FakeSerial.chunk)
        b, self.out = self.out[:n], self.out[n:]
        return b

    def close(self):
        self.closed = True


serial_mod = types.ModuleType("serial")
serial_mod.Serial = FakeSerial
sys.modules["serial"] = serial_mod


class Base(unittest.TestCase):
    def setUp(self):
        FakeSerial.regs = {0x0000: 0b11010100, 0x000D: 0x03, 0x0006: 50}
        FakeSerial.reply_code = LABEL
        FakeSerial.writes = []
        bc._recent.clear()
        bc.find_port = lambda: "/dev/serial/by-id/usb-USBScn_fake"


class TestParse(Base):
    def test_label_rule_matches_bims(self):
        self.assertTrue(bc.is_label(LABEL))
        self.assertTrue(bc.is_label("CART-000123"))
        self.assertFalse(bc.is_label(LABEL[:20]))
        self.assertFalse(bc.is_label(LABEL + LABEL))

    def test_half_label_is_not_returned(self):
        self.assertEqual(bc.split_scan_reply(bc.ACK + LABEL[:10].encode()), (True, None))

    def test_ack_then_label(self):
        self.assertEqual(bc.split_scan_reply(bc.ACK + LABEL.encode() + b"\r"), (True, LABEL))

    def test_label_without_ack(self):
        self.assertEqual(bc.split_scan_reply(LABEL.encode() + b"\r\n"), (False, LABEL))

    def test_commands(self):
        self.assertEqual(bc.read_cmd(0x000D).hex(" "), "7e 00 07 01 00 0d 01 ab cd")
        self.assertEqual(bc.write_cmd(0x0000, 0xD5).hex(" "), "7e 00 08 01 00 00 d5 ab cd")


class TestScan(Base):
    def test_scan_reads_whole_label_in_pieces(self):
        r = bc.scan_blocking(1000)
        self.assertTrue(r["ok"])
        self.assertEqual(r["code"], LABEL)
        self.assertTrue(r["label"])
        self.assertTrue(r["acked"])
        self.assertEqual(bc._recent[0]["code"], LABEL)

    def test_nothing_in_view_sends_stop(self):
        FakeSerial.reply_code = None
        r = bc.scan_blocking(300)
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"], "no barcode read")
        self.assertIn(bc.STOP, FakeSerial.writes)

    def test_partial_code_is_not_a_label(self):
        FakeSerial.reply_code = LABEL[:30]
        r = bc.scan_blocking(1000)
        self.assertTrue(r["ok"])
        self.assertFalse(r["label"])

    def test_busy_refuses(self):
        bc._lock.acquire()
        try:
            r = bc.scan_blocking(300)
        finally:
            bc._lock.release()
        self.assertTrue(r.get("busy"))

    def test_keyboard_mode_explains_setup_code(self):
        bc.find_port = lambda: None
        real = bc.interface
        bc.interface = lambda: "usb_keyboard"
        try:
            r = bc.scan_blocking(300)
        finally:
            bc.interface = real
        self.assertFalse(r["ok"])
        self.assertIn("USB Virtual Port", r["error"])


class TestSettings(Base):
    def test_command_mode_keeps_other_bits_and_saves(self):
        r = bc.set_command_mode()
        self.assertEqual(r["before"], "manual")
        self.assertEqual(r["after"], "command")
        self.assertTrue(r["saved"])
        self.assertEqual(FakeSerial.regs[0x0000], 0b11010101)
        self.assertIn(bc.SAVE, FakeSerial.writes)

    def test_read_settings(self):
        r = bc.read_settings()
        self.assertEqual(r["interface"], "usb_virtual_port")
        self.assertEqual(r["single_scan_s"], 5.0)


class TestAfterFire(Base):
    def setUp(self):
        super().setUp()
        import tempfile
        from pathlib import Path

        self.tmp = tempfile.TemporaryDirectory()
        bc.PENDING = Path(self.tmp.name) / "pending.jsonl"
        bc.SCAN_AFTER_DELAY_MS = 0
        self.posts = []
        self.answer = True
        bc._post = lambda rows: (self.posts.append(list(rows)), self.answer)[1]
        bc.time.sleep = lambda s: None  # no retry back-off in tests

    def tearDown(self):
        import time as _t

        bc.time.sleep = _t.sleep
        self.tmp.cleanup()

    def run_after_fire(self, delay_ms=0):
        import threading

        before = set(threading.enumerate())
        bc.scan_after_fire(solenoid="A", pin=17, run_id="R1", title="Drop A", delay_ms=delay_ms)
        for t in set(threading.enumerate()) - before:
            t.join(5)

    def test_good_scan_is_sent(self):
        self.run_after_fire()
        row = self.posts[0][0]
        self.assertTrue(row["ok"])
        self.assertEqual(row["code"], LABEL)
        self.assertEqual((row["solenoid"], row["pin"], row["run_id"], row["title"]), ("A", 17, "R1", "Drop A"))
        self.assertFalse(bc.PENDING.exists())

    def test_step_delay_is_waited_and_sent(self):
        slept = []
        bc.time.sleep = lambda s: slept.append(s)
        self.run_after_fire(delay_ms=250)
        self.assertEqual(slept[0], 0.25)
        self.assertEqual(self.posts[0][0]["delay_ms"], 250)

    def test_zero_delay_does_not_wait(self):
        slept = []
        bc.time.sleep = lambda s: slept.append(s)
        self.run_after_fire(delay_ms=0)
        self.assertEqual(slept, [])
        self.assertEqual(self.posts[0][0]["delay_ms"], 0)

    def test_no_read_is_sent_as_failed(self):
        FakeSerial.reply_code = None
        bc.SCAN_AFTER_TIMEOUT_MS = 300
        try:
            self.run_after_fire()
        finally:
            bc.SCAN_AFTER_TIMEOUT_MS = 3000
        row = self.posts[0][0]
        self.assertFalse(row["ok"])
        self.assertEqual(row["error"], "no barcode read")

    def test_partial_code_is_failed(self):
        FakeSerial.reply_code = LABEL[:20]
        self.run_after_fire()
        row = self.posts[0][0]
        self.assertFalse(row["ok"])
        self.assertEqual(row["error"], "not a whole cartridge label")

    def test_unsent_row_waits_and_goes_with_the_next(self):
        self.answer = False
        self.run_after_fire()
        self.assertTrue(bc.PENDING.exists())
        self.answer = True
        self.posts.clear()
        self.run_after_fire()
        self.assertEqual(len(self.posts[0]), 2)
        self.assertFalse(bc.PENDING.exists())

    def test_url_from_changes_url(self):
        os.environ["BIMS_CHANGES_URL"] = "https://x.example/api/robot-arm/changes"
        try:
            self.assertEqual(bc.bims_url(), "https://x.example/api/robot-arm/chute-scans")
        finally:
            del os.environ["BIMS_CHANGES_URL"]


if __name__ == "__main__":
    unittest.main(verbosity=2)

#!/usr/bin/env python3
"""Regression test for the scanner-port recovery path in ot2-bridge.py.

Run: python3 scripts/test-ot2-bridge-scanner.py   (no deps — pyserial is stubbed)

Guards the 2026-07-13 R04 outage. The scanner's USB re-enumerated (bumped cable),
which invalidated the open file handle. Reads/writes on the dead fd raise
termios.error / OSError — NOT serial.SerialException — so the old generic handler
swallowed them without closing the port. is_open() kept reporting True, every
later scan reused the dead handle, and each failed scan kicked off an 18-stop
gantry raster that could never succeed. The single command worker was blocked for
~10 minutes; the maintenance run then failed to delete and wedged the run engine,
which took a manual robot-server restart to clear.
"""
import importlib.util
import os
import sys
import termios
import types

# --- stub pyserial + requests so the bridge imports without hardware ----------
fake_serial = types.ModuleType("serial")


class SerialException(Exception):
    pass


class FakeSerial:
    """A serial handle whose USB node is dead whenever FakeSerial.dead is set."""
    opens = []

    def __init__(self, port, baudrate=9600, timeout=0.2, **kw):
        self.port, self.is_open = port, True
        self.dead = FakeSerial.dead
        FakeSerial.opens.append(self)

    def reset_input_buffer(self):
        if self.dead:  # exactly what a re-enumerated ttyACM raises
            raise termios.error(5, "Input/output error")

    def write(self, data):
        return len(data)

    def flush(self):
        pass

    def read(self, n=1):
        return b"" if self.dead else b"\x02BARCODE-OK\x03"

    def close(self):
        self.is_open = False


FakeSerial.dead = False
fake_serial.Serial = FakeSerial
fake_serial.SerialException = SerialException
sys.modules["serial"] = fake_serial
sys.modules["requests"] = types.ModuleType("requests")

_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("bridge", os.path.join(_here, "ot2-bridge.py"))
bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bridge)

bridge.PORT_REOPEN_DELAY_S = 0.01  # keep the suite fast
_failures = []


def check(name, ok):
    print(("  ok   " if ok else "  FAIL ") + name)
    if not ok:
        _failures.append(name)


print("\n1. a dead handle is dropped, and the port reopens")
FakeSerial.dead = True
port = bridge.ScannerPort("/dev/scanner", 9600)
text, _raw, err = port.trigger_and_read(0.3)
check("scan fails", text is None)
check("reported as a PORT error, not a no-decode", bridge.is_port_error(err))
check("the dead handle is closed (it used to be left open forever)", not port.is_open())
check("the open is retried, so udev can repoint /dev/scanner at the new node",
      len(FakeSerial.opens) == bridge.PORT_OPEN_ATTEMPTS)

print("\n2. once the scanner re-enumerates, scanning resumes with no daemon restart")
FakeSerial.dead = False
text, _raw, err = port.trigger_and_read(0.3)
check("barcode decodes again", text is not None and "BARCODE-OK" in text)
check("no error", err is None)

print("\n3. a dead port does NOT raster the gantry (this was the ~10 min of dead time)")
moves = []
bridge.move_to_coordinates = lambda *a, **k: moves.append(a)
FakeSerial.dead = True
res = bridge.search_scan(bridge.ScannerPort("/dev/scanner", 9600), "run", "pip", 100.0, 100.0, 50.0)
check("search bails out (%d move(s), not %d)" % (len(moves), len(bridge.SEARCH_OFFSETS)),
      len(moves) <= 1)
check("the port error still propagates to the caller", bridge.is_port_error(res["error"]))

print("\n4. a live scanner that simply didn't decode STILL rasters (fallback intact)")
moves.clear()
FakeSerial.dead = False
live = bridge.ScannerPort("/dev/scanner", 9600)
live.trigger_and_read(0.05)  # open a healthy handle
live._scan_window = lambda w: (None, None, "empty payload (ACK only)")
res = bridge.search_scan(live, "run", "pip", 100.0, 100.0, 50.0)
check("all %d stops rastered" % len(bridge.SEARCH_OFFSETS), len(moves) == len(bridge.SEARCH_OFFSETS))
check("a no-decode is not misclassified as a port error", not bridge.is_port_error(res["error"]))

print("\n5. scan_with_retry doesn't re-run the reopen ladder it just exhausted")
FakeSerial.dead = True
r = bridge.scan_with_retry(bridge.ScannerPort("/dev/scanner", 9600), 0.05, retry_once=True)
check("1 attempt, not 2", r["attempts"] == 1)

print("\n6. the maintenance-run endpoint is the real one")
check("uses /maintenance_runs/current_run — '/maintenance_runs/current' is captured by "
      "the {runId} route and always 404s",
      bridge.MAINT_CURRENT_RUN == "/maintenance_runs/current_run")

print("\n%s\n" % ("ALL PASS" if not _failures else "%d FAILURE(S)" % len(_failures)))
sys.exit(1 if _failures else 0)

"""Every GPIO pin change is kept with its source (gpio_events.py, 2026-11-24). Stdlib only, simulated pins:

    python -I services/robot-arm/tests_local/test_gpio_events.py
"""
import asyncio
import importlib.util
import os
import sys
import tempfile
import threading
import time
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "..", "src", "server")
TMP = tempfile.mkdtemp()
os.environ["GPIO_EVENTS_LOG"] = os.path.join(TMP, "gpio-events.jsonl")
os.environ["GPIO_WATCH_S"] = "0.05"
os.environ["GPIO_WATCH_QUIET_S"] = "0.3"

# fastapi / pydantic stand-ins: only what gpio.py and conveyor.py touch at import.
fastapi = types.ModuleType("fastapi")


class HTTPException(Exception):
    def __init__(self, status_code, detail=None):
        super().__init__(detail)
        self.status_code = status_code


class APIRouter:
    def __init__(self, *a, **k):
        pass

    def _deco(self, *a, **k):
        return lambda f: f

    get = post = _deco


fastapi.APIRouter, fastapi.HTTPException = APIRouter, HTTPException
pydantic = types.ModuleType("pydantic")


class BaseModel:
    def __init__(self, **k):
        for n, v in k.items():
            setattr(self, n, v)


pydantic.BaseModel, pydantic.Field = BaseModel, (lambda default=None, **k: default)
sys.modules.update({"fastapi": fastapi, "pydantic": pydantic})

src = types.ModuleType("src")
server = types.ModuleType("src.server")
src.server = server
sys.modules.update({"src": src, "src.server": server})


def load(name):
    spec = importlib.util.spec_from_file_location(f"src.server.{name}", os.path.join(SERVER, f"{name}.py"))
    m = importlib.util.module_from_spec(spec)
    sys.modules[f"src.server.{name}"] = m
    setattr(server, name, m)
    spec.loader.exec_module(m)
    return m


ev = load("gpio_events")
gpio = load("gpio")
belt = load("conveyor")

driver = types.ModuleType("src.server.loop_driver")
driver.DRIVER = types.SimpleNamespace(state={"running": False, "loop_id": None})
sys.modules["src.server.loop_driver"] = driver


def new_events(since):
    return [e for e in ev.events(since, 2000) if e.get("source") != "boot"]


class TestGpioEvents(unittest.TestCase):
    def setUp(self):
        gpio._backend.state(17)  # claim (simulated on a laptop)
        self.since = ev.now_iso()
        time.sleep(0.005)

    def test_boot_rows(self):
        boots = [e for e in ev.events(None, 2000) if e.get("source") == "boot"]
        self.assertEqual(sorted({e["pin"] for e in boots}), [17, 22, 27])

    def test_rest_pulse_is_bims_pulse(self):
        asyncio.run(gpio.gpio_pulse(gpio.PulseRequest(pin=17, ms=30)))
        rows = new_events(self.since)
        self.assertEqual([(e["pin"], e["state"], e["source"]) for e in rows], [(17, 1, "bims-pulse"), (17, 0, "bims-pulse")])
        self.assertEqual(rows[0]["ms"], 30)
        self.assertGreaterEqual(rows[1]["held_ms"], 25)

    def test_replay_fire_thread_carries_run_id(self):
        out = {}

        def work():
            threading.current_thread().run_id = "R42"
            out["r"] = gpio.pulse_blocking(27, 30)

        t = threading.Thread(target=work, name="replay-fire")
        t.start()
        t.join(3)
        self.assertTrue(out["r"]["ok"])
        rows = new_events(self.since)
        self.assertEqual([(e["pin"], e["state"], e["source"], e.get("run_id")) for e in rows], [(27, 1, "replay-fire", "R42"), (27, 0, "replay-fire", "R42")])

    def test_loop_driver_when_loop_runs(self):
        driver.DRIVER.state = {"running": True, "loop_id": "L7"}
        try:
            t = threading.Thread(target=lambda: gpio.pulse_blocking(17, 25), name="replay-fire")
            t.start()
            t.join(3)
        finally:
            driver.DRIVER.state = {"running": False, "loop_id": None}
        rows = new_events(self.since)
        self.assertEqual({(e["source"], e.get("loop_id")) for e in rows}, {("loop-driver", "L7")})

    def test_outside_change_is_unknown(self):
        with ev.write_lock:
            gpio._backend._sim_state[17] = 1  # a level this service did not drive
        time.sleep(0.3)
        rows = new_events(self.since)
        self.assertEqual([(e["pin"], e["state"], e["source"], e["driven"]) for e in rows], [(17, 1, "unknown", 0)])
        self.assertEqual(rows[0]["note"], "reads high while driven low")
        with ev.write_lock:
            gpio._backend._sim_state[17] = 0
        time.sleep(0.6)
        rows = new_events(self.since)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1]["state"], 0)
        self.assertIn("reads as driven (low) again", rows[1]["note"])

    def test_flicker_is_one_episode(self):
        # GPIO 17 on 2026-11-24: a ~60 Hz wave while driven low. Never a row per read.
        for i in range(12):
            with ev.write_lock:
                gpio._backend._sim_state[27] = i % 2
            time.sleep(0.06)
        with ev.write_lock:
            gpio._backend._sim_state[27] = 0
        time.sleep(0.6)
        rows = [e for e in new_events(self.since) if e["pin"] == 27]
        self.assertEqual([e["state"] for e in rows], [1, 0])
        self.assertGreater(rows[1]["odd_reads"], 1)

    def test_pulse_during_watch_is_not_outside(self):
        t = threading.Thread(target=lambda: gpio.pulse_blocking(17, 200), name="replay-fire")
        t.start()
        t.join(3)
        time.sleep(0.1)
        self.assertEqual([e["source"] for e in new_events(self.since)], ["replay-fire", "replay-fire"])

    def test_no_event_without_change(self):
        gpio.all_off()
        gpio.all_off()
        self.assertEqual(new_events(self.since), [])

    def test_conveyor_pulse_and_force_off(self):
        async def go():
            await belt.conveyor_pulse(belt.PulseRequest(ms=5000, delay_ms=0))
            await asyncio.sleep(0.02)
            await belt.conveyor_force_off()
            await belt.conveyor_stop()

        asyncio.run(go())
        rows = [e for e in new_events(self.since) if e["pin"] == 22]
        self.assertEqual([(e["state"], e["source"]) for e in rows], [(1, "bims-pulse"), (0, "all-off")])
        self.assertEqual(rows[0]["ms"], 5000)

    def test_status_and_events_route(self):
        asyncio.run(gpio.gpio_pulse(gpio.PulseRequest(pin=17, ms=20)))
        st = asyncio.run(gpio.gpio_status())
        self.assertEqual(st["pins"]["17"]["last_on"]["source"], "bims-pulse")
        self.assertEqual(st["pins"]["17"]["state"], 0)
        r = asyncio.run(gpio.gpio_events_route(since=self.since))
        self.assertEqual(len(r["events"]), 2)
        self.assertIn("22", r["pins"])

    def test_history_survives_restart(self):
        asyncio.run(gpio.gpio_pulse(gpio.PulseRequest(pin=27, ms=20)))
        ids = [e["id"] for e in new_events(self.since)]
        ev._ring.clear()
        ev._load_disk()
        self.assertTrue(set(ids) <= {e["id"] for e in ev._ring})


if __name__ == "__main__":
    unittest.main()

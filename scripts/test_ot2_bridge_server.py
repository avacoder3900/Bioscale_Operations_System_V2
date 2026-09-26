"""
Unit tests for the ot2-bridge /bridge job server (OT2-TAILNET-5 S5).

    python -m unittest scripts/test_ot2_bridge_server.py        (repo root)
    py -3 -m unittest scripts/test_ot2_bridge_server.py

Stdlib only. The daemon is imported with importlib (its filename has a dash)
WITHOUT starting main(); pyserial / requests are stubbed if not installed, so
this runs on a dev machine. Nothing here touches a robot, a serial port or BIMS:
BIMS_BASE_URL is blanked, handlers are fakes, and the HTTP server binds an
ephemeral 127.0.0.1 port.
"""
import importlib.util
import json
import logging
import os
import sys
import threading
import time
import types
import unittest
import urllib.error
import urllib.request
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))


def _stub(name: str) -> None:
    if name in sys.modules:
        return
    try:
        __import__(name)
    except ImportError:
        m = types.ModuleType(name)
        m.Serial = object
        m.SerialException = Exception
        m.post = m.request = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("network disabled in tests"))
        sys.modules[name] = m


_stub("serial")
_stub("requests")
_spec = importlib.util.spec_from_file_location("ot2_bridge", os.path.join(HERE, "ot2-bridge.py"))
bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bridge)
bridge.BIMS_BASE_URL = ""  # never report anywhere from tests
bridge.log.setLevel(logging.WARNING)

# ---- Shared test vector: the SAME literal is in src/lib/server/opentrons/bridge-token.test.ts
VECTOR_SECRET = "ot2-bridge-shared-test-vector-secret"
VECTOR_CLAIMS = OrderedDict([
    ("aud", "ot2-bridge"), ("robotId", "robot-test-0001"), ("deviceId", "ot2-b99-bridge"),
    ("kinds", ["sweep", "scan"]), ("sub", "vector-user"), ("iat", 1790000000),
    ("exp", 1790000300), ("jti", "vector-jti-0001"),
])
VECTOR_TOKEN = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJhdWQiOiJvdDItYnJpZGdlIiwicm9ib3RJZCI6InJvYm90LXRlc3QtMDAwMSIsImRldmljZUlkIjoib3QyLWI5OS1icmlkZ2UiLCJr"
    "aW5kcyI6WyJzd2VlcCIsInNjYW4iXSwic3ViIjoidmVjdG9yLXVzZXIiLCJpYXQiOjE3OTAwMDAwMDAsImV4cCI6MTc5MDAwMDMwMCwi"
    "anRpIjoidmVjdG9yLWp0aS0wMDAxIn0."
    "OCrG02Thi-nfRaIAHmoUsuE_RzXE3cvB3ZvTLTV0Mo4"
)
DEVICE = "ot2-b99-bridge"
SECRET = "unit-test-secret"


def mint(kinds=("sweep", "deck_scan", "restart_robot_server", "scan"), device=DEVICE, robot="robot-test-0001",
         ttl=300, secret=SECRET, now=None):
    now = int(time.time() if now is None else now)
    return bridge.sign_bridge_token(OrderedDict([
        ("aud", "ot2-bridge"), ("robotId", robot), ("deviceId", device), ("kinds", list(kinds)),
        ("sub", "tester"), ("iat", now), ("exp", now + ttl), ("jti", "t"),
    ]), secret)


class TokenTests(unittest.TestCase):
    NOW = 1790000100  # inside the vector's iat..exp

    def verify(self, token, **kw):
        args = dict(secret=VECTOR_SECRET, device_id=DEVICE, now=self.NOW)
        args.update(kw)
        return bridge.verify_bridge_token(token, **args)

    def assertStatus(self, status, token, **kw):
        with self.assertRaises(bridge.TokenError) as cm:
            self.verify(token, **kw)
        self.assertEqual(cm.exception.status, status, cm.exception.message)

    def test_shared_vector_signs_identically(self):
        self.assertEqual(bridge.sign_bridge_token(VECTOR_CLAIMS, VECTOR_SECRET), VECTOR_TOKEN)

    def test_good_token(self):
        claims = self.verify(VECTOR_TOKEN, kind="sweep")
        self.assertEqual(claims["robotId"], "robot-test-0001")
        self.assertEqual(claims["kinds"], ["sweep", "scan"])
        self.verify(VECTOR_TOKEN, kind="scan", robot_id="robot-test-0001")
        self.verify(VECTOR_TOKEN)  # no kind = health

    def test_expired(self):
        self.verify(VECTOR_TOKEN, now=1790000300 + 29)  # within the 30 s leeway
        self.assertStatus(401, VECTOR_TOKEN, now=1790000300 + 31)

    def test_tampered(self):
        head, body, sig = VECTOR_TOKEN.split(".")
        forged = bridge.sign_bridge_token(
            OrderedDict(list(VECTOR_CLAIMS.items()) + [("kinds", ["restart_robot_server"])]), "wrong-secret")
        self.assertStatus(401, head + "." + forged.split(".")[1] + "." + sig)  # swapped claims
        self.assertStatus(401, head + "." + body + "." + sig[:-2] + ("AA" if sig[-2:] != "AA" else "BB"))
        self.assertStatus(401, VECTOR_TOKEN, secret="another-secret")
        self.assertStatus(401, "not-a-token")
        self.assertStatus(401, "")
        none_head = bridge._b64url_encode(b'{"alg":"none","typ":"JWT"}')
        self.assertStatus(401, none_head + "." + body + ".")

    def test_wrong_robot(self):
        self.assertStatus(403, VECTOR_TOKEN, device_id="ot2-b07-bridge")
        self.assertStatus(403, VECTOR_TOKEN, robot_id="some-other-robot")

    def test_wrong_kind(self):
        self.assertStatus(403, VECTOR_TOKEN, kind="restart_robot_server")

    def test_no_secret(self):
        self.assertStatus(503, VECTOR_TOKEN, secret="")


class CorsTests(unittest.TestCase):
    def test_allowlist(self):
        ok = [
            "https://bioscale-operations-system-mongodb.vercel.app",
            "https://bioscale-operations-system-mongodb-git-feat-ot2-tailnet-direct-brevitest.vercel.app",
            "https://bioscale-operations-system-mongodb-6p44wsg03-brevitest.vercel.app",
            "http://localhost:5173",
            "http://localhost",
        ]
        for o in ok:
            self.assertTrue(bridge.origin_allowed(o), o)
        bad = [
            None, "", "null", "https://evil.example.com",
            "http://bioscale-operations-system-mongodb.vercel.app",           # http
            "https://bioscale-operations-system-mongodb.vercel.app.evil.com",
            "https://brevitest.vercel.app.evil.com",
            "https://evil-brevitest.vercel.app/x",                             # a path is not an origin
            "https://localhost:5173", "http://127.0.0.1:5173", "http://localhost.evil.com",
            "https://ot2-b14.tailf65a70.ts.net",
        ]
        for o in bad:
            self.assertFalse(bridge.origin_allowed(o), o)
        self.assertTrue(bridge.origin_allowed("https://bims.example.org", ("https://bims.example.org",)))


class FakePort:
    port = "/dev/fake-scanner"

    def __init__(self):
        self.lock = threading.Lock()
        self.scans = 0

    def is_open(self):
        return True

    def trigger_and_read(self, timeout_s=None, clamp=True):
        with self.lock:
            self.scans += 1
            return "CART-123", "deadbeef", None


class ServerHarness(unittest.TestCase):
    """Real BridgeJobServer on an ephemeral port, real WorkQueue, fake handlers."""
    secret = SECRET

    def setUp(self):
        self.work = bridge.WorkQueue()
        self.registry = bridge.JobRegistry()
        self.port = FakePort()
        self.ctx = bridge.JobServerContext(work=self.work, port=self.port, secret=self.secret, device_id=DEVICE,
                                           scanner_device_id="ot2-b99-scanner", registry=self.registry)
        self.server = bridge.BridgeJobServer(("127.0.0.1", 0), self.ctx)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = "http://127.0.0.1:{}".format(self.server.server_address[1])
        self.stop = threading.Event()
        self._orig_execute = bridge.execute_command
        self._orig_poll = bridge._poll_command

    def tearDown(self):
        self.stop.set()
        bridge.execute_command = self._orig_execute
        bridge._poll_command = self._orig_poll
        self.server.shutdown()
        self.server.server_close()

    def request(self, method, path, body=None, token=None, origin=None, headers=None):
        h = dict(headers or {})
        if token:
            h["Authorization"] = "Bearer " + token
        if origin:
            h["Origin"] = origin
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else None), dict(r.headers)
        except urllib.error.HTTPError as e:
            raw = e.read()
            e.close()
            return e.code, (json.loads(raw) if raw else None), dict(e.headers)

    def start_worker(self):
        threading.Thread(target=bridge.command_worker_loop, args=(self.port, self.work, self.stop), daemon=True).start()


class AuthAndCorsHttpTests(ServerHarness):
    def test_401_without_token_both_path_forms(self):
        for path in ("/bridge/health", "/health", "/bridge/jobs/abcdefgh"):
            status, body, _ = self.request("GET", path)
            self.assertEqual(status, 401, path)
            self.assertEqual(body["service"], "ot2-bridge")
        status, _, _ = self.request("POST", "/bridge/jobs", {"kind": "sweep", "payload": {}})
        self.assertEqual(status, 401)
        status, _, _ = self.request("POST", "/bridge/scan", {})
        self.assertEqual(status, 401)
        self.assertEqual(self.port.scans, 0)

    def test_bad_and_expired_tokens_are_401(self):
        self.assertEqual(self.request("GET", "/bridge/health", token=mint(secret="nope"))[0], 401)
        self.assertEqual(self.request("GET", "/bridge/health", token=mint(ttl=-120))[0], 401)

    def test_health_with_token(self):
        status, body, _ = self.request("GET", "/bridge/health", token=mint(kinds=()))
        self.assertEqual(status, 200)
        self.assertEqual(body["version"], bridge.VERSION)
        self.assertTrue(body["jobServer"])
        self.assertEqual(body["deviceId"], DEVICE)

    def test_scope_is_403(self):
        self.assertEqual(self.request("GET", "/bridge/health", token=mint(device="ot2-b07-bridge"))[0], 403)
        status, _, _ = self.request("POST", "/bridge/jobs", {"kind": "calibrate_tip", "payload": {}},
                                    token=mint(kinds=("sweep",)))
        self.assertEqual(status, 403)
        self.assertEqual(self.request("POST", "/bridge/scan", {}, token=mint(kinds=("sweep",)))[0], 403)
        self.assertEqual(len(self.work.describe()["waiting"]), 0)

    def test_cors(self):
        origin = "https://bioscale-operations-system-mongodb.vercel.app"
        status, _, h = self.request("OPTIONS", "/bridge/jobs", origin=origin, headers={
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
            "Access-Control-Request-Private-Network": "true"})
        self.assertEqual(status, 204)
        self.assertEqual(h.get("Access-Control-Allow-Origin"), origin)
        self.assertIn("Authorization", h.get("Access-Control-Allow-Headers", ""))
        self.assertEqual(h.get("Access-Control-Allow-Private-Network"), "true")
        # A 401 to an allowed origin is still readable by the page (so it can refresh the token).
        status, _, h = self.request("GET", "/bridge/health", origin=origin)
        self.assertEqual(status, 401)
        self.assertEqual(h.get("Access-Control-Allow-Origin"), origin)
        # A foreign origin: refused, and nothing echoed.
        status, _, h = self.request("OPTIONS", "/bridge/jobs", origin="https://evil.example.com")
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", h)
        status, _, h = self.request("GET", "/bridge/health", token=mint(), origin="https://evil.example.com")
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", h)

    def test_test_scan(self):
        status, body, _ = self.request("POST", "/bridge/scan", {"source": "test"}, token=mint(kinds=("scan",)))
        self.assertEqual(status, 200)
        self.assertEqual(body["barcode"], "CART-123")
        self.assertEqual(self.port.scans, 1)


class DisabledServerTests(ServerHarness):
    secret = ""

    def test_503_when_secret_unset(self):
        self.assertEqual(self.request("GET", "/bridge/health", token=mint())[0], 503)
        self.assertEqual(self.request("POST", "/bridge/jobs", {"kind": "sweep"}, token=mint())[0], 503)

    def test_start_job_server_refuses_without_secret(self):
        self.assertIsNone(bridge.start_job_server(self.ctx, port=0))


class SingleWorkerOrderingTests(ServerHarness):
    def install_fake_handlers(self, duration=0.25):
        self.active = 0
        self.max_active = 0
        self.runs = []  # (id, source, start, end)
        lock = threading.Lock()

        def fake_execute(cmd, port):
            with lock:
                self.active += 1
                self.max_active = max(self.max_active, self.active)
            start = time.time()
            direct = bridge._direct_job_for(cmd["_id"]) is not None
            time.sleep(duration)
            with lock:
                self.active -= 1
            self.runs.append((cmd["_id"], "direct" if direct else "queue", start, time.time()))
            if direct:  # the real handlers end with _post_result; routed to the job record
                bridge._post_result(cmd["_id"], {"ok": True, "status": 200, "body": {"done": cmd["kind"]}})

        bridge.execute_command = fake_execute

    def test_queue_command_and_bridge_job_never_overlap(self):
        self.install_fake_handlers()
        handed_out = []

        def fake_poll():
            if not handed_out:
                handed_out.append(1)
                return {"_id": "queue-cmd-000001", "kind": "sweep", "payload": {}}
            time.sleep(0.05)
            return None

        bridge._poll_command = fake_poll
        threading.Thread(target=bridge.command_poll_loop, args=(self.work, self.stop), daemon=True).start()
        self.start_worker()
        status, body, _ = self.request("POST", "/bridge/jobs",
                                       {"kind": "deck_scan", "payload": {"position": {}}, "jobId": "direct-job-0001"},
                                       token=mint())
        self.assertEqual(status, 202)
        self.assertEqual(body["jobId"], "direct-job-0001")

        deadline = time.time() + 5
        while len(self.runs) < 2 and time.time() < deadline:
            time.sleep(0.02)
        self.assertEqual(len(self.runs), 2, self.runs)
        self.assertEqual(self.max_active, 1)
        (a_id, _, a_start, a_end), (b_id, _, b_start, b_end) = sorted(self.runs, key=lambda r: r[2])
        self.assertLessEqual(a_end, b_start, "the two items overlapped")
        self.assertEqual({r[1] for r in self.runs}, {"queue", "direct"})

        status, job, _ = self.request("GET", "/bridge/jobs/direct-job-0001", token=mint())
        self.assertEqual(status, 200)
        self.assertEqual(job["status"], "completed")
        self.assertEqual(job["result"], {"done": "deck_scan"})

    def test_cancel_before_start_and_duplicate_submit(self):
        self.install_fake_handlers(duration=0.4)
        self.start_worker()
        tok = mint()
        self.assertEqual(self.request("POST", "/bridge/jobs", {"kind": "deck_scan", "jobId": "first-job-01"}, token=tok)[0], 202)
        time.sleep(0.1)  # first is running now
        status, body, _ = self.request("POST", "/bridge/jobs", {"kind": "sweep", "jobId": "second-job-1",
                                                                 "payload": {"sweepRunId": "s1"}}, token=tok)
        self.assertEqual((status, body["position"]), (202, 1))
        # Same jobId again: the existing job comes back; it is never queued twice.
        status, body, _ = self.request("POST", "/bridge/jobs", {"kind": "sweep", "jobId": "second-job-1"}, token=tok)
        self.assertEqual((status, body["duplicate"]), (200, True))
        # A running non-sweep cannot be interrupted.
        self.assertEqual(self.request("POST", "/bridge/jobs/first-job-01/control", {"action": "cancel"}, token=tok)[0], 409)
        status, job, _ = self.request("POST", "/bridge/jobs/second-job-1/control", {"action": "cancel"}, token=tok)
        self.assertEqual((status, job["status"]), (200, "cancelled"))
        time.sleep(0.6)
        self.assertEqual([r[0] for r in self.runs], ["first-job-01"])  # the cancelled sweep never ran
        self.assertEqual(self.request("GET", "/bridge/jobs/nope-nope-1", token=tok)[0], 404)

    def test_queue_commands_do_not_route_to_job_endpoints(self):
        self.assertIsNone(bridge._direct_job_for("anything"))


if __name__ == "__main__":
    unittest.main()

"""
Direct arm-pi <-> OT-2 link over the USB-B cable (2026-11-06).

The OT-2's side USB-B port is a USB Ethernet adapter: cabled to the arm Pi it
shows up as `eth1` here and `eth0` on the robot (169.254.x.x link-local on
the robot's side; this Pi's eth1 is given a fixed 169.254.42.1/16). A request
over it answers in ~2 ms instead of ~8 ms over Wi-Fi, and keeps working when
the office Wi-Fi or the Starlink uplink does not. Until now every exchange
between the two machines went up to BIMS and back down through the OT-2's
Mongo command queue (0.8-3 s a hop); this module lets BIMS, and the stage
protocol running on the robot, talk through the cable instead.

Endpoints (auth is noted per route; `require_api_key` is injected by
scripts/install_ot2_link_router.py so this module never imports app.py):

    GET  /ot2/link                       (key)  which path is up (cable / lan), rtt, the robot, our own addresses
    POST /ot2/link/discover              (key)  probe again now
    ANY  /ot2/api/{path}                 (key)  forward the request to the robot's HTTP API over the best path
                                                 (?timeout_s= is ours, the rest of the query goes through);
                                                 the answer carries x-ot2-link and x-ot2-ms
    GET  /ot2/run/{id}/pause             (key)  the run's status, current ARM pause and last two ARM markers
    GET  /ot2/run/{id}/wait?fp=&timeout_s=  (key)  long-poll: returns as soon as that read changes (or the run ends)
    POST /ot2/loop/instruction           (key)  BIMS sets the next instruction for the protocol {seq, loop, cart, action, barcode}
    GET  /ot2/loop/instruction?loop=&after=&wait_s=   (key, or the robot itself over the cable / LAN)
                                                 the protocol long-polls its next instruction; 204 when none within wait_s
    POST /ot2/loop/announce              (key, or the robot)  the protocol reports a marker the moment it reaches it
    GET  /ot2/loop/state                 (key)  the stored instruction, our addresses, the last announcements
    GET  /ot2/loop/events?limit=         (key)  announcements and served instructions, newest first, with timestamps
    GET  /ot2/calls?limit=               (key)  journal of every call this module made to the robot (ms per hop)

The robot is trusted without a key only from its own addresses (the cable's
169.254/16, IPv6 link-local, or its known LAN address), and only on the two
protocol routes. Nothing here moves the arm or touches the servo bus.

State survives a service restart in ~/.bims-arm/ot2_link.json (the learned
addresses) and ~/.bims-arm/arm_loop_instruction.json (the last instruction).
"""

from __future__ import annotations

import http.client
import inspect
import ipaddress
import json
import os
import re
import subprocess
import threading
import time
from collections import deque
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

router = APIRouter(prefix="/ot2", tags=["ot2-link"])

# ---------------------------------------------------------------- config

CABLE_IFACE = os.environ.get("OT2_CABLE_IFACE", "eth1")
LAN_IFACE = os.environ.get("OT2_LAN_IFACE", "wlan0")
PORT = int(os.environ.get("OT2_PORT", "31950"))
STATE_DIR = os.path.expanduser(os.environ.get("BIMS_ARM_STATE_DIR", "~/.bims-arm"))
STATE_FILE = os.path.join(STATE_DIR, "ot2_link.json")
INSTRUCTION_FILE = os.path.join(STATE_DIR, "arm_loop_instruction.json")
HEADERS = {"opentrons-version": "*"}
PROBE_TIMEOUT_S = 1.5
CHECK_UP_S = float(os.environ.get("OT2_LINK_CHECK_UP_S", "15"))
CHECK_DOWN_S = float(os.environ.get("OT2_LINK_CHECK_DOWN_S", "3"))
MAX_WAIT_S = 25.0
LINK_LOCAL_V4 = ipaddress.ip_network("169.254.0.0/16")

# Injected by the installer: app.py's require_api_key(x_api_key). None = open (dev).
require_api_key = None


async def _key(x_api_key: Optional[str] = Header(None)) -> None:
    # app.py's require_api_key is sync on the live Pi, async in the repo copy: take either.
    if require_api_key is not None:
        r = require_api_key(x_api_key)
        if inspect.isawaitable(r):
            await r


def _peer_is_robot(host: Optional[str]) -> bool:
    """The robot itself: on the cable (169.254/16 or fe80::/10) or at its known LAN address."""
    if not host:
        return False
    bare = host.split("%")[0]
    try:
        ip = ipaddress.ip_address(bare)
    except ValueError:
        return False
    if ip.version == 4 and ip in LINK_LOCAL_V4:
        return True
    if ip.version == 6 and ip.is_link_local:
        return True
    lan = LINK.lan.get("addr")
    return bool(lan) and bare == lan


async def _key_or_robot(request: Request, x_api_key: Optional[str] = Header(None)) -> None:
    if request.client and _peer_is_robot(request.client.host):
        return
    await _key(x_api_key)


# ---------------------------------------------------------------- helpers

def _now() -> float:
    return time.time()


def _run(argv: list[str], timeout: float = 2.0) -> str:
    try:
        p = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout)
    except Exception:
        return ""
    return p.stdout.decode("utf-8", "replace") if p.returncode == 0 else ""


def _iface_up(iface: str) -> bool:
    try:
        with open(f"/sys/class/net/{iface}/carrier") as f:
            return f.read().strip() == "1"
    except OSError:
        return False


def _iface_ipv4(iface: str) -> Optional[str]:
    out = _run(["ip", "-4", "-o", "addr", "show", "dev", iface])
    m = re.search(r"\binet\s+(\d+\.\d+\.\d+\.\d+)", out)
    return m.group(1) if m else None


def _load_json(path: str) -> Optional[dict]:
    try:
        with open(path) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else None
    except Exception:
        return None


def _save_json(path: str, data: dict) -> None:
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, path)
    except Exception:
        pass


# ---------------------------------------------------------------- the link

class _Journal:
    def __init__(self, n: int = 500):
        self.rows: deque = deque(maxlen=n)
        self.lock = threading.Lock()

    def add(self, **row: Any) -> None:
        row.setdefault("at", _now())
        with self.lock:
            self.rows.append(row)

    def last(self, limit: int = 100) -> list[dict]:
        with self.lock:
            rows = list(self.rows)
        return list(reversed(rows))[: max(1, min(limit, len(rows) or 1))] if rows else []


CALLS = _Journal(500)


class Link:
    """Where the robot is and which path answers; probed by a background thread."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        saved = _load_json(STATE_FILE) or {}
        self.cable: dict = {"addr": os.environ.get("OT2_CABLE_ADDR") or saved.get("cable_addr"), "up": False, "rtt_ms": None, "checked_at": None, "error": None}
        self.lan: dict = {"addr": os.environ.get("OT2_LAN_ADDR") or saved.get("lan_addr"), "up": False, "rtt_ms": None, "checked_at": None, "error": None}
        self.robot: dict = {"name": saved.get("robot_name"), "serial": saved.get("robot_serial")}
        self.self_addrs: dict = {"cable": None, "lan": None}
        self.client = httpx.Client(headers=HEADERS, timeout=PROBE_TIMEOUT_S)
        self._wake = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="ot2-link", daemon=True)
        self._thread.start()

    # ---- state ----
    def snapshot(self) -> dict:
        with self.lock:
            active = "cable" if self.cable["up"] else "lan" if self.lan["up"] else None
            return {
                "active": active,
                "cable": dict(self.cable, iface=CABLE_IFACE, carrier=_iface_up(CABLE_IFACE)),
                "lan": dict(self.lan, iface=LAN_IFACE),
                "robot": dict(self.robot),
                "self": dict(self.self_addrs),
                "port": PORT,
            }

    def _persist(self) -> None:
        _save_json(STATE_FILE, {"cable_addr": self.cable["addr"], "lan_addr": self.lan["addr"], "robot_name": self.robot["name"], "robot_serial": self.robot["serial"]})

    def base(self) -> tuple[str, str]:
        """(name, base_url) of the best path, or 503."""
        with self.lock:
            if self.cable["up"] and self.cable["addr"]:
                return "cable", f"http://{self.cable['addr']}:{PORT}"
            if self.lan["up"] and self.lan["addr"]:
                return "lan", f"http://{self.lan['addr']}:{PORT}"
        raise HTTPException(status_code=503, detail="OT-2 unreachable over the cable and the LAN")

    def mark_down(self, name: str, error: str) -> None:
        with self.lock:
            d = self.cable if name == "cable" else self.lan
            d.update(up=False, error=error[:200], checked_at=_now())
        self._wake.set()

    # ---- probing ----
    def _probe(self, addr: str) -> tuple[bool, Optional[float], Optional[str], Optional[dict]]:
        t0 = time.perf_counter()
        try:
            r = self.client.get(f"http://{addr}:{PORT}/health")
            ms = (time.perf_counter() - t0) * 1000
            if r.status_code != 200:
                return False, ms, f"HTTP {r.status_code}", None
            return True, ms, None, r.json()
        except Exception as e:
            return False, None, f"{type(e).__name__}: {e}"[:200], None

    def _networking_status(self, addr: str) -> Optional[dict]:
        try:
            r = self.client.get(f"http://{addr}:{PORT}/networking/status")
            return r.json() if r.status_code == 200 else None
        except Exception:
            return None

    def _ipv6_neighbours(self) -> list[str]:
        """Link-local IPv6 neighbours on the cable: one multicast ping, then the neighbour table."""
        _run(["ping", "-6", "-c", "1", "-W", "1", f"ff02::1%{CABLE_IFACE}"], timeout=3)
        out = _run(["ip", "-6", "neigh", "show", "dev", CABLE_IFACE])
        found = []
        for line in out.splitlines():
            m = re.match(r"^(fe80:[0-9a-f:]+)\s", line, re.I)
            if m and "FAILED" not in line:
                found.append(m.group(1))
        return found

    def _ipv4_neighbours(self) -> list[str]:
        out = _run(["ip", "-4", "neigh", "show", "dev", CABLE_IFACE])
        return [m.group(1) for m in re.finditer(r"^(169\.254\.\d+\.\d+)\s", out, re.M) if "FAILED" not in out]

    def _ipv6_networking_status(self, v6: str) -> Optional[dict]:
        """GET /networking/status over a scoped link-local IPv6 address (http.client handles the zone id)."""
        try:
            c = http.client.HTTPConnection(f"{v6}%{CABLE_IFACE}", PORT, timeout=PROBE_TIMEOUT_S)
            c.request("GET", "/networking/status", headers=HEADERS)
            r = c.getresponse()
            data = json.loads(r.read().decode("utf-8")) if r.status == 200 else None
            c.close()
            return data
        except Exception:
            return None

    def _discover_cable(self) -> Optional[str]:
        """The robot's IPv4 on the cable, or None. Tries the known address, then IPv4 and IPv6 neighbours."""
        if not _iface_up(CABLE_IFACE):
            return None
        candidates: list[str] = []
        if self.cable["addr"]:
            candidates.append(self.cable["addr"])
        candidates += [a for a in self._ipv4_neighbours() if a not in candidates]
        for a in candidates:
            ok, _ms, _err, _h = self._probe(a)
            if ok:
                return a
        for v6 in self._ipv6_neighbours():
            st = self._ipv6_networking_status(v6)
            ip = (((st or {}).get("interfaces") or {}).get("eth0") or {}).get("ipAddress")
            if ip:
                ip = str(ip).split("/")[0]
                ok, _ms, _err, _h = self._probe(ip)
                if ok:
                    return ip
        return None

    def check(self) -> None:
        now = _now()
        self.self_addrs = {"cable": _iface_ipv4(CABLE_IFACE), "lan": _iface_ipv4(LAN_IFACE)}
        # Cable
        addr = self.cable["addr"]
        ok = False
        ms = err = health = None
        if addr and _iface_up(CABLE_IFACE):
            ok, ms, err, health = self._probe(addr)
        if not ok:
            found = self._discover_cable()
            if found:
                addr = found
                ok, ms, err, health = self._probe(addr)
        with self.lock:
            if ok:
                self.cable.update(addr=addr, up=True, rtt_ms=round(ms, 2) if ms else None, checked_at=now, error=None)
            else:
                self.cable.update(up=False, rtt_ms=None, checked_at=now, error=err or ("no carrier" if not _iface_up(CABLE_IFACE) else "not found"))
        if health:
            with self.lock:
                self.robot.update(name=health.get("name"), serial=health.get("robot_serial"))
        # LAN: the configured address, else what the robot says its wlan0 is.
        lan = self.lan["addr"]
        if not lan and ok:
            st = self._networking_status(addr)
            w = (((st or {}).get("interfaces") or {}).get("wlan0") or {}).get("ipAddress")
            if w:
                lan = str(w).split("/")[0]
        lok = lms = lerr = None
        if lan:
            lok, lms, lerr, lh = self._probe(lan)
            if lh and not health:
                with self.lock:
                    self.robot.update(name=lh.get("name"), serial=lh.get("robot_serial"))
        with self.lock:
            self.lan.update(addr=lan, up=bool(lok), rtt_ms=round(lms, 2) if lms else None, checked_at=now, error=None if lok else (lerr or "no address"))
        self._persist()

    def _loop(self) -> None:
        while True:
            try:
                self.check()
            except Exception:
                pass
            self._wake.wait(CHECK_UP_S if self.cable["up"] else CHECK_DOWN_S)
            self._wake.clear()

    def discover_now(self) -> dict:
        self.check()
        return self.snapshot()

    # ---- requests ----
    def request(self, method: str, path: str, *, content: Optional[bytes] = None, json_body: Any = None, timeout_s: float = 10.0, by: str = "bims") -> tuple[httpx.Response, str, float]:
        """One request to the robot over the best path; a cable failure falls back to the LAN once."""
        tried: list[str] = []
        last_err: Optional[Exception] = None
        for _attempt in range(2):
            name, base = self.base()
            if name in tried:
                break
            tried.append(name)
            t0 = time.perf_counter()
            try:
                r = self.client.request(method, base + path, content=content, json=json_body, timeout=timeout_s, headers={"Content-Type": "application/json"} if (content or json_body is not None) else None)
                ms = (time.perf_counter() - t0) * 1000
                CALLS.add(method=method, path=path, status=r.status_code, ms=round(ms, 1), link=name, by=by)
                return r, name, ms
            except Exception as e:
                ms = (time.perf_counter() - t0) * 1000
                last_err = e
                CALLS.add(method=method, path=path, status=None, ms=round(ms, 1), link=name, by=by, error=f"{type(e).__name__}: {e}"[:200])
                self.mark_down(name, f"{type(e).__name__}: {e}")
        raise HTTPException(status_code=502, detail=f"OT-2 request failed: {type(last_err).__name__}: {last_err}" if last_err else "OT-2 unreachable")


LINK = Link()


# ---------------------------------------------------------------- run reads

PAUSE_RE = re.compile(r"^\s*ARM\s+(PARKED|AT_SCAN|NO_INSTRUCTION)\s+(\d+)\b")
COMMENT_RE = re.compile(r"^\s*ARM\s+(PROBING|CALIBRATED|CLEAR|FILLED)(?:\s+(\d+))?\b")
TERMINAL = {"succeeded", "failed", "stopped"}
PAGE = 50


def _marker_str(m: Optional[dict]) -> str:
    return f"{m['kind']}:{m['cart']}:{int(m['paused'])}" if m else "-"


def read_pause(run_id: str, by: str = "bims") -> dict:
    """The same read BIMS's readRunPause makes, from here: status, the pause the
    run is at, the last two ARM markers in its command log, and a fingerprint
    that changes whenever any of that does."""
    t0 = time.perf_counter()
    r, link, _ms = LINK.request("GET", f"/runs/{run_id}", by=by)
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"GET /runs/{run_id} -> HTTP {r.status_code}")
    run = (r.json() or {}).get("data") or {}
    status = str(run.get("status") or "unknown")
    out: dict = {"status": status, "message": None, "pause": None, "last": None, "prev": None, "link": link}
    if status in ("paused", "running"):
        cmds: list = []
        try:
            p, _l, _m = LINK.request("GET", f"/runs/{run_id}/commands?pageLength={PAGE}", by=by)
            page = p.json() if p.status_code == 200 else {}
            cmds = page.get("data") or []
            meta = page.get("meta") or {}
            total = int(meta.get("totalLength") or 0)
            end = int(meta.get("cursor") or 0) + len(cmds)
            if total > 0 and end < total:
                p, _l, _m = LINK.request("GET", f"/runs/{run_id}/commands?cursor={max(0, total - PAGE)}&pageLength={PAGE}", by=by)
                page = p.json() if p.status_code == 200 else {}
                cmds = page.get("data") or []
        except HTTPException:
            cmds = []
        waits = [c for c in cmds if c.get("commandType") == "waitForResume"]
        cur = None
        if status == "paused":
            cur = next((c for c in waits if c.get("status") == "running"), waits[-1] if waits else None)
        msg = ((cur or {}).get("params") or {}).get("message")
        out["message"] = str(msg) if isinstance(msg, str) else None
        m = PAUSE_RE.match(out["message"] or "")
        out["pause"] = {"kind": m.group(1), "cart": int(m.group(2))} if m else None
        last = prev = None
        for c in cmds:
            mk = None
            text = ((c.get("params") or {}).get("message"))
            if c.get("commandType") == "waitForResume":
                m = PAUSE_RE.match(text or "")
                if m:
                    mk = {"kind": m.group(1), "cart": int(m.group(2)), "paused": c.get("status") == "running"}
            elif c.get("commandType") == "comment":
                m = COMMENT_RE.match(text or "")
                if m:
                    mk = {"kind": m.group(1), "cart": int(m.group(2)) if m.group(2) else 0, "paused": False}
            if mk:
                prev, last = last, mk
        out["last"], out["prev"] = last, prev
    out["fp"] = f"{status}|{out['message'] or ''}|{_marker_str(out['last'])}|{_marker_str(out['prev'])}"
    out["read_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    return out


# ---------------------------------------------------------------- the broker

class Broker:
    """The instruction BIMS wants the protocol to act on next, and what the protocol announces."""

    def __init__(self) -> None:
        self.cond = threading.Condition()
        self.rec: Optional[dict] = _load_json(INSTRUCTION_FILE)
        self.events: deque = deque(maxlen=2000)

    def set(self, rec: dict) -> None:
        with self.cond:
            self.rec = rec
            self.cond.notify_all()
        _save_json(INSTRUCTION_FILE, rec)
        self.event("instruction_set", loop=rec.get("loop"), cart=rec.get("cart"), seq=rec.get("seq"), action=rec.get("action"))

    def _fresh(self, loop: str, after: int) -> Optional[dict]:
        r = self.rec
        if r and str(r.get("loop")) == loop:
            try:
                if int(r.get("seq")) > after:
                    return r
            except (TypeError, ValueError):
                return None
        return None

    def wait(self, loop: str, after: int, wait_s: float) -> Optional[dict]:
        deadline = time.monotonic() + wait_s
        with self.cond:
            while True:
                r = self._fresh(loop, after)
                if r:
                    return r
                left = deadline - time.monotonic()
                if left <= 0:
                    return None
                self.cond.wait(min(left, 1.0))

    def event(self, kind: str, **data: Any) -> dict:
        row = {"at": _now(), "kind": kind, **data}
        with self.cond:
            self.events.append(row)
        return row

    def last_events(self, limit: int) -> list[dict]:
        with self.cond:
            rows = list(self.events)
        return list(reversed(rows))[:limit]


BROKER = Broker()


# ---------------------------------------------------------------- routes

@router.get("/link", dependencies=[Depends(_key)])
async def link_status() -> dict:
    return LINK.snapshot()


@router.post("/link/discover", dependencies=[Depends(_key)])
async def link_discover() -> dict:
    return await run_in_threadpool(LINK.discover_now)


@router.get("/calls", dependencies=[Depends(_key)])
async def calls(limit: int = Query(100, ge=1, le=500)) -> dict:
    return {"calls": CALLS.last(limit)}


@router.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], dependencies=[Depends(_key)])
async def proxy(path: str, request: Request, timeout_s: float = Query(10.0, ge=0.5, le=60.0)) -> Response:
    """Forward to the robot's HTTP API as-is (body, method, query minus timeout_s)."""
    body = await request.body()
    qs = "&".join(f"{k}={v}" for k, v in request.query_params.multi_items() if k != "timeout_s")
    target = "/" + path + (f"?{qs}" if qs else "")

    def go():
        return LINK.request(request.method, target, content=body or None, timeout_s=timeout_s)

    r, link, ms = await run_in_threadpool(go)
    return Response(
        content=r.content,
        status_code=r.status_code,
        media_type=r.headers.get("content-type", "application/json"),
        headers={"x-ot2-link": link, "x-ot2-ms": f"{ms:.1f}"},
    )


@router.get("/run/{run_id}/pause", dependencies=[Depends(_key)])
async def run_pause(run_id: str) -> dict:
    return await run_in_threadpool(read_pause, run_id)


@router.get("/run/{run_id}/wait", dependencies=[Depends(_key)])
async def run_wait(run_id: str, fp: Optional[str] = None, timeout_s: float = Query(20.0, ge=0.0, le=MAX_WAIT_S), poll_ms: int = Query(150, ge=50, le=2000)) -> dict:
    """Return the run read as soon as it differs from `fp` (or at once when fp is
    empty), when the run ends, or after timeout_s. BIMS keeps the gate logic;
    this only removes the queue's seconds from every poll."""

    def go():
        t0 = time.perf_counter()
        polls = 0
        while True:
            r = read_pause(run_id)
            polls += 1
            changed = r["fp"] != (fp or "")
            if changed or r["status"] in TERMINAL or (time.perf_counter() - t0) >= timeout_s:
                r["changed"] = changed
                r["waited_ms"] = round((time.perf_counter() - t0) * 1000, 1)
                r["polls"] = polls
                return r
            time.sleep(poll_ms / 1000.0)

    return await run_in_threadpool(go)


class Instruction(BaseModel):
    seq: int = Field(ge=0)
    loop: str = Field(min_length=1, max_length=64)
    cart: int = Field(ge=0)
    action: str = Field(pattern=r"^(start|scan|fill|skip|end)$")
    barcode: Optional[str] = None
    run_id: Optional[str] = None


@router.post("/loop/instruction", dependencies=[Depends(_key)])
async def loop_instruction_set(body: Instruction) -> dict:
    rec = body.model_dump()
    rec["set_at"] = _now()
    BROKER.set(rec)
    return {"ok": True, "instruction": rec}


@router.get("/loop/instruction", dependencies=[Depends(_key_or_robot)])
async def loop_instruction_get(request: Request, loop: str = Query(min_length=1), after: int = Query(-1), wait_s: float = Query(5.0, ge=0.0, le=MAX_WAIT_S)) -> Response:
    """The protocol's long-poll: the stored instruction when it is for `loop` and
    newer than `after`, else 204 once wait_s is up."""
    rec = await run_in_threadpool(BROKER.wait, loop, after, wait_s)
    if rec is None:
        return Response(status_code=204)
    BROKER.event("instruction_served", loop=loop, cart=rec.get("cart"), seq=rec.get("seq"), action=rec.get("action"), peer=request.client.host if request.client else None)
    return Response(content=json.dumps(rec), media_type="application/json")


class Announce(BaseModel):
    loop: Optional[str] = None
    kind: str = Field(min_length=1, max_length=32)
    cart: Optional[int] = None
    run_id: Optional[str] = None
    note: Optional[str] = Field(default=None, max_length=200)


@router.post("/loop/announce", dependencies=[Depends(_key_or_robot)])
async def loop_announce(body: Announce, request: Request) -> dict:
    row = BROKER.event("announce", loop=body.loop, marker=body.kind.upper(), cart=body.cart, run_id=body.run_id, note=body.note, peer=request.client.host if request.client else None)
    return {"ok": True, "at": row["at"]}


@router.get("/loop/state", dependencies=[Depends(_key)])
async def loop_state() -> dict:
    with BROKER.cond:
        rec = dict(BROKER.rec) if BROKER.rec else None
    return {"instruction": rec, "self": LINK.snapshot()["self"], "events": BROKER.last_events(50)}


@router.get("/loop/events", dependencies=[Depends(_key)])
async def loop_events(limit: int = Query(200, ge=1, le=2000)) -> dict:
    return {"events": BROKER.last_events(limit)}

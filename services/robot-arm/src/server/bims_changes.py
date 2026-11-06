"""
Report changes made ON THE PI to BIMS's robot arm Change Log (2026-11-06).

BIMS keeps one row per change to the arm (Maintenance > Change Log, labels in
src/lib/robot-arm/change-labels.ts). Changes made from a BIMS page log
themselves; this module is the Pi's half, so gain writes, router installs and
service restarts show up in the same list:

    POST /servos/gains        -> servo.p_coefficient servo:2 6 -> 16   (servo_config.py)
    install_*.py              -> pi.router.thermal Installed           (scripts/bims_report.py)
    service start             -> pi.service.start 0.2.0, plus pi.route <path> Added / Removed
                                 and pi.app_py <hash> -> <hash> when app.py changed since the
                                 previous start (install_change_reporter.py wires it in)
    by hand                   -> python3 scripts/bims_report.py change --hardware network
                                 --key pi.wifi_ssid --new Aquinas_Townpark

Every row is appended to ~/.bims-arm/changes-pending.jsonl first and sent from
there, so a change made while BIMS is unreachable still arrives on the next
flush (every service start, every later report). Rows BIMS rejects (a bad label)
are dropped and printed; rows it could not store are kept.

Config (environment; a script run by hand also reads .env at the project root):
    BIMS_CHANGES_URL    where to POST. Default: BIMS_WEBHOOK_URL with /webhook -> /changes,
                        else BIMS_URL + /api/robot-arm/changes
    AGENT_API_KEY       the x-agent-api-key BIMS expects (same key as the webhook)

Stdlib only; never raises into the caller.
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

ROOT = Path(__file__).resolve().parents[2]
PENDING = Path(os.environ.get("BIMS_ARM_CHANGES_PENDING", str(Path.home() / ".bims-arm" / "changes-pending.jsonl")))
STATE = Path(os.environ.get("BIMS_ARM_CHANGES_STATE", str(Path.home() / ".bims-arm" / "changes-state.json")))
CHUNK = 50
TIMEOUT_S = 8.0
RETRY_DELAYS_S = (1.0, 3.0)

_lock = threading.Lock()


def _log(msg: str) -> None:
    print(f"[bims-changes] {msg}", flush=True)


def _load_dotenv() -> None:
    """Fill missing BIMS_* / AGENT_API_KEY from the project's .env (scripts run by hand have no systemd env)."""
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    try:
        for raw in env_file.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            if k.startswith("export "):
                k = k[7:].strip()
            if k and k not in os.environ:
                os.environ[k] = v.strip().strip("'\"")
    except Exception as exc:  # pragma: no cover - best effort
        _log(f".env not read: {exc}")


def config() -> tuple[Optional[str], Optional[str]]:
    """(url, key), either None when not configured."""
    if not os.environ.get("AGENT_API_KEY") or not (os.environ.get("BIMS_CHANGES_URL") or os.environ.get("BIMS_WEBHOOK_URL") or os.environ.get("BIMS_URL")):
        _load_dotenv()
    url = os.environ.get("BIMS_CHANGES_URL")
    if not url:
        hook = os.environ.get("BIMS_WEBHOOK_URL", "")
        if hook.rstrip("/").endswith("/api/robot-arm/webhook"):
            url = hook.rstrip("/")[: -len("/webhook")] + "/changes"
        elif os.environ.get("BIMS_URL"):
            url = os.environ["BIMS_URL"].rstrip("/") + "/api/robot-arm/changes"
    return (url or None), (os.environ.get("AGENT_API_KEY") or None)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def change(
    hardware: str,
    key: str,
    *,
    target: Optional[str] = None,
    old: Any = None,
    new: Any = None,
    unit: Optional[str] = None,
    note: Optional[str] = None,
    details: Optional[dict[str, Any]] = None,
    page: str = "pi",
    source: str = "pi",
) -> dict[str, Any]:
    """One Change Log row, as BIMS's POST /api/robot-arm/changes wants it."""
    return {
        "at": _now(),
        "page": page,
        "hardware": hardware,
        "key": key,
        "target": target,
        "oldValue": old,
        "newValue": new,
        "unit": unit,
        "note": note,
        "details": details,
        "source": source,
    }


def file_hash(path: Path) -> Optional[str]:
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()[:12]
    except Exception:
        return None


# ── pending queue ─────────────────────────────────────────────────────────


def _read_pending() -> list[dict[str, Any]]:
    if not PENDING.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in PENDING.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            continue
    return rows


def _write_pending(rows: list[dict[str, Any]]) -> None:
    PENDING.parent.mkdir(parents=True, exist_ok=True)
    PENDING.write_text("".join(json.dumps(r, separators=(",", ":")) + "\n" for r in rows), encoding="utf-8")


def _append_pending(rows: Iterable[dict[str, Any]]) -> None:
    PENDING.parent.mkdir(parents=True, exist_ok=True)
    with PENDING.open("a", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r, separators=(",", ":")) + "\n")


def _post(rows: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """BIMS's answer ({written, rejected, failed}) or None when it could not be reached."""
    url, key = config()
    if not url or not key:
        _log("not configured (BIMS_CHANGES_URL / BIMS_WEBHOOK_URL and AGENT_API_KEY); rows stay pending")
        return None
    body = json.dumps({"changes": rows, "host": socket.gethostname()}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST", headers={"content-type": "application/json", "x-agent-api-key": key})
    for attempt, delay in enumerate((0.0, *RETRY_DELAYS_S)):
        if delay:
            time.sleep(delay)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
                return json.loads(res.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as exc:
            # 4xx is BIMS's verdict on the whole request (bad key, bad body): retrying will not change it.
            text = exc.read().decode("utf-8", "replace")[:200] if exc.fp else ""
            _log(f"HTTP {exc.code} from BIMS: {text}")
            if 400 <= exc.code < 500:
                return {"written": 0, "rejected": [{"index": i, "reason": f"HTTP {exc.code}"} for i in range(len(rows))], "failed": []}
        except Exception as exc:
            _log(f"attempt {attempt + 1}: {exc}")
    return None


def flush() -> int:
    """Send every pending row. Returns how many BIMS stored; leaves the rest pending."""
    with _lock:
        pending = _read_pending()
        if not pending:
            return 0
        stored = 0
        remaining: list[dict[str, Any]] = []
        for i in range(0, len(pending), CHUNK):
            chunk = pending[i : i + CHUNK]
            if remaining:
                remaining.extend(chunk)
                continue
            ans = _post(chunk)
            if ans is None:
                remaining.extend(chunk)
                continue
            failed = {int(f) for f in (ans.get("failed") or []) if isinstance(f, (int, float))}
            for r in ans.get("rejected") or []:
                idx = r.get("index") if isinstance(r, dict) else None
                row = chunk[idx] if isinstance(idx, int) and 0 <= idx < len(chunk) else None
                _log(f"rejected by BIMS ({r.get('reason') if isinstance(r, dict) else r}): {row.get('key') if row else '?'} {row.get('target') if row else ''}")
            stored += int(ans.get("written") or 0)
            remaining.extend(chunk[j] for j in sorted(failed) if j < len(chunk))
        _write_pending(remaining)
        if remaining:
            _log(f"{len(remaining)} row(s) still pending")
        return stored


def report(rows: list[dict[str, Any]], wait: bool = False) -> int:
    """Queue rows and send. wait=False sends from a daemon thread (the service); wait=True sends now (scripts)."""
    rows = [r for r in rows if r]
    if not rows:
        return 0
    try:
        with _lock:
            _append_pending(rows)
    except Exception as exc:
        _log(f"could not queue: {exc}")
        return 0
    if wait:
        return flush()
    threading.Thread(target=flush, name="bims-changes", daemon=True).start()
    return 0


# ── what the Pi reports ───────────────────────────────────────────────────

GAIN_KEYS = {"P_Coefficient": "servo.p_coefficient", "D_Coefficient": "servo.d_coefficient", "I_Coefficient": "servo.i_coefficient"}


def gain_rows(results: list[dict[str, Any]], persist: bool) -> list[dict[str, Any]]:
    """One row per servo gain that changed, from write_gains()'s before/after."""
    rows: list[dict[str, Any]] = []
    note = "Saved to EEPROM" if persist else "Temporary (lost at power-off)"
    for r in results:
        before, after = r.get("before") or {}, r.get("after") or {}
        for reg, key in GAIN_KEYS.items():
            if reg in after and before.get(reg) != after.get(reg):
                rows.append(change("servo", key, target=f"servo:{r.get('id')}", old=before.get(reg), new=after.get(reg), note=note, details={"joint": r.get("joint"), "lock": after.get("Lock")}))
    return rows


def report_gains(results: list[dict[str, Any]], persist: bool) -> None:
    try:
        report(gain_rows(results, persist))
    except Exception as exc:  # the write already happened; never fail the route
        _log(f"gains not reported: {exc}")


def report_install(name: str, files: Iterable[Path] = (), note: Optional[str] = None, wait: bool = True) -> None:
    """An install_*.py wrote something: pi.router.<name> Installed, with the files' hashes."""
    try:
        hashes = {Path(f).name: file_hash(Path(f)) for f in files}
        report([change("pi", f"pi.router.{name}", new="Installed", note=note, details={"files": hashes} if hashes else None)], wait=wait)
    except Exception as exc:
        _log(f"install not reported: {exc}")


def _snapshot(app: Any) -> dict[str, Any]:
    routes = sorted({p for p in (getattr(r, "path", None) for r in getattr(app, "routes", [])) if isinstance(p, str)})
    return {"version": getattr(app, "version", None), "app_py": file_hash(ROOT / "src" / "server" / "app.py"), "routes": routes, "at": _now()}


def start_rows(now: dict[str, Any], prev: Optional[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rows for a service start: the start itself, then what differs from the previous start."""
    rows = [change("pi", "pi.service.start", new=now.get("version") or "?", details={"app_py": now.get("app_py"), "routes": len(now.get("routes") or [])})]
    if not prev:
        return rows
    if prev.get("app_py") and now.get("app_py") and prev["app_py"] != now["app_py"]:
        rows.append(change("pi", "pi.app_py", old=prev["app_py"], new=now["app_py"], note="app.py changed since the previous start"))
    before, after = set(prev.get("routes") or []), set(now.get("routes") or [])
    for p in sorted(after - before):
        rows.append(change("pi", "pi.route", target=p, new="Added"))
    for p in sorted(before - after):
        rows.append(change("pi", "pi.route", target=p, new="Removed"))
    return rows


def service_started(app: Any, delay_s: float = 3.0) -> None:
    """Call at import time from app.py (install_change_reporter.py): reports the start from a daemon thread."""

    def run() -> None:
        try:
            time.sleep(delay_s)
            now = _snapshot(app)
            prev: Optional[dict[str, Any]] = None
            try:
                prev = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else None
            except Exception:
                prev = None
            rows = start_rows(now, prev)
            STATE.parent.mkdir(parents=True, exist_ok=True)
            STATE.write_text(json.dumps(now), encoding="utf-8")
            report(rows, wait=True)
        except Exception as exc:
            _log(f"service start not reported: {exc}")

    threading.Thread(target=run, name="bims-changes-start", daemon=True).start()

"""
UVC controls for the robot-arm colour camera: exposure, gain, white balance,
sharpness and the rest of what the sensor lets us set.

Why: the D415's colour sensor runs on full auto out of the box. Under lab
light auto exposure picks a long shutter (motion blur on a moving arm) and a
high gain (noise on tag edges), and both change from frame to frame, so the
AprilTag corners the arm's checks depend on wobble with the lighting. Fixing
these is free in CPU and heat: the camera does the work.

Ranges come from the device, never from this file. ``v4l2-ctl
--list-ctrls-menus`` reports every control's min/max/step/default/current
value and menu labels; that is what BIMS gets, so its sliders and number
boxes are bounded by what the hardware accepts. A control marked
``inactive`` (e.g. exposure_time_absolute while auto_exposure is on) is
reported as such rather than hidden.

Endpoints (auth is applied by app.py when the router is included):
    GET  /cameras/{name}/controls
        -> {available, reason, device, source, controls: [Control...],
            saved: {name: value}, saved_file}
    POST /cameras/{name}/controls        {set: {name: value, ...}, persist?: true}
        -> as GET + {applied: [name...], rejected: {name: reason}}
    POST /cameras/{name}/controls/reset  {persist?: true}
        -> every control back to the device default, saved set cleared

    Control = {id, type: "int"|"bool"|"menu", min, max, step, default, value,
               flags: [...], menu: {"0": "Disabled", ...} | null, unit, hint}

Writes go through ``v4l2-ctl --set-ctrl`` on the colour node while
cameras.py streams it: V4L2 controls are per-device, not per-open, so a
second file descriptor may set them. An auto switch going to manual is
written before the values it gates, one going back to auto after them
(so a reset restores exposure/gain defaults while they are still
writable), and every write is read back: v4l2-ctl's exit status is not a
reliable signal. A gated write while auto is on comes back as a rejection
that names the switch to flip. Verified on arm-pi 2026-10-23: on the D415,
gain and exposure_dynamic_framerate are gated by auto_exposure too (EACCES
without an `inactive` flag).

Persistence: the applied set is saved to CAMERA_CONTROLS_FILE (default
calibrations/camera_controls.json, keyed by camera name). cameras.py calls
:func:`apply_saved` every time it (re)opens the device, so a replug or a
service restart does not quietly return the sensor to auto.

Units: UVC exposure_time_absolute is in units of 100 microseconds (166 =
16.6 ms, i.e. 1/60 s); white_balance_temperature is kelvin; gamma is x0.01.
These hints travel with the control so the UI can show real units next to
raw values.

Config (env, ~/robot-arm/.env):
    CAMERA_CONTROLS_FILE   saved set (default calibrations/camera_controls.json)
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

try:
    from . import cameras as _cameras  # type: ignore
except Exception:  # pragma: no cover - standalone import
    _cameras = None  # type: ignore

log = logging.getLogger(__name__)
router = APIRouter(prefix="/cameras", tags=["camera-controls"])

SAVED_FILE = Path(os.environ.get("CAMERA_CONTROLS_FILE", "calibrations/camera_controls.json"))
_io_lock = threading.Lock()

# Auto switches and the value that means MANUAL on each. Order of writes:
# an auto switch going to manual is written first (it frees the controls it
# gates), an auto switch going back to auto is written last (the gated
# values are written while still accepted), everything else in between. The
# UVC driver answers EACCES ("Permission denied") for a gated control while
# its auto switch is on, and on this camera `gain` is gated by auto_exposure
# too without being flagged inactive.
_AUTO_MANUAL: Dict[str, int] = {
    "auto_exposure": 1,  # UVC menu: 1 = Manual Mode, 3 = Aperture Priority
    "white_balance_automatic": 0,
    "exposure_auto": 1,
    "focus_automatic_continuous": 0,
}
_GATED_BY: Dict[str, str] = {
    "exposure_time_absolute": "auto_exposure",
    "gain": "auto_exposure",
    "exposure_dynamic_framerate": "auto_exposure",
    "white_balance_temperature": "white_balance_automatic",
}

# Known UVC controls: unit of the raw value and a one-line hint for the UI.
_META: Dict[str, Dict[str, str]] = {
    "exposure_time_absolute": {"unit": "x100 us", "hint": "Shutter time. 166 = 16.6 ms (1/60 s); shorter freezes a moving arm but needs more light. Only active with auto_exposure = Manual Mode."},
    "auto_exposure": {"unit": "", "hint": "1 = Manual Mode (exposure_time_absolute applies), 3 = Aperture Priority (camera picks the shutter)."},
    "exposure_dynamic_framerate": {"unit": "", "hint": "Let a long exposure lower the frame rate instead of clipping the shutter."},
    "gain": {"unit": "", "hint": "Sensor amplification. Lower = less noise on tag edges; raise exposure or add light before raising gain."},
    "brightness": {"unit": "", "hint": "Black-level offset. Leave at 0 unless the image is crushed."},
    "contrast": {"unit": "", "hint": "Tone curve steepness. Mid value keeps edges linear for the detector."},
    "saturation": {"unit": "", "hint": "Colour intensity. No effect on detection (it reads luma only)."},
    "hue": {"unit": "deg", "hint": "Colour rotation. No effect on detection."},
    "gamma": {"unit": "x0.01", "hint": "300 = gamma 3.0 (sRGB-like). Lower flattens highlights."},
    "sharpness": {"unit": "", "hint": "In-camera edge enhancement. Over the default it adds ringing that hurts sub-pixel corners; keep at or below default."},
    "backlight_compensation": {"unit": "", "hint": "Lifts shadows against a bright background. Usually off."},
    "white_balance_automatic": {"unit": "", "hint": "Camera picks the colour temperature. Off lets white_balance_temperature apply (fixed colours frame to frame)."},
    "white_balance_temperature": {"unit": "K", "hint": "Fixed colour temperature; daylight ~5000-6500, warm indoor ~2800-3500. Only active with white_balance_automatic off."},
    "power_line_frequency": {"unit": "", "hint": "Anti-flicker for mains lighting: 60 Hz in the US. Irrelevant under daylight."},
}

_HEAD_RE = re.compile(r"^\s*([a-z0-9_]+)\s+0x([0-9a-f]+)\s+\((\w+)\)\s*:\s*(.*)$")
_KV_RE = re.compile(r"(\w+)=(-?\w+)")
_MENU_RE = re.compile(r"^\s+(\d+):\s*(.+?)\s*$")
_FLAGS_RE = re.compile(r"flags=([\w, -]+?)\s*$")


# -- device -------------------------------------------------------------------

def _worker(name: str):
    mgr = _cameras.current() if _cameras is not None else None
    if mgr is None:
        return None
    peek = getattr(mgr, "peek", None)
    return peek(name) if peek else mgr.get(name)


def _device_for(name: str) -> Optional[str]:
    w = _worker(name)
    if w is None:
        return None
    return getattr(w, "device", None) or w.peek_device()


def _run(args: List[str], timeout: float = 5.0) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)


# -- read ---------------------------------------------------------------------

def _num(v: Optional[str]) -> Optional[int]:
    if v is None:
        return None
    try:
        return int(v)
    except ValueError:
        return None


def _parse_ctrls(text: str) -> List[dict]:
    out: List[dict] = []
    cur: Optional[dict] = None
    for line in text.splitlines():
        m = _HEAD_RE.match(line)
        if m:
            name, _hex, typ, rest = m.groups()
            kv = dict(_KV_RE.findall(rest))
            fm = _FLAGS_RE.search(rest)  # "flags=inactive, has-min-max" (comma + space)
            flags = [f.strip() for f in fm.group(1).split(",") if f.strip()] if fm else []
            # value=3 (Auto): the label after the number is the menu text.
            lbl = re.search(r"value=-?\d+\s+\(([^)]*)\)", rest)
            typ_out = {"int": "int", "int64": "int", "bool": "bool", "menu": "menu", "intmenu": "menu"}.get(typ)
            if typ_out is None:
                cur = None  # buttons / strings / bitmasks: nothing a slider can hold
                continue
            cur = {
                "id": name,
                "type": typ_out,
                "min": _num(kv.get("min")),
                "max": _num(kv.get("max")),
                "step": _num(kv.get("step")),
                "default": _num(kv.get("default")),
                "value": _num(kv.get("value")),
                "value_label": lbl.group(1) if lbl else None,
                "flags": flags,
                "menu": None,
                "unit": _META.get(name, {}).get("unit", ""),
                "hint": _META.get(name, {}).get("hint", ""),
            }
            if typ_out == "bool":
                cur.update(min=0, max=1, step=1)
            out.append(cur)
            continue
        mm = _MENU_RE.match(line)
        if mm and cur is not None and cur["type"] == "menu":
            cur["menu"] = cur["menu"] or {}
            cur["menu"][mm.group(1)] = mm.group(2)
    return out


def read_controls(device: str) -> List[dict]:
    r = _run(["v4l2-ctl", "-d", device, "--list-ctrls-menus"])
    if r.returncode != 0 and not r.stdout.strip():
        raise RuntimeError((r.stderr or r.stdout).strip() or f"v4l2-ctl failed ({r.returncode})")
    ctrls = _parse_ctrls(r.stdout)
    if not ctrls:
        raise RuntimeError("v4l2-ctl listed no controls")
    return ctrls


# -- validate + write ---------------------------------------------------------

def _coerce(ctrl: dict, value: Any) -> int:
    if isinstance(value, bool):
        value = int(value)
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ("true", "on", "yes"):
            value = 1
        elif v in ("false", "off", "no"):
            value = 0
        else:
            value = int(v, 0)
    if isinstance(value, float):
        if value != int(value):
            raise ValueError("must be a whole number")
        value = int(value)
    if not isinstance(value, int):
        raise ValueError("must be a number")
    if ctrl["type"] == "menu":
        if ctrl["menu"] and str(value) not in ctrl["menu"]:
            raise ValueError("must be one of " + ", ".join(f"{k} ({v})" for k, v in ctrl["menu"].items()))
        return value
    if ctrl["type"] == "bool":
        if value not in (0, 1):
            raise ValueError("must be 0 or 1")
        return value
    lo, hi, step = ctrl["min"], ctrl["max"], ctrl["step"] or 1
    if (lo is not None and value < lo) or (hi is not None and value > hi):
        raise ValueError(f"out of range {lo}..{hi}")
    if lo is not None and step > 1 and (value - lo) % step:
        raise ValueError(f"must step by {step} from {lo}")
    return value


def _ordered(wanted: Dict[str, int]) -> List[str]:
    to_manual = [n for n, v in wanted.items() if n in _AUTO_MANUAL and v == _AUTO_MANUAL[n]]
    to_auto = [n for n, v in wanted.items() if n in _AUTO_MANUAL and v != _AUTO_MANUAL[n]]
    rest = [n for n in wanted if n not in _AUTO_MANUAL]
    return to_manual + rest + to_auto


def _gate_reason(name: str, ctrls: Dict[str, dict]) -> str:
    gate = _GATED_BY.get(name)
    if gate and gate in ctrls:
        manual = _AUTO_MANUAL.get(gate)
        return f"the camera sets this automatically while {gate} is on; set {gate} = {manual} (manual) first"
    return "inactive: the camera is setting this automatically"


def apply_controls(device: str, values: Dict[str, Any]) -> tuple[List[str], Dict[str, str], List[dict]]:
    """Validate against the device's ranges, write in a safe order, read back.

    Returns (applied names, {rejected name: reason}, controls after)."""
    ctrls = {c["id"]: c for c in read_controls(device)}
    applied: List[str] = []
    rejected: Dict[str, str] = {}
    wanted: Dict[str, int] = {}
    for name, raw in values.items():
        c = ctrls.get(name)
        if c is None:
            rejected[name] = "no such control on this camera"
            continue
        try:
            wanted[name] = _coerce(c, raw)
        except (ValueError, TypeError) as e:
            rejected[name] = str(e)
    for name in _ordered(wanted):
        if ctrls[name].get("value") == wanted[name]:
            applied.append(name)  # already there; a gated control at its value needs no write
            continue
        r = _run(["v4l2-ctl", "-d", device, f"--set-ctrl={name}={wanted[name]}"])
        err = (r.stderr or "").strip()
        if r.returncode != 0 or "failed" in err.lower() or "error" in err.lower():
            if "permission denied" in err.lower() or "inactive" in (ctrls[name].get("flags") or []):
                rejected[name] = _gate_reason(name, ctrls)
            else:
                rejected[name] = err or f"v4l2-ctl exit {r.returncode}"
        else:
            applied.append(name)
    after = read_controls(device)
    by = {c["id"]: c for c in after}
    for name in list(applied):
        got = by.get(name, {}).get("value")
        if got != wanted[name]:
            applied.remove(name)
            c = by.get(name, {})
            why = _gate_reason(name, ctrls) if "inactive" in (c.get("flags") or []) else f"camera kept {got}"
            rejected[name] = f"not accepted ({why})"
    return applied, rejected, after


# -- persistence --------------------------------------------------------------

def _load_saved() -> Dict[str, Any]:
    try:
        data = json.loads(SAVED_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save(name: str, values: Optional[Dict[str, int]]) -> None:
    with _io_lock:
        data = _load_saved()
        if values is None:
            data.pop(name, None)
        else:
            data[name] = {**(data.get(name) or {}), **values}
        data["_meta"] = {
            "written_at": time.time(),
            "note": "applied by cameras.py on every device open; edit via BIMS or POST /cameras/{name}/controls",
        }
        SAVED_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = SAVED_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(SAVED_FILE)


def saved_for(name: str) -> Dict[str, int]:
    v = _load_saved().get(name)
    return {k: int(x) for k, x in v.items()} if isinstance(v, dict) else {}


def apply_saved(name: str, device: str) -> None:
    """Called by cameras.py after it opens the device. Best effort, logged."""
    values = saved_for(name)
    if not values:
        return
    try:
        applied, rejected, _ = apply_controls(device, values)
        if rejected:
            log.warning("camera %s: saved controls not accepted: %s", name, rejected)
        else:
            log.info("camera %s: re-applied %d saved controls on %s", name, len(applied), device)
    except Exception as e:  # pragma: no cover - hardware
        log.warning("camera %s: could not re-apply saved controls: %s", name, e)


# -- routes -------------------------------------------------------------------

class SetRequest(BaseModel):
    set: Dict[str, Any] = Field(default_factory=dict, max_length=40)
    persist: bool = True


class ResetRequest(BaseModel):
    persist: bool = True


def _payload(name: str, device: Optional[str], controls: Optional[List[dict]], reason: Optional[str] = None, **extra: Any) -> dict:
    return {
        "available": controls is not None,
        "reason": reason,
        "camera": name,
        "device": device,
        "source": "v4l2-ctl",
        "controls": controls or [],
        "saved": saved_for(name),
        "saved_file": str(SAVED_FILE),
        **extra,
    }


@router.get("/{name}/controls")
def get_controls(name: str):
    """Every settable control with its device-reported range and current value."""
    device = _device_for(name)
    if not device:
        return _payload(name, None, None, "camera node not found (is the camera plugged in?)")
    try:
        return _payload(name, device, read_controls(device))
    except Exception as e:
        return _payload(name, device, None, str(e))


@router.post("/{name}/controls")
def set_controls(name: str, body: SetRequest):
    """Apply values (validated against the device's ranges) and, by default, remember them."""
    if not body.set:
        raise HTTPException(status_code=422, detail="set is empty")
    device = _device_for(name)
    if not device:
        return _payload(name, None, None, "camera node not found", applied=[], rejected={k: "no device" for k in body.set})
    try:
        applied, rejected, after = apply_controls(device, body.set)
    except Exception as e:
        return _payload(name, device, None, str(e), applied=[], rejected={k: str(e) for k in body.set})
    if body.persist and applied:
        by = {c["id"]: c["value"] for c in after}
        _save(name, {k: by[k] for k in applied if k in by})
    return _payload(name, device, after, applied=applied, rejected=rejected)


@router.post("/{name}/controls/reset")
def reset_controls(name: str, body: ResetRequest):
    """Back to the camera's own defaults (auto exposure, auto white balance...)."""
    device = _device_for(name)
    if not device:
        return _payload(name, None, None, "camera node not found", applied=[], rejected={})
    try:
        ctrls = read_controls(device)
        defaults = {c["id"]: c["default"] for c in ctrls if c["default"] is not None}
        applied, rejected, after = apply_controls(device, defaults)
    except Exception as e:
        return _payload(name, device, None, str(e), applied=[], rejected={})
    if body.persist:
        _save(name, None)
    return _payload(name, device, after, applied=applied, rejected=rejected)

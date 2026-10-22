"""
Pi thermal and throttling state for BIMS — GET /health/thermal.

Why: the arm Pi (Raspberry Pi 5, passive heatsink, no fan) sat at 79–80 °C
with the camera at 1920x1080 @ 30 fps (2026-10-21), right at the firmware's
soft throttle point. When it throttles, the only symptom BIMS used to see was
a slower feed. This route tells BIMS what the firmware is doing so the arm
pages can warn the operator, and the BIMS side logs the episodes.

Response:
    {
      "temp_c": 79.6,
      "level": "ok" | "warm" | "hot" | "critical",
      "throttled_hex": "0xe0000",
      "now": ["throttled", "freq_capped"],            # active right now
      "since_boot": ["soft_temp_limit_occurred", …],  # ever, since boot
      "clock_mhz": 1800, "clock_max_mhz": 2400,
      "load_1m": 1.2, "service_cpu_pct": 95.3,        # this process, all threads
      "fan_rpm": null,
      "uptime_s": 198000,
      "thresholds": {"warm_c": 70, "hot_c": 78, "critical_c": 84},
      "network": {                                    # which Wi-Fi the Pi is on
        "iface": "wlan0", "ssid": "Aquinas_Townpark", "connection": "Aquinas",
        "signal_pct": 66, "freq_mhz": 5765, "ip": "192.168.1.231",
        "expected_ssid": "Aquinas_Townpark", "source": "nmcli"
      },
      "sampled_at": 1792620000.0
    }

`level` is what BIMS shows:
    critical  temp ≥ THERMAL_CRITICAL_C, or the firmware's soft temperature
              limit is active now (it is already cutting the clock to cool)
    hot       temp ≥ THERMAL_HOT_C, or throttled / frequency-capped right now
    warm      temp ≥ THERMAL_WARM_C, or under-voltage right now
    ok        otherwise

Pi 5 firmware behaviour, for reference: the clock is pulled down from 80 °C
(soft limit) and hard-throttled at 85 °C; the kernel's critical trip point
(~110 °C) powers the board off. Nothing on this Pi stops services on its own;
if BIMS loses the Pi after a `critical` reading, assume that trip.

Sources (no root needed): /sys/class/thermal/thermal_zone0/temp,
`vcgencmd get_throttled` (fallback: /sys/devices/platform/soc/soc:firmware/
get_throttled), cpufreq sysfs, os.getloadavg(), os.times() for this process
(so service_cpu_pct can exceed 100 with several busy threads).

`network` (2026-10-22): the Pi had quietly moved between its two saved Wi-Fi
networks (Aquinas_Townpark, now preferred at autoconnect priority 100, and
Fannin_WIFI at 10) and nothing in BIMS said which one it was on — the arm pages
only showed "unreachable" once the tunnel heartbeat went stale. nmcli is
read as the service user (no root needed; `dev show` + the cached scan list, no
rescan), cached for NETWORK_TTL_S so the 30 s BIMS poll never queues nmcli calls.
`expected_ssid` comes from ARM_WIFI_EXPECTED_SSID so BIMS can flag the wrong network.

Env (~/robot-arm/.env): THERMAL_WARM_C, THERMAL_HOT_C, THERMAL_CRITICAL_C,
ARM_WIFI_EXPECTED_SSID (e.g. Aquinas_Townpark), THERMAL_WIFI_IFACE (default wlan0).
Installed on the Pi by scripts/install_thermal_router.py (auth: require_api_key).
"""

from __future__ import annotations

import os
import re
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter

router = APIRouter(prefix="/health", tags=["thermal"])


def _env_float(key: str, default: float) -> float:
    try:
        return float(os.environ.get(key, "") or default)
    except ValueError:
        return default


WARM_C = _env_float("THERMAL_WARM_C", 70.0)
HOT_C = _env_float("THERMAL_HOT_C", 78.0)
CRITICAL_C = _env_float("THERMAL_CRITICAL_C", 84.0)

# vcgencmd get_throttled bit meanings (Raspberry Pi firmware).
_NOW_BITS = {0: "under_voltage", 1: "freq_capped", 2: "throttled", 3: "soft_temp_limit"}
_BOOT_BITS = {
    16: "under_voltage_occurred",
    17: "freq_capped_occurred",
    18: "throttled_occurred",
    19: "soft_temp_limit_occurred",
}

_TEMP = Path("/sys/class/thermal/thermal_zone0/temp")
_THROTTLED_SYSFS = Path("/sys/devices/platform/soc/soc:firmware/get_throttled")
_CPUFREQ = Path("/sys/devices/system/cpu/cpu0/cpufreq")
_FAN_GLOB = "/sys/devices/platform/cooling_fan/hwmon/hwmon*/fan1_input"


def _read_temp_c() -> Optional[float]:
    try:
        return round(int(_TEMP.read_text().strip()) / 1000.0, 1)
    except Exception:
        return None


def _read_throttled() -> Optional[int]:
    try:
        out = subprocess.run(["vcgencmd", "get_throttled"], capture_output=True, text=True, timeout=2, check=False).stdout
        if "=" in out:
            return int(out.split("=", 1)[1].strip(), 16)
    except Exception:
        pass
    try:
        return int(_THROTTLED_SYSFS.read_text().strip(), 16)
    except Exception:
        return None


def _read_khz(name: str) -> Optional[int]:
    try:
        return int((_CPUFREQ / name).read_text().strip())
    except Exception:
        return None


def _read_fan_rpm() -> Optional[int]:
    try:
        import glob

        for p in glob.glob(_FAN_GLOB):
            return int(Path(p).read_text().strip())
    except Exception:
        pass
    return None


def _uptime_s() -> Optional[int]:
    try:
        return int(float(Path("/proc/uptime").read_text().split()[0]))
    except Exception:
        return None


# This process's CPU use since the previous sample (all threads).
_cpu_lock = threading.Lock()
_cpu_last: tuple[float, float] | None = None  # (wall, cpu seconds)


def _service_cpu_pct() -> Optional[float]:
    global _cpu_last
    t = os.times()
    cpu = t.user + t.system
    wall = time.monotonic()
    with _cpu_lock:
        prev = _cpu_last
        _cpu_last = (wall, cpu)
    if prev is None or wall - prev[0] < 0.5:
        return None
    return round(100.0 * (cpu - prev[1]) / (wall - prev[0]), 1)


# ---- Wi-Fi: which network the Pi is on (nmcli, read-only, cached) -------------
WIFI_IFACE = os.environ.get("THERMAL_WIFI_IFACE", "") or "wlan0"
EXPECTED_SSID: Optional[str] = os.environ.get("ARM_WIFI_EXPECTED_SSID", "").strip() or None
NETWORK_TTL_S = 15.0
_net_lock = threading.Lock()
_net_cache: tuple[float, dict[str, Any]] | None = None


def _nmcli(*args: str) -> list[str]:
    out = subprocess.run(["nmcli", "-t", *args], capture_output=True, text=True, timeout=4, check=False)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or f"nmcli exit {out.returncode}")
    return out.stdout.splitlines()


def _nm_fields(line: str) -> list[str]:
    # nmcli -t escapes ':' and '\' inside values with a backslash.
    return [f.replace("\\:", ":").replace("\\\\", "\\") for f in re.split(r"(?<!\\):", line)]


def _read_network() -> dict[str, Any]:
    net: dict[str, Any] = {
        "iface": WIFI_IFACE,
        "ssid": None,
        "connection": None,
        "signal_pct": None,
        "freq_mhz": None,
        "ip": None,
        "expected_ssid": EXPECTED_SSID,
        "source": None,
    }
    try:
        for line in _nmcli("-f", "GENERAL.CONNECTION,IP4.ADDRESS", "dev", "show", WIFI_IFACE):
            k, _, v = line.partition(":")
            v = v.strip()
            if k == "GENERAL.CONNECTION" and v and v != "--":
                net["connection"] = v
            elif k.startswith("IP4.ADDRESS") and v and net["ip"] is None:
                net["ip"] = v.split("/")[0]
        # The cached scan table (no rescan: a rescan drops the link for ~1 s on some drivers).
        for line in _nmcli("-f", "ACTIVE,SSID,SIGNAL,FREQ", "dev", "wifi", "list", "ifname", WIFI_IFACE, "--rescan", "no"):
            f = _nm_fields(line)
            if len(f) >= 4 and f[0] == "yes":
                net["ssid"] = f[1] or None
                try:
                    net["signal_pct"] = int(f[2])
                except ValueError:
                    pass
                m = re.match(r"\s*(\d+)", f[3])
                net["freq_mhz"] = int(m.group(1)) if m else None
                break
        net["source"] = "nmcli"
    except Exception as exc:  # nmcli missing, NetworkManager down, iface absent
        net["source"] = f"unavailable: {exc}"[:120]
    return net


def network() -> dict[str, Any]:
    """Current Wi-Fi of the Pi, cached NETWORK_TTL_S so polling never stacks nmcli calls."""
    global _net_cache
    now = time.monotonic()
    with _net_lock:
        if _net_cache is not None and now - _net_cache[0] < NETWORK_TTL_S:
            return _net_cache[1]
        net = _read_network()
        _net_cache = (now, net)
        return net


def level_for(temp_c: Optional[float], now: list[str]) -> str:
    if (temp_c is not None and temp_c >= CRITICAL_C) or "soft_temp_limit" in now:
        return "critical"
    if (temp_c is not None and temp_c >= HOT_C) or "throttled" in now or "freq_capped" in now:
        return "hot"
    if (temp_c is not None and temp_c >= WARM_C) or "under_voltage" in now:
        return "warm"
    return "ok"


def sample() -> dict[str, Any]:
    temp_c = _read_temp_c()
    raw = _read_throttled()
    now = [name for bit, name in _NOW_BITS.items() if raw is not None and raw & (1 << bit)]
    since_boot = [name for bit, name in _BOOT_BITS.items() if raw is not None and raw & (1 << bit)]
    cur = _read_khz("scaling_cur_freq")
    mx = _read_khz("cpuinfo_max_freq")
    try:
        load_1m: Optional[float] = round(os.getloadavg()[0], 2)
    except OSError:
        load_1m = None
    return {
        "temp_c": temp_c,
        "level": level_for(temp_c, now),
        "throttled_hex": None if raw is None else hex(raw),
        "now": now,
        "since_boot": since_boot,
        "clock_mhz": None if cur is None else cur // 1000,
        "clock_max_mhz": None if mx is None else mx // 1000,
        "load_1m": load_1m,
        "service_cpu_pct": _service_cpu_pct(),
        "fan_rpm": _read_fan_rpm(),
        "uptime_s": _uptime_s(),
        "thresholds": {"warm_c": WARM_C, "hot_c": HOT_C, "critical_c": CRITICAL_C},
        "network": network(),
        "sampled_at": time.time(),
    }


@router.get("/thermal")
def thermal() -> dict[str, Any]:
    """SoC temperature, firmware throttle flags, clock, this service's CPU use, and the Wi-Fi it is on."""
    return sample()

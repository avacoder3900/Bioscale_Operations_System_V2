#!/usr/bin/env python3
"""
Cloudflare quick tunnel for the robot-arm service, registered with BIMS.

A second public route to the arm alongside the Tailscale Funnel. The office
uplink is Starlink and the Pi's Tailscale relay connection is reset every
~30 s, which takes the Funnel down for minutes to hours (2026-10-19).
cloudflared holds several outbound connections to Cloudflare and replaces a
dropped one immediately, and needs no account for a quick tunnel.

A quick tunnel gets a random https://<words>.trycloudflare.com URL that
changes every time cloudflared starts, so this wrapper:
  1. runs `cloudflared tunnel --url http://127.0.0.1:8000`,
  2. picks the URL out of cloudflared's log,
  3. waits (up to 90 s) for it to answer /health,
  4. POSTs it to BIMS at /api/robot-arm/tunnel (auth: ROBOT_ARM_API_KEY),
  5. re-POSTs every 5 min as a heartbeat (BIMS ignores a URL older than 15 min).
If cloudflared exits, this exits non-zero and systemd restarts both.

Config (environment, see /etc/arm-tunnel.env written by install.sh):
  ROBOT_ARM_API_KEY  required; the same key the robot-arm service uses
  BIMS_URL           default https://bioscale-operations-system-mongodb.vercel.app
  ARM_LOCAL_URL      default http://127.0.0.1:8000
  CLOUDFLARED        default "cloudflared" (on PATH)
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

BIMS_URL = os.environ.get("BIMS_URL", "https://bioscale-operations-system-mongodb.vercel.app").rstrip("/")
LOCAL_URL = os.environ.get("ARM_LOCAL_URL", "http://127.0.0.1:8000")
API_KEY = os.environ.get("ROBOT_ARM_API_KEY", "")
CLOUDFLARED = os.environ.get("CLOUDFLARED", "cloudflared")
HEARTBEAT_S = 300
RETRY_S = 30
READY_WAIT_S = 90

URL_RE = re.compile(r"https://(?!api\.)[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com")

current_url: str | None = None
url_found = threading.Event()


def log(msg: str) -> None:
    print(f"arm-tunnel: {msg}", flush=True)


def read_cloudflared(proc: subprocess.Popen) -> None:
    global current_url
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.rstrip()
        m = URL_RE.search(line)
        if m and current_url is None:
            current_url = m.group(0)
            log(f"tunnel URL: {current_url}")
            url_found.set()
        # cloudflared is chatty at INFO; keep warnings/errors and the URL banner.
        if " ERR " in line or " WRN " in line or "trycloudflare.com" in line:
            print(line, flush=True)


def tunnel_answers(url: str) -> bool:
    try:
        with urllib.request.urlopen(f"{url}/health", timeout=10) as r:
            return r.status == 200
    except Exception:
        return False


def register(url: str) -> bool:
    req = urllib.request.Request(
        f"{BIMS_URL}/api/robot-arm/tunnel",
        data=json.dumps({"url": url}).encode(),
        headers={"Content-Type": "application/json", "x-api-key": API_KEY},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = json.loads(r.read() or b"{}")
            if body.get("changed"):
                log(f"registered with BIMS: {url}")
            return True
    except urllib.error.HTTPError as e:
        log(f"BIMS rejected registration: HTTP {e.code} {e.read()[:200]!r}")
    except Exception as e:  # network
        log(f"could not reach BIMS to register: {e}")
    return False


def main() -> int:
    if not API_KEY:
        log("ROBOT_ARM_API_KEY is not set; refusing to start")
        return 2

    proc = subprocess.Popen(
        [CLOUDFLARED, "tunnel", "--no-autoupdate", "--url", LOCAL_URL],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    threading.Thread(target=read_cloudflared, args=(proc,), daemon=True).start()

    if not url_found.wait(timeout=120):
        log("cloudflared did not report a tunnel URL within 120 s")
        proc.terminate()
        return 1
    url = current_url
    assert url is not None

    deadline = time.time() + READY_WAIT_S
    while time.time() < deadline and proc.poll() is None:
        if tunnel_answers(url):
            log("tunnel answers /health")
            break
        time.sleep(5)
    else:
        log(f"tunnel not answering /health after {READY_WAIT_S}s; registering anyway")

    next_at = 0.0
    while proc.poll() is None:
        if time.time() >= next_at:
            next_at = time.time() + (HEARTBEAT_S if register(url) else RETRY_S)
        time.sleep(5)

    log(f"cloudflared exited with code {proc.returncode}")
    return 1


if __name__ == "__main__":
    sys.exit(main())

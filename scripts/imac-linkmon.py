#!/usr/bin/env python3
"""
OT2-LOG-1 L4 — lab iMac link monitor.

Once a minute, for every robot and every path it is reachable on (wifi, wired,
tailnet): ICMP loss % and average RTT (5 pings), and the robot-server /health
latency. Samples are POSTed in one batch to BIMS
(POST /api/agent/robot-link/samples, agent key) and always appended to a local
CSV; a failed POST is spooled to a JSONL file and retried on the next cycle.
Read-only against the robots. No dependencies beyond the macOS python3.

Config: ~/.config/bims-linkmon.env  (KEY=VALUE lines; never committed)
  BIMS_BASE_URL=https://<bims host>
  AGENT_API_KEY=<the daemon's agent key>
  ROBOTS=<JSON array>  e.g.
   [{"robotId":"2vIu0fzsbqzkZ7_Zjj3h2","deviceId":"ot2-b07-bridge","name":"B07",
     "paths":{"wifi":"192.168.1.59","wired":"hidden-leaf.local","tailnet":"100.109.115.63"}}, ...]
  INTERVAL_S=60            (optional)
  CSV=~/Library/Logs/bims-linkmon.csv   (optional)
  SPOOL=~/Library/Logs/bims-linkmon.spool.jsonl (optional)

Install as a launchd agent (keeps running across logins/reboots of the iMac):
  cp scripts/launchd/com.bims.linkmon.plist ~/Library/LaunchAgents/
  (edit the ProgramArguments path to this file)   then
  launchctl load -w ~/Library/LaunchAgents/com.bims.linkmon.plist
  tail -f ~/Library/Logs/bims-linkmon.log
Stop:  launchctl unload -w ~/Library/LaunchAgents/com.bims.linkmon.plist
"""
import csv
import datetime as dt
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

CONFIG = os.path.expanduser('~/.config/bims-linkmon.env')
OT_HDR = {'Opentrons-Version': '3'}
PING_COUNT = 5
PING_INTERVAL = '0.3'
PING_TIMEOUT_S = 3
HEALTH_TIMEOUT_S = 5
SPOOL_MAX_LINES = 10000


def load_config():
    cfg = {}
    try:
        with open(CONFIG, encoding='utf-8') as f:
            for line in f:
                line = line.rstrip('\r\n').strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                cfg[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        sys.exit(f'config not found: {CONFIG} (see the header of this file)')
    for k in ('BIMS_BASE_URL', 'AGENT_API_KEY', 'ROBOTS'):
        if not cfg.get(k):
            sys.exit(f'{k} missing in {CONFIG}')
    cfg['ROBOTS'] = json.loads(cfg['ROBOTS'])
    cfg['INTERVAL_S'] = int(cfg.get('INTERVAL_S', '60'))
    cfg['CSV'] = os.path.expanduser(cfg.get('CSV', '~/Library/Logs/bims-linkmon.csv'))
    cfg['SPOOL'] = os.path.expanduser(cfg.get('SPOOL', '~/Library/Logs/bims-linkmon.spool.jsonl'))
    return cfg


def ping(host):
    """(loss_pct, avg_rtt_ms) — macOS ping; None values when the host never answered."""
    try:
        r = subprocess.run(['ping', '-c', str(PING_COUNT), '-i', PING_INTERVAL, '-t', str(PING_TIMEOUT_S), host],
                           capture_output=True, text=True, timeout=PING_TIMEOUT_S + 3)
    except Exception:
        return 100.0, None
    loss, rtt = 100.0, None
    for line in r.stdout.splitlines():
        if 'packet loss' in line:
            try:
                loss = float(line.split('%')[0].split()[-1])
            except ValueError:
                pass
        if 'round-trip' in line or 'rtt' in line:
            try:
                rtt = float(line.split('=')[1].split('/')[1])
            except (IndexError, ValueError):
                pass
    return loss, rtt


def health(host):
    """(latency_ms, err) for GET /health on the robot-server."""
    t = time.time()
    try:
        req = urllib.request.Request(f'http://{host}:31950/health', headers=OT_HDR)
        with urllib.request.urlopen(req, timeout=HEALTH_TIMEOUT_S) as resp:
            resp.read()
            return round((time.time() - t) * 1000, 1), None
    except Exception as e:  # noqa: BLE001 — any failure class is the datum
        return None, type(e).__name__


def sample_robot(robot):
    paths = []
    for name, host in (robot.get('paths') or {}).items():
        if not host:
            continue
        loss, rtt = ping(host)
        ms, err = health(host)
        paths.append({'name': name, 'ip': host, 'lossPct': loss, 'rttMs': rtt, 'healthMs': ms, 'healthErr': err})
    return {
        'robotId': robot['robotId'],
        'deviceId': robot.get('deviceId'),
        'at': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
        'source': 'imac',
        'paths': paths,
    }


def _ssl_context():
    """python.org builds on macOS ship without a CA bundle; fall back to the system file."""
    import ssl
    ctx = ssl.create_default_context()
    try:
        ctx.load_default_certs()
    except Exception:
        pass
    if not ctx.get_ca_certs():
        for cafile in ('/etc/ssl/cert.pem', '/private/etc/ssl/cert.pem'):
            if os.path.exists(cafile):
                return ssl.create_default_context(cafile=cafile)
    return ctx


_SSL = None


def post_samples(cfg, samples):
    global _SSL
    if _SSL is None:
        _SSL = _ssl_context()
    body = json.dumps({'samples': samples}).encode()
    req = urllib.request.Request(cfg['BIMS_BASE_URL'].rstrip('/') + '/api/agent/robot-link/samples', data=body,
                                 headers={'Content-Type': 'application/json', 'x-api-key': cfg['AGENT_API_KEY']}, method='POST')
    with urllib.request.urlopen(req, timeout=20, context=_SSL) as resp:
        return json.loads(resp.read() or b'{}')


def spool_append(cfg, samples):
    os.makedirs(os.path.dirname(cfg['SPOOL']), exist_ok=True)
    with open(cfg['SPOOL'], 'a', encoding='utf-8') as f:
        for s in samples:
            f.write(json.dumps(s) + '\n')
    # cap the spool
    try:
        with open(cfg['SPOOL'], encoding='utf-8') as f:
            lines = f.readlines()
        if len(lines) > SPOOL_MAX_LINES:
            with open(cfg['SPOOL'], 'w', encoding='utf-8') as f:
                f.writelines(lines[-SPOOL_MAX_LINES:])
    except OSError:
        pass


def spool_drain(cfg):
    """Re-send spooled samples in batches of 200; keep what still fails."""
    if not os.path.exists(cfg['SPOOL']):
        return 0
    with open(cfg['SPOOL'], encoding='utf-8') as f:
        rows = [json.loads(l) for l in f if l.strip()]
    if not rows:
        return 0
    sent = 0
    remaining = []
    for i in range(0, len(rows), 200):
        batch = rows[i:i + 200]
        try:
            post_samples(cfg, batch)
            sent += len(batch)
        except Exception:
            remaining.extend(batch)
    with open(cfg['SPOOL'], 'w', encoding='utf-8') as f:
        for r in remaining:
            f.write(json.dumps(r) + '\n')
    return sent


def csv_append(cfg, samples):
    os.makedirs(os.path.dirname(cfg['CSV']), exist_ok=True)
    new = not os.path.exists(cfg['CSV'])
    with open(cfg['CSV'], 'a', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        if new:
            w.writerow(['at', 'robotId', 'path', 'host', 'lossPct', 'rttMs', 'healthMs', 'healthErr'])
        for s in samples:
            for p in s['paths']:
                w.writerow([s['at'], s['robotId'], p['name'], p['ip'], p['lossPct'], p['rttMs'], p['healthMs'], p['healthErr'] or ''])


def main():
    cfg = load_config()
    once = '--once' in sys.argv
    print(f'[linkmon] {len(cfg["ROBOTS"])} robots, every {cfg["INTERVAL_S"]} s, BIMS {cfg["BIMS_BASE_URL"]}', flush=True)
    while True:
        t0 = time.time()
        samples = [sample_robot(r) for r in cfg['ROBOTS']]
        csv_append(cfg, samples)
        try:
            res = post_samples(cfg, samples)
            drained = spool_drain(cfg)
            print(f'[linkmon] {samples[0]["at"]} posted {res.get("inserted", "?")} (+{drained} spooled) '
                  + ' '.join(f'{s["robotId"][:4]}:' + ','.join(f'{p["name"]}={p["lossPct"]}%/{p["healthMs"]}ms' for p in s['paths']) for s in samples), flush=True)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError) as e:
            spool_append(cfg, samples)
            print(f'[linkmon] POST failed ({type(e).__name__}: {e}); spooled {len(samples)}', flush=True)
        if once:
            return
        time.sleep(max(5, cfg['INTERVAL_S'] - (time.time() - t0)))


if __name__ == '__main__':
    main()

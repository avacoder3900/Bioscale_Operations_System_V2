#!/usr/bin/env bash
#
# Tailscale Funnel watchdog for the robot-arm Pi.
#
# Production BIMS (Vercel) reaches the arm ONLY through the public Funnel at
# https://$FUNNEL_HOST. Three times (2026-10-15, -16, -19) the Pi and the arm
# service were healthy but the public ingress stopped forwarding: either the
# name vanished from public DNS, or the ingress refused the TLS handshake
# (curl exit 35). Each time `tailscale funnel ... off` then `... on` fixed it.
# This script automates exactly that, and nothing else.
#
# Run as root by funnel-watchdog.timer every 5 minutes. Each run:
#   1. Skips if the Pi booted < BOOT_GRACE_S ago (normal startup, 2026-10-19).
#   2. Skips if the arm service does not answer locally: a Funnel reset cannot
#      fix a dead service, and it is a different problem.
#   3. Resolves $FUNNEL_HOST through PUBLIC DNS (DNS-over-HTTPS to dns.google),
#      never through the Pi's own resolver: on the tailnet the name resolves to
#      the tailnet IP and bypasses the public ingress, so it always looks fine.
#      If dns.google itself is unreachable the Pi has no internet; skip.
#   4. Calls /health through every public ingress IP. Any failure, or no
#      public DNS answer at all, counts as one strike.
#   5. After FAIL_THRESHOLD consecutive strikes, and no reset within
#      MIN_RESET_INTERVAL_S, turns the Funnel off and back on, then re-checks.
#
# It never restarts the arm service or tailscaled and never moves the arm.
# Logs go to the journal: journalctl -u funnel-watchdog
#
# Test without touching Tailscale:  DRY_RUN=1 STATE_DIR=/tmp/fw ./funnel-watchdog.sh

set -u

FUNNEL_HOST="${FUNNEL_HOST:-arm-pi.tailf65a70.ts.net}"
LOCAL_URL="${LOCAL_URL:-http://127.0.0.1:8000/health}"
FUNNEL_TARGET="${FUNNEL_TARGET:-http://127.0.0.1:8000}"
STATE_DIR="${STATE_DIR:-/var/lib/funnel-watchdog}"
FAIL_THRESHOLD="${FAIL_THRESHOLD:-2}"
MIN_RESET_INTERVAL_S="${MIN_RESET_INTERVAL_S:-1800}"
BOOT_GRACE_S="${BOOT_GRACE_S:-600}"
DRY_RUN="${DRY_RUN:-0}"

FAILS_FILE="$STATE_DIR/fail_count"
RESET_FILE="$STATE_DIR/last_reset"

log() { echo "funnel-watchdog: $*"; }

mkdir -p "$STATE_DIR"
fails=$(cat "$FAILS_FILE" 2>/dev/null || echo 0)
last_reset=$(cat "$RESET_FILE" 2>/dev/null || echo 0)
now=$(date +%s)

# 1) boot grace
uptime_s=$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 999999)
if [ "$uptime_s" -lt "$BOOT_GRACE_S" ]; then
	log "booted ${uptime_s}s ago; waiting out the ${BOOT_GRACE_S}s startup grace"
	exit 0
fi

# 2) local service
if ! curl -fsS -m 5 -o /dev/null "$LOCAL_URL"; then
	log "arm service not answering at $LOCAL_URL; not touching the Funnel"
	echo 0 >"$FAILS_FILE"
	exit 0
fi

# 3) public DNS via DoH
doh=$(curl -fsS -m 10 "https://dns.google/resolve?name=${FUNNEL_HOST}&type=A" 2>/dev/null)
if [ -z "$doh" ]; then
	log "cannot reach dns.google (no internet?); skipping this check"
	exit 0
fi
ips=$(printf '%s' "$doh" | grep -oE '"data":"[0-9]+(\.[0-9]+){3}"' | grep -oE '[0-9]+(\.[0-9]+){3}')

# 4) /health through each public ingress
problem=""
if [ -z "$ips" ]; then
	problem="$FUNNEL_HOST has no public DNS record"
else
	for ip in $ips; do
		curl -fsS -m 10 -o /dev/null --resolve "${FUNNEL_HOST}:443:${ip}" "https://${FUNNEL_HOST}/health"
		rc=$?
		if [ "$rc" -ne 0 ]; then
			problem="${problem}${problem:+; }ingress $ip failed (curl exit $rc)"
		fi
	done
fi

if [ -z "$problem" ]; then
	if [ "$fails" -gt 0 ]; then
		log "public Funnel healthy again after $fails failed check(s)"
	fi
	echo 0 >"$FAILS_FILE"
	exit 0
fi

fails=$((fails + 1))
echo "$fails" >"$FAILS_FILE"
log "public check failed ($fails/$FAIL_THRESHOLD): $problem"

if [ "$fails" -lt "$FAIL_THRESHOLD" ]; then
	exit 0
fi

since=$((now - last_reset))
if [ "$since" -lt "$MIN_RESET_INTERVAL_S" ]; then
	log "last reset was ${since}s ago; waiting until ${MIN_RESET_INTERVAL_S}s before trying again"
	exit 0
fi

# 5) reset the Funnel
log "resetting Funnel: off, then on -> $FUNNEL_TARGET"
if [ "$DRY_RUN" = "1" ]; then
	log "DRY_RUN: tailscale funnel --https=443 off"
	log "DRY_RUN: tailscale funnel --bg --https=443 $FUNNEL_TARGET"
else
	tailscale funnel --https=443 off
	sleep 2
	tailscale funnel --bg --https=443 "$FUNNEL_TARGET"
fi
echo "$now" >"$RESET_FILE"
echo 0 >"$FAILS_FILE"

# Ingress registration takes a little while to propagate; report, don't loop.
sleep 60
ok=0
for ip in $ips; do
	if curl -fsS -m 10 -o /dev/null --resolve "${FUNNEL_HOST}:443:${ip}" "https://${FUNNEL_HOST}/health"; then
		ok=$((ok + 1))
	fi
done
log "after reset: $ok of $(echo $ips | wc -w) public ingress IP(s) answering /health"
exit 0

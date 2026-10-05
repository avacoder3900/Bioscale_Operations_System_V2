#!/usr/bin/env bash
# OT2-TAILNET-5 S5 — put an OT-2's bridge daemon on the tailnet (/bridge).
#
# Run from a workstation (macOS / Linux / Git Bash) that can SSH to the robot.
# It assumes the robot is ALREADY on the tailnet (OT2-TAILNET-3: tailscaled in
# /data/tailscale, `tailscale up` done, robot API served at /) and that the new
# daemon (scripts/ot2-bridge.py, VERSION ot2-bridge/1.1+) is ALREADY copied to
# /data/ot2-bridge/ (scripts/OT2-BRIDGE-DEPLOYMENT.md step 1). It then:
#
#   1. preflight   SSH works, tailscaled is Running, the daemon on disk is 1.1+
#   2. secret      writes BRIDGE_TOKEN_SECRET (and BRIDGE_ROBOT_ID, if given)
#                  into /data/ot2-bridge/.env, mode 600. The secret travels on
#                  SSH stdin — never on a command line, never echoed.
#   3. serve       tailscale serve --bg --https=443 http://localhost:31950          (idempotent)
#                  tailscale serve --bg --https=443 --set-path=/bridge http://127.0.0.1:31960
#   4. unit        (--install-unit) installs scripts/ot2-tailscale.service, which
#                  re-asserts both mounts on every tailscaled start
#   5. restart     systemctl restart ot2-bridge; waits for the job server on
#                  127.0.0.1:31960 to answer (401 without a token = healthy)
#   6. verify      from THIS machine: https://<fqdn>/bridge/health without a
#                  token must be 401 {"service":"ot2-bridge"}; prints the
#                  with-token smoke test to run next.
#
# Usage:
#   OT2_BRIDGE_TOKEN_SECRET=… scripts/ot2-tailnet-provision.sh <slot> [options]
#   scripts/ot2-tailnet-provision.sh b14 --secret-file ~/.bims/ot2-bridge-secret --robot-id <BIMS robot _id>
#
#   <slot>                b14 | b07 | r04 | …   → tailnet host ot2-<slot>
#   --host <ssh host>     default ot2-<slot> (Tailscale SSH); or the LAN IP
#   --key <path>          SSH identity (e.g. /tmp/ot2_key, see OT2-BRIDGE-DEPLOYMENT.md)
#   --secret-file <path>  file holding the secret (else $OT2_BRIDGE_TOKEN_SECRET)
#   --robot-id <id>       also pin tokens to this BIMS robot _id (BRIDGE_ROBOT_ID)
#   --install-unit        also install scripts/ot2-tailscale.service (remount rw/ro)
#   --dry-run             print what would run; touch nothing
#
# The secret is the SAME value as BIMS's OT2_BRIDGE_TOKEN_SECRET for the
# deployment whose browsers will drive this robot (Vercel env). Generate once:
#   openssl rand -base64 48
#
# Rollout rule (OT2-TAILNET-5 R3): B14 first. Do not run this on B07 or R04
# until approved — they keep the old daemon and the queue line, unaffected.
# Re-running is safe: every step is idempotent.

set -euo pipefail

TAILNET_SUFFIX="tailf65a70.ts.net"
TS="/data/tailscale/tailscale --socket=/data/tailscale/tailscaled.sock"
BRIDGE_DIR="/data/ot2-bridge"
JOB_PORT=31960
MIN_DAEMON_MINOR=1   # ot2-bridge/1.<minor>; the job server landed in 1.1

here="$(cd "$(dirname "$0")" && pwd)"

die() { echo "✗ $*" >&2; exit 1; }
ok() { echo "✓ $*"; }

slot="${1:-}"
[ -n "$slot" ] || die "usage: $0 <slot> [--host h] [--key k] [--secret-file f] [--robot-id id] [--install-unit] [--dry-run]"
shift
slot="$(printf '%s' "$slot" | tr '[:upper:]' '[:lower:]')"
printf '%s' "$slot" | grep -Eq '^[a-z][0-9]{2}$' || die "slot must look like b14 (got '$slot')"

host="ot2-$slot"
key=""
secret_file=""
robot_id=""
install_unit=0
dry=0
while [ $# -gt 0 ]; do
	case "$1" in
		--host) host="${2:?--host needs a value}"; shift 2 ;;
		--key) key="${2:?--key needs a value}"; shift 2 ;;
		--secret-file) secret_file="${2:?--secret-file needs a value}"; shift 2 ;;
		--robot-id) robot_id="${2:?--robot-id needs a value}"; shift 2 ;;
		--install-unit) install_unit=1; shift ;;
		--dry-run) dry=1; shift ;;
		*) die "unknown option: $1" ;;
	esac
done

fqdn="ot2-$slot.$TAILNET_SUFFIX"
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
[ -n "$key" ] && ssh_opts+=(-i "$key")
target="root@$host"

# --- the secret (never printed) ------------------------------------------------
if [ -n "$secret_file" ]; then
	[ -r "$secret_file" ] || die "cannot read --secret-file $secret_file"
	secret="$(head -n 1 "$secret_file" | tr -d '\r\n')"
else
	secret="${OT2_BRIDGE_TOKEN_SECRET:-}"
fi
[ -n "$secret" ] || die "no secret: set OT2_BRIDGE_TOKEN_SECRET or pass --secret-file"
[ "${#secret}" -ge 32 ] || die "secret is shorter than 32 characters — generate one with: openssl rand -base64 48"
case "$secret" in
	*[[:space:]]*|*\"*|*\'*|*\\*|*'$'*|*'`'*) die "secret must not contain whitespace, quotes, backslashes, \$ or backticks (it is sourced by run.sh)" ;;
esac
if [ -n "$robot_id" ]; then
	printf '%s' "$robot_id" | grep -Eq '^[A-Za-z0-9_-]{6,64}$' || die "--robot-id must be a BIMS nanoid"
fi

rsh() {
	# rsh <description>  — run the shell script on stdin on the robot (sh -s).
	# Scripts travel on stdin, so nothing sensitive is ever on a command line.
	if [ "$dry" -eq 1 ]; then
		echo "[dry-run] on the robot: $1" >&2
		cat >/dev/null
		return 0
	fi
	ssh "${ssh_opts[@]}" "$target" 'sh -s'
}

echo "OT2-TAILNET-5 /bridge provisioning — ot2-$slot (ssh $target → https://$fqdn/bridge/)"

# --- 1. preflight ---------------------------------------------------------------
if [ "$dry" -eq 0 ]; then
	ssh "${ssh_opts[@]}" "$target" true || die "ssh $target failed (Tailscale SSH, or pass --host <lan-ip> --key <path>)"
	ok "ssh $target"
fi
pre="$(rsh "preflight" <<EOF
state=\$($TS status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("BackendState","?"))' 2>/dev/null)
ver=\$(sed -n 's/^VERSION = "ot2-bridge\/\([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' $BRIDGE_DIR/ot2-bridge.py 2>/dev/null | head -n 1)
env=no; [ -f $BRIDGE_DIR/.env ] && env=yes
echo "\${state:-none} \${ver:-none} \$env"
EOF
)" || die "preflight over ssh failed"
if [ "$dry" -eq 0 ]; then
	read -r state ver has_env <<<"$pre"
	[ "$state" = "Running" ] || die "tailscaled on the robot is '$state', not Running — finish OT2-TAILNET-3 onboarding first"
	ok "tailscaled Running"
	[ "$ver" != "none" ] || die "no ot2-bridge.py with a VERSION in $BRIDGE_DIR — copy the new daemon first (OT2-BRIDGE-DEPLOYMENT.md step 1)"
	major="${ver%%.*}"; minor="${ver#*.}"
	if [ "$major" -lt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -lt "$MIN_DAEMON_MINOR" ]; }; then
		die "daemon on disk is ot2-bridge/$ver; the /bridge job server needs 1.$MIN_DAEMON_MINOR+ — scp scripts/ot2-bridge.py first"
	fi
	ok "daemon on disk: ot2-bridge/$ver"
	[ "$has_env" = "yes" ] || die "$BRIDGE_DIR/.env missing — the queue-line bridge must be configured first"
	ok "$BRIDGE_DIR/.env present"
fi

# --- 2. secret into .env (on stdin, never argv, never echoed) -----------------------
# The secret was validated above: no quotes/whitespace/$/backticks, so it is safe
# inside single quotes here.
n="$(rsh "write BRIDGE_TOKEN_SECRET=<${#secret} chars>${robot_id:+ and BRIDGE_ROBOT_ID=$robot_id} into $BRIDGE_DIR/.env (600)" <<EOF
set -eu
cd $BRIDGE_DIR
umask 077
secret='$secret'
robot_id='$robot_id'
grep -v -e '^BRIDGE_TOKEN_SECRET=' -e '^BRIDGE_ROBOT_ID=' .env > .env.tmp || true
printf '\n# OT2-TAILNET-5 /bridge job server (ot2-tailnet-provision.sh)\nBRIDGE_TOKEN_SECRET=%s\n' "\$secret" >> .env.tmp
if [ -n "\$robot_id" ]; then printf 'BRIDGE_ROBOT_ID=%s\n' "\$robot_id" >> .env.tmp; fi
chmod 600 .env.tmp
mv .env.tmp .env
grep -c '^BRIDGE_TOKEN_SECRET=' .env
EOF
)"
unset secret
if [ "$dry" -eq 0 ]; then
	[ "$n" = "1" ] || die "BRIDGE_TOKEN_SECRET not written exactly once to $BRIDGE_DIR/.env (count=$n)"
	ok "BRIDGE_TOKEN_SECRET installed in $BRIDGE_DIR/.env (600)${robot_id:+, BRIDGE_ROBOT_ID=$robot_id}"
fi

# --- 3. serve mounts (idempotent) ---------------------------------------------------
rsh "tailscale serve / → :31950 and /bridge → 127.0.0.1:$JOB_PORT" <<EOF
set -e
$TS serve --bg --https=443 http://localhost:31950
$TS serve --bg --https=443 --set-path=/bridge http://127.0.0.1:$JOB_PORT
$TS serve status
EOF
ok "tailscale serve: / → :31950, /bridge → 127.0.0.1:$JOB_PORT"

# --- 4. optional: the tailscale unit that re-asserts both mounts ---------------------
if [ "$install_unit" -eq 1 ]; then
	if [ "$dry" -eq 1 ]; then
		echo "[dry-run] scp -O scripts/ot2-tailscale.service → /data/tailscale/"
	else
		scp -O "${ssh_opts[@]}" "$here/ot2-tailscale.service" "$target:/data/tailscale/ot2-tailscale.service"
	fi
	rsh "remount rw, install ot2-tailscale.service, daemon-reload, remount ro" <<'EOF'
set -e
mount -o remount,rw /
trap 'mount -o remount,ro /' EXIT
cp /data/tailscale/ot2-tailscale.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable ot2-tailscale
EOF
	ok "ot2-tailscale.service installed (takes effect on the next tailscaled restart; serve is already applied)"
fi

# --- 5. restart the daemon, wait for the job server --------------------------------
code="$(rsh "systemctl restart ot2-bridge; wait for 127.0.0.1:$JOB_PORT/bridge/health → 401" <<EOF
systemctl restart ot2-bridge
code=0
for i in \$(seq 1 30); do
  code=\$(python3 - <<'PY' 2>/dev/null
import urllib.request, urllib.error
try:
    urllib.request.urlopen("http://127.0.0.1:$JOB_PORT/bridge/health", timeout=2)
    print(200)
except urllib.error.HTTPError as e:
    print(e.code)
except Exception:
    print(0)
PY
)
  [ "\$code" = "401" ] && break
  sleep 1
done
systemctl is-active ot2-bridge >/dev/null || code="inactive"
echo "\$code"
EOF
)"
if [ "$dry" -eq 0 ]; then
	[ "$code" = "401" ] || die "job server did not come up (last answer: $code) — journalctl -u ot2-bridge -n 50"
	ok "ot2-bridge restarted; job server answers 401 without a token on 127.0.0.1:$JOB_PORT"
fi

# --- 6. verify from this machine over the tailnet ------------------------------------
if [ "$dry" -eq 1 ]; then
	echo "[dry-run] curl https://$fqdn/bridge/health → expect 401 {\"service\":\"ot2-bridge\"}"
else
	body="$(curl -s -m 10 -w '\n%{http_code}' "https://$fqdn/bridge/health" || true)"
	status="${body##*$'\n'}"
	[ "$status" = "401" ] && printf '%s' "$body" | grep -q '"ot2-bridge"' \
		|| die "https://$fqdn/bridge/health answered '$status' (want 401 from ot2-bridge) — is this machine on the tailnet? tailscale serve status on the robot?"
	ok "https://$fqdn/bridge/health → 401 without a token (ot2-bridge)"
fi

cat <<EOF

Next — the with-token smoke test (OT2-BRIDGE-DEPLOYMENT.md "Over the tailnet"):
  TOKEN=\$(ssh $target 'cd $BRIDGE_DIR && set -a && . ./.env && set +a && python3 ot2-bridge.py --mint-token scan')
  curl -s https://$fqdn/bridge/health -H "Authorization: Bearer \$TOKEN"     # 200, version ot2-bridge/1.1
Then in BIMS: robot connection mode 'tailnet' + OT2_TAILNET_ROBOT_IDS on the deployment,
and OT2_BRIDGE_TOKEN_SECRET set to this same secret there.
EOF

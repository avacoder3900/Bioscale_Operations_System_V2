#!/usr/bin/env bash
# setup-station.sh — first-boot configuration for a BIMS capture station.
#
# Writes /etc/bims/station.env from operator-provided values, then calls
# the BIMS self-register endpoint (per
# docs/prds/PI-STATION-ADMIN-AND-LIFECYCLE.md story B2) to mint a
# jwtSecret and persist it back to the env file. cloudflared install
# is still deferred per the V1 PRD §7.1; Tailscale Serve covers TLS
# termination in the current production topology.
set -euo pipefail

ENV_FILE="/etc/bims/station.env"
ENV_DIR="$(dirname "$ENV_FILE")"

if [[ "$(id -u)" -ne 0 ]]; then
    echo "setup-station.sh must be run as root (try: sudo $0)" >&2
    exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
    read -r -p "$ENV_FILE already exists. Overwrite? [y/N] " ans
    case "${ans,,}" in
        y|yes) ;;
        *) echo "Aborted — existing config kept."; exit 0 ;;
    esac
fi

default_name="$(hostname)"
read -r -p "Station name [$default_name]: " station_name
station_name="${station_name:-$default_name}"

read -r -p "BIMS server URL (e.g. https://bims.example.com): " bims_url
while [[ -z "$bims_url" ]]; do
    read -r -p "BIMS URL is required: " bims_url
done

# STATION_AGENT_KEY is the shared fleet secret matching the env var on the
# BIMS deployment. Without it, the self-registration call below fails and
# the operator has to register manually. Prompt blank-allowed because some
# operators set the env file out-of-band before running this script.
read -r -p "STATION_AGENT_KEY (from BIMS Vercel env, leave blank to skip self-register): " station_agent_key

# Tailscale FQDN is what the operator's browser dials to reach the Pi over
# wss://. Probe `tailscale status` for the canonical name; fall back to the
# Linux hostname if Tailscale isn't installed yet.
default_fqdn="$(hostname)"
if command -v tailscale >/dev/null 2>&1; then
    ts_fqdn="$(tailscale status --json 2>/dev/null \
        | python3 -c 'import sys,json; d=json.load(sys.stdin); print((d.get("Self",{}).get("DNSName","")).rstrip("."))' \
        2>/dev/null || true)"
    if [[ -n "$ts_fqdn" ]]; then
        default_fqdn="$ts_fqdn"
    fi
fi
read -r -p "Tailscale FQDN [$default_fqdn]: " station_hostname
station_hostname="${station_hostname:-$default_fqdn}"

read -r -p "Station token (leave blank to generate): " station_token
if [[ -z "$station_token" ]]; then
    # 32 random bytes -> base64 (~43 chars, URL-safe enough for a header value).
    station_token="$(head -c 32 /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_')"
    echo "  generated STATION_TOKEN."
fi

# WIFI_SSID is informational — actual WiFi config is handled per
# docs/PI-SETUP-WIFI.md. Captured here so the env file documents which
# network the station is meant to join.
read -r -p "WiFi SSID (informational): " wifi_ssid

read -r -p "Cloudflare Tunnel token (Phase 5 placeholder, leave blank): " cf_token

station_id="$(uuidgen)"

mkdir -p "$ENV_DIR"
chmod 0755 "$ENV_DIR"

umask 077
tmp="$(mktemp)"
cat > "$tmp" <<EOF
# Written by setup-station.sh on $(date --iso-8601=seconds)
STATION_ID=${station_id}
STATION_NAME=${station_name}
STATION_TOKEN=${station_token}
BIMS_URL=${bims_url}
WIFI_SSID=${wifi_ssid}
CLOUDFLARE_TUNNEL_TOKEN=${cf_token}
# Shared fleet secret used by the agent to authenticate to BIMS for
# self-registration (POST /api/cv/stations/register) and heartbeats
# (POST /api/cv/stations/[id]/heartbeat). Must match the
# STATION_AGENT_KEY env var on the BIMS deployment. Paste the value
# here after first boot — see services/bims-capture-agent/RUNBOOK.md
# § "BIMS-side env vars".
STATION_AGENT_KEY=${station_agent_key}
PORT=8765
EOF

# Ensure the bims group exists before chowning so the unit's User=bims
# install can read the file. setup-station.sh in Phase 5 creates the user;
# for now fall back to root-only if the group is missing.
if getent group bims >/dev/null; then
    install -o root -g bims -m 0640 "$tmp" "$ENV_FILE"
else
    install -o root -g root -m 0600 "$tmp" "$ENV_FILE"
    echo "  note: 'bims' group not yet present — $ENV_FILE installed root-only."
fi
rm -f "$tmp"

echo
echo "Wrote ${ENV_FILE}."

# ---------------------------------------------------------------------------
# Self-registration (story B2). Skipped if STATION_AGENT_KEY is empty.
# 201 → first-time, parse jwtSecret out of body and append to env file.
# 200 → already registered, BIMS keeps the existing secret; do nothing.
# anything else → print body, exit non-zero so the operator can re-run.
# ---------------------------------------------------------------------------
if [[ -z "$station_agent_key" ]]; then
    cat <<EOF

STATION_AGENT_KEY was blank — self-registration skipped. Either:
  - edit ${ENV_FILE} to set STATION_AGENT_KEY and re-run this script, OR
  - register manually per RUNBOOK §4 "Manual re-registration".
EOF
else
    echo
    echo "Registering with BIMS at ${bims_url}/api/cv/stations/register ..."

    register_body=$(cat <<JSON
{
  "stationId": "${station_id}",
  "name": "${station_name}",
  "hostname": "${station_hostname}",
  "capabilities": { "camera": true, "scanner": true, "led": false, "robotArm": false, "sequence": true },
  "agentVersion": "0.1.0"
}
JSON
)

    register_tmp="$(mktemp)"
    register_status=$(curl -sS -o "$register_tmp" -w '%{http_code}' \
        -X POST \
        -H 'Content-Type: application/json' \
        -H "x-station-agent-key: ${station_agent_key}" \
        --data "$register_body" \
        "${bims_url%/}/api/cv/stations/register" || echo "000")

    case "$register_status" in
        201)
            jwt_secret="$(python3 -c 'import sys,json; print(json.load(sys.stdin).get("jwtSecret",""))' < "$register_tmp" 2>/dev/null || true)"
            if [[ -z "$jwt_secret" ]]; then
                echo "  registration returned 201 but no jwtSecret found in response body:"
                cat "$register_tmp"
                rm -f "$register_tmp"
                exit 1
            fi
            # Append STATION_JWT_SECRET. We append rather than rewrite so a
            # re-run that hits 200 (already-registered) leaves the existing
            # line in place — there's nothing in the 200 response to write.
            echo "STATION_JWT_SECRET=${jwt_secret}" >> "$ENV_FILE"
            echo "  registered (201) — STATION_JWT_SECRET written to ${ENV_FILE}."
            ;;
        200)
            echo "  already registered (200) — STATION_JWT_SECRET in ${ENV_FILE} kept as-is."
            echo "  (to rotate the secret, edit setup-station.sh or POST register with regenerateSecret: true)"
            ;;
        401)
            echo "  401 unauthorized — STATION_AGENT_KEY does not match the BIMS value."
            echo "  Fix: confirm the key on Vercel matches what was entered, then re-run."
            cat "$register_tmp"
            rm -f "$register_tmp"
            exit 1
            ;;
        000)
            echo "  network error reaching ${bims_url} — check BIMS_URL and connectivity."
            rm -f "$register_tmp"
            exit 1
            ;;
        *)
            echo "  registration failed (HTTP ${register_status}):"
            cat "$register_tmp"
            rm -f "$register_tmp"
            exit 1
            ;;
    esac
    rm -f "$register_tmp"
fi

cat <<EOF

Next steps:
  1. Install the agent at /opt/bims-capture-agent (clone repo + create venv).
  2. Copy bims-capture-agent.service to /etc/systemd/system/ and run:
       sudo systemctl daemon-reload
       sudo systemctl enable --now bims-capture-agent
  3. Verify with:  curl http://localhost:8765/health
  4. Confirm registration: curl ${bims_url}/api/cv/stations | python3 -m json.tool

EOF

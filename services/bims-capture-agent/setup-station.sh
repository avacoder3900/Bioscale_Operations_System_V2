#!/usr/bin/env bash
# setup-station.sh — first-boot configuration for a BIMS capture station.
#
# Phase 1 scope: write /etc/bims/station.env from operator-provided values.
# cloudflared installation and /api/cv/stations self-registration land in
# Phase 5 per docs/prds/PI-CAPTURE-STATION.md §7.1.
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
STATION_AGENT_KEY=
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

cat <<EOF

Wrote ${ENV_FILE}.

Next steps:
  1. Install the agent at /opt/bims-capture-agent (clone repo + create venv).
  2. Copy bims-capture-agent.service to /etc/systemd/system/ and run:
       sudo systemctl daemon-reload
       sudo systemctl enable --now bims-capture-agent
  3. Verify with:  curl http://localhost:8765/health
  4. Phase 5 will install cloudflared and self-register with BIMS.

EOF

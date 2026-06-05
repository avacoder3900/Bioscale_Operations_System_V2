#!/usr/bin/env bash
# provision-station.sh — one-shot, idempotent setup of a fresh Pi
# capture station.
#
# Usage (interactive setup-station.sh prompts hidden by env vars):
#
#   sudo BIMS_URL='https://...vercel.app' \
#        STATION_AGENT_KEY='<paste>' \
#        STATION_NAME='Wax Fill Bench 1' \
#        WIFI_SSID='Fannin_WIFI' \
#        REPO_URL='https://github.com/avacoder3900/Bioscale_Operations_System_V2.git' \
#        REPO_BRANCH='bims-capture-agent' \
#        bash provision-station.sh
#
# Prerequisites the script does NOT install:
#   - Tailscale (interactive auth — run `curl -fsSL https://tailscale.com/install.sh | sh`
#     then `sudo tailscale up --hostname=<name> --ssh` before this script)
#   - SSH access for the operator (already in place if you're reading this)
#
# The script is idempotent — safe to re-run on a partially-provisioned
# Pi. Each phase checks before doing work.
#
# Per docs/prds/PI-STATION-ADMIN-AND-LIFECYCLE.md and
# services/bims-capture-agent/RUNBOOK.md.
set -euo pipefail

[[ "$(id -u)" -ne 0 ]] && { echo "must be run as root (try: sudo $0)" >&2; exit 1; }

: "${BIMS_URL:?BIMS_URL env required (e.g. https://...vercel.app)}"
: "${STATION_AGENT_KEY:?STATION_AGENT_KEY env required (must match BIMS deployment env)}"
: "${STATION_NAME:=$(hostname)}"
: "${WIFI_SSID:=}"
: "${REPO_URL:=https://github.com/avacoder3900/Bioscale_Operations_System_V2.git}"
: "${REPO_BRANCH:=bims-capture-agent}"
: "${TARGET_USER:=brevitest}"

USER_HOME="/home/${TARGET_USER}"
CHECKOUT="${USER_HOME}/bims-capture-agent"
AGENT_DIR="${CHECKOUT}/services/bims-capture-agent"
ENV_FILE="/etc/bims/station.env"
SYSTEMD_UNIT="/etc/systemd/system/bims-capture-agent.service"
SUDOERS="/etc/sudoers.d/bims-capture-agent"

log() { printf '\n[provision] %s\n' "$*"; }

# ---------------------------------------------------------------------------
# Phase 1 — apt packages
# ---------------------------------------------------------------------------
log "Phase 1: apt install"
DEBIAN_FRONTEND=noninteractive apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y \
    git \
    python3 \
    python3-venv \
    python3-smbus \
    uuid-runtime \
    i2c-tools \
    fswebcam \
    evtest \
    curl \
    ca-certificates

# ---------------------------------------------------------------------------
# Phase 2 — sparse-checkout the agent
# ---------------------------------------------------------------------------
log "Phase 2: sparse-checkout repo at ${CHECKOUT}"
if [[ ! -d "${CHECKOUT}/.git" ]]; then
    sudo -u "${TARGET_USER}" mkdir -p "${CHECKOUT}"
    sudo -u "${TARGET_USER}" git -C "${CHECKOUT}" init -q
    sudo -u "${TARGET_USER}" git -C "${CHECKOUT}" remote add origin "${REPO_URL}"
    sudo -u "${TARGET_USER}" git -C "${CHECKOUT}" config core.sparseCheckout true
    echo "services/bims-capture-agent/*" | \
        sudo -u "${TARGET_USER}" tee "${CHECKOUT}/.git/info/sparse-checkout" > /dev/null
fi
sudo -u "${TARGET_USER}" git -C "${CHECKOUT}" pull --depth=1 origin "${REPO_BRANCH}"

# ---------------------------------------------------------------------------
# Phase 3 — python venv + deps
# ---------------------------------------------------------------------------
log "Phase 3: venv + pip install"
if [[ ! -d "${AGENT_DIR}/.venv" ]]; then
    sudo -u "${TARGET_USER}" python3 -m venv "${AGENT_DIR}/.venv"
fi
sudo -u "${TARGET_USER}" "${AGENT_DIR}/.venv/bin/pip" install --upgrade pip wheel
sudo -u "${TARGET_USER}" "${AGENT_DIR}/.venv/bin/pip" install -r "${AGENT_DIR}/requirements.txt"

# ---------------------------------------------------------------------------
# Phase 4 — write env file (mirrors setup-station.sh but non-interactive)
# ---------------------------------------------------------------------------
log "Phase 4: write ${ENV_FILE}"
if [[ -f "${ENV_FILE}" ]]; then
    echo "  ${ENV_FILE} already exists — leaving in place. Re-run with"
    echo "  sudo rm ${ENV_FILE} to force a rewrite."
else
    station_id="$(uuidgen)"
    # Generate a station_token (vestigial — agent doesn't use it today,
    # but setup-station.sh writes one, so we do too for parity)
    station_token="$(head -c 32 /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_')"

    mkdir -p "$(dirname "${ENV_FILE}")"
    chmod 0755 "$(dirname "${ENV_FILE}")"

    umask 077
    tmp="$(mktemp)"
    cat > "${tmp}" <<EOF
# Written by provision-station.sh on $(date --iso-8601=seconds)
STATION_ID=${station_id}
STATION_NAME=${STATION_NAME}
STATION_TOKEN=${station_token}
BIMS_URL=${BIMS_URL}
WIFI_SSID=${WIFI_SSID}
CLOUDFLARE_TUNNEL_TOKEN=
STATION_AGENT_KEY=${STATION_AGENT_KEY}
PORT=8765
EOF
    install -o root -g root -m 0600 "${tmp}" "${ENV_FILE}"
    rm -f "${tmp}"
fi

# Re-read STATION_ID in case env file already existed
STATION_ID="$(grep '^STATION_ID=' "${ENV_FILE}" | cut -d= -f2-)"

# ---------------------------------------------------------------------------
# Phase 5 — self-register with BIMS (if STATION_JWT_SECRET not yet present)
# ---------------------------------------------------------------------------
log "Phase 5: register with BIMS at ${BIMS_URL}"
if grep -q '^STATION_JWT_SECRET=..' "${ENV_FILE}"; then
    echo "  STATION_JWT_SECRET already in ${ENV_FILE} — skipping register."
else
    # Determine the Tailscale FQDN for hostname field. Pi must already be
    # joined to the tailnet (prerequisite).
    fqdn=""
    if command -v tailscale > /dev/null 2>&1; then
        fqdn="$(tailscale status --json 2>/dev/null | \
            python3 -c 'import sys,json; d=json.load(sys.stdin); print((d.get("Self",{}).get("DNSName","")).rstrip("."))' \
            2>/dev/null || true)"
    fi
    fqdn="${fqdn:-$(hostname)}"
    echo "  using hostname: ${fqdn}"

    register_tmp="$(mktemp)"
    register_body=$(cat <<JSON
{
  "stationId": "${STATION_ID}",
  "name": "${STATION_NAME}",
  "hostname": "${fqdn}",
  "capabilities": { "camera": true, "scanner": true, "led": false, "robotArm": false },
  "agentVersion": "0.1.0"
}
JSON
)
    register_status=$(curl -sS -o "${register_tmp}" -w '%{http_code}' \
        -X POST \
        -H 'Content-Type: application/json' \
        -H "x-station-agent-key: ${STATION_AGENT_KEY}" \
        --data "${register_body}" \
        "${BIMS_URL%/}/api/cv/stations/register" || echo "000")

    case "${register_status}" in
        201)
            jwt_secret="$(python3 -c 'import sys,json; print(json.load(sys.stdin).get("jwtSecret",""))' < "${register_tmp}")"
            if [[ -z "${jwt_secret}" ]]; then
                echo "  201 but no jwtSecret in response:"
                cat "${register_tmp}"
                rm -f "${register_tmp}"
                exit 1
            fi
            echo "STATION_JWT_SECRET=${jwt_secret}" >> "${ENV_FILE}"
            echo "  registered (201) — STATION_JWT_SECRET appended."
            ;;
        200)
            echo "  already registered (200) — STATION_JWT_SECRET preserved if present."
            ;;
        000|401|*)
            echo "  registration failed (HTTP ${register_status}):"
            cat "${register_tmp}"
            rm -f "${register_tmp}"
            exit 1
            ;;
    esac
    rm -f "${register_tmp}"
fi

# ---------------------------------------------------------------------------
# Phase 6 — create bims system user + groups
# ---------------------------------------------------------------------------
log "Phase 6: bims system user"
if ! getent group bims > /dev/null; then
    groupadd -r bims
fi
if ! getent passwd bims > /dev/null; then
    useradd -r -g bims -G input,video -s /usr/sbin/nologin \
        -d /opt/bims-capture-agent -M bims
fi

# ---------------------------------------------------------------------------
# Phase 7 — /opt symlink + permissions
# ---------------------------------------------------------------------------
log "Phase 7: /opt/bims-capture-agent symlink + perms"
ln -sfn "${AGENT_DIR}" /opt/bims-capture-agent
chmod o+x "${USER_HOME}"
chmod -R o+rX "${CHECKOUT}"

chown root:bims "${ENV_FILE}"
chmod 0640 "${ENV_FILE}"

# ---------------------------------------------------------------------------
# Phase 8 — systemd unit + sudoers drop-in
# ---------------------------------------------------------------------------
log "Phase 8: systemd unit + sudoers"
install -m 0644 -o root -g root /opt/bims-capture-agent/bims-capture-agent.service "${SYSTEMD_UNIT}"
install -m 0440 -o root -g root /opt/bims-capture-agent/sudoers.d/bims-capture-agent "${SUDOERS}"
visudo -c -f "${SUDOERS}"
systemctl daemon-reload

# ---------------------------------------------------------------------------
# Phase 9 — start the agent
# ---------------------------------------------------------------------------
log "Phase 9: enable + start bims-capture-agent"
systemctl enable --now bims-capture-agent
sleep 3
systemctl is-active --quiet bims-capture-agent || {
    echo "  agent failed to start. Logs:"
    journalctl -u bims-capture-agent -n 30 --no-pager
    exit 1
}

# ---------------------------------------------------------------------------
# Phase 10 — Tailscale Serve TLS termination
# ---------------------------------------------------------------------------
log "Phase 10: tailscale serve"
if ! tailscale serve status 2>/dev/null | grep -q "localhost:8765"; then
    tailscale serve --bg --https=443 http://localhost:8765
fi
tailscale serve status

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
cat <<EOF

============================================================
provision-station.sh: DONE.

Station ID:    ${STATION_ID}
Station name:  ${STATION_NAME}
Tailscale URL: https://$(hostname).tailf65a70.ts.net (adjust to your tailnet)

Verify:
  curl http://localhost:8765/health
  systemctl status bims-capture-agent

In BIMS, the station should appear at /cv/stations with status=online
within 30 s (the first heartbeat cycle).
============================================================
EOF

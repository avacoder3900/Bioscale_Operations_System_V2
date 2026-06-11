#!/bin/sh
# OT-2 bridge launcher — sources .env, validates config, execs the daemon.
#
# Deployed as /data/ot2-bridge/run.sh (chmod 755). The systemd unit
# (ot2-bridge.service) execs this script; it can also be run by hand in the
# foreground for smoke tests. See scripts/OT2-BRIDGE-DEPLOYMENT.md.

set -e
cd "$(dirname "$0")"

if [ ! -f .env ]; then
    echo "ERROR: .env not found next to run.sh ($(pwd)/.env)" >&2
    exit 1
fi

# Export everything defined in .env
set -a
. ./.env
set +a

fail=0
for var in BIMS_BASE_URL BIMS_AGENT_API_KEY BRIDGE_DEVICE_ID SCANNER_SERIAL_PORT; do
    eval "val=\${$var}"
    if [ -z "$val" ]; then
        echo "ERROR: $var is not set in .env" >&2
        fail=1
    fi
done
[ "$fail" -eq 0 ] || exit 1

case "$BIMS_AGENT_API_KEY" in
    *PLACEHOLDER*|*REPLACE*|*changeme*)
        echo "ERROR: BIMS_AGENT_API_KEY still looks like a placeholder — set the real AGENT_API_KEY in .env" >&2
        exit 1
        ;;
esac

exec python3 ot2-bridge.py

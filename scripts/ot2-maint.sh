#!/bin/sh
# BIMS OT-2 disk maintenance.
#
# The OT-2 (Buildroot) shares one ~14G partition between /var and /data and has
# TWO unbounded log growers, both from the stock Opentrons/OS image:
#   1. systemd journals orphaned by machine-id churn — a new /var/log/journal/<id>
#      dir is created on firmware updates/reboots and the old ones are never pruned.
#   2. /data/nginx-access.log — Opentrons' nginx logs every robot-API request with
#      no rotation.
# Left alone these fill the disk to 100%, which breaks installs and degrades the
# robot server. This script prunes both. Scheduled weekly via ot2-maint.timer.
#
# Deployed to /data/ot2-bridge/ot2-maint.sh alongside the bridge daemon.

LOG_CAP_BYTES=209715200   # 200 MB: truncate unrotated logs larger than this
JOURNAL_CAP=200M          # keep the live journal under this

# 1. Prune orphaned journal dirs (every machine-id except the live one).
MID=$(cat /etc/machine-id 2>/dev/null)
if [ -n "$MID" ] && [ -d "/var/log/journal/$MID" ]; then
	for d in /var/log/journal/*/; do
		id=$(basename "$d")
		[ "$id" = "$MID" ] && continue
		[ "$id" = "remote" ] && continue
		rm -rf "$d"
	done
	journalctl --vacuum-size="$JOURNAL_CAP" >/dev/null 2>&1 || true
else
	echo "ot2-maint: WARN empty/unknown machine-id ($MID) — skipping journal prune"
fi

# 2. Truncate stock unrotated logs (in place; keeps any open fd valid).
for f in /data/nginx-access.log /data/scanner-bridge/bridge.log; do
	[ -f "$f" ] || continue
	sz=$(wc -c < "$f" 2>/dev/null || echo 0)
	if [ "$sz" -gt "$LOG_CAP_BYTES" ]; then
		: > "$f" && echo "ot2-maint: truncated $f (was $sz bytes)"
	fi
done

echo "ot2-maint: done — $(df -h /data | tail -1)"

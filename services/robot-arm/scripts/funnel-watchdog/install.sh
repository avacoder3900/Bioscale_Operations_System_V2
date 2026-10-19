#!/usr/bin/env bash
# Install (or update) the Funnel watchdog on the robot-arm Pi.
#   cd ~/funnel-watchdog && sudo bash install.sh
# Remove:
#   sudo systemctl disable --now funnel-watchdog.timer
#   sudo rm /etc/systemd/system/funnel-watchdog.{service,timer} /usr/local/bin/funnel-watchdog.sh
#   sudo systemctl daemon-reload
set -euo pipefail
cd "$(dirname "$0")"

if [ "$(id -u)" -ne 0 ]; then
	echo "run with sudo: sudo bash install.sh" >&2
	exit 1
fi

# Strip any CRLF picked up on a Windows checkout before installing.
for f in funnel-watchdog.sh funnel-watchdog.service funnel-watchdog.timer; do
	sed -i 's/\r$//' "$f"
done

install -m 0755 funnel-watchdog.sh /usr/local/bin/funnel-watchdog.sh
install -m 0644 funnel-watchdog.service /etc/systemd/system/funnel-watchdog.service
install -m 0644 funnel-watchdog.timer /etc/systemd/system/funnel-watchdog.timer
systemctl daemon-reload
systemctl enable --now funnel-watchdog.timer

echo
echo "installed. Next run:"
systemctl list-timers funnel-watchdog.timer --no-pager | head -3
echo
echo "Run one check now:  sudo BOOT_GRACE_S=0 /usr/local/bin/funnel-watchdog.sh"
echo "History:            journalctl -u funnel-watchdog --no-pager | tail -20"

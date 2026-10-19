#!/usr/bin/env bash
# Install (or update) the Cloudflare quick tunnel for the robot-arm Pi.
#   cd ~/arm-tunnel && sudo bash install.sh
# Remove:
#   sudo systemctl disable --now arm-tunnel
#   sudo rm /etc/systemd/system/arm-tunnel.service /usr/local/bin/arm_tunnel.py /etc/arm-tunnel.env
#   sudo systemctl daemon-reload
set -euo pipefail
cd "$(dirname "$0")"

if [ "$(id -u)" -ne 0 ]; then
	echo "run with sudo: sudo bash install.sh" >&2
	exit 1
fi

for f in arm_tunnel.py arm-tunnel.service; do
	sed -i 's/\r$//' "$f"
done

# 1) cloudflared
if ! command -v cloudflared >/dev/null 2>&1; then
	arch=$(dpkg --print-architecture)
	echo "installing cloudflared ($arch)..."
	tmp=$(mktemp -d)
	curl -fsSL -o "$tmp/cloudflared.deb" \
		"https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb"
	dpkg -i "$tmp/cloudflared.deb"
	rm -rf "$tmp"
fi
cloudflared --version

# 2) API key: take it from the RUNNING robot-arm service (what the Pi actually
#    checks), falling back to ~/robot-arm/.env. Never printed.
key=""
pid=$(systemctl show -p MainPID --value robot-arm 2>/dev/null || echo 0)
if [ "${pid:-0}" != "0" ] && [ -r "/proc/$pid/environ" ]; then
	key=$(tr '\0' '\n' <"/proc/$pid/environ" | sed -n 's/^ROBOT_ARM_API_KEY=//p' | head -1)
fi
if [ -z "$key" ] && [ -f /home/brevitest3/robot-arm/.env ]; then
	key=$(sed -n 's/^ROBOT_ARM_API_KEY=//p' /home/brevitest3/robot-arm/.env | head -1 | tr -d '"'"'"'\r')
fi
if [ -z "$key" ]; then
	echo "could not find ROBOT_ARM_API_KEY (robot-arm service env or ~/robot-arm/.env)" >&2
	exit 1
fi
umask 077
printf 'ROBOT_ARM_API_KEY=%s\nBIMS_URL=%s\n' "$key" \
	"${BIMS_URL:-https://bioscale-operations-system-mongodb.vercel.app}" >/etc/arm-tunnel.env
chown brevitest3:brevitest3 /etc/arm-tunnel.env
chmod 600 /etc/arm-tunnel.env
echo "wrote /etc/arm-tunnel.env (key found, not shown)"

# 3) service
install -m 0755 arm_tunnel.py /usr/local/bin/arm_tunnel.py
install -m 0644 arm-tunnel.service /etc/systemd/system/arm-tunnel.service
systemctl daemon-reload
systemctl enable arm-tunnel
systemctl restart arm-tunnel

echo
echo "started. Watch it come up (Ctrl+C to stop watching):"
echo "  journalctl -u arm-tunnel -f"
echo "Expect: 'tunnel URL: https://....trycloudflare.com', 'tunnel answers /health',"
echo "        'registered with BIMS: ...'"

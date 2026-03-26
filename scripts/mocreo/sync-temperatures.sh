#!/usr/bin/env bash
# Sync Mocreo temperature readings — intended for cron every 10 minutes
# Usage: AGENT_API_KEY=xxx BASE_URL=https://your-app.com ./sync-temperatures.sh

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:5173}"
API_KEY="${AGENT_API_KEY:?AGENT_API_KEY environment variable is required}"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Syncing Mocreo temperatures..."

response=$(curl -s -w "\n%{http_code}" -X POST \
  "${BASE_URL}/api/mocreo/sync" \
  -H "x-api-key: ${API_KEY}" \
  -H "Content-Type: application/json")

http_code=$(echo "$response" | tail -1)
body=$(echo "$response" | head -n -1)

if [ "$http_code" -eq 200 ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Sync complete: ${body}"
else
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ERROR: HTTP ${http_code} — ${body}" >&2
  exit 1
fi

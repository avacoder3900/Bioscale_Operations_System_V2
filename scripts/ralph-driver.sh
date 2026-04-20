#!/usr/bin/env bash
# Ralph Driver — Opentrons Clone Production-Ready (DOMAIN-12)
#
# Outer shell loop that repeatedly invokes Claude Code as a one-shot coding
# sub-agent until every pending story in DOMAIN-12 is marked `done` in
# docs/migration/prds/prd.json, or until max iterations is hit, or until
# 3 consecutive iterations make no progress.
#
# Each invocation is a FRESH Claude session (no conversation memory). State
# flows exclusively through files: prd.json, PROGRESS.md, progress.txt,
# the PRD, and the repo itself.
#
# Usage:
#   ./scripts/ralph-driver.sh             # start the loop
#   RALPH_MAX_ITERATIONS=20 ./...         # cap total iterations (default 20)
#   RALPH_ITER_TIMEOUT=3600 ./...         # per-iteration timeout seconds (default 3600)
#   RALPH_DRY_RUN=1 ./...                 # print what would run, don't invoke claude

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DOMAIN_ID="OPENTRONS_CLONE_PROD"
PRD_JSON="docs/migration/prds/prd.json"
PRD_FILE="docs/migration/prds/DOMAIN-12-OPENTRONS-CLONE-PROD-READY.md"
PROMPT_FILE="scripts/ralph-prompt.md"
BRANCH="feature/opentrons-clone-ui"
LOG_DIR="$REPO_ROOT/.ralph-logs"
mkdir -p "$LOG_DIR"

MAX_ITERATIONS="${RALPH_MAX_ITERATIONS:-20}"
ITER_TIMEOUT="${RALPH_ITER_TIMEOUT:-3600}"
DRY_RUN="${RALPH_DRY_RUN:-0}"

log() { printf '[ralph %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }

count_pending() {
  python3 - <<PY
import json
with open("$PRD_JSON") as f: d = json.load(f)
dom = next((x for x in d["domains"] if x["id"] == "$DOMAIN_ID"), None)
if not dom:
    print(0)
else:
    print(sum(1 for s in dom["stories"] if s["status"] == "pending"))
PY
}

total_stories() {
  python3 - <<PY
import json
with open("$PRD_JSON") as f: d = json.load(f)
dom = next((x for x in d["domains"] if x["id"] == "$DOMAIN_ID"), None)
print(len(dom["stories"]) if dom else 0)
PY
}

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current_branch" != "$BRANCH" ]; then
  log "ERROR: expected branch $BRANCH, got $current_branch. Checkout first."
  exit 1
fi

if [ ! -f "$PRD_JSON" ] || [ ! -f "$PRD_FILE" ] || [ ! -f "$PROMPT_FILE" ]; then
  log "ERROR: missing one of: $PRD_JSON | $PRD_FILE | $PROMPT_FILE"
  exit 1
fi

initial_pending="$(count_pending)"
total="$(total_stories)"
log "Starting. ${initial_pending}/${total} stories pending in $DOMAIN_ID."

consecutive_failures=0
iteration=0

while [ "$iteration" -lt "$MAX_ITERATIONS" ]; do
  iteration=$((iteration + 1))
  pending="$(count_pending)"

  if [ "$pending" = "0" ]; then
    log "All stories in $DOMAIN_ID marked done. Loop complete."
    break
  fi

  log "Iteration ${iteration}/${MAX_ITERATIONS} — ${pending} stories pending"

  if ! git pull --ff-only origin "$BRANCH" 2>/dev/null; then
    log "  git pull failed (no network? branch diverged?). Continuing with local state."
  fi

  LOG_FILE="$LOG_DIR/iter-${iteration}-$(date -u +%Y%m%dT%H%M%SZ).log"

  if [ "$DRY_RUN" = "1" ]; then
    log "  DRY RUN — would invoke: claude --print --permission-mode acceptEdits < $PROMPT_FILE"
    log "  dest: $LOG_FILE"
    log "  prompt size: $(wc -l < "$PROMPT_FILE") lines"
    exit 0
  fi

  log "  invoking claude (log: $LOG_FILE)"
  set +e
  timeout "$ITER_TIMEOUT" claude \
    --permission-mode acceptEdits \
    --print \
    --output-format text \
    "$(cat "$PROMPT_FILE")" \
    > "$LOG_FILE" 2>&1
  claude_exit=$?
  set -e

  new_pending="$(count_pending)"
  if [ "$new_pending" -lt "$pending" ]; then
    consecutive_failures=0
    marked=$((pending - new_pending))
    log "  iteration $iteration OK — $marked story marked done (${new_pending} pending)"
  else
    consecutive_failures=$((consecutive_failures + 1))
    log "  iteration $iteration made no progress (claude exit $claude_exit, consecutive failures=$consecutive_failures)"
    if [ "$consecutive_failures" -ge 3 ]; then
      log "  3 consecutive failures. Stopping. See $LOG_FILE and $LOG_DIR/."
      exit 2
    fi
  fi

  sleep 15
done

final_pending="$(count_pending)"
if [ "$final_pending" = "0" ]; then
  log "SUCCESS: all ${total} stories done. See PRODUCTION-READY.md."
  exit 0
else
  log "TIMEOUT: ${MAX_ITERATIONS} iterations spent, ${final_pending} stories still pending."
  exit 3
fi

#!/usr/bin/env bash
set -euo pipefail

# Run the multi-repo cloud workflow phases in order: A → B → C.
#
# Each phase opens its own PR. Subsequent phases branch off the current
# HEAD, so if you run straight through they stack on the prior phase's
# branch; merge-then-continue is opt-in.
#
# Usage: ./scripts/run-multi-repo-cloud-phases.sh [--from a|b|c] [--wait-for-merge]
#   --from <phase>     Start from the given phase (skip earlier ones).
#   --wait-for-merge   Pause between phases so you can merge each PR.
#
# Prereqs:
#   - agent-relay CLI on PATH
#   - Sibling ../relay checkout on a writable branch
#   - gh authenticated against AgentWorkforce/{cloud,relay}

CLOUD="$(cd "$(dirname "$0")/.." && pwd)"
GREEN="\033[0;32m"
RED="\033[0;31m"
YELLOW="\033[0;33m"
BOLD="\033[1m"
NC="\033[0m"

log()  { echo -e "${BOLD}[$(date +%H:%M:%S)]${NC} $*"; }
pass() { echo -e "${GREEN}✓${NC} $*"; }
fail() { echo -e "${RED}✗${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }

FROM="a"
WAIT_FOR_MERGE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --wait-for-merge) WAIT_FOR_MERGE=1; shift ;;
    -h|--help) sed -n '3,15p' "$0"; exit 0 ;;
    *) fail "Unknown arg: $1"; exit 2 ;;
  esac
done

case "${FROM}" in a|b|c) ;; *) fail "--from must be a, b, or c"; exit 2 ;; esac

run_phase() {
  local name="$1"
  local file="$2"
  local logfile="${CLOUD}/.relay/workflow-logs/${name}.log"
  mkdir -p "$(dirname "${logfile}")"

  log "Starting: ${name}"
  set +e
  agent-relay run "${file}" 2>&1 | tee "${logfile}"
  local rc=${PIPESTATUS[0]}
  set -e
  if [[ ${rc} -eq 0 ]] && ! grep -q "^Workflow status: failed" "${logfile}"; then
    pass "${name} — completed (log: ${logfile})"
    return 0
  else
    fail "${name} — failed (log: ${logfile})"
    return 1
  fi
}

maybe_pause_for_merge() {
  local phase="$1"
  [[ "${WAIT_FOR_MERGE}" -eq 1 ]] || return 0
  echo ""
  warn "Phase ${phase} opened a PR. Merge it (cloud + relay if applicable), then press Enter to continue."
  read -r _
}

# ── Preflight ────────────────────────────────────────────────

log "Preflight..."
command -v agent-relay >/dev/null 2>&1 || { fail "agent-relay CLI not on PATH"; exit 1; }
[[ -d "${CLOUD}/../relay" ]] || { fail "sibling ../relay checkout not found"; exit 1; }
pass "agent-relay present; ../relay found"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " Multi-repo cloud workflows: A → B → C"
echo "═══════════════════════════════════════════════════════════"

if [[ "${FROM}" == "a" ]]; then
  run_phase "phase-a-allowlist" "${CLOUD}/workflows/multi-repo-cloud-phase-a-allowlist.ts" || exit 1
  maybe_pause_for_merge "A"
fi

if [[ "${FROM}" == "a" || "${FROM}" == "b" ]]; then
  run_phase "phase-b-plumbing" "${CLOUD}/workflows/multi-repo-cloud-phase-b-plumbing.ts" || exit 1
  maybe_pause_for_merge "B"
fi

run_phase "phase-c-pushback" "${CLOUD}/workflows/multi-repo-cloud-phase-c-pushback.ts" || exit 1

echo ""
pass "All phases completed. PRs are open; merge to ship."
log "Logs: ${CLOUD}/.relay/workflow-logs/"

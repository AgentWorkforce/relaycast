#!/usr/bin/env bash
set -euo pipefail

# Run all cloud workflows in the correct order with parallelization.
# Usage: ./scripts/run-all-workflows.sh
#
# Prerequisites:
#   - @relayauth packages published to npm (types, core, sdk, server)
#   - agent-relay CLI available

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

run_workflow() {
  local name="$1"
  local file="$2"
  local logfile="${CLOUD}/.relay/workflow-logs/${name}.log"
  mkdir -p "$(dirname "${logfile}")"

  log "Starting: ${name}"
  if agent-relay run "${file}" > "${logfile}" 2>&1; then
    pass "${name} — completed (log: ${logfile})"
    return 0
  else
    fail "${name} — failed (log: ${logfile})"
    tail -5 "${logfile}" >&2
    return 1
  fi
}

run_parallel() {
  local pids=()
  local names=()
  local results=()

  for pair in "$@"; do
    local name="${pair%%=*}"
    local file="${pair#*=}"
    names+=("${name}")
    run_workflow "${name}" "${file}" &
    pids+=($!)
  done

  local all_ok=0
  for i in "${!pids[@]}"; do
    if wait "${pids[$i]}"; then
      results+=("pass")
    else
      results+=("fail")
      all_ok=1
    fi
  done

  echo ""
  for i in "${!names[@]}"; do
    if [[ "${results[$i]}" == "pass" ]]; then
      pass "${names[$i]}"
    else
      fail "${names[$i]}"
    fi
  done

  return ${all_ok}
}

# ── Preflight checks ──────────────────────────────────────────

log "Checking prerequisites..."

if ! command -v agent-relay >/dev/null 2>&1; then
  fail "agent-relay CLI not found. Install from the relay repo."
  exit 1
fi

# Check npm packages are published
for pkg in @relayauth/core @relayauth/sdk @relayauth/types @relayauth/server; do
  if ! npm view "${pkg}" version >/dev/null 2>&1; then
    fail "${pkg} not published to npm yet."
    echo ""
    echo "Publish first:"
    echo "  Go to GitHub Actions → relayauth → Publish Packages → all"
    echo ""
    exit 1
  fi
done
pass "All @relayauth packages published"

# Install latest versions
log "Installing latest @relayauth packages..."
cd "${CLOUD}"
npm install @relayauth/core@latest @relayauth/sdk@latest @relayauth/types@latest @relayauth/server@latest --legacy-peer-deps 2>&1 | tail -3
pass "Packages installed"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " WAVE 1: Independent workflows (parallel)"
echo "═══════════════════════════════════════════════════════════"
echo ""

if ! run_parallel \
  "fix-relative-imports=${CLOUD}/workflows/fix-relative-imports.ts" \
  "infra-deployment-wiring=${CLOUD}/workflows/infra-deployment-wiring.ts" \
  "refactor-cloudflare-storage=${CLOUD}/workflows/refactor-cloudflare-storage.ts"; then
  fail "Wave 1 had failures. Check logs above."
  warn "Continuing to Wave 2 anyway (some workflows may fail)..."
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " WAVE 2: Integration workflows (parallel)"
echo "═══════════════════════════════════════════════════════════"
echo ""

if ! run_parallel \
  "cloud-relayauth-integration=${CLOUD}/workflows/cloud-relayauth-integration.ts" \
  "relayauth-relayfile-linking=${CLOUD}/workflows/relayauth-relayfile-linking.ts"; then
  fail "Wave 2 had failures. Check logs above."
  warn "Continuing to Wave 3 anyway..."
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " WAVE 3: Unified workspace (sequential)"
echo "═══════════════════════════════════════════════════════════"
echo ""

run_workflow "unified-workspace-id" "${CLOUD}/workflows/unified-workspace-id.ts" || {
  fail "Wave 3 failed."
}

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " SUMMARY"
echo "═══════════════════════════════════════════════════════════"
echo ""

log "Workflow logs at: ${CLOUD}/.relay/workflow-logs/"
log "Done."

#!/usr/bin/env bash
# probe-clone-prod.sh — thin wrapper around probe-clone.sh. Prompts
# only for the bearer token (so it never lands in shell history).
#
# Usage:
#   PROBE_WORKSPACE_ID=… PROBE_CONNECTION_ID=… scripts/probe-clone-prod.sh
#   PROBE_TOKEN=… PROBE_WORKSPACE_ID=… PROBE_CONNECTION_ID=… scripts/probe-clone-prod.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export PROBE_BASE_URL="${PROBE_BASE_URL:-https://agentrelay.com/cloud}"
if [[ -z "${PROBE_WORKSPACE_ID:-}" || -z "${PROBE_CONNECTION_ID:-}" ]]; then
  echo "PROBE_WORKSPACE_ID and PROBE_CONNECTION_ID are required." >&2
  exit 2
fi
export PROBE_OWNER="${PROBE_OWNER:-AgentWorkforce}"
export PROBE_REPO="${PROBE_REPO:-cloud}"
export PROBE_REF="${PROBE_REF:-HEAD}"

if [[ -z "${PROBE_TOKEN:-}" ]]; then
  printf 'SPECIALIST_CLOUD_API_TOKEN (or SAGE_CLOUD_API_TOKEN): '
  read -rs PROBE_TOKEN
  echo
  export PROBE_TOKEN
fi

exec "$SCRIPT_DIR/probe-clone.sh" "$PROBE_OWNER" "$PROBE_REPO"

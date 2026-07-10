#!/bin/bash
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SERVICE_DIR}/../.." && pwd)"
ENV_FILE="${SAGE_ENV_FILE:-${SERVICE_DIR}/.env}"

if [ -f "${ROOT_DIR}/.env" ]; then
  set -a
  source "${ROOT_DIR}/.env"
  set +a
fi

if [ -f "${ENV_FILE}" ]; then
  set -a
  source "${ENV_FILE}"
  set +a
fi

AWS_PROFILE="${AWS_PROFILE:-}"
SST_STAGE="${SST_STAGE:-}"

if [ -z "${AWS_PROFILE}" ]; then
  echo "AWS_PROFILE is required. Set it in ${ENV_FILE} or your shell."
  exit 1
fi

if [ -z "${SST_STAGE}" ]; then
  echo "SST_STAGE is required. Set it in ${ENV_FILE} or your shell."
  exit 1
fi

: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY is required}"
: "${SUPERMEMORY_API_KEY:?SUPERMEMORY_API_KEY is required}"
: "${NANGO_SECRET_KEY:?NANGO_SECRET_KEY is required}"
: "${CLOUD_API_TOKEN:?CLOUD_API_TOKEN is required}"
: "${AGENTCRON_API_KEY:?AGENTCRON_API_KEY is required}"

cd "${ROOT_DIR}"

SST=(node ./node_modules/sst/bin/sst.mjs)

set_secret() {
  local name="$1"
  local value="$2"

  "${SST[@]}" secret set "${name}" "${value}" --stage "${SST_STAGE}" >/dev/null
  echo "✓ ${name}"
}

echo "Loading Sage secrets for stage ${SST_STAGE} with AWS_PROFILE=${AWS_PROFILE}"

set_secret "SageOpenrouterApiKey" "${OPENROUTER_API_KEY}"
set_secret "SageSupermemoryApiKey" "${SUPERMEMORY_API_KEY}"
set_secret "SageNangoSecretKey" "${NANGO_SECRET_KEY}"
set_secret "SageCloudApiToken" "${CLOUD_API_TOKEN}"
set_secret "SageAgentcronApiKey" "${AGENTCRON_API_KEY}"

#!/bin/bash
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SERVICE_DIR}/../.." && pwd)"
ENV_FILE="${SAGE_ENV_FILE:-${SERVICE_DIR}/.env}"
COMMAND="${1:-deploy}"

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

cd "${ROOT_DIR}"

case "${COMMAND}" in
  deploy)
    AWS_LOGIN_SILENT=1 npm run login --silent
    "${SERVICE_DIR}/load-secrets.sh"
    exec npm run deploy -- --stage "${SST_STAGE}"
    ;;
  dev)
    AWS_LOGIN_SILENT=1 npm run login --silent
    "${SERVICE_DIR}/load-secrets.sh"
    exec npm run dev -- --stage "${SST_STAGE}"
    ;;
  remove)
    AWS_LOGIN_SILENT=1 npm run login --silent
    exec npm run remove -- --stage "${SST_STAGE}"
    ;;
  local)
    PORT="${PORT:-3777}"
    APP_ENV_FILE="${SAGE_APP_ENV_FILE:-${ROOT_DIR}/../sage/.env}"
    case "${APP_ENV_FILE}" in
      /*) ;;
      *) APP_ENV_FILE="${SERVICE_DIR}/${APP_ENV_FILE}" ;;
    esac
    APP_ENV_DIR="$(cd "$(dirname "${APP_ENV_FILE}")" && pwd)"
    APP_ENV_FILE="${APP_ENV_DIR}/$(basename "${APP_ENV_FILE}")"
    cd "${ROOT_DIR}/../sage"
    docker build -t sage .
    exec docker run --rm -p "${PORT}:3777" --env-file "${APP_ENV_FILE}" sage
    ;;
  *)
    echo "Usage: $0 [deploy|dev|remove|local]"
    exit 1
    ;;
esac

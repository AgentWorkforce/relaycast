#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEBUG="${BOOTSTRAP_DEBUG:-false}"

if [ "$DEBUG" = "true" ]; then
  set -x
fi

trap 'echo "ERROR: command failed at line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

wrangler() {
  npx --yes wrangler "$@"
}

get_existing_d1_id() {
  local db_name="$1"
  local list_out=""
  local id=""
  local name_lc=""

  list_out="$(wrangler d1 list --json 2>/dev/null || wrangler d1 list 2>/dev/null || true)"
  id="$(printf '%s' "$list_out" | jq -r --arg name "$db_name" '
    (if type == "array" then . else (.result // []) end)
    | map(select(.name == $name))
    | (.[0].uuid // .[0].id // .[0].database_id // empty)
  ' 2>/dev/null || true)"

  if [ -z "$id" ] || [ "$id" = "null" ]; then
    name_lc="$(printf '%s' "$db_name" | tr '[:upper:]' '[:lower:]')"
    # Fallback for non-JSON/multiline output: remember last UUID and match when name appears.
    id="$(printf '%s\n' "$list_out" | awk -v name="$name_lc" '
      {
        line=tolower($0)
        if (match($0, /[a-f0-9-]{36}/)) {
          last=substr($0, RSTART, RLENGTH)
        }
        if (index(line, name) > 0 && last != "") {
          print last
          exit
        }
      }
    ' | head -1 || true)"
  fi

  if [ -n "$id" ] && [ "$id" != "null" ]; then
    printf '%s' "$id"
  fi
}

get_existing_kv_id() {
  local title="$1"
  local list_out=""
  local id=""
  local title_lc=""

  list_out="$(wrangler kv namespace list --json 2>/dev/null || wrangler kv namespace list 2>/dev/null || true)"
  id="$(printf '%s' "$list_out" | jq -r --arg title "$title" '
    (if type == "array" then . else (.result // []) end)
    | map(select(.title == $title))
    | (.[0].id // empty)
  ' 2>/dev/null || true)"

  if [ -z "$id" ] || [ "$id" = "null" ]; then
    title_lc="$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]')"
    # Fallback for non-JSON/multiline output: remember last namespace id and match when title appears.
    id="$(printf '%s\n' "$list_out" | awk -v title="$title_lc" '
      {
        line=tolower($0)
        if (match($0, /[a-f0-9]{32}/)) {
          last=substr($0, RSTART, RLENGTH)
        }
        if (index(line, title) > 0 && last != "") {
          print last
          exit
        }
      }
    ' | head -1 || true)"
  fi

  if [ -n "$id" ] && [ "$id" != "null" ]; then
    printf '%s' "$id"
  fi
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd"
    exit 1
  fi
}

prompt_required() {
  local prompt="$1"
  local value=""
  while [ -z "$value" ]; do
    read -r -p "$prompt: " value
  done
  printf '%s' "$value"
}

prompt_required_default() {
  local prompt="$1"
  local default="$2"
  local value=""
  read -r -p "$prompt [$default]: " value
  printf '%s' "${value:-$default}"
}

prompt_secret_required() {
  local prompt="$1"
  local value=""
  while [ -z "$value" ]; do
    read -r -s -p "$prompt: " value
    echo ""
  done
  printf '%s' "$value"
}

prompt_yes_no() {
  local prompt="$1"
  local default="$2"
  local value=""
  local normalized=""

  while true; do
    if [ "$default" = "true" ]; then
      read -r -p "$prompt [Y/n]: " value
      value="${value:-y}"
    else
      read -r -p "$prompt [y/N]: " value
      value="${value:-n}"
    fi

    normalized="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
    case "$normalized" in
      y|yes) printf 'true'; return 0 ;;
      n|no) printf 'false'; return 0 ;;
      *) echo "Please answer y or n." ;;
    esac
  done
}

require_cmd npx
require_cmd jq
require_cmd curl

echo "This script bootstraps staging + production Cloudflare resources via Wrangler/API."
echo "Required Cloudflare API token permissions:"
echo "- Account: D1:Edit"
echo "- Account: Workers KV Storage:Edit"
echo "- Account: Workers R2 Storage:Edit"
echo "- Account: Queues:Edit"
echo "- Zone: DNS:Edit (if wildcard DNS is enabled)"
echo "- Zone: Zone:Read (if wildcard DNS is enabled)"
echo ""

CF_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
if [ -z "$CF_API_TOKEN" ]; then
  CF_API_TOKEN="$(prompt_secret_required "Cloudflare API token")"
fi

CF_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
if [ -z "$CF_ACCOUNT_ID" ]; then
  CF_ACCOUNT_ID="$(prompt_required "Cloudflare account ID")"
fi

ZONE_NAME="${CLOUDFLARE_ZONE_NAME:-}"
if [ -z "$ZONE_NAME" ]; then
  ZONE_NAME="$(prompt_required_default "Cloudflare zone name for wildcard DNS" "relaycast.dev")"
fi

if [ -n "${MANAGE_WILDCARD_DNS:-}" ]; then
  MANAGE_WILDCARD_DNS="${MANAGE_WILDCARD_DNS}"
else
  MANAGE_WILDCARD_DNS="$(prompt_yes_no "Ensure wildcard DNS (*.api.${ZONE_NAME}) for staging/preview" "true")"
fi

if [ -n "${APPLY_MIGRATIONS:-}" ]; then
  APPLY_MIGRATIONS="${APPLY_MIGRATIONS}"
else
  APPLY_MIGRATIONS="$(prompt_yes_no "Apply D1 migrations after provisioning" "true")"
fi

if [ -n "${SET_GH_VARS:-}" ]; then
  SET_GH_VARS="${SET_GH_VARS}"
else
  SET_GH_VARS="$(prompt_yes_no "Set GitHub repository variables automatically (requires gh auth)" "false")"
fi

export CLOUDFLARE_API_TOKEN="$CF_API_TOKEN"
export CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID"
export CI=1

ensure_d1() {
  local db_name="$1"
  local id=""
  local out=""
  local list_out=""

  # Idempotent: reuse existing DB if present.
  id="$(get_existing_d1_id "$db_name" || true)"
  if [ -n "$id" ]; then
    printf '%s' "$id"
    return 0
  fi

  out="$(wrangler d1 create "$db_name" 2>&1 || true)"
  id="$(printf '%s' "$out" | grep -oE '[a-f0-9-]{36}' | head -1 || true)"

  if [ -z "$id" ]; then
    id="$(get_existing_d1_id "$db_name" || true)"
    list_out="$(wrangler d1 list 2>/dev/null || true)"
  fi

  if [ -z "$id" ] || [ "$id" = "null" ]; then
    echo "Failed to resolve D1 ID for ${db_name}" >&2
    if [ "$DEBUG" = "true" ]; then
      echo "--- d1 create output ---" >&2
      echo "$out" >&2
      echo "--- d1 list output ---" >&2
      echo "$list_out" >&2
      echo "------------------------" >&2
    fi
    exit 1
  fi

  printf '%s' "$id"
}

ensure_kv() {
  local title="$1"
  local id=""
  local out=""
  local list_out=""

  # Idempotent: reuse existing namespace if present.
  id="$(get_existing_kv_id "$title" || true)"
  if [ -n "$id" ]; then
    printf '%s' "$id"
    return 0
  fi

  out="$(wrangler kv namespace create "$title" 2>&1 || true)"
  id="$(printf '%s' "$out" | grep -oE '[a-f0-9]{32}' | head -1 || true)"

  if [ -z "$id" ]; then
    id="$(get_existing_kv_id "$title" || true)"
    list_out="$(wrangler kv namespace list 2>/dev/null || true)"
  fi

  if [ -z "$id" ] || [ "$id" = "null" ]; then
    echo "Failed to resolve KV namespace ID for ${title}" >&2
    if [ "$DEBUG" = "true" ]; then
      echo "--- kv create output ---" >&2
      echo "$out" >&2
      echo "--- kv list output ---" >&2
      echo "$list_out" >&2
      echo "------------------------" >&2
    fi
    exit 1
  fi

  printf '%s' "$id"
}

ensure_r2_bucket() {
  local name="$1"
  wrangler r2 bucket create "$name" >/dev/null 2>&1 || true
}

ensure_queue() {
  local name="$1"
  wrangler queues create "$name" >/dev/null 2>&1 || true
}

ensure_wildcard_dns() {
  local zone_name="$1"
  local zone_id=""
  local dns_api=""
  local existing=""
  local result=""

  zone_id="$(curl -sS \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4/zones?name=${zone_name}&status=active&page=1&per_page=1" \
    | jq -r '.result[0].id // empty')"

  if [ -z "$zone_id" ]; then
    echo "Failed to resolve zone id for ${zone_name}"
    exit 1
  fi

  dns_api="https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records"
  existing="$(curl -sS \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    "${dns_api}?type=AAAA&name=*.api.${zone_name}" \
    | jq -r '.result | length')"

  if [ "$existing" -eq 0 ]; then
    result="$(curl -sS -X POST "$dns_api" \
      -H "Authorization: Bearer ${CF_API_TOKEN}" \
      -H "Content-Type: application/json" \
      --data '{"type":"AAAA","name":"*.api","content":"100::","proxied":true,"comment":"Wildcard for preview and staging workers"}')"
    if ! echo "$result" | jq -e '.success' >/dev/null 2>&1; then
      echo "Failed creating wildcard DNS record: $(echo "$result" | jq -r '.errors[0].message // "unknown error"')"
      exit 1
    fi
  fi

  printf '%s' "$zone_id"
}

apply_migrations_for_db() {
  local db_name="$1"
  local db_id="$2"
  local cfg=""

  cfg="$(mktemp /tmp/wrangler-d1-migrate-XXXX.toml)"
  cat > "$cfg" <<EOF
name = "relaycast-bootstrap-migrations"
main = "packages/server/src/worker.ts"
compatibility_date = "2024-12-01"

[[d1_databases]]
binding = "DB"
database_name = "${db_name}"
database_id = "${db_id}"
migrations_dir = "packages/server/src/db/migrations"
EOF

  (
    cd "$ROOT_DIR"
    wrangler d1 migrations apply DB --remote --config "$cfg"
  )

  rm -f "$cfg"
}

echo ""
echo "=== Provisioning staging ==="
STAGING_D1_DATABASE_ID="$(ensure_d1 "relaycast-staging")"
STAGING_KV_ID="$(ensure_kv "relaycast-staging-kv")"
ensure_r2_bucket "relaycast-files-staging"
ensure_queue "relaycast-webhooks-staging"
ensure_queue "relaycast-notifications-staging"
ensure_queue "relaycast-webhooks-staging-dlq"

echo ""
echo "=== Provisioning production ==="
PRODUCTION_D1_DATABASE_ID="$(ensure_d1 "relaycast")"
PRODUCTION_KV_ID="$(ensure_kv "relaycast-kv")"
ensure_r2_bucket "relaycast-files"
ensure_queue "relaycast-webhooks"
ensure_queue "relaycast-notifications"
ensure_queue "relaycast-webhooks-dlq"

CLOUDFLARE_ZONE_ID=""
if [ "$MANAGE_WILDCARD_DNS" = "true" ]; then
  echo ""
  echo "=== Ensuring wildcard DNS ==="
  CLOUDFLARE_ZONE_ID="$(ensure_wildcard_dns "$ZONE_NAME")"
fi

if [ "$APPLY_MIGRATIONS" = "true" ]; then
  echo ""
  echo "=== Applying D1 migrations ==="
  apply_migrations_for_db "relaycast-staging" "$STAGING_D1_DATABASE_ID"
  apply_migrations_for_db "relaycast" "$PRODUCTION_D1_DATABASE_ID"
fi

if [ "$SET_GH_VARS" = "true" ]; then
  require_cmd gh
  if ! gh auth status >/dev/null 2>&1; then
    echo "gh is not authenticated. Run: gh auth login"
    exit 1
  fi

  echo ""
  echo "=== Setting GitHub variables ==="
  gh variable set STAGING_D1_DATABASE_ID --body "$STAGING_D1_DATABASE_ID"
  gh variable set STAGING_KV_ID --body "$STAGING_KV_ID"
  gh variable set PRODUCTION_D1_DATABASE_ID --body "$PRODUCTION_D1_DATABASE_ID"
  gh variable set PRODUCTION_KV_ID --body "$PRODUCTION_KV_ID"
  if [ -n "$CLOUDFLARE_ZONE_ID" ]; then
    gh variable set CLOUDFLARE_ZONE_ID --body "$CLOUDFLARE_ZONE_ID"
  fi
fi

echo ""
echo "=== Done ==="
echo "STAGING_D1_DATABASE_ID=${STAGING_D1_DATABASE_ID}"
echo "STAGING_KV_ID=${STAGING_KV_ID}"
echo "PRODUCTION_D1_DATABASE_ID=${PRODUCTION_D1_DATABASE_ID}"
echo "PRODUCTION_KV_ID=${PRODUCTION_KV_ID}"
if [ -n "$CLOUDFLARE_ZONE_ID" ]; then
  echo "CLOUDFLARE_ZONE_ID=${CLOUDFLARE_ZONE_ID}"
fi

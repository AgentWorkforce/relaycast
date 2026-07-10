#!/usr/bin/env bash
# probe-clone.sh — interactive end-to-end test of the GitHub clone pipeline.
#
# Bypasses every known upstream failure (sage's suppressed trigger, sage's
# truncated payload, specialist-worker's identical truncated payload,
# cataloging-agent-github's unauthorized token tier) and POSTs a complete
# 5-field clone request directly to the cloud durable-queue endpoint, then
# polls /status/[jobId] until terminal.
#
# Token to use:
#   - The clone-request route allowlist is `SageCloudApiToken` OR
#     `SpecialistCloudApiToken` (cloud/packages/web/lib/integrations/
#     github-clone-auth.ts:8-11).
#   - `CatalogingCloudApiToken` is rejected (401).
#   - The Lambda mints its own relayfile token via `WebRelayauthApiKey`;
#     that's a separate concern — see spec phase-0 layer (5).
#
# What this disambiguates: layer (5) latent risks in
# specs/sage-anti-fabrication-pipeline.md — the only failure mode the four
# upstream bugs (1)-(4) prevent us from observing in prod traffic.
#
# Usage:
#   scripts/probe-clone.sh                # fully interactive
#   PROBE_TOKEN=... PROBE_WORKSPACE_ID=... PROBE_CONNECTION_ID=... \
#       scripts/probe-clone.sh AgentWorkforce cloud
#
# Requires: curl, jq.

set -euo pipefail

red()   { printf '\033[31m%s\033[0m' "$1"; }
green() { printf '\033[32m%s\033[0m' "$1"; }
yellow(){ printf '\033[33m%s\033[0m' "$1"; }
cyan()  { printf '\033[36m%s\033[0m' "$1"; }
bold()  { printf '\033[1m%s\033[0m' "$1"; }

die() { red "ERROR: "; echo "$*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"
}

require curl
require jq

# ---------------------------------------------------------------- prompts ---

prompt() {
  # prompt VAR_NAME "Question text" [default]
  local var="$1" question="$2" default="${3:-}"
  local current="${!var:-}"
  if [[ -n "$current" ]]; then
    cyan "$question "
    echo "[using $var=$current]"
    return
  fi
  local input
  if [[ -n "$default" ]]; then
    cyan "$question "
    printf "[%s] " "$default"
  else
    cyan "$question "
  fi
  read -r input
  printf -v "$var" '%s' "${input:-$default}"
}

prompt_secret() {
  local var="$1" question="$2"
  local current="${!var:-}"
  if [[ -n "$current" ]]; then
    cyan "$question "
    echo "[using $var=••••${current: -4}]"
    return
  fi
  cyan "$question "
  read -rs input
  echo
  printf -v "$var" '%s' "$input"
}

# ------------------------------------------------------- stage / base url ---

PROBE_BASE_URL="${PROBE_BASE_URL:-}"
if [[ -z "$PROBE_BASE_URL" ]]; then
  bold "Stage:"; echo
  echo "  1) prod      → https://agentrelay.com/cloud"
  echo "  2) staging   → https://staging.agentrelay.com/cloud"
  echo "  3) custom"
  prompt PROBE_STAGE_CHOICE "Pick a stage (1/2/3)" "1"
  case "$PROBE_STAGE_CHOICE" in
    1) PROBE_BASE_URL="https://agentrelay.com/cloud" ;;
    2) PROBE_BASE_URL="https://staging.agentrelay.com/cloud" ;;
    3) prompt PROBE_BASE_URL "Base URL (must include /cloud prefix)" "" ;;
    *) die "invalid choice: $PROBE_STAGE_CHOICE" ;;
  esac
fi
PROBE_BASE_URL="${PROBE_BASE_URL%/}"

bold "Probe target: "; echo "$PROBE_BASE_URL"
echo

# -------------------------------------------------------------- inputs ---

OWNER="${1:-${PROBE_OWNER:-}}"
REPO="${2:-${PROBE_REPO:-}}"

prompt PROBE_WORKSPACE_ID "Workspace ID (UUID, look it up in your relayfile workspace settings)" ""
[[ -n "$PROBE_WORKSPACE_ID" ]] || die "workspaceId required"

prompt OWNER "Repo owner" "AgentWorkforce"
prompt REPO  "Repo name"  "cloud"
prompt PROBE_REF "Git ref (branch, tag, or HEAD)" "HEAD"
echo
yellow "connectionId source — pick the one you have:"; echo
echo "  • Nango admin → GitHub integration → connection_id for the AgentWorkforce install"
echo "  • Postgres:  SELECT connection_id FROM workspace_integrations"
echo "               WHERE workspace_id='\$WORKSPACE_ID' AND provider='github';"
echo "  • Both sage's CloneRequester and specialist-worker's CloneRequester are NOT"
echo "    sending this field today — that's the schema-validation bug (layer 2/3)."
echo
prompt PROBE_CONNECTION_ID "Nango connectionId for the GitHub install" ""
[[ -n "$PROBE_CONNECTION_ID" ]] || die "connectionId required — schema validation will 400 without it"

echo
yellow "Bearer token: SageCloudApiToken or SpecialistCloudApiToken."; echo
echo "  • Pull from sage worker env (Cloudflare → sage worker → Variables → CLOUD_API_TOKEN)"
echo "  • OR from SST: cd ../cloud && npx sst secret list | grep SageCloudApiToken"
echo "  • CatalogingCloudApiToken WILL 401 — do not use it."
echo
prompt_secret PROBE_TOKEN "SageCloudApiToken or SpecialistCloudApiToken"
[[ -n "$PROBE_TOKEN" ]] || die "auth token required"

# -------------------------------------------------------------- payload ---

PAYLOAD=$(jq -nc \
  --arg workspaceId "$PROBE_WORKSPACE_ID" \
  --arg owner "$OWNER" \
  --arg repo "$REPO" \
  --arg ref "$PROBE_REF" \
  --arg connectionId "$PROBE_CONNECTION_ID" \
  '{workspaceId:$workspaceId, owner:$owner, repo:$repo, ref:$ref, connectionId:$connectionId}')

echo
bold "Submitting clone request..."; echo
echo "  POST $PROBE_BASE_URL/api/v1/github/clone/request"
echo "  body: $PAYLOAD" | sed 's/.\{120\}/&\n        /g'

SUBMIT_RESP="$(mktemp)"
HTTP_CODE=$(curl -sS -o "$SUBMIT_RESP" -w '%{http_code}' \
  -X POST "$PROBE_BASE_URL/api/v1/github/clone/request" \
  -H "Authorization: Bearer $PROBE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" || true)

echo
echo "HTTP $HTTP_CODE"
if jq -e . >/dev/null 2>&1 <"$SUBMIT_RESP"; then
  jq . "$SUBMIT_RESP"
else
  cat "$SUBMIT_RESP"
fi

case "$HTTP_CODE" in
  200|202)
    JOB_ID=$(jq -r '.jobId // empty' "$SUBMIT_RESP")
    [[ -n "$JOB_ID" ]] || { yellow "No jobId in response — endpoint may be running legacy path."; echo; exit 0; }
    INITIAL_STATUS=$(jq -r '.status // "queued"' "$SUBMIT_RESP")
    echo
    green "Accepted: jobId=$JOB_ID status=$INITIAL_STATUS"; echo
    ;;
  400)
    red "400 Bad Request — schema validation failed."; echo
    yellow "  This is the failure mode sage's CloneRequester hits in prod:"; echo
    yellow "  src/integrations/clone-requester.ts only sends 3 fields, the route requires 5."; echo
    exit 2
    ;;
  401)
    red "401 Unauthorized — token doesn't match SageCloudApiToken or SpecialistCloudApiToken."; echo
    exit 2
    ;;
  500)
    red "500 — request route failed before / during enqueue. Check cloud web logs and github-clone-audit emissions."; echo
    exit 2
    ;;
  *)
    red "Unexpected HTTP $HTTP_CODE."; echo
    exit 2
    ;;
esac

# -------------------------------------------------------------- polling ---

echo
bold "Polling /api/v1/github/clone/status/$JOB_ID..."; echo
echo "(Lambda visibility timeout is 16 min; poll budget = 6 min, every 10s)"
echo

DEADLINE=$(( $(date +%s) + 360 ))
LAST_STATUS=""
while [[ $(date +%s) -lt $DEADLINE ]]; do
  POLL_RESP="$(mktemp)"
  POLL_CODE=$(curl -sS -o "$POLL_RESP" -w '%{http_code}' \
    -H "Authorization: Bearer $PROBE_TOKEN" \
    "$PROBE_BASE_URL/api/v1/github/clone/status/$JOB_ID" || true)

  if [[ "$POLL_CODE" != "200" ]]; then
    yellow "$(date +%H:%M:%S) status http=$POLL_CODE"; echo
    cat "$POLL_RESP"
    echo
  else
    STATUS=$(jq -r '.status // .state // "unknown"' "$POLL_RESP")
    if [[ "$STATUS" != "$LAST_STATUS" ]]; then
      printf '%s ' "$(date +%H:%M:%S)"
      case "$STATUS" in
        succeeded) green "$STATUS" ;;
        failed)    red   "$STATUS" ;;
        running)   cyan  "$STATUS" ;;
        queued)    yellow "$STATUS" ;;
        *)                printf "%s" "$STATUS" ;;
      esac
      echo
      jq -c '.' "$POLL_RESP"
      LAST_STATUS="$STATUS"
    fi
    case "$STATUS" in
      succeeded|failed) break ;;
    esac
  fi
  sleep 10
done

echo
bold "Final status:"; echo
jq . "$POLL_RESP"

FINAL_STATUS=$(jq -r '.status // .state // "unknown"' "$POLL_RESP")
ERROR_MSG=$(jq -r '.errorMessage // .error // empty' "$POLL_RESP")

echo
bold "Diagnosis:"; echo
case "$FINAL_STATUS" in
  succeeded)
    green "  Lambda + writer fully functional."; echo
    echo "  Now check the relayfile UI at /github/repos/$OWNER/$REPO/ — meta.json must be present."
    echo "  If meta.json IS present: the only remaining bug is sage's suppressed trigger."
    echo "    → Fix: ship spec §5a (sentinel + status-query) + the events/ + metadata.json hotfix."
    echo "  If meta.json is missing despite status=succeeded: the writer wrote to a different"
    echo "    workspace ID (mis-wiring between web request handler and Lambda env)."
    ;;
  failed)
    red "  Lambda invoked but executor errored."; echo
    [[ -n "$ERROR_MSG" ]] && echo "  error_message: $ERROR_MSG"
    echo "  Common culprits, by error_message shape:"
    echo "    'RelayFileApiError 401/403' → relayfile bearer scope wrong for this workspace"
    echo "    'Nango proxy ... empty tarball stream' → GitHub installation token / repo access"
    echo "    'too-large' / 'binary' → tarball walker filter too aggressive"
    echo "    timeout/OOM → look at CloudWatch metrics for the Lambda"
    echo "  → Fix: open a clone-lambda-recovery spec; spec §5a is paused until Lambda is green."
    ;;
  queued|running)
    yellow "  Job did not reach a terminal state within poll budget."; echo
    echo "  If 'queued' for >2 min: SQS event-source-mapping or Lambda subscriber is broken."
    echo "  If 'running' for >16 min: Lambda is hitting visibility timeout without writing"
    echo "    success/failure — likely OOM or infinite loop in tarball walker."
    echo "  → Need CloudWatch tail of /aws/lambda/GithubCloneQueueSubscriberBbcfkxFunction"
    echo "    in account 857812839918. The 131935618863 SSO profile cannot reach it."
    ;;
  *)
    yellow "  Unknown final status: $FINAL_STATUS"; echo
    ;;
esac

rm -f "$SUBMIT_RESP" "$POLL_RESP"

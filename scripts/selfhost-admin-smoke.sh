#!/usr/bin/env bash
# End-to-end smoke test for the self-host image's internal admin API.
#
# Builds the repository image (unless SKIP_BUILD=1), runs it on loopback with a
# throwaway internal secret and an opted-in plaintext base URL, then:
#   1. checks /internal is authenticated and advertises capabilities,
#   2. creates a workspace through POST /internal/workspaces,
#   3. registers two agents with the returned key and exchanges a #general message,
#   4. rotates the key via POST /internal/workspaces/:id/api-key and proves the
#      old key is rejected while the new one works,
#   5. exercises the hosted-shape push (control-plane-minted key + generation).
# Secrets and keys are never printed. Everything is removed on exit.
#
# Env: RELAYCAST_SMOKE_PORT (default 19487), RELAYCAST_SMOKE_IMAGE
# (default relaycast-self-host:smoke), RELAYCAST_SMOKE_NAME (container name),
# SKIP_BUILD=1 to reuse an existing image.
set -euo pipefail

PORT="${RELAYCAST_SMOKE_PORT:-19487}"
IMAGE="${RELAYCAST_SMOKE_IMAGE:-relaycast-self-host:smoke}"
NAME="${RELAYCAST_SMOKE_NAME:-sp-relaycast-admin-smoke}"
BASE="http://127.0.0.1:${PORT}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for tool in docker curl jq openssl; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 2; }
done

SECRET_DIR="$(mktemp -d "${TMPDIR:-/tmp}/relaycast-smoke.XXXXXX")"
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$SECRET_DIR"
}
trap cleanup EXIT

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1" >&2; docker logs "$NAME" 2>&1 | tail -20 >&2 || true; exit 1; }

# status <method> <path> <bearer> [json-body] → prints HTTP status, body in $BODY_FILE
BODY_FILE="$SECRET_DIR/body.json"
status() {
  local method="$1" path="$2" bearer="$3" body="${4:-}"
  local args=(-sS -o "$BODY_FILE" -w '%{http_code}' -X "$method" "${BASE}${path}")
  [[ -n "$bearer" ]] && args+=(-H "authorization: Bearer ${bearer}")
  [[ -n "$body" ]] && args+=(-H 'content-type: application/json' --data "$body")
  curl "${args[@]}"
}
expect() { # expect <want> <got> <label>
  [[ "$1" == "$2" ]] && pass "$3 ($2)" || fail "$3: expected $1, got $2"
}

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "building $IMAGE ..."
  # A restrictive umask leaves context files unreadable for the image's
  # non-root user; open the build context up for reading first.
  chmod -R go+rX "$ROOT/packages" "$ROOT/docker" "$ROOT/package.json" \
    "$ROOT/package-lock.json" "$ROOT/tsconfig.base.json" "$ROOT/Dockerfile"
  docker build -q -t "$IMAGE" "$ROOT" >/dev/null
fi

umask 077
openssl rand -hex 32 > "$SECRET_DIR/internal-secret"
INTERNAL_SECRET="$(cat "$SECRET_DIR/internal-secret")"
# The container runs as uid 1000 (node); keep the mount owner-only when that is us.
[[ "$(id -u)" == "1000" ]] || chmod 0444 "$SECRET_DIR/internal-secret"
chmod 0755 "$SECRET_DIR"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" \
  -p "127.0.0.1:${PORT}:8787" \
  --read-only --tmpfs /tmp:size=64m --tmpfs /data:uid=1000,gid=1000 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  -e RELAYCAST_ALLOW_INSECURE_BASE_URL=true \
  -e RELAYCAST_INTERNAL_SECRET_FILE=/run/secrets/relaycast/internal-secret \
  -v "$SECRET_DIR/internal-secret:/run/secrets/relaycast/internal-secret:ro" \
  "$IMAGE" --base-url "$BASE" >/dev/null

for _ in $(seq 1 60); do
  curl -sf "$BASE/health" >/dev/null 2>&1 && break
  sleep 0.5
done
expect 200 "$(status GET /health '')" "container healthy on $BASE (http base URL accepted)"

# 1. Auth gate + capabilities
expect 401 "$(status GET /internal/capabilities '')" "internal API rejects a missing bearer"
expect 401 "$(status GET /internal/capabilities 'wrong-secret')" "internal API rejects a wrong bearer"
expect 200 "$(status GET /internal/capabilities "$INTERNAL_SECRET")" "capabilities"
[[ "$(jq -r '.data.workspace_key_push.generation_cas and .data.workspace_key_push.previous_key_slot and .data.workspace_key_push.grace_ms' "$BODY_FILE")" == "true" ]] \
  && pass "capabilities advertise generation_cas/previous_key_slot/grace_ms" || fail "capabilities shape"

# 2. Create a workspace
expect 201 "$(status POST /internal/workspaces "$INTERNAL_SECRET" '{"name":"selfhost-smoke"}')" "create workspace"
WS_ID="$(jq -r .data.workspace_id "$BODY_FILE")"
OLD_KEY="$(jq -r .data.api_key "$BODY_FILE")"
[[ "$OLD_KEY" == rk_live_* && -n "$WS_ID" ]] && pass "create returned workspace_id + rk_live_ api_key" || fail "create response shape"

# 3. Two agents, one channel message
expect 201 "$(status POST /v1/agents "$OLD_KEY" '{"name":"alice"}')" "register agent alice"
ALICE="$(jq -r .data.token "$BODY_FILE")"
expect 201 "$(status POST /v1/agents "$OLD_KEY" '{"name":"bob"}')" "register agent bob"
BOB="$(jq -r .data.token "$BODY_FILE")"
expect 201 "$(status POST /v1/channels/general/messages "$ALICE" '{"text":"hello from alice (selfhost smoke)"}')" "alice posts to #general"
expect 200 "$(status GET /v1/channels/general/messages "$BOB" '')" "bob reads #general"
jq -e '[.. | strings] | any(. == "hello from alice (selfhost smoke)")' "$BODY_FILE" >/dev/null \
  && pass "bob sees alice's message" || fail "message not visible to bob"

# 4. Rotate (server-minted, grace 0) — the old key must stop working
expect 200 "$(status POST "/internal/workspaces/${WS_ID}/api-key" "$INTERNAL_SECRET" '{"grace_ms":0}')" "rotate workspace key"
NEW_KEY="$(jq -r .data.api_key "$BODY_FILE")"
GEN="$(jq -r .data.api_key_generation "$BODY_FILE")"
[[ "$NEW_KEY" == rk_live_* && "$NEW_KEY" != "$OLD_KEY" && "$GEN" == "1" ]] \
  && pass "rotation returned a new key at api_key_generation 1" || fail "rotation response shape"
expect 401 "$(status GET /v1/workspace "$OLD_KEY")" "old key rejected after rotation"
expect 200 "$(status GET /v1/workspace "$NEW_KEY")" "new key accepted"
expect 200 "$(status GET /v1/channels/general/messages "$BOB" '')" "existing agent tokens keep working"

# 5. Hosted-shape push: control plane mints the key and fences by generation
CP_KEY="rk_live_$(openssl rand -hex 16)"
expect 200 "$(status POST "/internal/workspaces/${WS_ID}/api-key" "$INTERNAL_SECRET" "{\"api_key\":\"${CP_KEY}\",\"key_generation\":2,\"grace_ms\":0}")" "hosted-shape push (key_generation 2)"
[[ "$(jq -c .data "$BODY_FILE")" == "{\"workspace_id\":\"${WS_ID}\",\"api_key_generation\":2}" ]] \
  && pass "push echoes {workspace_id, api_key_generation}" || fail "push response shape"
expect 401 "$(status GET /v1/workspace "$NEW_KEY")" "server-minted key rejected after push"
expect 200 "$(status GET /v1/workspace "$CP_KEY")" "pushed key accepted"
expect 409 "$(status POST "/internal/workspaces/${WS_ID}/api-key" "$INTERNAL_SECRET" "{\"api_key\":\"${NEW_KEY}\",\"key_generation\":1}")" "stale generation push refused"

echo "selfhost admin smoke: all checks passed"

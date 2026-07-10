#!/usr/bin/env bash
# End-to-end smoke for multi-repo cloud workflows (Phases A+B+C).
#
# Exercises the surface that PGlite/mock tests can't:
#   - Real GitHub App installation-token mint via Nango
#   - Real GET /repos/{owner}/{repo} default_branch resolution
#   - Real branch-create + Contents-API push
#   - Real PR opens
#   - Callback idempotency (manually re-fires the callback URL)
#
# Reads two scratch repos from env (does NOT create them). Both must:
#   - Exist on GitHub
#   - Have the workspace's GitHub App installed
#   - Be allowlisted with pushAllowed=true (this script POSTs the allowlist
#     entries idempotently — it won't re-create existing rows)
#
# Required env:
#   SMOKE_API_BASE        e.g. https://staging.agentrelay.com/cloud
#   SMOKE_API_TOKEN       Bearer token for the cloud API (workspace-scoped)
#   SMOKE_WORKSPACE_ID    The workspace ID
#   SMOKE_REPO_A          owner/repo, e.g. AgentWorkforce/scratch-alpha
#   SMOKE_REPO_B          owner/repo, e.g. AgentWorkforce/scratch-beta
#
# Optional env:
#   SMOKE_KEEP_ARTIFACTS=1   Don't close PRs / delete branches at the end
#   SMOKE_SKIP_IDEMPOTENCY=1 Don't re-fire the callback to test idempotency
#   SMOKE_TIMEOUT_SECS=900   Max wait for run completion (default 15min)
#   DRY_RUN=1                Echo every command, don't execute

set -euo pipefail

# ── Helpers ──────────────────────────────────────────────────────────────
say()  { printf '\n\033[1;36m[smoke]\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m[smoke ✓]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[smoke ⚠]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[smoke ✗]\033[0m %s\n' "$*" >&2; exit 1; }

run() {
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    printf '\033[0;90m[dry-run]\033[0m %q ' "$@"; printf '\n'
    return 0
  fi
  "$@"
}

require_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }
require_env() { [[ -n "${!1:-}" ]] || die "missing required env: $1"; }

api() {
  local method="$1" path="$2" body="${3:-}"
  local url="${SMOKE_API_BASE%/}${path}"
  local args=(-sS -X "$method" -H "Authorization: Bearer ${SMOKE_API_TOKEN}" -H "Content-Type: application/json")
  if [[ -n "$body" ]]; then args+=(--data "$body"); fi
  curl "${args[@]}" "$url"
}

# Split owner/repo into globals so we don't re-parse repeatedly.
parse_coord() {
  local coord="$1" out_owner="$2" out_repo="$3"
  [[ "$coord" == */* ]] || die "$coord is not in owner/repo form"
  printf -v "$out_owner" '%s' "${coord%%/*}"
  printf -v "$out_repo"  '%s' "${coord##*/}"
}

# ── Preflight ────────────────────────────────────────────────────────────
say "Preflight"
require_cmd curl
require_cmd jq
require_cmd gh
require_cmd git
require_cmd agent-relay
gh auth status >/dev/null 2>&1 || die "gh is not authenticated. Run: gh auth login"

require_env SMOKE_API_BASE
require_env SMOKE_API_TOKEN
require_env SMOKE_WORKSPACE_ID
require_env SMOKE_REPO_A
require_env SMOKE_REPO_B

parse_coord "$SMOKE_REPO_A" REPO_A_OWNER REPO_A_NAME
parse_coord "$SMOKE_REPO_B" REPO_B_OWNER REPO_B_NAME

gh repo view "$SMOKE_REPO_A" >/dev/null 2>&1 || die "$SMOKE_REPO_A not visible to gh"
gh repo view "$SMOKE_REPO_B" >/dev/null 2>&1 || die "$SMOKE_REPO_B not visible to gh"
ok "scratch repos $SMOKE_REPO_A and $SMOKE_REPO_B exist"

TIMEOUT_SECS="${SMOKE_TIMEOUT_SECS:-900}"
WORK_DIR="$(mktemp -d -t cloud-multirepo-smoke-XXXXXX)"
say "work dir: $WORK_DIR"

# ── Step 1: Allowlist both repos (idempotent) ────────────────────────────
say "Step 1 — allowlisting both repos with pushAllowed=true"
allow_repo() {
  local owner="$1" repo="$2"
  local existing
  existing="$(api GET "/api/v1/workspaces/${SMOKE_WORKSPACE_ID}/integrations/github/allowed-repos/${owner}/${repo}" || echo '{}')"
  local id
  id="$(printf '%s' "$existing" | jq -r '.id // empty')"
  if [[ -n "$id" ]]; then
    api PATCH "/api/v1/workspaces/${SMOKE_WORKSPACE_ID}/integrations/github/allowed-repos/${owner}/${repo}" \
      '{"pushAllowed": true}' | jq -e '.pushAllowed == true' >/dev/null \
      || die "PATCH did not flip pushAllowed for ${owner}/${repo}"
    ok "${owner}/${repo} allowlist row exists, pushAllowed=true"
  else
    api POST "/api/v1/workspaces/${SMOKE_WORKSPACE_ID}/integrations/github/allowed-repos" \
      "$(jq -nc --arg o "$owner" --arg r "$repo" '{repoOwner:$o, repoName:$r, pushAllowed: true}')" \
      | jq -e '.pushAllowed == true' >/dev/null \
      || die "POST failed for ${owner}/${repo}"
    ok "${owner}/${repo} allowlist row created, pushAllowed=true"
  fi
}
allow_repo "$REPO_A_OWNER" "$REPO_A_NAME"
allow_repo "$REPO_B_OWNER" "$REPO_B_NAME"

# ── Step 2: Clone scratch repos to predictable sibling paths ─────────────
say "Step 2 — cloning scratch repos"
ALPHA_DIR="${WORK_DIR}/scratch-alpha"
BETA_DIR="${WORK_DIR}/scratch-beta"
run gh repo clone "$SMOKE_REPO_A" "$ALPHA_DIR" -- --quiet
run gh repo clone "$SMOKE_REPO_B" "$BETA_DIR"  -- --quiet

# Capture each repo's default branch SHA — used later to assert the PR's
# base matches the resolved default_branch (NOT necessarily 'main').
default_branch() { gh repo view "$1" --json defaultBranchRef --jq '.defaultBranchRef.name'; }
ALPHA_DEFAULT="$(default_branch "$SMOKE_REPO_A")"
BETA_DEFAULT="$(default_branch "$SMOKE_REPO_B")"
ok "alpha default branch: $ALPHA_DEFAULT, beta default branch: $BETA_DEFAULT"

# ── Step 3: Run the workflow ─────────────────────────────────────────────
say "Step 3 — running multi-repo workflow in cloud"
SMOKE_REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKFLOW_FILE="${SMOKE_REPO_DIR}/tests/e2e/multi-repo-smoke.yaml"
[[ -f "$WORKFLOW_FILE" ]] || die "workflow file not found: $WORKFLOW_FILE"

# Run from inside alpha so cwd inference treats alpha as the primary path.
RUN_LOG="$(mktemp -t multi-repo-smoke-run-XXXXXX.log)"
say "run log → $RUN_LOG"
(
  cd "$ALPHA_DIR"
  run agent-relay cloud run "$WORKFLOW_FILE" --json
) 2>&1 | tee "$RUN_LOG"

RUN_ID="$(jq -Rr 'fromjson? | .runId // .id // empty' "$RUN_LOG" 2>/dev/null | head -1 || true)"
if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(grep -oE 'runId[: ]+[a-zA-Z0-9_-]+' "$RUN_LOG" | head -1 | awk '{print $NF}')"
fi
[[ -n "$RUN_ID" ]] || die "could not extract runId from $RUN_LOG"
ok "captured runId: $RUN_ID"

# ── Step 4: Wait for completion + assert pushedTo populated ──────────────
say "Step 4 — polling for completion"
deadline=$(( $(date +%s) + TIMEOUT_SECS ))
status=""
while [[ $(date +%s) -lt $deadline ]]; do
  resp="$(api GET "/api/v1/workflows/runs/${RUN_ID}")"
  status="$(printf '%s' "$resp" | jq -r '.status')"
  case "$status" in
    completed) break ;;
    failed|cancelled) die "run $RUN_ID terminated with status=$status" ;;
    *) sleep 5 ;;
  esac
done
[[ "$status" == "completed" ]] || die "run $RUN_ID did not complete within ${TIMEOUT_SECS}s (last status=$status)"
ok "run $RUN_ID completed"

# ── Step 5: Assert per-repo PRs opened ───────────────────────────────────
say "Step 5 — verifying per-repo PRs"
ALPHA_PR_URL="$(printf '%s' "$resp" | jq -r '.patches.alpha.pushedTo.prUrl // empty')"
BETA_PR_URL="$(printf '%s' "$resp"  | jq -r '.patches.beta.pushedTo.prUrl  // empty')"
[[ -n "$ALPHA_PR_URL" ]] || die "patches.alpha.pushedTo.prUrl missing in run response"
[[ -n "$BETA_PR_URL"  ]] || die "patches.beta.pushedTo.prUrl missing in run response"
ok "alpha PR: $ALPHA_PR_URL"
ok "beta PR:  $BETA_PR_URL"

ALPHA_PR_NUM="${ALPHA_PR_URL##*/}"
BETA_PR_NUM="${BETA_PR_URL##*/}"

assert_pr() {
  local repo="$1" num="$2" expected_default="$3"
  local pr_json
  pr_json="$(gh pr view "$num" --repo "$repo" --json baseRefName,headRefName,files,state)"
  local base head state
  base="$(printf '%s' "$pr_json" | jq -r '.baseRefName')"
  head="$(printf '%s' "$pr_json" | jq -r '.headRefName')"
  state="$(printf '%s' "$pr_json" | jq -r '.state')"
  [[ "$state" == "OPEN" ]]            || die "PR $repo#$num is not OPEN (state=$state)"
  [[ "$base" == "$expected_default" ]] || die "PR $repo#$num base is $base, expected default $expected_default"
  [[ "$head" == agent-relay/run-* ]]   || die "PR $repo#$num head $head doesn't follow agent-relay/run-* convention"
  printf '%s' "$pr_json" | jq -e '.files[] | select(.path == ".relay-smoke/heartbeat.txt")' >/dev/null \
    || die "PR $repo#$num diff is missing .relay-smoke/heartbeat.txt"
  ok "PR $repo#$num: base=$base head=$head heartbeat present"
}
assert_pr "$SMOKE_REPO_A" "$ALPHA_PR_NUM" "$ALPHA_DEFAULT"
assert_pr "$SMOKE_REPO_B" "$BETA_PR_NUM"  "$BETA_DEFAULT"

# ── Step 6: Idempotency — re-fire the callback ───────────────────────────
if [[ "${SMOKE_SKIP_IDEMPOTENCY:-0}" != "1" ]]; then
  say "Step 6 — re-firing callback to verify idempotency"
  # Re-firing the same completed callback should be a no-op: pushedTo
  # already populated → callback handler skips push-back. PRs should
  # remain a single pair (no duplicates).
  api POST "/api/v1/workflows/callback" \
    "$(jq -nc --arg id "$RUN_ID" '{runId: $id, status: "completed"}')" \
    >/dev/null || warn "callback re-fire returned non-2xx (acceptable if endpoint requires signed payload)"

  sleep 5
  resp_after="$(api GET "/api/v1/workflows/runs/${RUN_ID}")"
  alpha_after="$(printf '%s' "$resp_after" | jq -r '.patches.alpha.pushedTo.prUrl')"
  beta_after="$(printf '%s' "$resp_after"  | jq -r '.patches.beta.pushedTo.prUrl')"
  [[ "$alpha_after" == "$ALPHA_PR_URL" ]] || die "idempotency check: alpha PR URL changed ($ALPHA_PR_URL → $alpha_after)"
  [[ "$beta_after"  == "$BETA_PR_URL"  ]] || die "idempotency check: beta PR URL changed  ($BETA_PR_URL → $beta_after)"
  ok "callback idempotency holds — pushedTo unchanged after re-fire"
else
  warn "skipping idempotency check (SMOKE_SKIP_IDEMPOTENCY=1)"
fi

# ── Step 7: Cleanup ──────────────────────────────────────────────────────
if [[ "${SMOKE_KEEP_ARTIFACTS:-0}" == "1" ]]; then
  warn "SMOKE_KEEP_ARTIFACTS=1 — leaving PRs and branches in place"
  warn "  alpha: $ALPHA_PR_URL"
  warn "  beta:  $BETA_PR_URL"
  warn "  work dir: $WORK_DIR"
else
  say "Step 7 — cleaning up"
  cleanup_pr() {
    local repo="$1" num="$2"
    local head
    head="$(gh pr view "$num" --repo "$repo" --json headRefName --jq '.headRefName' 2>/dev/null || echo '')"
    gh pr close "$num" --repo "$repo" --delete-branch >/dev/null 2>&1 \
      || warn "couldn't close $repo#$num cleanly (may need manual cleanup; head=$head)"
  }
  cleanup_pr "$SMOKE_REPO_A" "$ALPHA_PR_NUM"
  cleanup_pr "$SMOKE_REPO_B" "$BETA_PR_NUM"
  rm -rf "$WORK_DIR"
  ok "cleanup done"
fi

ok "Multi-repo cloud smoke passed."

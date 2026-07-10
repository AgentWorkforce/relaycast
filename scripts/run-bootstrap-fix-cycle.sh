#!/usr/bin/env bash
# Continuous-ish pipeline for landing the cloud bootstrap fixes and
# validating them end-to-end.
#
# Runs the master fix workflow locally, pauses for you to merge the PR,
# triggers the snapshot rebuild, waits for the SSM parameter to flip,
# then launches the two probe workflows on cloud and confirms the result.
#
# Usage:
#   scripts/run-bootstrap-fix-cycle.sh
#
# Flags (env vars):
#   SKIP_FIX=1        Skip the fix-workflow step. Assumes a PR already exists.
#                     Useful when resuming after an earlier failure.
#   PR_NUMBER=<n>     Supply the PR number directly. Required with SKIP_FIX.
#   SKIP_REBUILD=1    Don't trigger rebuild-snapshot.yml. Use when the
#                     snapshot is already rebuilt.
#   SKIP_PROBES=1     Don't run the verification probes.
#   AUTO_MERGE=1      After opening the PR, attempt `gh pr merge --auto`.
#                     Still pauses if the PR requires review approvals that
#                     the token doesn't have.
#   DRY_RUN=1         Echo every command; don't execute.
#
# Requires: agent-relay, gh, aws (for SSM), jq.

set -euo pipefail

REPO="AgentWorkforce/cloud"
SNAPSHOT_SSM_NAME="/cloud/production/relay-sandbox-snapshot"
AWS_REGION="${AWS_REGION:-us-east-1}"

FIX_WORKFLOW="workflows/fix-cloud-bootstrap-master.ts"
PROBE_SANDBOX="workflows/e2e-per-agent-sandbox.ts"
PROBE_CLOUD_SYNC="workflows/e2e-cloud-sync.ts"

# ── Helpers ──────────────────────────────────────────────────────────────
# say() writes to stderr so functions that want to print progress while
# ALSO returning a value via stdout + $(...) don't get their progress
# captured into the value. warn/die already write to stderr.
say() { printf '\n\033[1;36m[cycle]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[cycle]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[cycle]\033[0m %s\n' "$*" >&2; exit 1; }

run() {
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    printf '\033[0;90m[dry-run]\033[0m %s\n' "$*"
    return 0
  fi
  "$@"
}

require() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

# ── Preflight ────────────────────────────────────────────────────────────
say "Preflight"
require agent-relay
require gh
require aws
require jq
gh auth status >/dev/null 2>&1 || die "gh is not authenticated. Run: gh auth login"
aws sts get-caller-identity >/dev/null 2>&1 \
  || die "aws credentials not configured for ${AWS_REGION}. Run: aws sso login"

# ── Phase 1: Fix workflow (local) ────────────────────────────────────────
PR_NUMBER="${PR_NUMBER:-}"

if [[ "${SKIP_FIX:-0}" != "1" ]]; then
  say "Phase 1 — running fix workflow locally"
  say "  $FIX_WORKFLOW"
  say "  This invokes claude + codex; expect ~15-20 minutes."

  # Capture the workflow's stdout so we can parse the PR URL it prints.
  out_log="$(mktemp -t bootstrap-fix-XXXXXX.log)"
  say "  output → $out_log"
  if ! run agent-relay run "$FIX_WORKFLOW" 2>&1 | tee "$out_log"; then
    die "fix workflow failed. See $out_log for details."
  fi

  # The workflow's commit-and-pr step uses `gh pr create`, which prints the
  # PR URL on stdout. Extract it.
  pr_url="$(grep -Eo "https://github\.com/${REPO//\//\/}/pull/[0-9]+" "$out_log" | tail -n1 || true)"
  [[ -n "$pr_url" ]] || die "could not extract PR URL from $out_log"
  PR_NUMBER="${pr_url##*/}"
  say "PR opened: $pr_url"
else
  [[ -n "$PR_NUMBER" ]] || die "SKIP_FIX=1 requires PR_NUMBER=<n>"
  say "Phase 1 — skipped, resuming from PR #$PR_NUMBER"
fi

# ── Phase 2: Merge PR (human-in-the-loop) ────────────────────────────────
say "Phase 2 — waiting for PR #$PR_NUMBER to merge"

if [[ "${AUTO_MERGE:-0}" == "1" ]]; then
  say "  AUTO_MERGE=1 — attempting gh pr merge --auto"
  run gh pr merge --auto --squash --repo "$REPO" "$PR_NUMBER" \
    || warn "  auto-merge setup failed; falling back to manual merge"
fi

say "  Review + merge the PR in your browser:"
say "  https://github.com/$REPO/pull/$PR_NUMBER"
say "  Polling every 30s — Ctrl-C to abort."

while true; do
  merged_at="$(gh pr view "$PR_NUMBER" --repo "$REPO" --json mergedAt --jq '.mergedAt // empty')"
  if [[ -n "$merged_at" ]]; then
    say "  merged at $merged_at"
    break
  fi
  sleep 30
done

# ── Phase 3: Snapshot rebuild ────────────────────────────────────────────
if [[ "${SKIP_REBUILD:-0}" == "1" ]]; then
  say "Phase 3 — skipped per SKIP_REBUILD=1"
else
  say "Phase 3 — triggering Rebuild Daytona Snapshot"

  # Record the current snapshot name so we can detect the rollover.
  before="$(
    aws ssm get-parameter \
      --region "$AWS_REGION" \
      --name "$SNAPSHOT_SSM_NAME" \
      --query Parameter.Value \
      --output text 2>/dev/null || echo unknown
  )"
  say "  current snapshot: $before"

  run gh workflow run rebuild-snapshot.yml --repo "$REPO" --ref main

  say "  polling SSM for updated snapshot name (every 45s, up to 20 min)..."
  deadline=$(( $(date +%s) + 1200 ))
  while true; do
    now="$(
      aws ssm get-parameter \
        --region "$AWS_REGION" \
        --name "$SNAPSHOT_SSM_NAME" \
        --query Parameter.Value \
        --output text 2>/dev/null || echo unknown
    )"
    if [[ "$now" != "$before" && "$now" != "unknown" ]]; then
      say "  new snapshot: $now"
      break
    fi
    if (( $(date +%s) > deadline )); then
      die "  timed out waiting for snapshot rollover. Check rebuild-snapshot.yml run logs."
    fi
    sleep 45
  done

  # Lambda cache TTL for the SSM value — 5 min worst case.
  say "  waiting 5 min for Lambda SSM cache to expire..."
  run sleep 300
fi

# ── Phase 4: Verification probes ─────────────────────────────────────────
if [[ "${SKIP_PROBES:-0}" == "1" ]]; then
  say "Phase 4 — skipped per SKIP_PROBES=1"
  exit 0
fi

run_probe() {
  # Sets a global <label>_RUN_ID var instead of returning via stdout so
  # the progress logs don't get captured into the value.
  local probe_path="$1"
  local label="$2"
  local var_name="$3"
  say "Phase 4 — probe: $label"
  say "  $probe_path"

  local probe_log
  probe_log="$(mktemp -t "${label}-XXXXXX.log")"
  if ! run agent-relay cloud run "$probe_path" 2>&1 | tee "$probe_log"; then
    die "probe $label failed during launch. See $probe_log."
  fi

  local run_id
  run_id="$(grep -Eo 'Run created: [a-f0-9-]+' "$probe_log" | awk '{print $3}' | tail -n1 || true)"
  [[ -n "$run_id" ]] || die "could not extract run id for $label from $probe_log"
  say "  run id: $run_id"
  printf -v "$var_name" '%s' "$run_id"
}

say "Phase 4 — launching verification probes on cloud"

sandbox_run_id=""
sync_run_id=""
run_probe "$PROBE_SANDBOX"     "per-agent-sandbox" sandbox_run_id
run_probe "$PROBE_CLOUD_SYNC"  "cloud-sync"        sync_run_id

# Give each probe a generous window to complete.
say "  waiting 5 min for both probes to finish executing..."
run sleep 300

# Sync assertion — the cloud-sync probe's whole point is to prove the
# patch is now non-empty. Use --dry-run so we can inspect the patch
# text without mutating the local tree.
say "Phase 5 — fetching cloud-sync probe patch (dry-run)"
patch_log="$(mktemp -t sync-patch-XXXXXX.log)"
if ! run agent-relay cloud sync "$sync_run_id" --dry-run >"$patch_log" 2>&1; then
  warn "  cloud sync exited non-zero; inspecting output anyway"
fi

say "  patch output → $patch_log"
# `cloud sync --dry-run` prints the patch text when there is one. An empty
# patch shows up as "No changes to sync — the workflow did not modify any
# files." — assert against that literal.
if grep -q "No changes to sync" "$patch_log" 2>/dev/null; then
  die "cloud sync returned empty for $sync_run_id. Fix 2 is NOT working. See $patch_log."
fi
patch_bytes="$(wc -c <"$patch_log" | tr -d ' ')"
if [[ "${patch_bytes:-0}" -lt 50 ]]; then
  die "cloud sync patch is suspiciously small (${patch_bytes} bytes) for $sync_run_id. See $patch_log."
fi
say "  cloud sync returned a non-empty patch (${patch_bytes} bytes)."

say ""
say "Cycle complete."
say "  per-agent-sandbox probe run: $sandbox_run_id"
say "  cloud-sync probe run:        $sync_run_id"
say "  cloud-sync patch log:        $patch_log"
say ""
say "Manual verification left to you:"
say "  - Open the per-agent-sandbox run log; confirm each agent's"
say "    DAYTONA_SANDBOX_ID is distinct:"
say "      agent-relay cloud logs $sandbox_run_id"
say "  - Inspect $patch_log for the probe-written file."

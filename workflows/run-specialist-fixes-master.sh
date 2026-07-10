#!/usr/bin/env bash
#
# Master executor for the five-workflow specialist-data-correctness fix:
#
#   Wave 1 (parallel, up to 4 workflows in 4 worktrees, 4 PRs):
#     A. GitHub itemMatchesQuery fix        → cloud (already shipped via codex agent — PR #373)
#     B. Linear apiFallback build-out       → cloud (workflows/fix-linear-specialist-apifallback.ts)
#     C. Notion librarian add               → agent-assistant (workflows/add-notion-librarian-to-agent-assistant.ts)
#     E. Harness redundant-tool-loop        → agent-assistant (workflows/fix-harness-redundant-tool-loop.ts)
#
#     C and E both touch agent-assistant but DIFFERENT packages
#     (specialists vs harness) so file-level conflicts are unlikely; safe to
#     run in parallel.
#
#   HUMAN GATE between waves:
#     - Merge PR C in agent-assistant + cut a release of @agent-assistant/specialists
#     - (Optional) Merge PR E + cut a release of @agent-assistant/harness — Wave 2
#       does not strictly require harness republish, but you'll want it for the
#       redundant-loop fix to land in cloud via the next sage release
#     - Confirm `npm view @agent-assistant/specialists version` reflects the new version
#
#   Wave 2 (parallel, up to 2 workflows in 2 worktrees, 2 PRs):
#     D. Notion specialist + apiFallback    → cloud (workflows/fix-notion-specialist-apifallback.ts)
#     F. Bump sage after harness release    → sage  (workflows/bump-sage-after-harness-release.ts)
#
#     D and F target different repos so they parallelize cleanly. F's preflight
#     hard-fails if @agent-assistant/harness latest does not export
#     redundant_tool_loop yet — so safe to spawn even if you haven't republished
#     harness yet (it'll bail loudly).
#
#   Wave 3 (manual / codex sub-agent):
#     G. Bump @agentworkforce/sage in cloud's packages/sage-worker — tiny PR
#        after F's release publishes. Trivial enough to not need a workflow.
#
# Usage:
#   ./workflows/run-specialist-fixes-master.sh [wave1|wave2|all]
#
# Flags:
#   wave1   — run Wave 1 only (parallel; default if no arg given)
#   wave2   — run Wave 2 only (assumes Wave 1's PRs merged + dep republished)
#   all     — run Wave 1, prompt for human gate confirmation, then run Wave 2
#
# Each workflow opens its own PR. The script prints all PR URLs at the end.
#
# Why bash and not a TypeScript master workflow:
# - Cross-repo workflows have different cwd (cloud vs agent-assistant). A TS master
#   would need to spawn `agent-relay run` subprocesses anyway.
# - The human gate between waves is naturally serial; bash + `read -p` is the right
#   primitive.
# - The `&` + `wait` parallelism pattern is exactly what the
#   writing-agent-relay-workflows skill recommends for cross-workflow parallelism.

set -euo pipefail

CLOUD_DIR="/Users/khaliqgant/Projects/AgentWorkforce/cloud"
AGENT_ASSISTANT_DIR="/Users/khaliqgant/Projects/AgentWorkforce/agent-assistant"
SAGE_DIR="/Users/khaliqgant/Projects/AgentWorkforce/sage"

LOG_DIR="/tmp/specialist-fixes-master"
mkdir -p "$LOG_DIR"

WAVE="${1:-wave1}"

print_header() {
  echo
  echo "=================================================================="
  echo "$1"
  echo "=================================================================="
}

ensure_clean_repo() {
  local repo="$1"
  local label="$2"
  if [ ! -d "$repo" ]; then
    echo "ERROR: $label dir does not exist: $repo" >&2
    exit 1
  fi
  if ! git -C "$repo" diff --quiet || ! git -C "$repo" diff --cached --quiet; then
    echo "ERROR: $label has uncommitted changes — clean it before running:" >&2
    git -C "$repo" status -s >&2
    exit 1
  fi
}

ensure_branch_absent_or_skip() {
  # If the workflow's target branch already exists locally OR remotely, skip
  # spawning that workflow (it's likely been run already). Caller passes the
  # branch name and a label.
  local repo="$1"
  local branch="$2"
  if git -C "$repo" rev-parse --verify "$branch" >/dev/null 2>&1; then
    echo "  branch $branch already exists locally in $(basename "$repo") — skipping"
    return 1
  fi
  if git -C "$repo" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    echo "  branch $branch already exists on origin in $(basename "$repo") — skipping"
    return 1
  fi
  return 0
}

# ─────────────────────────────────────────────────────────────────────
# WAVE 1
# ─────────────────────────────────────────────────────────────────────
run_wave1() {
  print_header "WAVE 1 — parallel workflows (cloud Linear + agent-assistant Notion librarian)"
  echo "(GitHub itemMatchesQuery fix is already in flight as PR #373 — skipping that one.)"
  echo
  echo "Logs: $LOG_DIR/"

  ensure_clean_repo "$CLOUD_DIR" "cloud"
  ensure_clean_repo "$AGENT_ASSISTANT_DIR" "agent-assistant"

  local pids=()
  local labels=()

  # Wave 1B — Linear apiFallback (cloud)
  if ensure_branch_absent_or_skip "$CLOUD_DIR" "feat/linear-specialist-apifallback"; then
    print_header "spawning: Linear apiFallback (cloud)"
    (
      cd "$CLOUD_DIR"
      agent-relay run workflows/fix-linear-specialist-apifallback.ts
    ) > "$LOG_DIR/linear.log" 2>&1 &
    pids+=($!)
    labels+=("linear")
  fi

  # Wave 1C — Notion librarian (agent-assistant)
  if ensure_branch_absent_or_skip "$AGENT_ASSISTANT_DIR" "feat/notion-librarian"; then
    print_header "spawning: Notion librarian (agent-assistant)"
    (
      cd "$AGENT_ASSISTANT_DIR"
      agent-relay run "$CLOUD_DIR/workflows/add-notion-librarian-to-agent-assistant.ts"
    ) > "$LOG_DIR/notion-librarian.log" 2>&1 &
    pids+=($!)
    labels+=("notion-librarian")
  fi

  # Wave 1E — Harness redundant-tool-loop (agent-assistant)
  if ensure_branch_absent_or_skip "$AGENT_ASSISTANT_DIR" "feat/harness-redundant-tool-loop"; then
    print_header "spawning: Harness redundant-tool-loop (agent-assistant)"
    (
      cd "$AGENT_ASSISTANT_DIR"
      agent-relay run "$CLOUD_DIR/workflows/fix-harness-redundant-tool-loop.ts"
    ) > "$LOG_DIR/redundant-loop.log" 2>&1 &
    pids+=($!)
    labels+=("redundant-loop")
  fi

  if [ ${#pids[@]} -eq 0 ]; then
    echo "Nothing to do — all Wave 1 branches already exist."
    return 0
  fi

  echo
  echo "Wave 1 spawned ${#pids[@]} workflow(s): ${labels[*]}"
  echo "Tail logs in another terminal:"
  for label in "${labels[@]}"; do
    echo "  tail -f $LOG_DIR/${label}.log"
  done
  echo

  # Wait for each, capture exit codes
  local fail=0
  for i in "${!pids[@]}"; do
    if wait "${pids[$i]}"; then
      echo "  ✅ ${labels[$i]} workflow exited 0"
    else
      echo "  ❌ ${labels[$i]} workflow exited NON-ZERO — see $LOG_DIR/${labels[$i]}.log"
      fail=1
    fi
  done

  print_header "WAVE 1 RESULTS"
  echo "Open PRs after Wave 1:"
  echo
  echo "GitHub itemMatchesQuery fix (codex agent, in flight):"
  gh pr list --repo AgentWorkforce/cloud --head fix/specialist-drop-itemmatchesquery --json url,state,title 2>/dev/null | head -20 || true
  echo
  echo "Linear apiFallback (cloud):"
  gh pr list --repo AgentWorkforce/cloud --head feat/linear-specialist-apifallback --json url,state,title 2>/dev/null | head -20 || true
  echo
  echo "Notion librarian (agent-assistant):"
  gh pr list --repo AgentWorkforce/agent-assistant --head feat/notion-librarian --json url,state,title 2>/dev/null | head -20 || true
  echo
  echo "Harness redundant-tool-loop (agent-assistant):"
  gh pr list --repo AgentWorkforce/agent-assistant --head feat/harness-redundant-tool-loop --json url,state,title 2>/dev/null | head -20 || true

  if [ $fail -ne 0 ]; then
    echo
    echo "ERROR: at least one Wave 1 workflow failed. Check logs in $LOG_DIR/." >&2
    return 1
  fi

  print_header "HUMAN GATE — required before Wave 2"
  cat <<EOF
1. Review and merge:
   - GitHub fix PR (#373 or whatever the codex agent opened)
   - Linear apiFallback PR
   - Notion librarian PR (agent-assistant)
   - Harness redundant-tool-loop PR (agent-assistant)

2. After the Notion librarian PR merges, cut a release of @agent-assistant/specialists.
   Verify with:  npm view @agent-assistant/specialists version

3. Confirm the published version exports createNotionLibrarian:
   curl -fsS https://unpkg.com/@agent-assistant/specialists@latest/dist/notion/index.d.ts || \\
     (echo "WARN: latest @agent-assistant/specialists may not have notion exports yet")

4. (Optional but recommended) After the harness PR merges, cut a release of
   @agent-assistant/harness so the redundant_tool_loop stopReason copy ships
   downstream. Wave 2 itself does NOT block on this — the harness change is
   independent of the Notion specialist. But the next sage release should bump
   @agent-assistant/harness to pick up the loop detector.

5. Then run:
   $0 wave2
EOF

  return 0
}

# ─────────────────────────────────────────────────────────────────────
# WAVE 2
# ─────────────────────────────────────────────────────────────────────
run_wave2() {
  print_header "WAVE 2 — parallel: Notion specialist (cloud) + Sage release (sage)"

  ensure_clean_repo "$CLOUD_DIR" "cloud"
  ensure_clean_repo "$SAGE_DIR" "sage"

  local latest_spec
  latest_spec=$(npm view @agent-assistant/specialists version)
  echo "Checking @agent-assistant/specialists@${latest_spec} ships notion module..."
  local notion_check
  notion_check=$(curl -fsS "https://unpkg.com/@agent-assistant/specialists@${latest_spec}/dist/notion/index.d.ts" 2>/dev/null || echo "MISSING")
  if [ "$notion_check" = "MISSING" ]; then
    echo "WARN: @agent-assistant/specialists@${latest_spec} does not appear to ship a notion module." >&2
    echo "      Notion specialist (workflow D) preflight will fail. Continuing anyway so workflow F can still run." >&2
  else
    echo "  ✅ notion exports present"
  fi

  local latest_harness
  latest_harness=$(npm view @agent-assistant/harness version)
  echo "Checking @agent-assistant/harness@${latest_harness} ships redundant_tool_loop..."
  local loop_check
  loop_check=$(curl -fsS "https://unpkg.com/@agent-assistant/harness@${latest_harness}/dist/types.d.ts" 2>/dev/null | grep -c "redundant_tool_loop" || echo 0)
  if [ "$loop_check" = "0" ]; then
    echo "WARN: @agent-assistant/harness@${latest_harness} does not export redundant_tool_loop." >&2
    echo "      Sage release (workflow F) preflight will fail. Continuing anyway so workflow D can still run." >&2
  else
    echo "  ✅ redundant_tool_loop present"
  fi

  local pids=()
  local labels=()

  if ensure_branch_absent_or_skip "$CLOUD_DIR" "feat/notion-specialist-apifallback"; then
    print_header "spawning: Notion specialist + apiFallback (cloud)"
    (
      cd "$CLOUD_DIR"
      agent-relay run workflows/fix-notion-specialist-apifallback.ts
    ) > "$LOG_DIR/notion-specialist.log" 2>&1 &
    pids+=($!)
    labels+=("notion-specialist")
  fi

  if ensure_branch_absent_or_skip "$SAGE_DIR" "chore/bump-aa-harness-redundant-loop"; then
    print_header "spawning: Sage release (sage)"
    (
      cd "$SAGE_DIR"
      agent-relay run "$CLOUD_DIR/workflows/bump-sage-after-harness-release.ts"
    ) > "$LOG_DIR/sage-release.log" 2>&1 &
    pids+=($!)
    labels+=("sage-release")
  fi

  if [ ${#pids[@]} -eq 0 ]; then
    echo "Nothing to do — Wave 2 branches already exist."
    return 0
  fi

  echo
  echo "Wave 2 spawned ${#pids[@]} workflow(s): ${labels[*]}"
  for label in "${labels[@]}"; do
    echo "  tail -f $LOG_DIR/${label}.log"
  done
  echo

  local fail=0
  for i in "${!pids[@]}"; do
    if wait "${pids[$i]}"; then
      echo "  ✅ ${labels[$i]} workflow exited 0"
    else
      echo "  ❌ ${labels[$i]} workflow exited NON-ZERO — see $LOG_DIR/${labels[$i]}.log"
      fail=1
    fi
  done

  print_header "WAVE 2 RESULTS"
  echo "Notion specialist PR (cloud):"
  gh pr list --repo AgentWorkforce/cloud --head feat/notion-specialist-apifallback --json url,state,title 2>/dev/null | head -20 || true
  echo
  echo "Sage release PR (sage):"
  gh pr list --repo AgentWorkforce/sage --head chore/bump-aa-harness-redundant-loop --json url,state,title 2>/dev/null | head -20 || true

  if [ $fail -ne 0 ]; then
    echo
    echo "ERROR: at least one Wave 2 workflow failed. Check logs in $LOG_DIR/." >&2
    return 1
  fi

  print_header "ALL DONE — Wave 1 + Wave 2 complete"
  echo "Up to 6 PRs are open across 3 repos. Recommended merge order:"
  echo "  Wave 1 (any order, all independent):"
  echo "    - GitHub itemMatchesQuery fix    (cloud)"
  echo "    - Linear apiFallback             (cloud)"
  echo "    - Notion librarian               (agent-assistant)  — required before Wave 2 D"
  echo "    - Harness redundant-tool-loop    (agent-assistant)  — required before Wave 2 F"
  echo "  Wave 2:"
  echo "    - Notion specialist              (cloud)"
  echo "    - Sage release with new harness  (sage)"
  echo "  Wave 3 (manual):"
  echo "    - Bump @agentworkforce/sage in cloud's packages/sage-worker (small PR after sage publishes)"
  echo
  echo "After everything merges + deploys, retry these Slack DMs to verify:"
  echo "  - 'which PRs are open in AgentWorkforce/cloud'         (GitHub fix + bare-repo handling)"
  echo "  - 'what linear issues are open?'                       (Linear apiFallback)"
  echo "  - 'do you see any info about our investors in notion?' (Notion specialist)"
  echo "  - 'explore the codebase structure deeply'              (redundant_tool_loop fail-fast)"

  return 0
}

# ─────────────────────────────────────────────────────────────────────
# entrypoint
# ─────────────────────────────────────────────────────────────────────
case "$WAVE" in
  wave1)
    run_wave1
    ;;
  wave2)
    run_wave2
    ;;
  all)
    run_wave1
    echo
    read -r -p "Wave 1 done. Have you merged the Notion librarian PR + republished @agent-assistant/specialists? [y/N] " confirm
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
      run_wave2
    else
      echo "Aborting. Re-run with: $0 wave2  (after the human gate is cleared)"
      exit 0
    fi
    ;;
  *)
    echo "Usage: $0 [wave1|wave2|all]" >&2
    exit 64
    ;;
esac

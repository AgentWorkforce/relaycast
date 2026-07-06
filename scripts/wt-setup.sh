#!/usr/bin/env bash
# Create an isolated worktree off origin/main with its own node_modules copy.
# Usage: wt-setup.sh <slug>
# Prints the worktree path on success.
set -euo pipefail
SLUG="$1"
ROOT=/home/user/relaycast
WT_BASE=/tmp/claude-0/-home-user-relaycast/84ada561-ee3f-5a7d-b887-421a38451707/worktrees
BRANCH="claude/test-coverage-gaps-npl7kl-${SLUG}"
WT="${WT_BASE}/${SLUG}"
mkdir -p "$WT_BASE"
cd "$ROOT"
git fetch origin main -q
git worktree add -q -B "$BRANCH" "$WT" origin/main
# Isolated deps: cp -a preserves the relative @relaycast/* symlinks so they
# resolve to THIS worktree's packages, and gives it its own turbo cache.
cp -a "$ROOT/node_modules" "$WT/node_modules"
echo "$WT"

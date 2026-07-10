#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$PROJECT_ROOT"
mkdir -p .logs

trap scripts/e2e/down.sh EXIT

scripts/e2e/up.sh
scripts/e2e/seed.sh

echo "==> Driving app-mention fixture..."
npx tsx tests/e2e/drive-app-mention-fixture.ts

latest_evidence="$(ls -1t .logs/e2e-*.json 2>/dev/null | head -n 1 || true)"
if [[ -n "$latest_evidence" ]]; then
  echo "==> Evidence captured at $latest_evidence"
else
  echo "No E2E evidence file was produced." >&2
  exit 1
fi

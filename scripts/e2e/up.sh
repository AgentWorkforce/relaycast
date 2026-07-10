#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$PROJECT_ROOT"
mkdir -p .logs

echo "==> Starting E2E stack..."
docker compose -f docker-compose.e2e.yml up -d --build --wait

echo "==> E2E stack is healthy."

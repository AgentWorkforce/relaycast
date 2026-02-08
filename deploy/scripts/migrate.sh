#!/bin/bash
set -euo pipefail

echo "Running Relay Transport database migrations..."

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set"
  exit 1
fi

node packages/server/dist/db/migrate.js

echo "Migrations complete."

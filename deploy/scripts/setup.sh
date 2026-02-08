#!/bin/bash
set -euo pipefail

echo "=== Relay Transport Deployment Setup ==="

# Check required environment variables
required_vars=(DATABASE_URL REDIS_URL)
for var in "${required_vars[@]}"; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var is not set"
    exit 1
  fi
done

echo "1. Running database migrations..."
node packages/server/dist/db/migrate.js
echo "   Migrations complete."

echo "2. Checking Redis connectivity..."
if command -v redis-cli &> /dev/null; then
  redis-cli -u "$REDIS_URL" ping && echo "   Redis OK" || echo "   WARNING: Redis ping failed"
else
  echo "   Skipping Redis check (redis-cli not available)"
fi

echo "3. Checking health endpoint..."
PORT="${PORT:-8080}"
sleep 2
if command -v wget &> /dev/null; then
  wget -q --spider "http://localhost:$PORT/health" && echo "   Health OK" || echo "   WARNING: Health check failed (server may not be running yet)"
elif command -v curl &> /dev/null; then
  curl -sf "http://localhost:$PORT/health" > /dev/null && echo "   Health OK" || echo "   WARNING: Health check failed (server may not be running yet)"
fi

echo "=== Setup complete ==="

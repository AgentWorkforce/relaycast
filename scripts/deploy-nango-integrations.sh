#!/usr/bin/env bash
# Deploy cloud-owned Nango syncs/actions under nango-integrations/ to Nango.
#
# Authenticates with the same NANGO_SECRET_KEY that the cloud worker uses
# at runtime (see infra/secrets.ts: sst.Secret("NangoSecretKey"); set via
# scripts/set-secrets.sh). One credential covers both runtime API calls
# (nangoClient.listRecords) and admin operations (nango deploy).
#
# Usage:
#   NANGO_SECRET_KEY=<key> ENVIRONMENT=prod scripts/deploy-nango-integrations.sh
#
# ENVIRONMENT defaults to "prod". Pass "dev" to deploy to a Nango dev env.
#
# After this lands a successful prod run, the providers.ts catalog can be
# flipped from *-sage to *-relay so new cloud-mount workspaces use the
# cloud-owned syncs.

set -euo pipefail

ENVIRONMENT="${ENVIRONMENT:-prod}"

if [ -z "${NANGO_SECRET_KEY:-}" ]; then
  echo "error: NANGO_SECRET_KEY is not set." >&2
  echo "  Pull it from SST (Resource.NangoSecretKey.value) or 1Password" >&2
  echo "  before re-running. See .claude/rules/sst-secrets.md." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$REPO_ROOT"
if [ ! -d node_modules ]; then
  echo "→ Installing root deps for adapter-owned generated-file checks..."
  npm ci --no-audit --no-fund
fi

echo "→ Checking committed adapter-owned Nango generated files..."
npm run nango-github-webhook-events:check

cd "$REPO_ROOT/nango-integrations"

if [ ! -d node_modules ]; then
  echo "→ Installing nango CLI deps..."
  npm ci --no-audit --no-fund
fi

echo "→ Compiling syncs/actions (validates allowed-import contract)..."
npx nango compile

echo "→ Deploying to Nango environment: $ENVIRONMENT"
NANGO_SECRET_KEY="$NANGO_SECRET_KEY" \
  npx nango deploy "$ENVIRONMENT" --auto-confirm

cd "$REPO_ROOT"
if [ "${NANGO_SKIP_WEBHOOK_SYNC_REFRESH:-}" != "true" ]; then
  echo "→ Refreshing Nango webhook-backed sync schedules for existing connections..."
  NANGO_SECRET_KEY="$NANGO_SECRET_KEY" \
    node scripts/refresh-nango-webhook-syncs.mjs --environment "$ENVIRONMENT"
else
  echo "→ Skipping Nango webhook-backed sync schedule refresh (NANGO_SKIP_WEBHOOK_SYNC_REFRESH=true)."
fi

echo "→ Verifying live Nango webhook subscriptions match committed declarations..."
NANGO_SECRET_KEY="$NANGO_SECRET_KEY" \
  node scripts/assert-nango-webhook-subscriptions.mjs --environment "$ENVIRONMENT"

echo "✓ Deployed. Verify in Nango dashboard:"
echo "    https://app.nango.dev/$ENVIRONMENT/integrations"
echo "  Expect: github-relay, slack-relay, notion-relay, linear-relay each"
echo "  showing the syncs declared in nango-integrations/.nango/nango.json."

#!/usr/bin/env bash
#
# Fully programmatic setup for staging + preview environments.
# Creates all Cloudflare resources and stores IDs as GitHub Actions variables.
#
# Prerequisites:
#   - gh CLI authenticated (gh auth login)
#   - wrangler authenticated (npx wrangler login)
#   - CLOUDFLARE_ZONE_ID set (find via: npx wrangler zones list)
#
# Usage:
#   CLOUDFLARE_ZONE_ID=xxx .github/scripts/setup-staging-resources.sh
#
# What it creates:
#   1. D1 database (staging)
#   2. KV namespace (staging)
#   3. R2 bucket (staging)
#   4. Queues (staging)
#   5. Wildcard DNS record (*.api.relaycast.dev)
#   6. GitHub Actions variables for all resource IDs

set -euo pipefail

: "${CLOUDFLARE_ZONE_ID:?Set CLOUDFLARE_ZONE_ID (find via: npx wrangler zones list)}"

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
echo "Repository: ${REPO}"
echo ""

set_gh_var() {
  local name="$1" value="$2"
  gh variable set "$name" --body "$value"
  echo "   GitHub variable: ${name}=${value}"
}

# ─── 1. D1 Database ────────────────────────────────────────────────
echo "=== 1/6 D1 database (staging) ==="

D1_OUTPUT=$(npx wrangler d1 create relaycast-staging 2>&1) || true
D1_ID=$(echo "$D1_OUTPUT" | grep -oP 'database_id\s*=\s*"\K[a-f0-9-]+' || \
  echo "$D1_OUTPUT" | grep -o '[a-f0-9-]\{36\}' | head -1)

if [ -z "$D1_ID" ]; then
  # Already exists — list and find it
  D1_ID=$(npx wrangler d1 list --json 2>/dev/null \
    | jq -r '.[] | select(.name == "relaycast-staging") | .uuid' | head -1)
fi

echo "   D1 database ID: ${D1_ID}"
set_gh_var "STAGING_D1_DATABASE_ID" "$D1_ID"
echo ""

# ─── 2. KV Namespace ───────────────────────────────────────────────
echo "=== 2/6 KV namespace (staging) ==="

KV_OUTPUT=$(npx wrangler kv namespace create "relaycast-staging-kv" 2>&1) || true
KV_ID=$(echo "$KV_OUTPUT" | grep -oP 'id:\s*"\K[a-f0-9]+' || \
  echo "$KV_OUTPUT" | grep -o '[a-f0-9]\{32\}' | head -1)

if [ -z "$KV_ID" ]; then
  KV_ID=$(npx wrangler kv namespace list 2>/dev/null \
    | jq -r '.[] | select(.title | contains("staging")) | .id' | head -1)
fi

echo "   KV namespace ID: ${KV_ID}"
set_gh_var "STAGING_KV_ID" "$KV_ID"
echo ""

# ─── 3. R2 Bucket ──────────────────────────────────────────────────
echo "=== 3/6 R2 bucket (staging) ==="
npx wrangler r2 bucket create relaycast-files-staging 2>&1 || echo "   (already exists)"
echo ""

# ─── 4. Queues ─────────────────────────────────────────────────────
echo "=== 4/6 Queues (staging) ==="
npx wrangler queues create relaycast-webhooks-staging 2>&1 || echo "   (already exists)"
npx wrangler queues create relaycast-notifications-staging 2>&1 || echo "   (already exists)"
npx wrangler queues create relaycast-webhooks-staging-dlq 2>&1 || echo "   (already exists)"
echo ""

# ─── 5. Wildcard DNS ───────────────────────────────────────────────
echo "=== 5/6 Wildcard DNS record ==="

CF_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
if [ -z "$CF_TOKEN" ]; then
  echo "   Set CLOUDFLARE_API_TOKEN to create DNS record"
  echo "   Or create it manually: *.api.relaycast.dev → 100:: (proxied AAAA)"
else
  DNS_API="https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records"
  EXISTING_DNS=$(curl -s -H "Authorization: Bearer ${CF_TOKEN}" \
    "${DNS_API}?type=AAAA&name=*.api.relaycast.dev" \
    | jq -r '.result | length')

  if [ "$EXISTING_DNS" -gt 0 ]; then
    echo "   Wildcard record already exists"
  else
    RESULT=$(curl -s -X POST "$DNS_API" \
      -H "Authorization: Bearer ${CF_TOKEN}" \
      -H "Content-Type: application/json" \
      --data '{
        "type": "AAAA",
        "name": "*.api",
        "content": "100::",
        "proxied": true,
        "comment": "Wildcard for PR preview deploys and staging"
      }')
    if echo "$RESULT" | jq -e '.success' > /dev/null 2>&1; then
      echo "   Created *.api.relaycast.dev → 100:: (proxied)"
    else
      echo "   Failed: $(echo "$RESULT" | jq -r '.errors[0].message // "unknown error"')"
    fi
  fi
fi

set_gh_var "CLOUDFLARE_ZONE_ID" "$CLOUDFLARE_ZONE_ID"
echo ""

# ─── 6. Apply D1 migrations ────────────────────────────────────────
echo "=== 6/6 Apply D1 migrations to staging ==="
npx wrangler d1 migrations apply relaycast-staging --remote 2>&1 || echo "   (no migrations to apply yet)"
echo ""

# ─── Summary ────────────────────────────────────────────────────────
echo "=== Setup complete ==="
echo ""
echo "GitHub Actions variables set:"
echo "  STAGING_D1_DATABASE_ID = ${D1_ID}"
echo "  STAGING_KV_ID          = ${KV_ID}"
echo "  CLOUDFLARE_ZONE_ID     = ${CLOUDFLARE_ZONE_ID}"
echo ""
echo "Remaining manual steps:"
echo "  1. Set staging secrets:"
echo "     npx wrangler secret put STRIPE_SECRET_KEY --name relaycast-api-staging"
echo "     npx wrangler secret put STRIPE_WEBHOOK_SECRET --name relaycast-api-staging"
echo ""
echo "  2. Generate and apply D1 migrations:"
echo "     npx drizzle-kit generate"
echo "     npx wrangler d1 migrations apply relaycast-staging --remote"
echo ""
echo "Done! Push to a PR to test preview deploys."

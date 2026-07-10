#!/usr/bin/env bash
#
# seed-adhoc-stage-secrets.sh <stage> [flags]
#
# Seed every SST secret a brand-new ad-hoc / ephemeral stage needs so that
# `sst deploy --stage <stage>` clears `SecretMissingError` and the web app
# boots without `[boot] resource binding check FAILED` noise.
#
# WHY THIS EXISTS
#   SST requires *some* value for *every* declared `sst.Secret(...)` the moment
#   a stage's module graph evaluates — even secrets the stage never links to a
#   deployed function. A fresh stage has zero per-stage values, so a raw
#   `sst deploy --stage e2e-foo` dies at the first unseeded declaration
#   (the report hit `SecretMissingError: Set a value for
#   SpecialistRelayauthApiKey ...`). This script is the local-laptop analog of
#   `.github/scripts/seed-sst-secrets.sh` (which only runs in CI from GitHub
#   Actions secrets): it mirrors that script's placeholder strategy, but
#   sources real values from the environment and generates self-contained
#   material locally.
#
# DESIGN PRINCIPLES
#   - Idempotent: reads which secrets already resolve for the stage (including
#     account-wide `--fallback` values) and skips them unless --force. Re-runs
#     are a no-op, so generated random values are NOT churned on every run.
#   - Never prints a secret VALUE. All values are piped to `sst secret set`
#     over stdin (matches seed-sst-secrets.sh). The script logs only NAMES and
#     the action taken (set / skip / generate).
#   - NEVER parses `sst secret list` for values — that command prints plaintext
#     (incl. multiline PEM private keys), and a `sed 's/=.*/'` "name-only" trick
#     FAILS on multiline values because continuation lines have no `=`. We grep
#     for names only and intersect with a known allow-list.
#   - dev account only. Refuses production/staging/prod and asserts the live
#     AWS identity is the dev account (251880984430) before touching anything.
#
# USAGE
#   eval "$(aws configure export-credentials --profile ar_dev --format env)"
#   unset AWS_PROFILE
#   export CLOUDFLARE_DEFAULT_ACCOUNT_ID=f7232cb80f6fab86a95426302af243e4
#   export CLOUDFLARE_API_TOKEN=<dev CF token>     # or rely on fallback CloudflareApiToken
#   bash scripts/seed-adhoc-stage-secrets.sh e2e-myname
#   npx sst deploy --stage e2e-myname || npx sst deploy --stage e2e-myname  # 2nd pass clears CF DO 10061
#
# FLAGS
#   --clone-e2e   Hard-require the clone-path real secrets from env
#                 (NANGO_SECRET_KEY, WEB_RELAYAUTH_API_KEY). Without these a
#                 clone request → Relayfile DO → sandbox flow cannot resolve
#                 GitHub creds or mint a relayfile token. See docs.
#   --force       Re-set secrets even if a value already resolves.
#   --dry-run     Print the plan (names + action only). Set nothing.
#
# See docs/ad-hoc-stage-secrets.md for the full required-vs-placeholder
# breakdown, value sources, and the CF Durable Object 10061 workaround.

set -euo pipefail

# ----------------------------------------------------------------------------
# Args
# ----------------------------------------------------------------------------
STAGE=""
CLONE_E2E=0
FORCE=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --clone-e2e) CLONE_E2E=1 ;;
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    -*) echo "Unknown flag: $1" >&2; exit 2 ;;
    *) if [ -z "$STAGE" ]; then STAGE="$1"; else echo "Unexpected arg: $1" >&2; exit 2; fi ;;
  esac
  shift
done

if [ -z "$STAGE" ]; then
  echo "Usage: $0 <stage> [--clone-e2e] [--force] [--dry-run]" >&2
  echo "  e.g. $0 e2e-\$(whoami)-\$(date +%s)" >&2
  exit 2
fi

DEV_ACCOUNT_ID="251880984430"

# ----------------------------------------------------------------------------
# Guardrails — refuse anything that isn't a throwaway dev-account stage.
# ----------------------------------------------------------------------------
norm_stage="$STAGE"
[ "$norm_stage" = "prod" ] && norm_stage="production"
case "$norm_stage" in
  production|staging)
    echo "REFUSING: '$STAGE' is a protected long-lived stage. This script is for ad-hoc dev stages only." >&2
    exit 1 ;;
esac
case "$STAGE" in
  dev|will)
    echo "REFUSING: '$STAGE' is a shared dev stage with seeded secrets. Pick a fresh throwaway name (e.g. e2e-foo)." >&2
    exit 1 ;;
esac
case "$STAGE" in
  e2e-*|adhoc-*) : ;;
  *) echo "WARNING: stage '$STAGE' does not start with e2e-/adhoc-. Continuing, but a prefix keeps throwaway stages obvious." >&2 ;;
esac

# Resolve the SST CLI. Must run from a checkout that has node_modules installed.
if [ ! -f "sst.config.ts" ]; then
  echo "ERROR: run this from the cloud repo root (sst.config.ts not found in \$PWD)." >&2
  exit 1
fi
if [ -f "./node_modules/sst/bin/sst.mjs" ]; then
  SST=(node ./node_modules/sst/bin/sst.mjs)
else
  SST=(npx sst)
fi

# Assert we are pointed at the dev account before any mutation.
if command -v aws >/dev/null 2>&1; then
  acct="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
  if [ -z "$acct" ]; then
    echo "ERROR: no usable AWS credentials. Run:" >&2
    echo "  eval \"\$(aws configure export-credentials --profile ar_dev --format env)\"; unset AWS_PROFILE" >&2
    exit 1
  fi
  if [ "$acct" != "$DEV_ACCOUNT_ID" ]; then
    echo "REFUSING: AWS account is $acct, expected dev account $DEV_ACCOUNT_ID." >&2
    echo "  A static [default] profile can shadow AWS_PROFILE. Export ar_dev creds explicitly:" >&2
    echo "  eval \"\$(aws configure export-credentials --profile ar_dev --format env)\"; unset AWS_PROFILE" >&2
    exit 1
  fi
  echo "[seed-adhoc] AWS account $acct (dev) confirmed; stage '$STAGE'."
else
  echo "WARNING: aws CLI not found; skipping dev-account assertion. Make sure you are NOT pointed at prod." >&2
fi

# ----------------------------------------------------------------------------
# Discover which secrets already resolve for this stage (incl. --fallback).
# NAMES ONLY — values never enter a variable or disk.
# ----------------------------------------------------------------------------
echo "[seed-adhoc] reading existing secret names for '$STAGE' (values never printed)…"
existing_names="$(
  "${SST[@]}" secret list --stage "$STAGE" 2>/dev/null \
    | grep -oE '^[A-Za-z][A-Za-z0-9_]*=' \
    | sed 's/=$//' \
    | sort -u || true
)"

has_value() {
  # Already satisfied if the name appears in the resolved list (own or fallback).
  printf '%s\n' "$existing_names" | grep -qx "$1"
}

# ----------------------------------------------------------------------------
# Value generators (no external dependencies; safe for a throwaway stage).
# ----------------------------------------------------------------------------
gen_random() { openssl rand -base64 32; }

# RelayAuth RS256 keypair. relayauth-api signs tokens with the private PEM and
# publishes the public PEM. A fresh keypair is fine for an isolated stage.
RSA_PRIV=""
RSA_PUB=""
gen_rsa_keypair() {
  [ -n "$RSA_PRIV" ] && return 0
  local d; d="$(mktemp -d)"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$d/priv.pem" >/dev/null 2>&1
  openssl pkey -in "$d/priv.pem" -pubout -out "$d/pub.pem" >/dev/null 2>&1
  RSA_PRIV="$(cat "$d/priv.pem")"
  RSA_PUB="$(cat "$d/pub.pem")"
  rm -rf "$d"
}

# ----------------------------------------------------------------------------
# seed <name> <kind> [arg]
#   kinds:
#     gen                          random 32-byte base64
#     literal <value>              fixed placeholder / value (no secrets in source)
#     env <ENV_VAR> <fallback>     real value from env, else <fallback> placeholder
#     env_required <ENV_VAR>       real value from env, hard-fail if unset
#     rsa_priv | rsa_pub           RelayAuth signing keypair halves
# Skips when the secret already resolves (unless --force).
# Never echoes the value.
# ----------------------------------------------------------------------------
set_count=0
skip_count=0
seed() {
  local name="$1" kind="$2" value=""

  if [ "$FORCE" -eq 0 ] && has_value "$name"; then
    echo "  = $name (already resolves; skip)"
    skip_count=$((skip_count + 1))
    return 0
  fi

  case "$kind" in
    gen)      value="$(gen_random)" ;;
    literal)  value="$3" ;;
    rsa_priv) gen_rsa_keypair; value="$RSA_PRIV" ;;
    rsa_pub)  gen_rsa_keypair; value="$RSA_PUB" ;;
    env)
      local ev="$3" fb="$4"
      value="${!ev:-$fb}"
      ;;
    env_required)
      local ev="$3"
      value="${!ev:-}"
      if [ -z "$value" ]; then
        echo "ERROR: $name requires \$$ev to be set (--clone-e2e). Export it and re-run." >&2
        exit 1
      fi
      ;;
    *) echo "internal error: unknown seed kind '$kind'" >&2; exit 99 ;;
  esac

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  + $name (would set via $kind)"
    set_count=$((set_count + 1))
    return 0
  fi

  printf '%s' "$value" | "${SST[@]}" secret set "$name" --stage "$STAGE" >/dev/null
  echo "  + $name (set via $kind)"
  set_count=$((set_count + 1))
}

echo "[seed-adhoc] seeding stage '$STAGE'$([ "$DRY_RUN" -eq 1 ] && echo ' (dry-run)') (clone-e2e=$CLONE_E2E force=$FORCE)…"

# --- Self-contained random / HMAC / signing secrets ------------------------
# Also covers the account-wide --fallback secrets so the script is robust even
# in an account whose _fallback.json isn't populated. Where fallback already
# resolves them, has_value() skips and no churn occurs.
seed AuthSessionSecret            gen
seed BrokerKeySecret              gen
seed BrokerHmacSecret             gen
seed CredentialEncryptionKey      gen
seed RelayJwtSecret               gen
seed RelayauthInternalSecret      gen
seed RelayfileInternalHmacSecret  gen
seed AgentGatewayInternalSecret   gen
seed CredentialProxyJwtSecret     gen        # HS256 mint(web)+verify(credential-proxy); same stage value
seed DigestFunctionSigningKey     gen        # HMAC mint+verify within web/sage
seed CloudAgentSpawnQuotaDefault  literal "8"

# --- RelayAuth RS256 signing keypair (relayauth-api) -----------------------
seed RelayauthSigningKeyPem       rsa_priv
seed RelayauthSigningKeyPemPublic rsa_pub

# --- Neon Postgres connection string ---------------------------------------
# Ad-hoc stages need a real Neon connection string (there is nothing to
# synthesize). Provide one via NEON_DATABASE_URL — e.g. a dedicated Neon
# branch's pooled connection string.
seed NeonDatabaseUrl              env_required NEON_DATABASE_URL

# --- Clone-path real secrets (function-needing) ----------------------------
# Real values come from the environment, mirroring CI. In --clone-e2e mode the
# two clone-critical ones are hard-required; otherwise they fall back to the
# same harmless placeholders CI uses for preview-disabled integrations.
if [ "$CLONE_E2E" -eq 1 ]; then
  seed NangoSecretKey    env_required NANGO_SECRET_KEY
  seed WebRelayauthApiKey env_required WEB_RELAYAUTH_API_KEY
  seed RelayhistoryAssertionRelayauthApiKey env_required RELAYHISTORY_ASSERTION_RELAYAUTH_API_KEY
else
  seed NangoSecretKey    env NANGO_SECRET_KEY ""
  seed WebRelayauthApiKey env WEB_RELAYAUTH_API_KEY ""
  seed RelayhistoryAssertionRelayauthApiKey env RELAYHISTORY_ASSERTION_RELAYAUTH_API_KEY "preview-relayhistory-assertion-disabled"
fi
# DaytonaApiKey, GoogleClientId/Secret are --fallback-covered in the dev
# account (inherited). Allow a per-stage override from env if provided;
# otherwise has_value() skips them (fallback satisfies SST).
seed DaytonaApiKey     env DAYTONA_API_KEY ""
seed GoogleClientId    env GOOGLE_CLIENT_ID ""
seed GoogleClientSecret env GOOGLE_CLIENT_SECRET ""

# --- Placeholder-OK on an e2e-* stage (feature not exercised / not deployed)-
# Values mirror .github/scripts/seed-sst-secrets.sh defaults exactly. Optional
# env overrides let you light up a specific integration without editing this
# file. SpecialistRelayauthApiKey is the one from the original SecretMissingError:
# linked only on the Sage-gated specialist worker (not deployed on e2e-*), so a
# placeholder satisfies SST and nothing breaks.
seed HouseAnthropicKey         env HOUSE_ANTHROPIC_KEY     "preview-house-anthropic-disabled"
seed HouseOpenaiKey            env HOUSE_OPENAI_KEY        "preview-house-openai-disabled"
seed HouseGoogleKey            env HOUSE_GOOGLE_KEY        "preview-house-google-disabled"
seed HouseOpenrouterKey        env HOUSE_OPENROUTER_KEY    "preview-house-openrouter-disabled"
seed HookdeckSigningSecret     env HOOKDECK_SIGNING_SECRET "preview-hookdeck-disabled"
seed ComposioApiKey            env COMPOSIO_API_KEY        "preview-composio-disabled"
seed SageSupermemoryApiKey     env SAGE_SUPERMEMORY_API_KEY "preview-supermemory-disabled"
seed SageCloudApiToken         env SAGE_CLOUD_API_TOKEN    "preview-sage-cloud-disabled"
seed RelaycronApiKey           env RELAYCRON_API_KEY       "preview-relaycron-disabled"
seed DropboxAppSecret          env DROPBOX_APP_SECRET      ""
seed WebhookConsumersJson      env WEBHOOK_CONSUMERS_JSON  '{"consumers":[]}'
seed WebhookMsdBackendToken    env WEBHOOK_MSD_BACKEND_TOKEN ""
seed ProactiveIssueResolverToken env PROACTIVE_ISSUE_RESOLVER_TOKEN ""
seed SpecialistOpenrouterApiKey  env SPECIALIST_OPENROUTER_API_KEY ""
seed SpecialistRelayauthApiKey   env SPECIALIST_RELAYAUTH_API_KEY  ""
seed SpecialistCloudApiToken     env SPECIALIST_CLOUD_API_TOKEN    ""
seed CatalogingCloudApiToken     env CATALOGING_CLOUD_API_TOKEN    ""

echo ""
echo "[seed-adhoc] done: set=$set_count skipped=$skip_count (dry-run=$DRY_RUN)."
echo "[seed-adhoc] Sage-only secrets (SageOpenrouterApiKey / SageAgentcronApiKey /"
echo "             SageRelayauthApiKey) are NOT declared on an e2e-* stage"
echo "             (isSageStage=false), so SST never asks for them — none seeded."
if [ "$DRY_RUN" -eq 0 ]; then
  echo ""
  echo "Next:"
  echo "  npx sst deploy --stage $STAGE || npx sst deploy --stage $STAGE"
  echo "  # the 2nd pass clears the Cloudflare Durable Object 10061 first-deploy race."
  echo "Teardown:"
  echo "  npx sst remove --stage $STAGE"
  echo "  # CloudGithubCiToken will refuse to remove (protect:true, shared/imported) — that is CORRECT; leave it."
fi

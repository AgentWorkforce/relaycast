#!/bin/bash
set -euo pipefail

# Load .env first so local dev can keep using a `.env`-driven flow.
# CI sets AWS creds via env vars (AWS_ACCESS_KEY_ID / SECRET /
# SESSION_TOKEN from a role-assumed identity), no `.env` and no
# AWS_PROFILE — the script handles both modes below.
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Resolve a usable AWS profile from arg-1 or AWS_PROFILE env. Empty
# string means "no profile, rely on whatever AWS creds are in env" —
# that's how CI runs us. Don't `export AWS_PROFILE=default` in that
# case: SST's AWS loader will then look up a `default` entry in
# ~/.aws/config, which doesn't exist in CI, and fail with
# "failed to get shared config profile, default" before any secret
# is touched. (#442 first introduced this CI hookup with a literal
# "default" argument and broke the deploy on staging — this revert/
# replace lets the env-creds path through cleanly.)
AWS_PROFILE="${1:-${AWS_PROFILE:-}}"

if [ -n "$AWS_PROFILE" ]; then
  export AWS_PROFILE
  echo "Using AWS_PROFILE=$AWS_PROFILE"
elif [ -n "${AWS_ACCESS_KEY_ID:-}" ]; then
  # Make sure SST's loader doesn't fall through to a phantom profile
  # name picked up from a stale env. With env-var creds present and
  # AWS_PROFILE unset, the AWS SDK chain uses the env creds directly.
  unset AWS_PROFILE
  echo "Using env AWS credentials (AWS_ACCESS_KEY_ID present, no AWS_PROFILE)"
else
  echo "Usage: ./scripts/set-secrets.sh [aws_profile]"
  echo "  e.g. ./scripts/set-secrets.sh ar_dev"
  echo "       ./scripts/set-secrets.sh ar_preview"
  echo "  or set AWS_PROFILE in .env / shell and run without an argument"
  echo "  or run with env-only creds (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY [+ AWS_SESSION_TOKEN])"
  exit 1
fi

SST="node ./node_modules/sst/bin/sst.mjs"

echo ""

# Pipe the value over stdin instead of passing it as a positional argv.
# The SST CLI's argv form silently rejects multiline values (it printed
# `Usage: sst secret set <name> [value]` and exited 1 on the first
# multiline PEM after PR #680 added PgbouncerTls{Cert,Key,CaCert}). The
# stdin form matches `.github/scripts/seed-sst-secrets.sh` and handles
# embedded newlines cleanly.
set_secret() {
  local sst_name="$1"
  local env_var="$2"
  local flags="${3:-}"
  local value="${!env_var:-}"

  if [ -n "$value" ]; then
    # shellcheck disable=SC2086
    printf '%s' "$value" | $SST secret set "$sst_name" $flags
    echo "✓ $sst_name (from $env_var)"
  else
    echo "— $sst_name skipped ($env_var not set)"
  fi
}

# Set secret to env var value, or generate a random value if not set
set_secret_or_generate() {
  local sst_name="$1"
  local env_var="$2"
  local flags="${3:-}"
  local value="${!env_var:-}"

  if [ -z "$value" ]; then
    value=$(openssl rand -base64 32)
    echo "  (generated random value for $sst_name)"
  fi

  # shellcheck disable=SC2086
  printf '%s' "$value" | $SST secret set "$sst_name" $flags
  echo "✓ $sst_name"
}

# Set secret to env var value, or to a literal default when the env var is not
# set. Use for default-off feature flags where generating a random value would
# accidentally enable the flag.
set_secret_or_default() {
  local sst_name="$1"
  local env_var="$2"
  local fallback="$3"
  local flags="${4:-}"
  local value="${!env_var:-$fallback}"

  # shellcheck disable=SC2086
  printf '%s' "$value" | $SST secret set "$sst_name" $flags
  echo "✓ $sst_name"
}

echo "=== Fallback secrets ==="
set_secret "DaytonaApiKey"               "DAYTONA_API_KEY"                "--fallback"
set_secret "DaytonaAuth0ClientId"        "DAYTONA_AUTH0_CLIENT_ID"        "--fallback"
set_secret "DaytonaAuth0ClientSecret"    "DAYTONA_AUTH0_CLIENT_SECRET"    "--fallback"
set_secret "GoogleClientId"              "GOOGLE_CLIENT_ID"               "--fallback"
set_secret "GoogleClientSecret"          "GOOGLE_CLIENT_SECRET"           "--fallback"
set_secret_or_generate "AuthSessionSecret"           "AUTH_SESSION_SECRET"              "--fallback"
set_secret_or_generate "BrokerKeySecret"             "BROKER_KEY_SECRET"                "--fallback"
# HMAC shared between cloud-web Worker and the Lambda STS broker. Auto-
# generated when not supplied so local-dev / first-time stage setup
# doesn't require manually rotating a secret. CI / production should
# set BROKER_HMAC_SECRET explicitly via `sst secret set` or the deploy
# workflow env. See infra/sts-broker.ts.
set_secret_or_generate "BrokerHmacSecret"            "BROKER_HMAC_SECRET"               "--fallback"
set_secret_or_generate "CloudAgentSpawnQuotaDefault" "CLOUD_AGENT_SPAWN_QUOTA_DEFAULT"  "--fallback"
set_secret_or_default  "CloudTeamLaunchN1Enabled"    "CLOUD_TEAM_LAUNCH_N1_ENABLED"     "false" "--fallback"
set_secret_or_default  "GithubInstallationCentric"   "INSTALLATION_CENTRIC_GITHUB"      "false" "--fallback"
set_secret_or_default  "SlackConversationRoutingEnabled" "CLOUD_SLACK_CONVERSATION_ROUTING_ENABLED" "disabled" "--fallback"
set_secret_or_generate "CredentialEncryptionKey"     "CREDENTIAL_ENCRYPTION_KEY"        "--fallback"
set_secret_or_generate "RelayJwtSecret"              "RELAY_JWT_SECRET"                 "--fallback"
set_secret_or_generate "RelayfileInternalHmacSecret" "RELAYFILE_INTERNAL_HMAC_SECRET"   "--fallback"
set_secret_or_generate "AgentGatewayInternalSecret"  "AGENT_GATEWAY_INTERNAL_SECRET"    "--fallback"
set_secret_or_generate "RelayauthInternalSecret"     "RELAYAUTH_INTERNAL_SECRET"        "--fallback"

echo ""
echo "=== Per-stage secrets (no fallback — each stage must supply its own value) ==="
# Why no `--fallback`: these are tenant-/account-scoped credentials.
# A staging stage must NOT silently fall through to a production
# value, and production must NOT inherit a sandbox value. Each is
# skipped (not generated) when the env var is missing — the
# corresponding feature degrades, the deploy succeeds, the next
# `set-secrets.sh` run with the env var present wires it up.
#
# History: NangoSecretKey was missing from this list pre-#NEW-PR,
# which is how a missing-binding bug hid every cross-repo cloud
# push-back failure for >24h in production. If you add a new
# `sst.Secret(...)` resource to `infra/secrets.ts` AND link it from
# any function in `infra/*.ts`, add it here too.
set_secret "NangoSecretKey"              "NANGO_SECRET_KEY"
set_secret "HookdeckSigningSecret"       "HOOKDECK_SIGNING_SECRET"
set_secret "RecallApiKey"                "RECALL_API_KEY"
set_secret "RecallWorkspaceVerificationSecret" "RECALL_WORKSPACE_VERIFICATION_SECRET"
set_secret "RecorderTranscribeToken"     "RECORDER_TRANSCRIBE_TOKEN"
set_secret "DropboxAppSecret"            "DROPBOX_APP_SECRET"
set_secret "LinearWebhookSecret"         "LINEAR_WEBHOOK_SECRET"
set_secret "ComposioApiKey"              "COMPOSIO_API_KEY"
set_secret "CredentialProxyJwtSecret"    "CREDENTIAL_PROXY_JWT_SECRET"
set_secret "AgentGatewayInternalSecret"  "AGENT_GATEWAY_INTERNAL_SECRET"
set_secret "RelaycastInternalSecret"     "RELAYCAST_INTERNAL_SECRET"
set_secret "WebRelayauthApiKey"          "WEB_RELAYAUTH_API_KEY"
set_secret "RelayhistoryAssertionRelayauthApiKey" "RELAYHISTORY_ASSERTION_RELAYAUTH_API_KEY"
set_secret "RelaycronApiKey"             "RELAYCRON_API_KEY"
set_secret_or_default "CloudTeamLaunchN1Enabled" "CLOUD_TEAM_LAUNCH_N1_ENABLED" "false"
set_secret_or_default "GithubInstallationCentric" "INSTALLATION_CENTRIC_GITHUB" "false"
set_secret_or_default "SlackConversationRoutingEnabled" "CLOUD_SLACK_CONVERSATION_ROUTING_ENABLED" "disabled"
# Shared R2 API access key pair, used by any service that signs S3-compatible
# URLs against R2 (e.g. relaycast). Single pair on purpose — rotating it
# updates every signing service in lockstep. Use --fallback so stages without
# these features can still deploy.
set_secret "R2AccessKeyId"               "R2_ACCESS_KEY_ID"                "--fallback"
set_secret "R2SecretAccessKey"           "R2_SECRET_ACCESS_KEY"            "--fallback"
set_secret "CatalogingCloudApiToken"     "CATALOGING_CLOUD_API_TOKEN"
set_secret "SageCloudApiToken"           "SAGE_CLOUD_API_TOKEN"
set_secret "SageSupermemoryApiKey"       "SAGE_SUPERMEMORY_API_KEY"
set_secret "HouseAnthropicKey"           "HOUSE_ANTHROPIC_KEY"
set_secret "HouseOpenaiKey"              "HOUSE_OPENAI_KEY"
set_secret "HouseGoogleKey"              "HOUSE_GOOGLE_KEY"
set_secret "HouseOpenrouterKey"          "HOUSE_OPENROUTER_KEY"
set_secret "SpecialistCloudApiToken"     "SPECIALIST_CLOUD_API_TOKEN"
set_secret "SpecialistOpenrouterApiKey"  "SPECIALIST_OPENROUTER_API_KEY"
set_secret "SpecialistRelayauthApiKey"   "SPECIALIST_RELAYAUTH_API_KEY"
set_secret "WebhookConsumersJson"        "WEBHOOK_CONSUMERS_JSON"
set_secret "WebhookMsdBackendToken"      "WEBHOOK_MSD_BACKEND_TOKEN"
set_secret "ProactiveIssueResolverToken" "PROACTIVE_ISSUE_RESOLVER_TOKEN"
set_secret "NightctoEvidenceToken"       "NIGHTCTO_EVIDENCE_TOKEN"
set_secret "DigestFunctionSigningKey"    "DIGEST_FUNCTION_SIGNING_KEY"
# Runtime Neon connection string for the deployed Lambda + Worker + queue/cron
# functions. This is the DML-only *app* role (app_blue/app_green on Neon) so its
# password can be rotated blue/green with no downtime. Migrations run as the
# schema-owning role via NEON_MIGRATIONS_DATABASE_URL and never use this secret
# (see .claude/rules/neon-credential-split.md).
#
# Required on every long-lived stage — there is no fallback. No `--fallback`:
# an empty connection string would attach a non-functional DB binding and 500
# every DB-backed route. (Ephemeral preview stages don't run this script; they
# seed NeonDatabaseUrl from their branch URL via seed-sst-secrets.sh.)
set_secret "NeonDatabaseUrl"             "NEON_APP_DATABASE_URL"

echo ""
echo "Done."

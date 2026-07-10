#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.e2e.yml"

cd "$PROJECT_ROOT"

echo "==> Applying Postgres schema for E2E..."
shopt -s nullglob
migration_files=("$PROJECT_ROOT"/packages/web/drizzle/*.sql)

if [[ "${#migration_files[@]}" -eq 0 ]]; then
  echo "No migration files found under packages/web/drizzle" >&2
  exit 1
fi

for migration_file in "${migration_files[@]}"; do
  cat "$migration_file"
  printf '\n'
done | docker compose -f "$COMPOSE_FILE" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U e2e -d e2e >/dev/null

echo "==> Seeding canonical E2E workspace + Slack integration..."
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U e2e -d e2e <<'SQL'
INSERT INTO organizations (id, slug, name, created_by_user_id, created_at, updated_at)
VALUES (
  'a0000000-0000-4000-8000-000000000000',
  'e2e-org',
  'E2E Organization',
  'a0000000-0000-4000-8000-0000000000aa',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workspaces (id, organization_id, slug, name, created_at, updated_at)
VALUES (
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000000',
  'e2e-workspace',
  'E2E Workspace',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workspace_integrations (
  workspace_id,
  provider,
  connection_id,
  provider_config_key,
  installation_id,
  metadata_json,
  created_at,
  updated_at
)
VALUES (
  'a0000000-0000-4000-8000-000000000001',
  'slack-sage',
  'conn-e2e',
  'slack-sage',
  NULL,
  '{"slackTeamId":"T0E2E000","slackBotUserId":"U-BOT","workspaceName":"E2E Workspace"}',
  NOW(),
  NOW()
)
ON CONFLICT (workspace_id, provider) DO UPDATE
SET
  connection_id = EXCLUDED.connection_id,
  provider_config_key = EXCLUDED.provider_config_key,
  installation_id = EXCLUDED.installation_id,
  metadata_json = EXCLUDED.metadata_json,
  updated_at = NOW();
SQL

echo "==> Seed complete."

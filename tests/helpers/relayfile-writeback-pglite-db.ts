import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../../packages/web/lib/db/schema.ts";

const WORKSPACES_DDL = `
  CREATE TABLE IF NOT EXISTS workspaces (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    default_runtime JSONB,
    relay_workspace_id TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS workspaces_org_slug_unique
    ON workspaces (organization_id, slug);

  CREATE INDEX IF NOT EXISTS idx_workspaces_org
    ON workspaces (organization_id);

  CREATE INDEX IF NOT EXISTS idx_workspaces_relay_workspace_id
    ON workspaces (relay_workspace_id);
`;

const WORKSPACE_INTEGRATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS workspace_integrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    adapter TEXT NOT NULL DEFAULT 'nango',
    name TEXT,
    display_name TEXT,
    created_by_user_id UUID,
    connection_id TEXT NOT NULL,
    provider_config_key TEXT,
    installation_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    writeback_dispatch_via TEXT NOT NULL DEFAULT 'bridge',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT workspace_integrations_writeback_dispatch_via_check
      CHECK (writeback_dispatch_via IN ('bridge', 'cf'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS workspace_integrations_workspace_provider_default_unique
    ON workspace_integrations (workspace_id, provider)
    WHERE name IS NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS workspace_integrations_workspace_provider_name_unique
    ON workspace_integrations (workspace_id, provider, name)
    WHERE name IS NOT NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS workspace_integrations_provider_connection_unique
    ON workspace_integrations (provider, connection_id);
`;

const USER_INTEGRATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS user_integrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    provider TEXT NOT NULL,
    adapter TEXT NOT NULL DEFAULT 'nango',
    name TEXT,
    connection_id TEXT NOT NULL,
    provider_config_key TEXT,
    installation_id TEXT,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS user_integrations_user_provider_default_unique
    ON user_integrations (user_id, provider)
    WHERE name IS NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS user_integrations_user_provider_name_unique
    ON user_integrations (user_id, provider, name)
    WHERE name IS NOT NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS user_integrations_provider_connection_unique
    ON user_integrations (provider, connection_id);
`;

const WORKFLOW_RUNS_DDL = `
  CREATE TABLE IF NOT EXISTS workflow_runs (
    id UUID PRIMARY KEY,
    sandbox_id TEXT,
    dispatch_type TEXT NOT NULL DEFAULT 'sandbox',
    user_id UUID NOT NULL,
    workspace_id UUID NOT NULL,
    relay_workspace_id TEXT,
    workflow TEXT NOT NULL,
    file_type TEXT NOT NULL,
    callback_token TEXT NOT NULL,
    status TEXT NOT NULL,
    relayauth_identity_id TEXT,
    result TEXT,
    error TEXT,
    paths JSONB,
    pushed_to JSONB,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  );
`;

const PERSONA_VERSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS persona_versions (
    id UUID PRIMARY KEY,
    persona_id UUID NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    spec JSONB NOT NULL DEFAULT '{}'::jsonb,
    spec_hash TEXT NOT NULL DEFAULT 'test',
    bundle_sha256 TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

const AGENTS_DDL = `
  CREATE TABLE IF NOT EXISTS agents (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    persona_id UUID NOT NULL,
    deployed_name TEXT NOT NULL,
    image_url TEXT,
    deployed_by_user_id UUID NOT NULL,
    credential_selections JSONB NOT NULL DEFAULT '{}'::jsonb,
    input_values JSONB NOT NULL DEFAULT '{}'::jsonb,
    pinned_version_id UUID REFERENCES persona_versions(id) ON DELETE SET NULL,
    spec_hash_at_deploy TEXT NOT NULL DEFAULT 'test',
    status TEXT NOT NULL DEFAULT 'active',
    destroyed_at TIMESTAMPTZ,
    destroyed_by_user_id UUID,
    spawned_by_agent_id UUID,
    watch_globs TEXT[],
    watch_rules JSONB,
    schedule_ids TEXT[],
    last_used_at TIMESTAMPTZ,
    last_error TEXT,
    executor JSONB NOT NULL DEFAULT '{"kind":"ephemeral-sandbox"}'::jsonb,
    owner_service TEXT,
    source_tag TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_agents_workspace_status
    ON agents (workspace_id, status);
`;

const WORKFLOW_REPOSITORY_ALLOWLISTS_DDL = `
  CREATE TABLE IF NOT EXISTS workflow_repository_allowlists (
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    repo_owner TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    push_allowed BOOLEAN NOT NULL DEFAULT FALSE,
    allowed_at TIMESTAMPTZ NOT NULL,
    allowed_by UUID NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS workflow_repository_allowlists_workspace_repo_unique
    ON workflow_repository_allowlists (workspace_id, repo_owner, repo_name);

  CREATE INDEX IF NOT EXISTS idx_workflow_repository_allowlists_workspace
    ON workflow_repository_allowlists (workspace_id);
`;

const RELAYFILE_WRITEBACK_RECEIPTS_DDL = `
  CREATE TABLE IF NOT EXISTS relayfile_writeback_receipts (
    workspace_id TEXT NOT NULL,
    op_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    outcome TEXT NOT NULL,
    error_code TEXT,
    error_message TEXT,
    metadata JSONB,
    acked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT relayfile_writeback_receipts_pk PRIMARY KEY (workspace_id, op_id),
    CONSTRAINT relayfile_writeback_receipts_outcome_check
      CHECK (outcome IN ('success','permanent_failure'))
  );

  CREATE INDEX IF NOT EXISTS relayfile_writeback_receipts_expires_idx
    ON relayfile_writeback_receipts (expires_at);
`;

const RICKY_WEBHOOK_DEDUP_DDL = `
  CREATE TABLE IF NOT EXISTS ricky_webhook_dedup (
    surface TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
  );

  CREATE INDEX IF NOT EXISTS ricky_webhook_dedup_expires_idx
    ON ricky_webhook_dedup (expires_at);
`;

export type RelayfileWritebackWorkspaceSeed = {
  id: string;
  organizationId?: string;
  slug?: string;
  name?: string;
  createdAt?: Date;
  updatedAt?: Date;
};

export type RelayfileWritebackIntegrationSeed = {
  workspaceId: string;
  provider: string;
  connectionId: string;
  providerConfigKey?: string | null;
  installationId?: string | null;
  metadata?: Record<string, unknown>;
  writebackDispatchVia?: "bridge" | "cf";
  createdAt?: Date;
  updatedAt?: Date;
};

export type RelayfileWritebackUserIntegrationSeed = {
  userId: string;
  provider: string;
  connectionId: string;
  providerConfigKey?: string | null;
  installationId?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
};

export type RelayfileWritebackAllowedRepoSeed = {
  workspaceId: string;
  repoOwner: string;
  repoName: string;
  installationId: string;
  pushAllowed?: boolean;
  allowedAt?: Date;
  allowedBy: string;
};

export type RelayfileWritebackWorkflowRunSeed = {
  id: string;
  userId: string;
  workspaceId: string;
  status?: string;
  callbackToken: string;
  workflow?: string;
  fileType?: string;
  sandboxId?: string | null;
  relayauthIdentityId?: string | null;
  paths?: Array<{
    name: string;
    s3CodeKey: string;
    repoOwner?: string;
    repoName?: string;
    pushBranch?: string;
    pushBase?: string;
    pushPrBody?: string;
  }>;
  createdAt?: Date;
  updatedAt?: Date;
};

export async function createRelayfileWritebackPgliteDb(): Promise<{
  db: ReturnType<typeof drizzle<typeof schema>>;
  installAsAppDb: () => void;
  insertWorkspace: (
    input: RelayfileWritebackWorkspaceSeed,
  ) => Promise<void>;
  insertWorkspaceIntegration: (
    input: RelayfileWritebackIntegrationSeed,
  ) => Promise<void>;
  insertUserIntegration: (
    input: RelayfileWritebackUserIntegrationSeed,
  ) => Promise<void>;
  insertAllowedRepo: (
    input: RelayfileWritebackAllowedRepoSeed,
  ) => Promise<void>;
  insertWorkflowRun: (
    input: RelayfileWritebackWorkflowRunSeed,
  ) => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const client = new PGlite();
  await client.exec(WORKSPACES_DDL);
  await client.exec(WORKSPACE_INTEGRATIONS_DDL);
  await client.exec(USER_INTEGRATIONS_DDL);
  await client.exec(WORKFLOW_REPOSITORY_ALLOWLISTS_DDL);
  await client.exec(WORKFLOW_RUNS_DDL);
  await client.exec(PERSONA_VERSIONS_DDL);
  await client.exec(AGENTS_DDL);
  await client.exec(RELAYFILE_WRITEBACK_RECEIPTS_DDL);
  await client.exec(RICKY_WEBHOOK_DEDUP_DDL);

  const db = drizzle(client, { schema });

  return {
    db,
    installAsAppDb: () => {
      (globalThis as unknown as { __appDbOverride?: unknown }).__appDbOverride = db;
    },
    insertWorkspace: async (input) => {
      const now = input.updatedAt ?? input.createdAt ?? new Date();
      await client.query(
        `
          INSERT INTO workspaces (
            id,
            organization_id,
            slug,
            name,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (id)
          DO UPDATE SET
            organization_id = EXCLUDED.organization_id,
            slug = EXCLUDED.slug,
            name = EXCLUDED.name,
            updated_at = EXCLUDED.updated_at
        `,
        [
          input.id,
          input.organizationId ?? "99999999-9999-4999-8999-999999999999",
          input.slug ?? "test-workspace",
          input.name ?? "Test Workspace",
          (input.createdAt ?? now).toISOString(),
          (input.updatedAt ?? now).toISOString(),
        ],
      );
    },
    insertWorkspaceIntegration: async (input) => {
      const now = input.updatedAt ?? input.createdAt ?? new Date();
      await client.query(
        `
          INSERT INTO workspace_integrations (
            workspace_id,
            provider,
            adapter,
            name,
            display_name,
            created_by_user_id,
            connection_id,
            provider_config_key,
            installation_id,
            metadata_json,
            writeback_dispatch_via,
            created_at,
            updated_at
          )
          VALUES ($1, $2, 'nango', NULL, NULL, NULL, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (workspace_id, provider) WHERE name IS NULL
          DO UPDATE SET
            connection_id = EXCLUDED.connection_id,
            provider_config_key = EXCLUDED.provider_config_key,
            installation_id = EXCLUDED.installation_id,
            metadata_json = EXCLUDED.metadata_json,
            writeback_dispatch_via = EXCLUDED.writeback_dispatch_via,
            updated_at = EXCLUDED.updated_at
        `,
        [
          input.workspaceId,
          input.provider,
          input.connectionId,
          input.providerConfigKey ?? null,
          input.installationId ?? null,
          JSON.stringify(input.metadata ?? {}),
          input.writebackDispatchVia ?? "bridge",
          (input.createdAt ?? now).toISOString(),
          (input.updatedAt ?? now).toISOString(),
        ],
      );
    },
    insertUserIntegration: async (input) => {
      const now = input.updatedAt ?? input.createdAt ?? new Date();
      await client.query(
        `
          INSERT INTO user_integrations (
            user_id,
            provider,
            adapter,
            name,
            connection_id,
            provider_config_key,
            installation_id,
            metadata_json,
            created_at,
            updated_at
          )
          VALUES ($1, $2, 'nango', NULL, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (user_id, provider) WHERE name IS NULL
          DO UPDATE SET
            connection_id = EXCLUDED.connection_id,
            provider_config_key = EXCLUDED.provider_config_key,
            installation_id = EXCLUDED.installation_id,
            metadata_json = EXCLUDED.metadata_json,
            updated_at = EXCLUDED.updated_at
        `,
        [
          input.userId,
          input.provider,
          input.connectionId,
          input.providerConfigKey ?? null,
          input.installationId ?? null,
          JSON.stringify(input.metadata ?? {}),
          (input.createdAt ?? now).toISOString(),
          (input.updatedAt ?? now).toISOString(),
        ],
      );
    },
    insertAllowedRepo: async (input) => {
      const now = input.allowedAt ?? new Date();
      await client.query(
        `
          INSERT INTO workflow_repository_allowlists (
            workspace_id,
            repo_owner,
            repo_name,
            installation_id,
            push_allowed,
            allowed_at,
            allowed_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (workspace_id, repo_owner, repo_name)
          DO UPDATE SET
            installation_id = EXCLUDED.installation_id,
            push_allowed = EXCLUDED.push_allowed,
            allowed_at = EXCLUDED.allowed_at,
            allowed_by = EXCLUDED.allowed_by
        `,
        [
          input.workspaceId,
          input.repoOwner,
          input.repoName,
          input.installationId,
          input.pushAllowed ?? false,
          now.toISOString(),
          input.allowedBy,
        ],
      );
    },
    insertWorkflowRun: async (input) => {
      const now = input.updatedAt ?? input.createdAt ?? new Date();
      await client.query(
        `
          INSERT INTO workflow_runs (
            id,
            sandbox_id,
            dispatch_type,
            user_id,
            workspace_id,
            workflow,
            file_type,
            callback_token,
            status,
            relayauth_identity_id,
            paths,
            created_at,
            updated_at
          )
          VALUES ($1, $2, 'sandbox', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (id)
          DO UPDATE SET
            status = EXCLUDED.status,
            paths = EXCLUDED.paths,
            updated_at = EXCLUDED.updated_at
        `,
        [
          input.id,
          input.sandboxId ?? null,
          input.userId,
          input.workspaceId,
          input.workflow ?? "name: test",
          input.fileType ?? "yaml",
          input.callbackToken,
          input.status ?? "running",
          input.relayauthIdentityId ?? null,
          input.paths ? JSON.stringify(input.paths) : null,
          (input.createdAt ?? now).toISOString(),
          (input.updatedAt ?? now).toISOString(),
        ],
      );
    },
    cleanup: async () => {
      delete (globalThis as typeof globalThis & { __appDbOverride?: unknown }).__appDbOverride;
      await client.close();
    },
  };
}

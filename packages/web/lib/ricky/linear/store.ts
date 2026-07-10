import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";

export const RICKY_LINEAR_PROVIDER = "linear-ricky" as const;

export type RickyLinearUserLink = {
  id: string;
  cloudUserId: string;
  linearOrgId: string;
  linearUserId: string;
  workspaceId: string;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
};

export type RickyLinearInstallation = {
  id: string;
  workspaceId: string;
  linearOrgId: string;
  connectionId: string;
  providerConfigKey: string;
  status: string;
  installedByCloudUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

type RawLinearUserLink = {
  id: string;
  cloud_user_id: string;
  linear_org_id: string;
  linear_user_id: string;
  workspace_id: string;
  created_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
};

type RawLinearInstallation = {
  id: string;
  workspace_id: string;
  linear_org_id: string;
  connection_id: string;
  provider_config_key: string;
  status: string;
  installed_by_cloud_user_id: string;
  created_at: Date;
  updated_at: Date;
};

function rowsOf<T>(result: unknown): T[] {
  const candidate = result as { rows?: T[] };
  return Array.isArray(candidate.rows) ? candidate.rows : [];
}

function mapUserLink(row: RawLinearUserLink): RickyLinearUserLink {
  return {
    id: row.id,
    cloudUserId: row.cloud_user_id,
    linearOrgId: row.linear_org_id,
    linearUserId: row.linear_user_id,
    workspaceId: row.workspace_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  };
}

function mapInstallation(row: RawLinearInstallation): RickyLinearInstallation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    linearOrgId: row.linear_org_id,
    connectionId: row.connection_id,
    providerConfigKey: row.provider_config_key,
    status: row.status,
    installedByCloudUserId: row.installed_by_cloud_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const rickyLinearStore = {
  async findActiveUserLink(input: {
    linearOrgId: string;
    linearUserId: string;
  }): Promise<RickyLinearUserLink | null> {
    const result = await getDb().execute(sql`
      SELECT *
      FROM ricky_linear_user_links
      WHERE linear_org_id = ${input.linearOrgId}
        AND linear_user_id = ${input.linearUserId}
        AND revoked_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 1
    `);
    const row = rowsOf<RawLinearUserLink>(result)[0];
    return row ? mapUserLink(row) : null;
  },

  async upsertUserLink(input: {
    cloudUserId: string;
    linearOrgId: string;
    linearUserId: string;
    workspaceId: string;
  }): Promise<RickyLinearUserLink> {
    const now = new Date();
    const result = await getDb().execute(sql`
      INSERT INTO ricky_linear_user_links (
        id, cloud_user_id, linear_org_id, linear_user_id, workspace_id, created_at, updated_at, revoked_at
      )
      VALUES (
        ${crypto.randomUUID()}, ${input.cloudUserId}, ${input.linearOrgId}, ${input.linearUserId},
        ${input.workspaceId}, ${now}, ${now}, NULL
      )
      ON CONFLICT (linear_org_id, linear_user_id, workspace_id) DO UPDATE
        SET cloud_user_id = EXCLUDED.cloud_user_id,
            revoked_at = NULL,
            updated_at = EXCLUDED.updated_at
      RETURNING *
    `);
    const row = rowsOf<RawLinearUserLink>(result)[0];
    if (!row) throw new Error("Failed to upsert Ricky Linear user link.");
    return mapUserLink(row);
  },

  async findActiveInstallationByWorkspace(workspaceId: string): Promise<RickyLinearInstallation | null> {
    const result = await getDb().execute(sql`
      SELECT *
      FROM ricky_linear_installations
      WHERE workspace_id = ${workspaceId}
        AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT 1
    `);
    const row = rowsOf<RawLinearInstallation>(result)[0];
    return row ? mapInstallation(row) : null;
  },

  async findActiveInstallationByOrg(linearOrgId: string): Promise<RickyLinearInstallation | null> {
    const result = await getDb().execute(sql`
      SELECT *
      FROM ricky_linear_installations
      WHERE linear_org_id = ${linearOrgId}
        AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT 1
    `);
    const row = rowsOf<RawLinearInstallation>(result)[0];
    return row ? mapInstallation(row) : null;
  },

  async upsertInstallation(input: {
    workspaceId: string;
    linearOrgId: string;
    connectionId: string;
    providerConfigKey: string;
    installedByCloudUserId: string;
  }): Promise<RickyLinearInstallation> {
    const now = new Date();
    const result = await getDb().execute(sql`
      INSERT INTO ricky_linear_installations (
        id, workspace_id, linear_org_id, connection_id, provider_config_key,
        status, installed_by_cloud_user_id, created_at, updated_at
      )
      VALUES (
        ${crypto.randomUUID()}, ${input.workspaceId}, ${input.linearOrgId}, ${input.connectionId},
        ${input.providerConfigKey}, 'active', ${input.installedByCloudUserId}, ${now}, ${now}
      )
      ON CONFLICT (workspace_id) DO UPDATE
        SET linear_org_id = EXCLUDED.linear_org_id,
            connection_id = EXCLUDED.connection_id,
            provider_config_key = EXCLUDED.provider_config_key,
            status = 'active',
            installed_by_cloud_user_id = EXCLUDED.installed_by_cloud_user_id,
            updated_at = EXCLUDED.updated_at
      RETURNING *
    `);
    const row = rowsOf<RawLinearInstallation>(result)[0];
    if (!row) throw new Error("Failed to upsert Ricky Linear installation.");
    return mapInstallation(row);
  },

  async getWorkspaceDefaultRepositoryId(workspaceId: string): Promise<string | null> {
    const result = await getDb().execute(sql`
      SELECT default_repository_id
      FROM workspaces
      WHERE id = ${workspaceId}
      LIMIT 1
    `);
    const row = rowsOf<{ default_repository_id: string | null }>(result)[0];
    return row?.default_repository_id ?? null;
  },
};

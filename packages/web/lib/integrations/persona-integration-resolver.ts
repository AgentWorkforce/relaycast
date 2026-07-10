import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  getIntegrationBackend,
  type BackendConnection,
  type ProviderBackend,
} from "@/lib/integrations/backend";
import {
  getBackendIntegrationId,
  isWorkspaceIntegrationProvider,
} from "@/lib/integrations/providers";
import {
  normalizePersonaIntegrationSource,
  type PersonaIntegrationConfigWithSource,
  type PersonaIntegrationSource,
} from "./persona-integration-config";

export { normalizePersonaIntegrationSource };
export type {
  PersonaIntegrationConfigWithSource,
  PersonaIntegrationSource,
};

export type IntegrationAdapter = "nango" | "composio" | "pipedream";

export type IntegrationRow = {
  id: string | null;
  provider: string;
  name: string | null;
  connectionId: string;
  providerConfigKey: string | null;
  installationId: string | null;
  metadata: Record<string, unknown>;
  adapter: IntegrationAdapter | string;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type UserIntegrationRow = IntegrationRow & {
  userId: string;
};

export type WorkspaceIntegrationRow = IntegrationRow & {
  workspaceId: string;
};

export type ResolvedPersonaIntegration =
  | {
    provider: string;
    source: { kind: "deployer_user" };
    adapter: IntegrationAdapter | string;
    user_oauth: UserIntegrationRow;
    backendConnection: BackendConnection | null;
  }
  | {
    provider: string;
    source: { kind: "workspace" };
    adapter: IntegrationAdapter | string;
    workspace_integration: WorkspaceIntegrationRow;
    backendConnection: BackendConnection | null;
  }
  | {
    provider: string;
    source: { kind: "workspace_service_account"; name: string };
    adapter: IntegrationAdapter | string;
    workspace_service_account: WorkspaceIntegrationRow;
    backendConnection: BackendConnection | null;
  }
  | {
    provider: "github";
    source: { kind: "deployer_user" };
    adapter: IntegrationAdapter | string;
    user_oauth: UserIntegrationRow;
    workspace_install: WorkspaceIntegrationRow;
    backendConnections: {
      user_oauth: BackendConnection | null;
      workspace_install: BackendConnection | null;
    };
  };

export type ResolvePersonaIntegrationsInput = {
  workspaceId: string;
  deployerUserId: string;
  integrations: Record<string, PersonaIntegrationConfigWithSource | null | undefined>;
  deps?: PersonaIntegrationResolverDeps;
};

export type SerializedBackendConnection = {
    backend: BackendConnection["backend"];
    connectionId: string;
    backendIntegrationId?: string;
    provider?: string;
    status?: BackendConnection["status"];
};

export type SerializedPersonaIntegration = {
  provider: string;
  source: PersonaIntegrationSource;
  adapter: IntegrationAdapter | string;
  backendConnection?: SerializedBackendConnection | null;
  backendConnections?: {
    user_oauth: SerializedBackendConnection | null;
    workspace_install: SerializedBackendConnection | null;
  };
  user_oauth?: Pick<UserIntegrationRow, "provider" | "name" | "connectionId" | "providerConfigKey">;
  workspace_integration?: Pick<WorkspaceIntegrationRow, "provider" | "name" | "connectionId" | "providerConfigKey" | "installationId">;
  workspace_service_account?: Pick<WorkspaceIntegrationRow, "provider" | "name" | "connectionId" | "providerConfigKey" | "installationId">;
  workspace_install?: Pick<WorkspaceIntegrationRow, "provider" | "name" | "connectionId" | "providerConfigKey" | "installationId">;
};

export type PersonaIntegrationResolverDeps = {
  findUserIntegration?: (input: {
    userId: string;
    provider: string;
    name: string | null;
  }) => Promise<UserIntegrationRow | null>;
  findWorkspaceIntegration?: (input: {
    workspaceId: string;
    provider: string;
    name: string | null;
  }) => Promise<WorkspaceIntegrationRow | null>;
  getIntegrationBackend?: (adapter: "nango" | "composio") => Pick<ProviderBackend, "getConnection">;
};

type QueryableDb = {
  execute(query: SQL): Promise<unknown>;
};

type RawIntegrationRow = {
  id?: unknown;
  oid?: unknown;
  user_id?: unknown;
  workspace_id?: unknown;
  provider?: unknown;
  name?: unknown;
  connection_id?: unknown;
  provider_config_key?: unknown;
  installation_id?: unknown;
  metadata_json?: unknown;
  metadata?: unknown;
  adapter?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function normalizeAdapter(value: unknown): IntegrationAdapter | string {
  return nonEmptyString(value)?.toLowerCase() ?? "nango";
}

function readRows(result: unknown): RawIntegrationRow[] {
  if (Array.isArray(result)) {
    return result.filter(isRecord);
  }
  if (isRecord(result) && Array.isArray(result.rows)) {
    return result.rows.filter(isRecord);
  }
  return [];
}

function mapBaseRow(row: RawIntegrationRow): IntegrationRow | null {
  const provider = nonEmptyString(row.provider);
  const connectionId = nonEmptyString(row.connection_id);
  if (!provider || !connectionId) {
    return null;
  }
  return {
    id: nonEmptyString(row.id),
    provider,
    name: nonEmptyString(row.name),
    connectionId,
    providerConfigKey: nonEmptyString(row.provider_config_key),
    installationId: nonEmptyString(row.installation_id),
    metadata: parseMetadata(row.metadata_json ?? row.metadata),
    adapter: normalizeAdapter(row.adapter),
    createdAt: parseDate(row.created_at),
    updatedAt: parseDate(row.updated_at),
  };
}

function mapUserRow(row: RawIntegrationRow): UserIntegrationRow | null {
  const base = mapBaseRow(row);
  const userId = nonEmptyString(row.user_id);
  return base && userId ? { ...base, userId } : null;
}

function mapWorkspaceRow(row: RawIntegrationRow): WorkspaceIntegrationRow | null {
  const base = mapBaseRow(row);
  const workspaceId = nonEmptyString(row.workspace_id);
  return base && workspaceId ? { ...base, workspaceId } : null;
}

async function queryFirst(query: SQL): Promise<RawIntegrationRow | null> {
  const db = getDb() as unknown as QueryableDb;
  const rows = readRows(await db.execute(query));
  return rows[0] ?? null;
}

async function relationExists(relationName: string): Promise<boolean> {
  const raw = await queryFirst(sql`SELECT to_regclass(${relationName}) AS oid`);
  return raw?.oid !== null && raw?.oid !== undefined;
}

async function findUserIntegration(input: {
  userId: string;
  provider: string;
  name: string | null;
}): Promise<UserIntegrationRow | null> {
  if (!await relationExists("user_integrations")) {
    return null;
  }

  const raw = await queryFirst(
    sql`
        SELECT
          to_jsonb(user_integrations)->>'id' AS id,
          user_id,
          provider,
          to_jsonb(user_integrations)->>'name' AS name,
          connection_id,
          provider_config_key,
          installation_id,
          metadata_json,
          COALESCE(to_jsonb(user_integrations)->>'adapter', 'nango') AS adapter,
          created_at,
          updated_at
        FROM user_integrations
        WHERE user_id = ${input.userId}
          AND provider = ${input.provider}
          AND (
            (${input.name}::text IS NULL AND to_jsonb(user_integrations)->>'name' IS NULL)
            OR (${input.name}::text IS NOT NULL AND to_jsonb(user_integrations)->>'name' = ${input.name})
          )
        LIMIT 1
      `,
  );
  return raw ? mapUserRow(raw) : null;
}

async function findWorkspaceIntegration(input: {
  workspaceId: string;
  provider: string;
  name: string | null;
}): Promise<WorkspaceIntegrationRow | null> {
  const raw = await queryFirst(
    sql`
        SELECT
          to_jsonb(workspace_integrations)->>'id' AS id,
          workspace_id,
          provider,
          to_jsonb(workspace_integrations)->>'name' AS name,
          connection_id,
          provider_config_key,
          installation_id,
          metadata_json,
          COALESCE(to_jsonb(workspace_integrations)->>'adapter', 'nango') AS adapter,
          created_at,
          updated_at
        FROM workspace_integrations
        WHERE workspace_id = ${input.workspaceId}
          AND provider = ${input.provider}
          AND (
            (${input.name}::text IS NULL AND to_jsonb(workspace_integrations)->>'name' IS NULL)
            OR (${input.name}::text IS NOT NULL AND to_jsonb(workspace_integrations)->>'name' = ${input.name})
          )
        LIMIT 1
      `,
  );
  return raw ? mapWorkspaceRow(raw) : null;
}

function assertAdapterWired(adapter: IntegrationAdapter | string): asserts adapter is "nango" | "composio" {
  if (adapter === "nango" || adapter === "composio") {
    return;
  }
  throw new Error(`Adapter '${adapter}' not yet wired`);
}

function backendIntegrationIdFor(row: IntegrationRow, adapter: "nango" | "composio"): string | undefined {
  if (row.providerConfigKey) {
    return row.providerConfigKey;
  }
  if (isWorkspaceIntegrationProvider(row.provider)) {
    return getBackendIntegrationId(row.provider, adapter) ?? undefined;
  }
  return undefined;
}

async function resolveBackendConnection(
  row: IntegrationRow,
  deps: PersonaIntegrationResolverDeps,
): Promise<BackendConnection | null> {
  const adapter = normalizeAdapter(row.adapter);
  assertAdapterWired(adapter);
  const backend = deps.getIntegrationBackend?.(adapter) ?? getIntegrationBackend(adapter);
  return backend.getConnection?.({
    connectionId: row.connectionId,
    backendIntegrationId: backendIntegrationIdFor(row, adapter),
    provider: row.provider,
  }) ?? null;
}

async function getRequiredUserIntegration(
  input: ResolvePersonaIntegrationsInput,
  provider: string,
): Promise<UserIntegrationRow> {
  const row = await (
    input.deps?.findUserIntegration ?? findUserIntegration
  )({
    userId: input.deployerUserId,
    provider,
    name: null,
  });
  if (!row) {
    throw new Error(
      `Integration '${provider}' requires deployer user credentials for user '${input.deployerUserId}'.`,
    );
  }
  return row;
}

async function getRequiredWorkspaceIntegration(
  input: ResolvePersonaIntegrationsInput,
  provider: string,
  name: string | null,
): Promise<WorkspaceIntegrationRow> {
  const row = await (
    input.deps?.findWorkspaceIntegration ?? findWorkspaceIntegration
  )({
    workspaceId: input.workspaceId,
    provider,
    name,
  });
  if (!row) {
    if (name) {
      throw new Error(
        `Integration '${provider}' requires workspace service account '${name}' in workspace '${input.workspaceId}'.`,
      );
    }
    throw new Error(
      `Integration '${provider}' requires a workspace integration in workspace '${input.workspaceId}'.`,
    );
  }
  return row;
}

async function resolveProviderIntegration(
  input: ResolvePersonaIntegrationsInput,
  provider: string,
  config: PersonaIntegrationConfigWithSource | null | undefined,
): Promise<ResolvedPersonaIntegration> {
  const source = normalizePersonaIntegrationSource(config);
  const deps = input.deps ?? {};

  if (source.kind === "deployer_user") {
    const userOauth = await getRequiredUserIntegration(input, provider);
    if (provider === "github") {
      const workspaceInstall = await (
        input.deps?.findWorkspaceIntegration ?? findWorkspaceIntegration
      )({
        workspaceId: input.workspaceId,
        provider,
        name: null,
      });
      if (!workspaceInstall?.installationId) {
        throw new Error(
          "GitHub deploys require both a user OAuth and a workspace GitHub App install. Workspace install missing.",
        );
      }
      return {
        provider: "github",
        source,
        adapter: userOauth.adapter,
        user_oauth: userOauth,
        workspace_install: workspaceInstall,
        backendConnections: {
          user_oauth: await resolveBackendConnection(userOauth, deps),
          workspace_install: await resolveBackendConnection(workspaceInstall, deps),
        },
      };
    }
    return {
      provider,
      source,
      adapter: userOauth.adapter,
      user_oauth: userOauth,
      backendConnection: await resolveBackendConnection(userOauth, deps),
    };
  }

  if (source.kind === "workspace") {
    const workspaceIntegration = await getRequiredWorkspaceIntegration(input, provider, null);
    return {
      provider,
      source,
      adapter: workspaceIntegration.adapter,
      workspace_integration: workspaceIntegration,
      backendConnection: await resolveBackendConnection(workspaceIntegration, deps),
    };
  }

  const workspaceServiceAccount = await getRequiredWorkspaceIntegration(
    input,
    provider,
    source.name,
  );
  return {
    provider,
    source,
    adapter: workspaceServiceAccount.adapter,
    workspace_service_account: workspaceServiceAccount,
    backendConnection: await resolveBackendConnection(workspaceServiceAccount, deps),
  };
}

export async function resolvePersonaIntegrations(
  input: ResolvePersonaIntegrationsInput,
): Promise<Record<string, ResolvedPersonaIntegration>> {
  const resolved: Record<string, ResolvedPersonaIntegration> = {};
  for (const [provider, config] of Object.entries(input.integrations)) {
    if (!provider.trim()) {
      continue;
    }
    resolved[provider] = await resolveProviderIntegration(input, provider.trim(), config);
  }
  return resolved;
}

function serializeBackendConnection(
  connection: BackendConnection | null,
): SerializedBackendConnection | null {
  if (!connection) {
    return null;
  }
  return {
    backend: connection.backend,
    connectionId: connection.connectionId,
    ...(connection.backendIntegrationId ? { backendIntegrationId: connection.backendIntegrationId } : {}),
    ...(connection.provider ? { provider: connection.provider } : {}),
    ...(connection.status ? { status: connection.status } : {}),
  };
}

function serializeUserIntegration(
  row: UserIntegrationRow,
): NonNullable<SerializedPersonaIntegration["user_oauth"]> {
  return {
    provider: row.provider,
    name: row.name,
    connectionId: row.connectionId,
    providerConfigKey: row.providerConfigKey,
  };
}

function serializeWorkspaceIntegration(
  row: WorkspaceIntegrationRow,
): NonNullable<SerializedPersonaIntegration["workspace_integration"]> {
  return {
    provider: row.provider,
    name: row.name,
    connectionId: row.connectionId,
    providerConfigKey: row.providerConfigKey,
    installationId: row.installationId,
  };
}

export function serializeResolvedPersonaIntegrations(
  resolved: Record<string, ResolvedPersonaIntegration>,
): Record<string, SerializedPersonaIntegration> {
  const serialized: Record<string, SerializedPersonaIntegration> = {};
  for (const [provider, integration] of Object.entries(resolved)) {
    if ("backendConnections" in integration) {
      serialized[provider] = {
        provider: integration.provider,
        source: integration.source,
        adapter: integration.adapter,
        user_oauth: serializeUserIntegration(integration.user_oauth),
        workspace_install: serializeWorkspaceIntegration(integration.workspace_install),
        backendConnections: {
          user_oauth: serializeBackendConnection(integration.backendConnections.user_oauth),
          workspace_install: serializeBackendConnection(integration.backendConnections.workspace_install),
        },
      };
      continue;
    }

    const base = {
      provider: integration.provider,
      source: integration.source,
      adapter: integration.adapter,
      backendConnection: serializeBackendConnection(integration.backendConnection),
    };

    if ("user_oauth" in integration) {
      serialized[provider] = {
        ...base,
        user_oauth: serializeUserIntegration(integration.user_oauth),
      };
    } else if ("workspace_integration" in integration) {
      serialized[provider] = {
        ...base,
        workspace_integration: serializeWorkspaceIntegration(integration.workspace_integration),
      };
    } else {
      serialized[provider] = {
        ...base,
        workspace_service_account: serializeWorkspaceIntegration(integration.workspace_service_account),
      };
    }
  }
  return serialized;
}

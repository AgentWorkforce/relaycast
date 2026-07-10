import { Readable } from "node:stream";
import { and, desc, eq, like } from "drizzle-orm";
import { Nango } from "@nangohq/node";
import { RelayFileApiError, RelayFileClient } from "@relayfile/sdk";
import { Resource } from "sst";
import { mintRelayfileToken } from "../relayfile/client.js";
import {
  githubCloneJobs,
  workspaceIntegrations,
  workspaces,
} from "../db/schema.js";
import type {
  GithubCloneExecutionDeps,
  GithubCloneExecutionResult,
} from "./github-clone-executor.js";
import type { GithubCloneJobRequest } from "./github-clone-job.js";
import { chunkedBulkWrite } from "./github-clone-writer.js";
import {
  GITHUB_CLONE_MAX_FILE_BYTES,
  walkGithubTarball,
} from "./github-tarball-walker.js";
import {
  compareGithubRefs,
  type CompareChangedFile,
  type CompareNangoClient,
  type CompareResult,
} from "./github-clone-compare.js";
import {
  importGithubTarballByRelayfileFetch,
  importGithubTarballToRelayfile,
  startGithubTarballFetchImport,
} from "./github-clone-tar-importer.js";
import {
  GithubCloneStageError,
  toGithubCloneStageError,
} from "./github-clone-stage-error.js";

const DEFAULT_NANGO_HOST = "https://api.nango.dev";
const DEFAULT_RELAYFILE_URL = "https://api.relayfile.dev";
const DEFAULT_RELAYAUTH_URL = "https://api.relayauth.dev";
const DEFAULT_GITHUB_PROVIDER_CONFIG_KEY = "github-relay";
const GITHUB_CLONE_MAX_BUFFERED_BYTES = 200 * 1024 * 1024;
const GITHUB_CLONE_RELAYFILE_WRITE_CONCURRENCY = 1;
const GITHUB_CLONE_SOURCE = "github-tarball-via-nango";
const GITHUB_REPOS_INDEX_PATH = "/github/repos/index.json";
const WORKSPACE_INTEGRATIONS_PROVIDER_CONNECTION_UNIQUE =
  "workspace_integrations_provider_connection_unique";

type CloneSkipReason = "binary" | "too-large" | "ignored";

type CloneIndexEntry = {
  owner: string;
  repo: string;
  defaultBranch?: string;
  headSha?: string;
  clonedAt?: string;
};

type RelayCloneFile = {
  path: string;
  content: string;
  contentType?: string;
  encoding: "utf-8" | "base64";
};

type NangoProxyClient = {
  proxy<T = unknown>(
    config: Record<string, unknown>,
  ): Promise<{
    status: number;
    headers: unknown;
    data: T;
  }>;
  // Nango SDK getToken signature: (providerConfigKey, connectionId,
  // forceRefresh, refreshGithubAppJwtToken). For GitHub App connections
  // pass refreshGithubAppJwtToken=true to get a fresh installation token.
  getToken(
    providerConfigKey: string,
    connectionId: string,
    forceRefresh?: boolean,
    refreshGithubAppJwtToken?: boolean,
  ): Promise<string | { access_token?: string; token?: string }>;
  listConnections?(params: {
    integrationId?: string | string[];
    limit?: number;
    tags?: Record<string, string>;
  }): Promise<{ connections?: unknown[] }>;
};

type DrizzleDb = {
  select: (...args: unknown[]) => {
    from: (table: unknown) => {
      where: (condition: unknown) => {
        orderBy: (...args: unknown[]) => {
          limit: (count: number) => Promise<
            Array<{
              connectionId?: string;
              provider?: string | null;
              providerConfigKey?: string | null;
              relayWorkspaceId?: string | null;
            }>
          >;
        };
        limit: (count: number) => Promise<
          Array<{
            connectionId?: string;
            provider?: string | null;
            providerConfigKey?: string | null;
            relayWorkspaceId?: string | null;
          }>
        >;
      };
      orderBy: (...args: unknown[]) => {
        limit: (count: number) => Promise<
          Array<{
            connectionId?: string;
            provider?: string | null;
            providerConfigKey?: string | null;
            relayWorkspaceId?: string | null;
          }>
        >;
      };
    };
  };
  update?: (table: unknown) => {
    set: (values: unknown) => {
      where: (condition: unknown) =>
        | {
            returning?: (columns?: unknown) => Promise<
              Array<{
                connectionId?: string;
                provider?: string | null;
                providerConfigKey?: string | null;
              }>
            >;
          }
        | Promise<unknown>;
    };
  };
};

type WorkerResourceMap = {
  NangoSecretKey?: { value?: string };
  WebRelayauthApiKey?: { value?: string };
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function readEnv(deps: GithubCloneExecutionDeps, name: string): string | null {
  const value = deps.env?.[name]?.trim();
  return value || null;
}

function readResourceValue(name: keyof WorkerResourceMap): string | null {
  try {
    const resources = Resource as unknown as WorkerResourceMap;
    const value = resources[name]?.value?.trim();
    return value || null;
  } catch {
    return null;
  }
}

function requireConfig(value: string | null, name: string): string {
  if (!value) {
    throw new Error(`${name} is not configured.`);
  }
  return value;
}

function createNangoClient(deps: GithubCloneExecutionDeps): NangoProxyClient {
  const secretKey = requireConfig(
    readEnv(deps, "NANGO_SECRET_KEY") ?? readResourceValue("NangoSecretKey"),
    "NANGO_SECRET_KEY",
  );
  const host = trimTrailingSlash(
    readEnv(deps, "NANGO_HOST") ??
      readEnv(deps, "NANGO_BASE_URL") ??
      DEFAULT_NANGO_HOST,
  );

  return new Nango({ secretKey, host }) as NangoProxyClient;
}

function createRelayfileClient(
  deps: GithubCloneExecutionDeps,
  workspaceId: string,
): RelayFileClient {
  return new RelayFileClient({
    baseUrl: relayfileBaseUrl(deps),
    readCache: {},
    token: () => mintGithubCloneRelayfileToken(deps, workspaceId),
  });
}

function relayfileBaseUrl(deps: GithubCloneExecutionDeps): string {
  return readEnv(deps, "RELAYFILE_URL") ?? DEFAULT_RELAYFILE_URL;
}

function mintGithubCloneRelayfileToken(
  deps: GithubCloneExecutionDeps,
  workspaceId: string,
): Promise<string> {
  const relayAuthApiKey = requireConfig(
    readEnv(deps, "WEB_RELAYAUTH_API_KEY") ??
      readEnv(deps, "NANGO_SYNC_RELAYAUTH_API_KEY") ??
      readResourceValue("WebRelayauthApiKey"),
    "WEB_RELAYAUTH_API_KEY",
  );

  const relayAuthUrl =
    readEnv(deps, "WEB_RELAYAUTH_URL") ??
    readEnv(deps, "RELAYAUTH_URL") ??
    readEnv(deps, "NANGO_SYNC_RELAYAUTH_URL") ??
    DEFAULT_RELAYAUTH_URL;

  return mintRelayfileToken({
    workspaceId,
    relayAuthUrl,
    relayAuthApiKey,
    agentName: "github-clone-worker",
    scopes: ["fs:read", "fs:write", "sync:read", "sync:trigger", "admin:acl"],
  });
}

type GithubCloneIntegration = {
  connectionId: string;
  providerConfigKey: string;
  provider?: string | null;
};

type GithubCloneConnectionPersistenceResult =
  | { status: "persisted"; connection: GithubCloneIntegration }
  | { status: "raced"; connection: GithubCloneIntegration }
  | {
      status: "transient";
      connection: GithubCloneIntegration;
      persistError: string;
    };

type HealedGithubConnectionPersistStatus =
  | { status: "persisted" }
  | { status: "not-persisted" }
  | { status: "failed"; error: unknown };

type GithubCloneIntegrationRow = {
  connectionId?: string;
  provider?: string | null;
  providerConfigKey?: string | null;
};

export type NangoConnectionCandidate = {
  connectionId: string;
  providerConfigKey: string;
  createdAt: string | null;
  updatedAt: string | null;
  raw: unknown;
};

function resolveGithubProviderConfigKey(row: {
  provider?: string | null;
  providerConfigKey?: string | null;
}): string {
  const configured = row.providerConfigKey?.trim();
  if (configured) return configured;
  const provider = row.provider?.trim();
  if (provider && provider !== "github") return provider;
  return DEFAULT_GITHUB_PROVIDER_CONFIG_KEY;
}

function formatCloneIntegrationFailure(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return String(error);
}

function isWorkspaceIntegrationConnectionUniqueViolation(
  error: unknown,
): boolean {
  if (!isRecord(error)) return false;
  const constraint = readString(error.constraint);
  const message =
    typeof error.message === "string" ? error.message.toLowerCase() : "";
  if (
    constraint === WORKSPACE_INTEGRATIONS_PROVIDER_CONNECTION_UNIQUE ||
    message.includes(WORKSPACE_INTEGRATIONS_PROVIDER_CONNECTION_UNIQUE)
  ) {
    return true;
  }
  return isWorkspaceIntegrationConnectionUniqueViolation(error.cause);
}

async function probeGithubCloneIntegration(input: {
  client: NangoProxyClient;
  candidate: GithubCloneIntegration;
  owner: string;
  repo: string;
}): Promise<void> {
  await proxyJson(input.client, {
    connectionId: input.candidate.connectionId,
    providerConfigKey: input.candidate.providerConfigKey,
    method: "GET",
    endpoint: getRepoEndpoint(input.owner, input.repo),
  });
}

function lowerErrorText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value.toLowerCase();
  if (isRecord(value)) {
    return [
      readString(value.code),
      readString(value.error),
      readString(value.message),
      readString(value.detail),
      lowerErrorText(value.data),
      lowerErrorText(value.error),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }
  return String(value).toLowerCase();
}

// Exported for reuse by the cloud-agent box-warm git clone credential path
// (packages/web .../github-clone-token.ts), which must recognize the same
// Nango missing/stale-connection 400|404 signal this module's clone worker
// already auto-heals (PRs #1433/#1435/#1437). Importing keeps the contract
// single-sourced instead of forking the classifier.
export function isMissingNangoConnectionError(error: unknown): boolean {
  const status =
    error instanceof GithubCloneStageError && typeof error.status === "number"
      ? error.status
      : isRecord(error) && typeof error.status === "number"
        ? error.status
        : (axiosErrorResponse(error)?.status ?? null);
  if (status !== 400 && status !== 404) {
    return false;
  }

  const details = [
    error instanceof Error ? error.message : null,
    isRecord(error) ? error.data : null,
    axiosErrorResponse(error)?.data,
  ]
    .map(lowerErrorText)
    .join(" ");

  return (
    details.includes("failed to get connection") ||
    details.includes("failed to find connection") ||
    details.includes("unknown_connection") ||
    details.includes("connection not found") ||
    details.includes("not_found")
  );
}

function sortStoredGithubRows(
  rows: GithubCloneIntegrationRow[],
  requestedConnectionId: string,
): GithubCloneIntegration[] {
  return rows
    .filter(
      (row) =>
        typeof row.connectionId === "string" &&
        row.connectionId.trim().length > 0,
    )
    .map((row) => ({
      connectionId: (row.connectionId as string).trim(),
      providerConfigKey: resolveGithubProviderConfigKey(row),
      provider: row.provider,
    }))
    .sort((left, right) => {
      if (left.connectionId === requestedConnectionId) return -1;
      if (right.connectionId === requestedConnectionId) return 1;
      return 0;
    });
}

function readNestedRecord(
  value: unknown,
  key: string,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const nested = value[key];
  return isRecord(nested) ? nested : null;
}

function collectConnectionWorkspaceIds(value: unknown): string[] {
  const connection = isRecord(value) ? value : {};
  const endUser =
    readNestedRecord(connection, "end_user") ??
    readNestedRecord(connection, "endUser");
  const tags = readNestedRecord(connection, "tags");
  const endUserTags = readNestedRecord(endUser, "tags");
  const keys = ["workspaceId", "workspace_id", "end_user_id", "endUserId"];
  const candidates = [
    readString(endUser?.id),
    readString(endUser?.endUserId),
    readString(endUser?.end_user_id),
    ...keys.flatMap((key) => [
      readString(tags?.[key]),
      readString(endUserTags?.[key]),
    ]),
  ];

  return Array.from(
    new Set(
      candidates
        .map((candidate) => candidate?.trim())
        .filter((candidate): candidate is string => Boolean(candidate)),
    ),
  );
}

function connectionMatchesRelayWorkspace(
  connection: unknown,
  relayfileWorkspaceId: string,
): boolean {
  const expected = relayfileWorkspaceId.trim();
  if (!expected) return false;
  return collectConnectionWorkspaceIds(connection).some(
    (candidate) => candidate === expected,
  );
}

function normalizeNangoConnection(
  value: unknown,
): NangoConnectionCandidate | null {
  if (!isRecord(value)) return null;
  const connectionId =
    readString(value.connection_id) ?? readString(value.connectionId);
  const providerConfigKey =
    readString(value.provider_config_key) ??
    readString(value.providerConfigKey) ??
    readString(value.integration_id) ??
    readString(value.integrationId);
  if (!connectionId || !providerConfigKey) {
    return null;
  }
  return {
    connectionId,
    providerConfigKey,
    createdAt:
      readString(value.created_at) ??
      readString(value.created) ??
      readString(value.createdAt),
    updatedAt: readString(value.updated_at) ?? readString(value.updatedAt),
    raw: value,
  };
}

function connectionTimestamp(
  candidate: NangoConnectionCandidate,
): number | null {
  const value = candidate.updatedAt ?? candidate.createdAt;
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function listSameTenantGithubConnections(input: {
  client: NangoProxyClient;
  providerConfigKey: string;
  relayfileWorkspaceId: string;
}): Promise<NangoConnectionCandidate[]> {
  if (!input.client.listConnections) {
    throw new Error(
      "Nango listConnections is required to heal a stale GitHub clone connection.",
    );
  }

  const response = await input.client.listConnections({
    integrationId: input.providerConfigKey,
    limit: 100,
  });
  const connections = Array.isArray(response.connections)
    ? response.connections
    : [];
  return connections
    .filter((connection) =>
      connectionMatchesRelayWorkspace(connection, input.relayfileWorkspaceId),
    )
    .map(normalizeNangoConnection)
    .filter((connection): connection is NangoConnectionCandidate =>
      Boolean(connection),
    );
}

// Exported for reuse by the box-warm git clone credential path. Re-resolves
// the LIVE Nango connection for a tenant by listing same-tenant GitHub
// connections and probing each for repo access — the durable answer to a
// stored connectionId that re-stales per fire. Single-sourced here so the
// box-warm path does not fork the production auto-heal.
export async function selectRepoCapableConnection(input: {
  client: NangoProxyClient;
  providerConfigKey: string;
  relayfileWorkspaceId: string;
  owner: string;
  repo: string;
}): Promise<NangoConnectionCandidate> {
  const candidates = await listSameTenantGithubConnections({
    client: input.client,
    providerConfigKey: input.providerConfigKey,
    relayfileWorkspaceId: input.relayfileWorkspaceId,
  });

  const usable: NangoConnectionCandidate[] = [];
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      await probeGithubCloneIntegration({
        client: input.client,
        candidate,
        owner: input.owner,
        repo: input.repo,
      });
      usable.push(candidate);
    } catch (error) {
      failures.push(
        `${candidate.providerConfigKey}/${candidate.connectionId}: ${formatCloneIntegrationFailure(error)}`,
      );
    }
  }

  if (usable.length === 1) {
    return usable[0] as NangoConnectionCandidate;
  }
  if (usable.length > 1) {
    const ranked = usable
      .map((candidate) => ({
        candidate,
        timestamp: connectionTimestamp(candidate),
      }))
      .filter(
        (
          entry,
        ): entry is {
          candidate: NangoConnectionCandidate;
          timestamp: number;
        } => entry.timestamp !== null,
      )
      .sort((left, right) => right.timestamp - left.timestamp);
    if (
      ranked.length === usable.length &&
      ranked[0]?.timestamp !== ranked[1]?.timestamp
    ) {
      return ranked[0].candidate;
    }
    throw new Error(
      `Multiple same-tenant GitHub connections can read ${input.owner}/${input.repo}; refusing to guess for relay workspace ${input.relayfileWorkspaceId}.`,
    );
  }

  throw new Error(
    `No same-tenant GitHub connection for relay workspace ${input.relayfileWorkspaceId} can read ${input.owner}/${input.repo}.${
      failures.length > 0 ? ` Tried: ${failures.slice(0, 3).join("; ")}` : ""
    }`,
  );
}

async function persistHealedGithubConnection(input: {
  db: DrizzleDb;
  workspaceId: string;
  staleConnectionId: string;
  selected: NangoConnectionCandidate;
  stored: GithubCloneIntegration;
}): Promise<HealedGithubConnectionPersistStatus> {
  if (!input.db.update) {
    return { status: "not-persisted" };
  }
  const now = new Date();
  const updateResult = input.db
    .update(workspaceIntegrations)
    .set({
      connectionId: input.selected.connectionId,
      providerConfigKey: input.selected.providerConfigKey,
      updatedAt: now,
    })
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, input.workspaceId),
        eq(workspaceIntegrations.provider, input.stored.provider ?? "github"),
        eq(workspaceIntegrations.connectionId, input.staleConnectionId),
      ),
    );
  if (
    updateResult &&
    typeof updateResult === "object" &&
    "returning" in updateResult
  ) {
    const rows = await updateResult.returning?.({
      connectionId: workspaceIntegrations.connectionId,
      providerConfigKey: workspaceIntegrations.providerConfigKey,
    });
    return Array.isArray(rows) && rows.length > 0
      ? { status: "persisted" }
      : { status: "not-persisted" };
  } else {
    await updateResult;
    return { status: "persisted" };
  }
}

async function currentStoredGithubConnection(input: {
  db: DrizzleDb;
  workspaceId: string;
  requestedConnectionId: string;
}): Promise<GithubCloneIntegration | null> {
  const rows = await input.db
    .select({
      connectionId: workspaceIntegrations.connectionId,
      provider: workspaceIntegrations.provider,
      providerConfigKey: workspaceIntegrations.providerConfigKey,
    })
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, input.workspaceId),
        like(workspaceIntegrations.provider, "github%"),
      ),
    )
    .orderBy(desc(workspaceIntegrations.updatedAt))
    .limit(25);

  return sortStoredGithubRows(rows, input.requestedConnectionId)[0] ?? null;
}

async function validateCurrentHealedGithubConnection(input: {
  db: DrizzleDb;
  client: NangoProxyClient;
  workspaceId: string;
  requestedConnectionId: string;
  relayfileWorkspaceId: string;
  owner: string;
  repo: string;
}): Promise<GithubCloneIntegration> {
  const current = await currentStoredGithubConnection({
    db: input.db,
    workspaceId: input.workspaceId,
    requestedConnectionId: input.requestedConnectionId,
  });
  if (!current) {
    throw new Error(
      `GitHub clone connection heal lost the workspace integration row for workspace ${input.workspaceId}.`,
    );
  }

  let matchingConnection: unknown = null;
  if (input.client.listConnections) {
    const response = await input.client.listConnections({
      integrationId: current.providerConfigKey,
      limit: 100,
    });
    matchingConnection =
      (Array.isArray(response.connections) ? response.connections : []).find(
        (connection) =>
          normalizeNangoConnection(connection)?.connectionId ===
          current.connectionId,
      ) ?? null;
  }

  if (
    !matchingConnection ||
    !connectionMatchesRelayWorkspace(
      matchingConnection,
      input.relayfileWorkspaceId,
    )
  ) {
    throw new Error(
      `GitHub clone connection heal raced, and the current connection ${current.connectionId} is not proven to belong to relay workspace ${input.relayfileWorkspaceId}.`,
    );
  }

  await probeGithubCloneIntegration({
    client: input.client,
    candidate: current,
    owner: input.owner,
    repo: input.repo,
  });
  return current;
}

async function persistOrConfirmHealedGithubConnection(input: {
  db: DrizzleDb;
  client: NangoProxyClient;
  workspaceId: string;
  staleConnectionId: string;
  requestedConnectionId: string;
  relayfileWorkspaceId: string;
  owner: string;
  repo: string;
  selected: NangoConnectionCandidate;
  stored: GithubCloneIntegration;
}): Promise<GithubCloneConnectionPersistenceResult> {
  let persistStatus: HealedGithubConnectionPersistStatus;
  try {
    persistStatus = await persistHealedGithubConnection({
      db: input.db,
      workspaceId: input.workspaceId,
      staleConnectionId: input.staleConnectionId,
      selected: input.selected,
      stored: input.stored,
    });
  } catch (error) {
    if (!isWorkspaceIntegrationConnectionUniqueViolation(error)) {
      throw error;
    }
    persistStatus = { status: "failed", error };
  }
  if (persistStatus.status === "persisted") {
    return {
      status: "persisted",
      connection: {
        connectionId: input.selected.connectionId,
        providerConfigKey: input.selected.providerConfigKey,
        provider: input.stored.provider,
      },
    };
  }

  if (persistStatus.status === "failed") {
    return {
      status: "transient",
      persistError: formatCloneIntegrationFailure(persistStatus.error),
      connection: {
        connectionId: input.selected.connectionId,
        providerConfigKey: input.selected.providerConfigKey,
        provider: input.stored.provider,
      },
    };
  }

  const current = await validateCurrentHealedGithubConnection({
    db: input.db,
    client: input.client,
    workspaceId: input.workspaceId,
    requestedConnectionId: input.requestedConnectionId,
    relayfileWorkspaceId: input.relayfileWorkspaceId,
    owner: input.owner,
    repo: input.repo,
  });
  return { status: "raced", connection: current };
}

async function persistGithubCloneJobConnectionId(input: {
  deps: GithubCloneExecutionDeps;
  jobId: string;
  connectionId: string;
}): Promise<void> {
  const db = input.deps.db as DrizzleDb | undefined;
  if (!db?.update) {
    return;
  }

  const updateResult = db
    .update(githubCloneJobs)
    .set({
      connectionId: input.connectionId,
      updatedAt: new Date(),
    })
    .where(eq(githubCloneJobs.id, input.jobId));
  if (
    updateResult &&
    typeof updateResult === "object" &&
    "returning" in updateResult
  ) {
    await updateResult.returning?.();
  } else {
    await updateResult;
  }
}

async function resolveGithubCloneIntegration(
  deps: GithubCloneExecutionDeps,
  request: GithubCloneJobRequest,
  client: NangoProxyClient,
): Promise<GithubCloneIntegration> {
  const db = deps.db as DrizzleDb | undefined;
  if (!db) {
    throw new Error(
      "Database dependency is required for GitHub clone execution.",
    );
  }

  const rows = await db
    .select({
      connectionId: workspaceIntegrations.connectionId,
      provider: workspaceIntegrations.provider,
      providerConfigKey: workspaceIntegrations.providerConfigKey,
    })
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, request.workspaceId),
        like(workspaceIntegrations.provider, "github%"),
      ),
    )
    .orderBy(desc(workspaceIntegrations.updatedAt))
    .limit(25);

  if (rows.length === 0) {
    const error = new Error("GitHub integration not found for workspace.");
    Object.assign(error, { status: 404 });
    throw error;
  }

  const candidates = sortStoredGithubRows(rows, request.connectionId);
  const stored = candidates[0];
  if (!stored) {
    const error = new Error(
      "GitHub integration connectionId missing for workspace.",
    );
    Object.assign(error, { status: 404 });
    throw error;
  }

  try {
    await probeGithubCloneIntegration({
      client,
      candidate: stored,
      owner: request.owner,
      repo: request.repo,
    });
    return stored;
  } catch (error) {
    if (!isMissingNangoConnectionError(error)) {
      throw error;
    }
  }

  const relayfileWorkspaceId = await resolveRelayfileWorkspaceIdForClone(
    deps,
    request.workspaceId,
  );
  const healed = await selectRepoCapableConnection({
    client,
    providerConfigKey: stored.providerConfigKey,
    relayfileWorkspaceId,
    owner: request.owner,
    repo: request.repo,
  });
  const persistence = await persistOrConfirmHealedGithubConnection({
    db,
    client,
    workspaceId: request.workspaceId,
    staleConnectionId: stored.connectionId,
    requestedConnectionId: request.connectionId,
    relayfileWorkspaceId,
    owner: request.owner,
    repo: request.repo,
    stored,
    selected: healed,
  });
  if (persistence.status === "persisted") {
    console.warn(
      JSON.stringify({
        event: "github_clone_connection_auto_healed",
        workspaceId: request.workspaceId,
        relayfileWorkspaceId,
        owner: request.owner,
        repo: request.repo,
        staleConnectionId: stored.connectionId,
        healedConnectionId: persistence.connection.connectionId,
        healedProviderConfigKey: persistence.connection.providerConfigKey,
      }),
    );
  } else if (persistence.status === "transient") {
    console.warn(
      JSON.stringify({
        event: "github_clone_connection_auto_heal_reconciled",
        workspaceId: request.workspaceId,
        relayfileWorkspaceId,
        owner: request.owner,
        repo: request.repo,
        staleConnectionId: stored.connectionId,
        currentConnectionId: persistence.connection.connectionId,
        currentProviderConfigKey: persistence.connection.providerConfigKey,
        persistError: persistence.persistError,
      }),
    );
  } else {
    console.warn(
      JSON.stringify({
        event: "github_clone_connection_auto_heal_raced",
        workspaceId: request.workspaceId,
        relayfileWorkspaceId,
        owner: request.owner,
        repo: request.repo,
        staleConnectionId: stored.connectionId,
        currentConnectionId: persistence.connection.connectionId,
        currentProviderConfigKey: persistence.connection.providerConfigKey,
      }),
    );
  }
  return persistence.connection;
}

export async function resolveRelayfileWorkspaceIdForClone(
  deps: Pick<GithubCloneExecutionDeps, "db">,
  workspaceId: string,
): Promise<string> {
  const trimmed = workspaceId.trim();
  if (trimmed.startsWith("rw_")) {
    return trimmed;
  }

  const db = deps.db as DrizzleDb | undefined;
  if (!db) {
    throw new Error(
      `RelayFile workspace binding not available for workspace ${trimmed}.`,
    );
  }

  const [workspace] = await db
    .select({ relayWorkspaceId: workspaces.relayWorkspaceId })
    .from(workspaces)
    .where(eq(workspaces.id, trimmed))
    .limit(1);
  const relayWorkspaceId = workspace?.relayWorkspaceId?.trim();
  if (!relayWorkspaceId) {
    throw new Error(
      `RelayFile workspace binding not found for workspace ${trimmed}.`,
    );
  }
  return relayWorkspaceId;
}

export const __githubCloneProductionTestHooks = {
  resolveGithubCloneIntegration,
  resolveGithubTarballFetchImportInput,
};

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function getRepoEndpoint(owner: string, repo: string): string {
  return `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}`;
}

function getTarballEndpoint(owner: string, repo: string, ref: string): string {
  return `${getRepoEndpoint(owner, repo)}/tarball/${encodePathSegment(ref)}`;
}

function getCommitEndpoint(owner: string, repo: string, ref: string): string {
  return `${getRepoEndpoint(owner, repo)}/commits/${encodePathSegment(ref)}`;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function formatBulkWriteFailure(
  count: number,
  label: string,
  firstError?: { code: string; message: string },
): string {
  const suffix = firstError
    ? ` First error: ${firstError.code}: ${firstError.message}`
    : "";
  return `Relayfile bulk write failed for ${count} ${label}.${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function axiosErrorResponse(
  error: unknown,
): { status: number; data: unknown } | null {
  if (!isRecord(error) || !isRecord(error.response)) {
    return null;
  }

  const status =
    typeof error.response.status === "number" ? error.response.status : null;
  if (status === null) {
    return null;
  }

  return { status, data: error.response.data };
}

function buildProxyError(
  endpoint: string,
  fallback: string,
  errorData: unknown,
): Error {
  let message = fallback;
  if (isRecord(errorData)) {
    const nestedError = isRecord(errorData.error) ? errorData.error : null;
    const extracted =
      readString(errorData.error) ??
      readString(errorData.message) ??
      readString(nestedError?.message) ??
      readString(nestedError?.code);
    if (extracted) {
      message = extracted;
    }
  }

  const error = new Error(`Nango proxy ${endpoint} failed: ${message}`);
  const status = Number(fallback);
  if (Number.isFinite(status)) {
    Object.assign(error, { status, data: errorData });
  }
  return error;
}

async function proxyJson<T extends Record<string, unknown>>(
  client: NangoProxyClient,
  input: {
    connectionId: string;
    providerConfigKey: string;
    method: string;
    endpoint: string;
  },
): Promise<T> {
  try {
    const response = await client.proxy<T>({
      method: input.method,
      endpoint: input.endpoint,
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
    });
    if (!response.data) {
      throw new Error(
        `Nango proxy ${input.endpoint} returned an empty response.`,
      );
    }
    return response.data;
  } catch (error) {
    const info = axiosErrorResponse(error);
    if (info) {
      throw buildProxyError(input.endpoint, `${info.status}`, info.data);
    }
    throw error;
  }
}

function extractInstallationToken(
  raw: string | { access_token?: string; token?: string },
): string {
  if (typeof raw === "string" && raw.length > 0) {
    return raw;
  }
  if (raw && typeof raw === "object") {
    const candidate = raw.access_token ?? raw.token;
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  throw new Error(
    "Nango getToken returned an unexpected GitHub App token shape.",
  );
}

async function getGithubInstallationToken(input: {
  client: NangoProxyClient;
  connectionId: string;
  providerConfigKey: string;
}): Promise<string> {
  return input.client
    .getToken(input.providerConfigKey, input.connectionId, false, true)
    .then(extractInstallationToken)
    .catch((error) => {
      throw toGithubCloneStageError("github_tarball_fetch_failed", error);
    });
}

async function fetchGithubTarballDirect(input: {
  client: NangoProxyClient;
  connectionId: string;
  providerConfigKey: string;
  owner: string;
  repo: string;
  ref: string;
}): Promise<NodeJS.ReadableStream> {
  // Bypass the Nango proxy for the tarball download. Nango's proxy mishandles
  // GitHub's binary-stream + 302-to-codeload response (returned 415 in prod,
  // see job 6d00709b / probe on 2026-05-02). Pattern mirrors relay-cloud
  // (`packages/cloud/src/services/nango.ts:160 getGithubAppToken`): use
  // Nango only as the GitHub App installation-token provider, then call
  // api.github.com directly with that token. The two JSON proxy calls
  // (repo + commit) still go through Nango — they're plain JSON and the
  // proxy handles them fine.
  const installationToken = await getGithubInstallationToken(input);

  const url = `https://api.github.com${getTarballEndpoint(input.owner, input.repo, input.ref)}`;
  // Use `globalThis.fetch` rather than a bare `fetch` identifier: Cloudflare
  // Workers with `nodejs_compat` can hoist bare `fetch` off `globalThis` and
  // throw `TypeError: Illegal invocation` when the binding loses its `this`.
  // See sage `.claude/rules/workers-fetch.md`.
  const response = await globalThis
    .fetch(url, {
      method: "GET",
      headers: {
        Authorization: `token ${installationToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "agentworkforce-github-clone-worker",
      },
      redirect: "follow",
    })
    .catch((error) => {
      throw toGithubCloneStageError("github_tarball_fetch_failed", error);
    });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new GithubCloneStageError(
      "github_tarball_fetch_failed",
      `GitHub tarball returned ${response.status}: ${bodyText.slice(0, 300) || response.statusText}`,
      { status: response.status },
    );
  }

  if (!response.body) {
    throw new GithubCloneStageError(
      "github_tarball_fetch_failed",
      "GitHub tarball returned an empty response body.",
    );
  }

  return Readable.fromWeb(
    response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
  );
}

async function resolveGithubTarballFetchImportInput(input: {
  client: NangoProxyClient;
  connectionId: string;
  providerConfigKey: string;
  owner: string;
  repo: string;
  ref: string;
}): Promise<{
  githubToken: string;
  tarballUrl: string;
  headSha: string;
  defaultBranch: string;
}> {
  const repoEndpoint = getRepoEndpoint(input.owner, input.repo);

  const [githubToken, repoPayload] = await Promise.all([
    getGithubInstallationToken({
      client: input.client,
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
    }),
    proxyJson(input.client, {
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      method: "GET",
      endpoint: repoEndpoint,
    }),
  ]);

  const defaultBranch = readString(repoPayload.default_branch);
  if (!defaultBranch) {
    throw new Error(
      `Nango proxy ${repoEndpoint} did not return default_branch.`,
    );
  }
  const resolvedRef = input.ref === "HEAD" ? defaultBranch : input.ref;
  const commitEndpoint = getCommitEndpoint(
    input.owner,
    input.repo,
    resolvedRef,
  );
  const commitPayload = await proxyJson(input.client, {
    connectionId: input.connectionId,
    providerConfigKey: input.providerConfigKey,
    method: "GET",
    endpoint: commitEndpoint,
  });

  const headSha =
    readString(commitPayload.sha) ?? readString(repoPayload.head_sha);
  if (!headSha) {
    throw new Error(`Nango proxy ${commitEndpoint} did not return sha.`);
  }

  return {
    githubToken,
    tarballUrl: `https://api.github.com${getTarballEndpoint(input.owner, input.repo, headSha)}`,
    headSha,
    defaultBranch,
  };
}

async function nangoGithubTarball(input: {
  client: NangoProxyClient;
  connectionId: string;
  providerConfigKey: string;
  owner: string;
  repo: string;
  ref: string;
}): Promise<{
  stream: NodeJS.ReadableStream;
  headSha: string;
  defaultBranch: string;
}> {
  const repoEndpoint = getRepoEndpoint(input.owner, input.repo);
  const repoPayload = await proxyJson(input.client, {
    connectionId: input.connectionId,
    providerConfigKey: input.providerConfigKey,
    method: "GET",
    endpoint: repoEndpoint,
  });
  const defaultBranch = readString(repoPayload.default_branch);
  if (!defaultBranch) {
    throw new Error(
      `Nango proxy ${repoEndpoint} did not return default_branch.`,
    );
  }
  const resolvedRef = input.ref === "HEAD" ? defaultBranch : input.ref;
  const commitEndpoint = getCommitEndpoint(
    input.owner,
    input.repo,
    resolvedRef,
  );
  const commitPayload = await proxyJson(input.client, {
    connectionId: input.connectionId,
    providerConfigKey: input.providerConfigKey,
    method: "GET",
    endpoint: commitEndpoint,
  });
  const headSha =
    readString(commitPayload.sha) ?? readString(repoPayload.head_sha);
  if (!headSha) {
    throw new Error(`Nango proxy ${commitEndpoint} did not return sha.`);
  }
  const stream = await fetchGithubTarballDirect({
    client: input.client,
    connectionId: input.connectionId,
    providerConfigKey: input.providerConfigKey,
    owner: input.owner,
    repo: input.repo,
    ref: headSha,
  });

  return {
    stream,
    headSha,
    defaultBranch,
  };
}

function buildRepoRoot(owner: string, repo: string): string {
  return `/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function encodeEntryPath(entryPath: string): string {
  return entryPath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildContentPath(
  owner: string,
  repo: string,
  entryPath: string,
  headSha: string,
): string {
  return `${buildRepoRoot(owner, repo)}/contents/${encodeEntryPath(entryPath)}@${encodeURIComponent(headSha)}.json`;
}

function buildMetaPath(owner: string, repo: string): string {
  return `${buildRepoRoot(owner, repo)}/meta.json`;
}

function buildCloneSentinelPath(owner: string, repo: string): string {
  return `${buildRepoRoot(owner, repo)}/.relayfile/clone.json`;
}

function mapSkippedReason(reason: string): CloneSkipReason {
  if (reason === "too-large") {
    return "too-large";
  }

  if (reason === "ignored") {
    return "ignored";
  }

  return "binary";
}

function getContentType(repoPath: string, isBinary: boolean): string {
  if (isBinary) {
    return "application/octet-stream";
  }

  if (repoPath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }

  if (repoPath.endsWith(".md")) {
    return "text/markdown; charset=utf-8";
  }

  return "text/plain; charset=utf-8";
}

function isIndexEntry(value: unknown): value is CloneIndexEntry {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { owner?: unknown }).owner === "string" &&
    typeof (value as { repo?: unknown }).repo === "string"
  );
}

function parseIndexEntries(content: string): CloneIndexEntry[] {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(isIndexEntry);
    }
    if (isRecord(parsed)) {
      if (Array.isArray(parsed.repos)) {
        return parsed.repos.filter(isIndexEntry);
      }
      if (Array.isArray(parsed.items)) {
        return parsed.items.filter(isIndexEntry);
      }
    }
  } catch {
    return [];
  }

  return [];
}

function isNotFoundError(error: unknown): boolean {
  return (
    (error instanceof RelayFileApiError && error.status === 404) ||
    (isRecord(error) && error.status === 404)
  );
}

async function readIndexEntries(
  relayfile: RelayFileClient,
  workspaceId: string,
): Promise<{ entries: CloneIndexEntry[]; baseRevision: string }> {
  try {
    const file = await relayfile.readFile(workspaceId, GITHUB_REPOS_INDEX_PATH);
    return {
      entries: parseIndexEntries(file.content),
      baseRevision: file.revision,
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return { entries: [], baseRevision: "0" };
    }
    throw error;
  }
}

async function readFileRevisionOrNew(
  relayfile: RelayFileClient,
  workspaceId: string,
  path: string,
): Promise<string> {
  try {
    const file = await relayfile.readFile(workspaceId, path);
    return file.revision;
  } catch (error) {
    if (isNotFoundError(error)) {
      return "0";
    }
    throw error;
  }
}

async function writeJsonFile(
  relayfile: RelayFileClient,
  workspaceId: string,
  path: string,
  correlationId: string,
  value: unknown,
): Promise<void> {
  const baseRevision = await readFileRevisionOrNew(
    relayfile,
    workspaceId,
    path,
  );

  await relayfile.writeFile({
    workspaceId,
    path,
    baseRevision,
    content: JSON.stringify(value),
    contentType: "application/json",
    encoding: "utf-8",
    correlationId,
  });
}

async function resolveGithubCloneJobId(
  deps: GithubCloneExecutionDeps,
): Promise<string> {
  const explicitJobId =
    readString((deps as { jobId?: unknown }).jobId) ??
    readString(
      (deps.request as (GithubCloneJobRequest & { jobId?: string }) | undefined)
        ?.jobId,
    );
  if (explicitJobId) {
    return explicitJobId;
  }
  throw new Error(
    "GitHub clone job id is required for clone sentinel metadata.",
  );
}

function upsertIndexEntry(
  entries: CloneIndexEntry[],
  nextEntry: CloneIndexEntry,
): CloneIndexEntry[] {
  const merged = entries.filter(
    (entry) =>
      !(entry.owner === nextEntry.owner && entry.repo === nextEntry.repo),
  );
  merged.push(nextEntry);
  return merged;
}

function toCloneFile(
  owner: string,
  repo: string,
  headSha: string,
  entry: {
    repoPath: string;
    content: Buffer;
    isBinary: boolean;
  },
): RelayCloneFile {
  return {
    path: buildContentPath(owner, repo, entry.repoPath, headSha),
    content: entry.isBinary
      ? entry.content.toString("base64")
      : entry.content.toString("utf8"),
    contentType: getContentType(entry.repoPath, entry.isBinary),
    encoding: entry.isBinary ? "base64" : "utf-8",
  };
}

function normalizeRef(ref?: string): string {
  const trimmed = ref?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "HEAD";
}

export async function runProductionGithubClone(
  deps: GithubCloneExecutionDeps,
  request: GithubCloneJobRequest,
): Promise<GithubCloneExecutionResult> {
  const startedAt = Date.now();
  const nangoClient = createNangoClient(deps);
  const githubIntegration = await resolveGithubCloneIntegration(
    deps,
    request,
    nangoClient,
  );
  const cloneRequest = {
    ...request,
    connectionId: githubIntegration.connectionId,
  };
  const providerConfigKey = githubIntegration.providerConfigKey;
  const relayfileWorkspaceId = await resolveRelayfileWorkspaceIdForClone(
    deps,
    cloneRequest.workspaceId,
  );
  const relayfile = createRelayfileClient(deps, relayfileWorkspaceId);

  // Incremental sync path — only entered when the webhook router enqueued
  // the job with mode='incremental' AND a baseSha. Any other shape (a
  // public clone-request, a 30-day staleness re-clone, sage's bootstrap
  // call) flows through the existing full-clone path below.
  if (cloneRequest.mode === "incremental" && cloneRequest.baseSha) {
    const incrementalResult = await runIncrementalSync({
      deps,
      request: cloneRequest,
      relayfileWorkspaceId,
      nangoClient,
      relayfile,
      providerConfigKey,
      startedAt,
    });

    if (incrementalResult) {
      return incrementalResult;
    }
    // runIncrementalSync returns null when it falls back to a full clone
    // (diverged / truncated). Fall through to the tarball pipeline below;
    // the caller's job row stays mode='incremental' and the manifest is
    // updated with fellBackToFull=true.
  }

  return runFullClone({
    deps,
    request: cloneRequest,
    relayfileWorkspaceId,
    nangoClient,
    relayfile,
    providerConfigKey,
    startedAt,
    fellBackFromIncremental:
      cloneRequest.mode === "incremental" && Boolean(cloneRequest.baseSha),
  });
}

interface CloneStageInput {
  deps: GithubCloneExecutionDeps;
  request: GithubCloneJobRequest;
  relayfileWorkspaceId: string;
  nangoClient: NangoProxyClient;
  relayfile: RelayFileClient;
  providerConfigKey: string;
  startedAt: number;
}

async function runFullClone(
  input: CloneStageInput & { fellBackFromIncremental: boolean },
): Promise<GithubCloneExecutionResult> {
  const {
    deps,
    request,
    relayfileWorkspaceId,
    nangoClient,
    relayfile,
    providerConfigKey,
    startedAt,
  } = input;
  const requestedRef = normalizeRef(request.ref);
  const jobId = await resolveGithubCloneJobId(deps);
  await persistGithubCloneJobConnectionId({
    deps,
    jobId,
    connectionId: request.connectionId,
  });

  if (
    githubCloneTarImportEnabled(deps) &&
    githubCloneRelayfileFetchImportEnabled(deps)
  ) {
    const tarball = await resolveGithubTarballFetchImportInput({
      client: nangoClient,
      connectionId: request.connectionId,
      providerConfigKey,
      owner: request.owner,
      repo: request.repo,
      ref: requestedRef,
    });
    const importJob = await startGithubTarballFetchImport({
      relayfileUrl: relayfileBaseUrl(deps),
      workspaceId: relayfileWorkspaceId,
      owner: request.owner,
      repo: request.repo,
      ref: requestedRef,
      headSha: tarball.headSha,
      jobId,
      tarballUrl: tarball.tarballUrl,
      githubToken: tarball.githubToken,
      token: () => mintGithubCloneRelayfileToken(deps, relayfileWorkspaceId),
    });

    if (importJob.status === "failed") {
      throw new GithubCloneStageError(
        "relayfile_tar_import_failed",
        importJob.lastError
          ? `Relayfile GitHub tarball fetch import failed: ${importJob.lastError}`
          : "Relayfile GitHub tarball fetch import failed.",
      );
    }

    if (importJob.status === "completed") {
      const imported =
        typeof importJob.imported === "number" ? importJob.imported : 0;
      const errorCount =
        typeof importJob.errorCount === "number" ? importJob.errorCount : 0;
      const errors = Array.isArray(importJob.errors) ? importJob.errors : [];
      if (errorCount > 0) {
        throw new GithubCloneStageError(
          "relayfile_tar_import_failed",
          formatBulkWriteFailure(
            errorCount,
            "GitHub tarball import files",
            errors[0],
          ),
        );
      }
      if (imported > 0) {
        await writeFullCloneManifests({
          relayfile,
          request,
          relayfileWorkspaceId,
          jobId,
          defaultBranch: tarball.defaultBranch,
          headSha: tarball.headSha,
          filesWritten: imported,
          fellBackFromIncremental: input.fellBackFromIncremental,
        });
      }
      return {
        filesWritten: imported,
        headSha: tarball.headSha,
        durationMs: Date.now() - startedAt,
        completedAt: new Date(),
        materialization: relayfileExportMaterialization({
          owner: request.owner,
          repo: request.repo,
          headSha: tarball.headSha,
          filesExpected: imported,
        }),
      };
    }

    if (!githubCloneLocalArchiveMaterializationEnabled(deps)) {
      const importResult = await importGithubTarballByRelayfileFetch({
        relayfileUrl: relayfileBaseUrl(deps),
        workspaceId: relayfileWorkspaceId,
        owner: request.owner,
        repo: request.repo,
        ref: requestedRef,
        headSha: tarball.headSha,
        jobId,
        tarballUrl: tarball.tarballUrl,
        githubToken: tarball.githubToken,
        token: () => mintGithubCloneRelayfileToken(deps, relayfileWorkspaceId),
      });

      if (importResult.errorCount > 0) {
        throw new GithubCloneStageError(
          "relayfile_tar_import_failed",
          formatBulkWriteFailure(
            importResult.errorCount,
            "GitHub tarball import files",
            importResult.errors[0],
          ),
        );
      }

      await writeFullCloneManifests({
        relayfile,
        request,
        relayfileWorkspaceId,
        jobId,
        defaultBranch: tarball.defaultBranch,
        headSha: tarball.headSha,
        filesWritten: importResult.imported,
        fellBackFromIncremental: input.fellBackFromIncremental,
      });

      return {
        filesWritten: importResult.imported,
        headSha: tarball.headSha,
        durationMs: Date.now() - startedAt,
        completedAt: new Date(),
        materialization: relayfileExportMaterialization({
          owner: request.owner,
          repo: request.repo,
          headSha: tarball.headSha,
          filesExpected: importResult.imported,
        }),
      };
    }

    return {
      filesWritten: null,
      headSha: tarball.headSha,
      durationMs: Date.now() - startedAt,
      completedAt: new Date(),
      materialization: localArchiveMaterialization({
        deps,
        jobId,
        headSha: tarball.headSha,
      }),
    };
  }

  const tarball = await nangoGithubTarball({
    client: nangoClient,
    connectionId: request.connectionId,
    providerConfigKey,
    owner: request.owner,
    repo: request.repo,
    ref: requestedRef,
  });

  if (githubCloneTarImportEnabled(deps)) {
    const importResult = await importGithubTarballToRelayfile({
      relayfileUrl: relayfileBaseUrl(deps),
      workspaceId: relayfileWorkspaceId,
      owner: request.owner,
      repo: request.repo,
      headSha: tarball.headSha,
      jobId,
      archive: tarball.stream,
      token: () => mintGithubCloneRelayfileToken(deps, relayfileWorkspaceId),
    });

    if (importResult.errorCount > 0) {
      throw new GithubCloneStageError(
        "relayfile_tar_import_failed",
        formatBulkWriteFailure(
          importResult.errorCount,
          "GitHub tarball import files",
          importResult.errors[0],
        ),
      );
    }

    if (importResult.imported > 0) {
      await writeFullCloneManifests({
        relayfile,
        request,
        relayfileWorkspaceId,
        jobId,
        defaultBranch: tarball.defaultBranch,
        headSha: tarball.headSha,
        filesWritten: importResult.imported,
        fellBackFromIncremental: input.fellBackFromIncremental,
      });
    }

    return {
      filesWritten: importResult.imported,
      headSha: tarball.headSha,
      durationMs: Date.now() - startedAt,
      completedAt: new Date(),
      materialization: relayfileExportMaterialization({
        owner: request.owner,
        repo: request.repo,
        headSha: tarball.headSha,
        filesExpected: importResult.imported,
      }),
    };
  }

  const skipped: Array<{ path: string; reason: CloneSkipReason }> = [];
  const files: RelayCloneFile[] = [];
  let bufferedBytes = 0;

  for await (const entry of walkGithubTarball(tarball.stream)) {
    if (entry.skipped) {
      skipped.push({
        path: entry.repoPath,
        reason: mapSkippedReason(entry.skipped),
      });
      continue;
    }

    if (entry.size > GITHUB_CLONE_MAX_FILE_BYTES) {
      skipped.push({
        path: entry.repoPath,
        reason: "too-large",
      });
      continue;
    }

    bufferedBytes += entry.content.byteLength;
    if (bufferedBytes > GITHUB_CLONE_MAX_BUFFERED_BYTES) {
      throw new Error(
        "GitHub clone exceeded the 200 MiB in-memory snapshot limit.",
      );
    }

    files.push(
      toCloneFile(request.owner, request.repo, tarball.headSha, entry),
    );
  }

  const writeResult = await chunkedBulkWrite({
    client: relayfile,
    workspaceId: relayfileWorkspaceId,
    jobId,
    files,
    maxConcurrent: GITHUB_CLONE_RELAYFILE_WRITE_CONCURRENCY,
  });

  if (writeResult.errors.length > 0) {
    throw new Error(
      formatBulkWriteFailure(
        writeResult.errors.length,
        "GitHub clone files",
        writeResult.errors[0],
      ),
    );
  }

  if (writeResult.written > 0) {
    await writeFullCloneManifests({
      relayfile,
      request,
      relayfileWorkspaceId,
      jobId,
      defaultBranch: tarball.defaultBranch,
      headSha: tarball.headSha,
      filesWritten: writeResult.written,
      fellBackFromIncremental: input.fellBackFromIncremental,
    });
  }

  return {
    filesWritten: writeResult.written,
    headSha: tarball.headSha,
    durationMs: Date.now() - startedAt,
    completedAt: new Date(),
    materialization: relayfileExportMaterialization({
      owner: request.owner,
      repo: request.repo,
      headSha: tarball.headSha,
      filesExpected: writeResult.written,
    }),
  };
}

function relayfileExportMaterialization(input: {
  owner: string;
  repo: string;
  headSha: string;
  filesExpected: number | null;
}): GithubCloneExecutionResult["materialization"] {
  const repoRoot = `/github/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
  return {
    mode: "relayfile_export",
    headSha: input.headSha,
    filesExpected: input.filesExpected,
    sentinelPath: `${repoRoot}/.relayfile/clone.json`,
    contentRoot: `${repoRoot}/contents`,
    exportParams: {
      format: "tar",
      decode: "github-working-tree",
      gzip: false,
    },
  };
}

function localArchiveMaterialization(input: {
  deps: GithubCloneExecutionDeps;
  jobId: string;
  headSha: string;
}): GithubCloneExecutionResult["materialization"] {
  return {
    mode: "local_archive",
    headSha: input.headSha,
    filesExpected: null,
    archiveUrl: `${cloudArchiveBaseUrl(input.deps)}/api/v1/github/clone/archive/${encodeURIComponent(input.jobId)}`,
    stripComponents: 1,
    expiresAt: new Date(
      Date.now() + githubCloneArchiveLeaseTtlMs(input.deps),
    ).toISOString(),
  };
}

function cloudArchiveBaseUrl(deps: GithubCloneExecutionDeps): string {
  const configured =
    readEnv(deps, "CLOUD_PUBLIC_URL") ??
    readEnv(deps, "NEXT_PUBLIC_APP_URL") ??
    readEnv(deps, "CLOUD_API_URL");
  if (!configured) {
    throw new Error(
      "CLOUD_PUBLIC_URL, NEXT_PUBLIC_APP_URL, or CLOUD_API_URL is required for GitHub local archive materialization.",
    );
  }
  const url = new URL(configured);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("GitHub clone archive base URL must use http or https.");
  }
  return url.toString().replace(/\/+$/, "");
}

function githubCloneTarImportEnabled(deps: GithubCloneExecutionDeps): boolean {
  const raw = readEnv(deps, "GITHUB_CLONE_TAR_IMPORT");
  if (!raw) {
    return true;
  }
  return !["0", "false", "off"].includes(raw.toLowerCase());
}

function githubCloneLocalArchiveMaterializationEnabled(
  deps: GithubCloneExecutionDeps,
): boolean {
  const raw = readEnv(deps, "GITHUB_CLONE_LOCAL_ARCHIVE_MATERIALIZATION");
  if (!raw) {
    return true;
  }
  return !["0", "false", "off"].includes(raw.toLowerCase());
}

function githubCloneArchiveLeaseTtlMs(deps: GithubCloneExecutionDeps): number {
  const raw = readEnv(deps, "GITHUB_CLONE_ARCHIVE_LEASE_TTL_SECONDS");
  if (!raw) {
    return 60 * 60 * 1000;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : 60 * 60 * 1000;
}

function githubCloneRelayfileFetchImportEnabled(
  deps: GithubCloneExecutionDeps,
): boolean {
  const raw = readEnv(deps, "GITHUB_CLONE_RELAYFILE_FETCH_IMPORT");
  if (!raw) {
    return false;
  }
  return ["1", "true", "on"].includes(raw.toLowerCase());
}

async function writeFullCloneManifests(input: {
  relayfile: RelayFileClient;
  request: GithubCloneJobRequest;
  relayfileWorkspaceId: string;
  jobId: string;
  defaultBranch: string;
  headSha: string;
  filesWritten: number;
  fellBackFromIncremental: boolean;
}): Promise<void> {
  const { relayfile, request } = input;
  const workspaceId = input.relayfileWorkspaceId;
  const completedAtIso = new Date().toISOString();
  const { entries: existingEntries, baseRevision: indexBaseRevision } =
    await readIndexEntries(relayfile, workspaceId);
  const mergedIndex = upsertIndexEntry(existingEntries, {
    owner: request.owner,
    repo: request.repo,
    defaultBranch: input.defaultBranch,
    headSha: input.headSha,
    clonedAt: completedAtIso,
  });

  await relayfile.writeFile({
    workspaceId,
    path: GITHUB_REPOS_INDEX_PATH,
    baseRevision: indexBaseRevision,
    content: JSON.stringify(mergedIndex),
    contentType: "application/json",
    encoding: "utf-8",
    correlationId: `github-clone-index-${workspaceId}`,
  });

  const cloneMetadata = {
    defaultBranch: input.defaultBranch,
    headSha: input.headSha,
    clonedAt: completedAtIso,
    filesWritten: input.filesWritten,
    cloneSource: GITHUB_CLONE_SOURCE,
    fellBackToFull: input.fellBackFromIncremental ? true : undefined,
  };

  // Legacy sentinel — kept for one release cycle so older sage instances can read it.
  await writeJsonFile(
    relayfile,
    workspaceId,
    buildMetaPath(request.owner, request.repo),
    `github-clone-meta-${workspaceId}`,
    cloneMetadata,
  );
  // New sentinel — preferred path. .relayfile/ is the reserved control-plane prefix.
  await writeJsonFile(
    relayfile,
    workspaceId,
    buildCloneSentinelPath(request.owner, request.repo),
    `github-clone-control-${workspaceId}`,
    {
      jobId: input.jobId,
      ...cloneMetadata,
    },
  );
}

async function runIncrementalSync(
  input: CloneStageInput,
): Promise<GithubCloneExecutionResult | null> {
  const {
    deps,
    request,
    nangoClient,
    relayfile,
    providerConfigKey,
    startedAt,
  } = input;
  const { relayfileWorkspaceId } = input;
  const baseSha = request.baseSha?.trim();
  if (!baseSha) {
    // Defensive — caller should have validated this. Fall through to full.
    return null;
  }

  const head = normalizeRef(request.ref);
  const compare: CompareResult = await compareGithubRefs({
    nango: nangoClient as unknown as CompareNangoClient,
    connectionId: request.connectionId,
    providerConfigKey,
    owner: request.owner,
    repo: request.repo,
    base: baseSha,
    head,
  });

  if (compare.kind === "diverged" || compare.kind === "truncated") {
    // Structured log so the anti-fab pipeline can count fallbacks. We use
    // console.warn here because the executor runs inside an SQS lambda
    // (cloud-runtime CloudWatch logs are the audit trail). No bare fetch.
    console.warn(
      JSON.stringify({
        event: "incremental_sync_fallback_to_full",
        reason: compare.kind,
        owner: request.owner,
        repo: request.repo,
        baseSha,
        head,
        ...(compare.kind === "diverged"
          ? { divergedReason: compare.reason }
          : { truncatedFiles: compare.totalChangedFiles }),
      }),
    );
    return null;
  }

  if (compare.kind === "no_change") {
    // Same SHA on both sides — record a zero-write completion and update
    // the manifest's lastIncrementalSyncAt. clonedAt and headSha stay as
    // they were.
    await writeIncrementalManifest({
      deps,
      relayfile,
      request,
      relayfileWorkspaceId,
      headSha: baseSha,
      filesWrittenDelta: 0,
      filesDeleted: 0,
    });

    return {
      filesWritten: 0,
      headSha: baseSha,
      durationMs: Date.now() - startedAt,
      completedAt: new Date(),
    };
  }

  // compare.kind === "changes"
  const changes = compare.files;
  const newHead = compare.headSha;
  const filesToWrite: RelayCloneFile[] = [];
  let filesDeleted = 0;

  for (const change of changes) {
    if (change.status === "removed" || change.status === "renamed") {
      // Sequential delete — typical changed-file count is <50. baseRevision
      // "*" matches the wire-level convention used by the Nango sync writer.
      const deletedPath =
        change.status === "renamed" ? change.previousPath : change.path;
      const path = buildContentPath(
        request.owner,
        request.repo,
        deletedPath,
        baseSha,
      );
      try {
        await relayfile.deleteFile({
          workspaceId: relayfileWorkspaceId,
          path,
          baseRevision: "*",
        });
        filesDeleted += 1;
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
        // Already gone — ignore. Treat as a successful delete.
        filesDeleted += 1;
      }
      if (change.status === "removed") {
        continue;
      }
      // A rename also writes the new path below.
    }

    // added / modified / renamed — fetch the blob via Nango and queue for
    // a chunked bulkWrite (same code path the full clone uses).
    const blob = await fetchGithubBlob({
      client: nangoClient,
      connectionId: request.connectionId,
      providerConfigKey,
      owner: request.owner,
      repo: request.repo,
      sha: change.sha,
    });
    filesToWrite.push(
      toCloneFile(request.owner, request.repo, newHead, {
        repoPath: change.path,
        content: blob.content,
        isBinary: blob.isBinary,
      }),
    );
  }

  let written = 0;
  if (filesToWrite.length > 0) {
    const jobId = await resolveGithubCloneJobId(deps);
    const writeResult = await chunkedBulkWrite({
      client: relayfile,
      workspaceId: relayfileWorkspaceId,
      jobId,
      files: filesToWrite,
      maxConcurrent: GITHUB_CLONE_RELAYFILE_WRITE_CONCURRENCY,
    });
    if (writeResult.errors.length > 0) {
      throw new Error(
        formatBulkWriteFailure(
          writeResult.errors.length,
          "incremental sync files",
          writeResult.errors[0],
        ),
      );
    }
    written = writeResult.written;
  }

  await writeIncrementalManifest({
    deps,
    relayfile,
    request,
    relayfileWorkspaceId,
    headSha: newHead,
    filesWrittenDelta: written,
    filesDeleted,
  });

  return {
    filesWritten: written,
    headSha: newHead,
    durationMs: Date.now() - startedAt,
    completedAt: new Date(),
  };
}

interface BlobFetchInput {
  client: NangoProxyClient;
  connectionId: string;
  providerConfigKey: string;
  owner: string;
  repo: string;
  sha: string;
}

async function fetchGithubBlob(
  input: BlobFetchInput,
): Promise<{ content: Buffer; isBinary: boolean }> {
  const endpoint = `${getRepoEndpoint(input.owner, input.repo)}/git/blobs/${encodePathSegment(input.sha)}`;
  const payload = await proxyJson<Record<string, unknown>>(input.client, {
    connectionId: input.connectionId,
    providerConfigKey: input.providerConfigKey,
    method: "GET",
    endpoint,
  });

  const encoding = readString(payload.encoding);
  const content = readString(payload.content);
  if (!encoding || content === null) {
    throw new Error(
      `GitHub blob ${input.sha} response missing content/encoding.`,
    );
  }

  if (encoding === "base64") {
    // GitHub wraps base64 at 60-char boundaries; the standard atob/Buffer
    // decoders ignore whitespace so we don't need to strip it manually.
    const buffer = Buffer.from(content, "base64");
    return {
      content: buffer,
      // Same heuristic the tarball walker uses: detect a NUL byte in the
      // first 8 KiB. Avoids importing the walker's helper just to call it.
      isBinary: looksBinary(buffer),
    };
  }

  if (encoding === "utf-8") {
    const buffer = Buffer.from(content, "utf8");
    return { content: buffer, isBinary: looksBinary(buffer) };
  }

  throw new Error(
    `Unexpected GitHub blob encoding '${encoding}' for ${input.sha}.`,
  );
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(8 * 1024, buffer.length));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

interface IncrementalManifestInput {
  deps: GithubCloneExecutionDeps;
  relayfile: RelayFileClient;
  request: GithubCloneJobRequest;
  relayfileWorkspaceId: string;
  headSha: string;
  filesWrittenDelta: number;
  filesDeleted: number;
}

async function writeIncrementalManifest(
  input: IncrementalManifestInput,
): Promise<void> {
  const {
    deps,
    relayfile,
    request,
    relayfileWorkspaceId,
    headSha,
    filesWrittenDelta,
    filesDeleted,
  } = input;
  const lastIncrementalSyncAt = new Date().toISOString();
  const sentinelPath = buildCloneSentinelPath(request.owner, request.repo);
  const metaPath = buildMetaPath(request.owner, request.repo);
  const jobId = await resolveGithubCloneJobId(deps);

  // Read existing sentinel to preserve clonedAt / cloneSource etc. If it's
  // missing (legacy clones from before #405) fall through to the legacy
  // meta.json. If both are missing we write a new sentinel with sensible
  // defaults — this matches the executor's full-clone shape minus
  // `clonedAt` (we don't have that for an incremental).
  const existing = await readCloneManifestForUpdate(
    relayfile,
    request,
    relayfileWorkspaceId,
  );
  const merged = {
    ...existing.previous,
    headSha,
    filesWritten:
      typeof existing.previous.filesWritten === "number"
        ? existing.previous.filesWritten + filesWrittenDelta - filesDeleted
        : filesWrittenDelta,
    lastIncrementalSyncAt,
    cloneSource: existing.previous.cloneSource ?? GITHUB_CLONE_SOURCE,
  };

  // Update the .relayfile/clone.json sentinel (preferred) and the legacy
  // meta.json (sage spec §5a says keep both for one release cycle).
  await relayfile.writeFile({
    workspaceId: relayfileWorkspaceId,
    path: sentinelPath,
    baseRevision: existing.sentinelRevision,
    content: JSON.stringify({
      jobId,
      ...merged,
    }),
    contentType: "application/json",
    encoding: "utf-8",
    correlationId: `github-clone-incremental-control-${relayfileWorkspaceId}`,
  });

  if (existing.metaRevision !== null) {
    await relayfile.writeFile({
      workspaceId: relayfileWorkspaceId,
      path: metaPath,
      baseRevision: existing.metaRevision,
      content: JSON.stringify(merged),
      contentType: "application/json",
      encoding: "utf-8",
      correlationId: `github-clone-incremental-meta-${relayfileWorkspaceId}`,
    });
  }
}

interface CloneManifestSnapshot {
  previous: Record<string, unknown> & {
    defaultBranch?: string;
    headSha?: string;
    clonedAt?: string;
    filesWritten?: number;
    cloneSource?: string;
  };
  sentinelRevision: string;
  metaRevision: string | null;
}

async function readCloneManifestForUpdate(
  relayfile: RelayFileClient,
  request: GithubCloneJobRequest,
  relayfileWorkspaceId: string,
): Promise<CloneManifestSnapshot> {
  const sentinelPath = buildCloneSentinelPath(request.owner, request.repo);
  const metaPath = buildMetaPath(request.owner, request.repo);

  let previous: CloneManifestSnapshot["previous"] = {};
  let sentinelRevision = "0";
  try {
    const file = await relayfile.readFile(relayfileWorkspaceId, sentinelPath);
    sentinelRevision = file.revision;
    const parsed = JSON.parse(file.content);
    if (parsed && typeof parsed === "object") {
      previous = parsed as CloneManifestSnapshot["previous"];
    }
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  let metaRevision: string | null = null;
  try {
    const file = await relayfile.readFile(relayfileWorkspaceId, metaPath);
    metaRevision = file.revision;
    if (Object.keys(previous).length === 0) {
      const parsed = JSON.parse(file.content);
      if (parsed && typeof parsed === "object") {
        previous = parsed as CloneManifestSnapshot["previous"];
      }
    }
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  return { previous, sentinelRevision, metaRevision };
}

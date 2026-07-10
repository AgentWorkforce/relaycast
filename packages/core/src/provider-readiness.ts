// Re-export all pure, pg-free functions and types from the core module so
// existing Lambda-path callers see identical exports.
export {
  READINESS_METADATA_KEY,
  parseIntegrationMetadata,
  readProviderReadiness,
  writeProviderReadiness,
  preserveProviderReadiness,
  aggregateProviderInitialSync,
  buildLegacyConnectedReadiness,
  buildPendingProviderReadiness,
  buildPendingProviderMetadata,
  buildInitialSyncRunningPatch,
  buildInitialSyncCompletePatch,
  buildInitialSyncFailedPatch,
} from "./provider-readiness-core.js";
export type {
  InitialSyncState,
  InitialSyncModelStatus,
  ProviderReadiness,
  IntegrationRow,
  ProviderReadinessPatch,
} from "./provider-readiness-core.js";

import {
  parseIntegrationMetadata,
  writeProviderReadiness,
  type ProviderReadinessPatch,
} from "./provider-readiness-core.js";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  readCoreDbRuntimeDiagnosticSnapshot,
} from "./db/client.js";
import { workspaceIntegrations } from "./db/schema.js";

const cloudflareContextSymbol = Symbol.for("__cloudflare-context__");
const nangoDbWorkspaceDiagnosticLoggedKeys = new WeakMap<object, Set<string>>();
const nangoDbWorkspaceDiagnosticNoContextToken = {};

type IntegrationRowLocal = {
  workspaceId: string;
  provider: string;
  metadataJson: string;
};

async function loadIntegration(
  workspaceId: string,
  provider: string,
  operation: string,
): Promise<IntegrationRowLocal | null> {
  try {
    const db = getDb();
    const [record] = await db
      .select({
        workspaceId: workspaceIntegrations.workspaceId,
        provider: workspaceIntegrations.provider,
        metadataJson: workspaceIntegrations.metadataJson,
      })
      .from(workspaceIntegrations)
      .where(
        and(
          eq(workspaceIntegrations.workspaceId, workspaceId),
          eq(workspaceIntegrations.provider, provider),
        ),
      )
      .limit(1);

    return record ?? null;
  } catch (error) {
    logNangoDbWorkspaceDiagnostic({
      callsite: `${operation}.loadIntegration`,
      phase: "query",
      error,
      workspaceId,
      provider,
    });
    throw error;
  }
}

async function saveIntegrationMetadata(
  workspaceId: string,
  provider: string,
  metadata: Record<string, unknown>,
  operation: string,
): Promise<void> {
  try {
    const db = getDb();
    await db
      .update(workspaceIntegrations)
      .set({
        metadataJson: JSON.stringify(metadata),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaceIntegrations.workspaceId, workspaceId),
          eq(workspaceIntegrations.provider, provider),
        ),
      );
  } catch (error) {
    logNangoDbWorkspaceDiagnostic({
      callsite: `${operation}.saveIntegrationMetadata`,
      phase: "query",
      error,
      workspaceId,
      provider,
    });
    throw error;
  }
}

async function mutateReadiness(
  workspaceId: string,
  provider: string,
  patch: ProviderReadinessPatch,
  operation = "mutateReadiness",
): Promise<void> {
  const record = await loadIntegration(workspaceId, provider, operation);
  if (!record) {
    return;
  }

  const metadata = parseIntegrationMetadata(record.metadataJson);
  const updatedMetadata = writeProviderReadiness(metadata, patch);
  await saveIntegrationMetadata(workspaceId, provider, updatedMetadata, operation);
}

export async function markProviderOAuthConnected(input: {
  workspaceId: string;
  provider: string;
  connectionId: string;
  providerConfigKey: string;
  at?: string;
}): Promise<void> {
  const at = input.at ?? new Date().toISOString();
  await mutateReadiness(input.workspaceId, input.provider, {
    oauthConnectedAt: at,
    lastAuthAt: at,
    connectionId: input.connectionId,
    providerConfigKey: input.providerConfigKey,
    updatedAt: at,
    initialSync: {
      state: "queued",
      enqueuedAt: at,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      lastError: null,
      syncName: null,
      model: null,
      modifiedAfter: null,
      byModel: {},
    },
  });
}

export async function markProviderInitialSyncQueued(input: {
  workspaceId: string;
  provider: string;
  providerConfigKey?: string | null;
  syncName?: string | null;
  model?: string | null;
  modifiedAfter?: string | null;
  at?: string;
}): Promise<void> {
  const at = input.at ?? new Date().toISOString();
  try {
    await mutateReadiness(
      input.workspaceId,
      input.provider,
      {
        updatedAt: at,
        providerConfigKey: input.providerConfigKey ?? undefined,
        initialSync: {
          state: "queued",
          enqueuedAt: at,
          startedAt: null,
          failedAt: null,
          lastError: null,
          syncName: input.syncName ?? null,
          model: input.model ?? null,
          modifiedAfter: input.modifiedAfter ?? null,
        },
      },
      "markProviderInitialSyncQueued",
    );
  } catch (error) {
    logNangoDbWorkspaceDiagnostic({
      callsite: "markProviderInitialSyncQueued",
      phase: "query",
      error,
      workspaceId: input.workspaceId,
      provider: input.provider,
    });
    throw error;
  }
}

export async function markProviderInitialSyncRunning(input: {
  workspaceId: string;
  provider: string;
  providerConfigKey?: string | null;
  syncName?: string | null;
  model?: string | null;
  modifiedAfter?: string | null;
  at?: string;
}): Promise<void> {
  const at = input.at ?? new Date().toISOString();
  await mutateReadiness(input.workspaceId, input.provider, {
    updatedAt: at,
    providerConfigKey: input.providerConfigKey ?? undefined,
    initialSync: {
      state: "running",
      startedAt: at,
      failedAt: null,
      lastError: null,
      syncName: input.syncName ?? null,
      model: input.model ?? null,
      modifiedAfter: input.modifiedAfter ?? null,
    },
  });
}

export async function markProviderInitialSyncComplete(input: {
  workspaceId: string;
  provider: string;
  providerConfigKey?: string | null;
  syncName?: string | null;
  model?: string | null;
  modifiedAfter?: string | null;
  at?: string;
}): Promise<void> {
  const at = input.at ?? new Date().toISOString();
  await mutateReadiness(input.workspaceId, input.provider, {
    updatedAt: at,
    providerConfigKey: input.providerConfigKey ?? undefined,
    initialSync: {
      state: "complete",
      completedAt: at,
      failedAt: null,
      lastError: null,
      syncName: input.syncName ?? null,
      model: input.model ?? null,
      modifiedAfter: input.modifiedAfter ?? null,
    },
  });
}

export async function markProviderInitialSyncFailed(input: {
  workspaceId: string;
  provider: string;
  error: string;
  providerConfigKey?: string | null;
  syncName?: string | null;
  model?: string | null;
  modifiedAfter?: string | null;
  at?: string;
}): Promise<void> {
  const at = input.at ?? new Date().toISOString();
  await mutateReadiness(input.workspaceId, input.provider, {
    updatedAt: at,
    providerConfigKey: input.providerConfigKey ?? undefined,
    initialSync: {
      state: "failed",
      failedAt: at,
      lastError: input.error,
      syncName: input.syncName ?? null,
      model: input.model ?? null,
      modifiedAfter: input.modifiedAfter ?? null,
    },
  });
}

type NangoDbWorkspaceDiagnosticInput = {
  callsite: string;
  phase: "query";
  error: unknown;
  workspaceId: string;
  provider: string;
};

// TEMP DIAGNOSTIC (diag/nango-db-workspace) -- REVERT after root-cause.
function logNangoDbWorkspaceDiagnostic(
  input: NangoDbWorkspaceDiagnosticInput,
): void {
  try {
    const context = (globalThis as Record<symbol, unknown>)[
      cloudflareContextSymbol
    ];
    const token =
      context && typeof context === "object"
        ? (context as object)
        : nangoDbWorkspaceDiagnosticNoContextToken;
    const loggedKeys = nangoDbWorkspaceDiagnosticLoggedKeys.get(token);
    if (loggedKeys?.has(input.callsite)) {
      return;
    }
    if (loggedKeys) {
      loggedKeys.add(input.callsite);
    } else {
      nangoDbWorkspaceDiagnosticLoggedKeys.set(token, new Set([input.callsite]));
    }

    console.info("[diag/nango-db-workspace]", {
      area: "diag/nango-db-workspace",
      tag: "nango-db-workspace",
      callsite: input.callsite,
      phase: input.phase,
      provider: input.provider,
      workspaceId: input.workspaceId,
      navigatorUserAgent: readNavigatorUserAgent(),
      isWorkerRuntime: isWorkerRuntimeForDiagnostic(context),
      cloudflareContextType: typeof context,
      cloudflareContextHasEnv: hasObjectEnv(context),
      cloudflareContextEnvKeys: countContextEnvKeys(context),
      // DB connectivity now lives in coreDbRuntime (Neon connection string +
      // selected driver). The old HYPERDRIVE binding probes were removed with
      // the move off Aurora/Hyperdrive.
      coreDbRuntime: readCoreDbRuntimeDiagnosticSnapshot() ?? null,
      error: serializeErrorForDiagnostic(input.error),
    });
  } catch {
    // Diagnostic logging must never affect webhook handling.
  }
}

function readNavigatorUserAgent(): string | null {
  const navigatorLike = (globalThis as { navigator?: { userAgent?: unknown } })
    .navigator;
  return typeof navigatorLike?.userAgent === "string"
    ? navigatorLike.userAgent
    : null;
}

function isWorkerRuntimeForDiagnostic(context: unknown): boolean {
  if (context && typeof context === "object") {
    return true;
  }
  const userAgent = readNavigatorUserAgent();
  return !!userAgent?.includes("Cloudflare-Workers");
}

function hasObjectEnv(context: unknown): boolean {
  return (
    !!context &&
    typeof context === "object" &&
    !!(context as { env?: unknown }).env &&
    typeof (context as { env?: unknown }).env === "object"
  );
}

function countContextEnvKeys(context: unknown): number {
  if (!hasObjectEnv(context)) {
    return 0;
  }
  return Object.keys((context as { env: Record<string, unknown> }).env).length;
}


function serializeErrorForDiagnostic(error: unknown): Record<string, unknown> {
  return {
    chain: serializeErrorChain(error),
  };
}

function serializeErrorChain(error: unknown): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    chain.push(serializeErrorFrame(current));
    current = (current as { cause?: unknown }).cause;
  }
  if (chain.length === 0) {
    chain.push({
      type: typeof error,
      message: String(error),
    });
  }
  return chain.slice(0, 6);
}

function serializeErrorFrame(error: object): Record<string, unknown> {
  const record = error as Record<string, unknown>;
  return {
    name: typeof record.name === "string" ? record.name : null,
    message: redactDiagnosticString(
      typeof record.message === "string" ? record.message : String(error),
    ),
    code: readStringField(record, "code"),
    detail: readStringField(record, "detail"),
    severity: readStringField(record, "severity"),
    routine: readStringField(record, "routine"),
    schema: readStringField(record, "schema"),
    table: readStringField(record, "table"),
    constraint: readStringField(record, "constraint"),
    causeType: typeof record.cause,
  };
}

function readStringField(
  record: Record<string, unknown>,
  field: string,
): string | null {
  const value = record[field];
  return typeof value === "string" && value.length > 0
    ? redactDiagnosticString(value)
    : null;
}

function redactDiagnosticString(value: string): string {
  return value
    .replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, "[redacted-postgres-url]")
    .replace(/(password=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(pass=)[^&\s]+/gi, "$1[redacted]");
}

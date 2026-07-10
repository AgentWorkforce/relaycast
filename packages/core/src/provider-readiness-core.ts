// Pure, pg-free module — no ./db/client.js, no pg, no drizzle-orm/node-postgres.
// Imported by provider-readiness.ts (Lambda path) AND provider-readiness-worker.ts
// (CF Worker path) so both stay in sync on the business logic while only the
// Lambda path ever touches the pg-backed client.ts.

export type InitialSyncState = "queued" | "running" | "complete" | "failed";

export type InitialSyncModelStatus = {
  state: InitialSyncState;
  providerConfigKey: string | null;
  enqueuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  lastError: string | null;
  syncName: string | null;
  model: string | null;
  modifiedAfter: string | null;
};

export type ProviderReadiness = {
  oauthConnectedAt: string | null;
  lastAuthAt: string | null;
  connectionId: string | null;
  providerConfigKey: string | null;
  initialSync: {
    state: InitialSyncState | "unknown";
    enqueuedAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    failedAt: string | null;
    lastError: string | null;
    syncName: string | null;
    model: string | null;
    modifiedAfter: string | null;
    byModel: Record<string, InitialSyncModelStatus>;
  };
  updatedAt: string | null;
};

export type IntegrationRow = {
  workspaceId: string;
  provider: string;
  metadataJson: string;
};

export type ProviderReadinessPatch = Partial<{
  oauthConnectedAt: string | null;
  lastAuthAt: string | null;
  connectionId: string | null;
  providerConfigKey: string | null;
  initialSync: Partial<ProviderReadiness["initialSync"]>;
  updatedAt: string | null;
}>;

export const READINESS_METADATA_KEY = "_relayfileProviderReadiness";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readInitialSyncState(value: unknown): InitialSyncState | null {
  const state = readString(value);
  return state === "queued" ||
    state === "running" ||
    state === "complete" ||
    state === "failed"
    ? state
    : null;
}

export function parseIntegrationMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function defaultProviderReadiness(): ProviderReadiness {
  return {
    oauthConnectedAt: null,
    lastAuthAt: null,
    connectionId: null,
    providerConfigKey: null,
    initialSync: {
      state: "unknown",
      enqueuedAt: null,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      lastError: null,
      syncName: null,
      model: null,
      modifiedAfter: null,
      byModel: {},
    },
    updatedAt: null,
  };
}

function readInitialSyncModelStatus(
  value: unknown,
): InitialSyncModelStatus | null {
  if (!isObject(value)) {
    return null;
  }
  const state = readInitialSyncState(value.state);
  if (!state) {
    return null;
  }
  return {
    state,
    providerConfigKey: readString(value.providerConfigKey),
    enqueuedAt: readString(value.enqueuedAt),
    startedAt: readString(value.startedAt),
    completedAt: readString(value.completedAt),
    failedAt: readString(value.failedAt),
    lastError: readString(value.lastError),
    syncName: readString(value.syncName),
    model: readString(value.model),
    modifiedAfter: readString(value.modifiedAfter),
  };
}

function readInitialSyncByModel(
  value: unknown,
): Record<string, InitialSyncModelStatus> {
  if (!isObject(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const status = readInitialSyncModelStatus(entry);
      return status ? [[key, status]] : [];
    }),
  );
}

export function readProviderReadiness(
  metadata: Record<string, unknown>,
): ProviderReadiness | null {
  const raw = metadata[READINESS_METADATA_KEY];
  if (!isObject(raw)) {
    return null;
  }

  const initialSync = isObject(raw.initialSync) ? raw.initialSync : {};
  const state = readInitialSyncState(initialSync.state);
  const readiness = defaultProviderReadiness();
  readiness.oauthConnectedAt = readString(raw.oauthConnectedAt);
  readiness.lastAuthAt = readString(raw.lastAuthAt);
  readiness.connectionId = readString(raw.connectionId);
  readiness.providerConfigKey = readString(raw.providerConfigKey);
  readiness.updatedAt = readString(raw.updatedAt);
  readiness.initialSync = {
    state: state ?? "unknown",
    enqueuedAt: readString(initialSync.enqueuedAt),
    startedAt: readString(initialSync.startedAt),
    completedAt: readString(initialSync.completedAt),
    failedAt: readString(initialSync.failedAt),
    lastError: readString(initialSync.lastError),
    syncName: readString(initialSync.syncName),
    model: readString(initialSync.model),
    modifiedAfter: readString(initialSync.modifiedAfter),
    byModel: readInitialSyncByModel(initialSync.byModel),
  };

  return readiness;
}

function latestTimestamp(values: Array<string | null | undefined>): string | null {
  const timestamps = values.filter(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  if (timestamps.length === 0) {
    return null;
  }
  timestamps.sort();
  return timestamps[timestamps.length - 1] ?? null;
}

function initialSyncModelKey(input: {
  providerConfigKey?: string | null;
  syncName?: string | null;
  model?: string | null;
}): string | null {
  const providerConfigKey = input.providerConfigKey?.trim();
  const syncName = input.syncName?.trim();
  const model = input.model?.trim();
  if (!providerConfigKey || !syncName || !model) {
    return null;
  }
  return `${providerConfigKey}:${syncName}:${model}`;
}

function modelStatusFromPatch(input: {
  current: InitialSyncModelStatus | null;
  providerConfigKey: string;
  patch: Partial<ProviderReadiness["initialSync"]>;
}): InitialSyncModelStatus {
  const patch = input.patch;
  const state = readInitialSyncState(patch.state) ?? input.current?.state ?? "queued";
  return {
    state,
    providerConfigKey: input.providerConfigKey,
    enqueuedAt:
      patch.enqueuedAt !== undefined
        ? patch.enqueuedAt
        : input.current?.enqueuedAt ?? null,
    startedAt:
      patch.startedAt !== undefined
        ? patch.startedAt
        : input.current?.startedAt ?? null,
    completedAt:
      patch.completedAt !== undefined
        ? patch.completedAt
        : input.current?.completedAt ?? null,
    failedAt:
      patch.failedAt !== undefined
        ? patch.failedAt
        : input.current?.failedAt ?? null,
    lastError:
      patch.lastError !== undefined
        ? patch.lastError
        : input.current?.lastError ?? null,
    syncName: patch.syncName ?? input.current?.syncName ?? null,
    model: patch.model ?? input.current?.model ?? null,
    modifiedAfter:
      patch.modifiedAfter !== undefined
        ? patch.modifiedAfter
        : input.current?.modifiedAfter ?? null,
  };
}

export function aggregateProviderInitialSync(input: {
  initialSync: ProviderReadiness["initialSync"];
  expectedModelKeys?: readonly string[];
}): ProviderReadiness["initialSync"] {
  const { initialSync } = input;
  const expectedModelKeys = input.expectedModelKeys ?? [];
  const modelStatuses = Object.values(initialSync.byModel);
  if (expectedModelKeys.length === 0 || modelStatuses.length === 0) {
    return initialSync;
  }

  const expectedStatuses = expectedModelKeys.map(
    (key) => initialSync.byModel[key] ?? null,
  );
  const presentExpectedStatuses = expectedStatuses.filter(
    (status): status is InitialSyncModelStatus => status !== null,
  );
  if (presentExpectedStatuses.length === 0) {
    return initialSync;
  }

  if (
    initialSync.state === "complete" &&
    initialSync.completedAt &&
    presentExpectedStatuses.every((status) => status.modifiedAfter)
  ) {
    return initialSync;
  }

  const everyExpectedCompleted = expectedStatuses.every(
    (status) => Boolean(status?.completedAt) || status?.state === "complete",
  );
  if (everyExpectedCompleted) {
    const completedAt = latestTimestamp(
      expectedStatuses.map((status) => status?.completedAt),
    );
    const latestCompleted =
      presentExpectedStatuses.find((status) => status.completedAt === completedAt) ??
      presentExpectedStatuses[presentExpectedStatuses.length - 1];
    return {
      ...initialSync,
      ...latestCompleted,
      state: "complete",
      completedAt: completedAt ?? latestCompleted.completedAt,
      failedAt: null,
      lastError: null,
      byModel: initialSync.byModel,
    };
  }

  const failed = presentExpectedStatuses.find(
    (status) => status.state === "failed",
  );
  if (failed) {
    return {
      ...initialSync,
      ...failed,
      state: "failed",
      failedAt: failed.failedAt ?? initialSync.failedAt,
      lastError: failed.lastError ?? initialSync.lastError,
      byModel: initialSync.byModel,
    };
  }

  const running = presentExpectedStatuses.find(
    (status) => status.state === "running" && !status.completedAt,
  );
  if (running) {
    return {
      ...initialSync,
      ...running,
      state: "running",
      byModel: initialSync.byModel,
    };
  }

  const queued =
    presentExpectedStatuses.find(
      (status) => status.state === "queued" && !status.completedAt,
    ) ?? presentExpectedStatuses[presentExpectedStatuses.length - 1];
  return {
    ...initialSync,
    ...queued,
    state: "queued",
    byModel: initialSync.byModel,
  };
}

export function buildLegacyConnectedReadiness(input: {
  connectionId?: string | null;
  providerConfigKey?: string | null;
}): ProviderReadiness {
  const readiness = defaultProviderReadiness();
  readiness.connectionId = input.connectionId?.trim() || null;
  readiness.providerConfigKey = input.providerConfigKey?.trim() || null;
  readiness.initialSync.state = "complete";
  return readiness;
}

export function buildPendingProviderReadiness(input: {
  connectionId?: string | null;
  providerConfigKey?: string | null;
  at?: string;
}): ProviderReadiness {
  const readiness = defaultProviderReadiness();
  readiness.connectionId = input.connectionId?.trim() || null;
  readiness.providerConfigKey = input.providerConfigKey?.trim() || null;
  readiness.updatedAt = input.at ?? new Date().toISOString();
  readiness.initialSync.state = "queued";
  readiness.initialSync.enqueuedAt = readiness.updatedAt;
  return readiness;
}

export function buildPendingProviderMetadata(input: {
  connectionId?: string | null;
  providerConfigKey?: string | null;
  at?: string;
}): Record<string, unknown> {
  return writeProviderReadiness({}, buildPendingProviderReadiness(input));
}

export function writeProviderReadiness(
  metadata: Record<string, unknown>,
  patch: ProviderReadinessPatch,
): Record<string, unknown> {
  const current = readProviderReadiness(metadata) ?? defaultProviderReadiness();
  const patchInitialSync = patch.initialSync ?? {};
  const providerConfigKey =
    patch.providerConfigKey !== undefined
      ? patch.providerConfigKey
      : current.providerConfigKey;
  const byModel =
    patchInitialSync.byModel !== undefined
      ? { ...patchInitialSync.byModel }
      : { ...current.initialSync.byModel };
  const modelKey = initialSyncModelKey({
    providerConfigKey,
    syncName: patchInitialSync.syncName ?? current.initialSync.syncName,
    model: patchInitialSync.model ?? current.initialSync.model,
  });
  if (modelKey && providerConfigKey) {
    byModel[modelKey] = modelStatusFromPatch({
      current: byModel[modelKey] ?? null,
      providerConfigKey,
      patch: patchInitialSync,
    });
  }

  const next: ProviderReadiness = {
    oauthConnectedAt:
      patch.oauthConnectedAt !== undefined
        ? patch.oauthConnectedAt
        : current.oauthConnectedAt,
    lastAuthAt: patch.lastAuthAt !== undefined ? patch.lastAuthAt : current.lastAuthAt,
    connectionId:
      patch.connectionId !== undefined ? patch.connectionId : current.connectionId,
    providerConfigKey,
    updatedAt: patch.updatedAt !== undefined ? patch.updatedAt : current.updatedAt,
    initialSync: {
      ...current.initialSync,
      ...patchInitialSync,
      byModel,
    },
  };

  return {
    ...metadata,
    [READINESS_METADATA_KEY]: next,
  };
}

export function preserveProviderReadiness(
  existingMetadata: Record<string, unknown>,
  nextMetadata: Record<string, unknown>,
): Record<string, unknown> {
  if (READINESS_METADATA_KEY in nextMetadata) {
    return nextMetadata;
  }
  if (!(READINESS_METADATA_KEY in existingMetadata)) {
    return nextMetadata;
  }

  return {
    ...nextMetadata,
    [READINESS_METADATA_KEY]: existingMetadata[READINESS_METADATA_KEY],
  };
}

// ---------------------------------------------------------------------------
// Patch builders for the three initial-sync state transitions.
// Used by both the Lambda path (provider-readiness.ts) and the Worker path
// (provider-readiness-worker.ts) so the patch shape stays in one place.
// ---------------------------------------------------------------------------

export function buildInitialSyncRunningPatch(input: {
  providerConfigKey?: string | null;
  syncName?: string | null;
  model?: string | null;
  modifiedAfter?: string | null;
  at: string;
}): ProviderReadinessPatch {
  return {
    updatedAt: input.at,
    providerConfigKey: input.providerConfigKey ?? undefined,
    initialSync: {
      state: "running",
      startedAt: input.at,
      failedAt: null,
      lastError: null,
      syncName: input.syncName ?? null,
      model: input.model ?? null,
      modifiedAfter: input.modifiedAfter ?? null,
    },
  };
}

export function buildInitialSyncCompletePatch(input: {
  providerConfigKey?: string | null;
  syncName?: string | null;
  model?: string | null;
  modifiedAfter?: string | null;
  at: string;
}): ProviderReadinessPatch {
  return {
    updatedAt: input.at,
    providerConfigKey: input.providerConfigKey ?? undefined,
    initialSync: {
      state: "complete",
      completedAt: input.at,
      failedAt: null,
      lastError: null,
      syncName: input.syncName ?? null,
      model: input.model ?? null,
      modifiedAfter: input.modifiedAfter ?? null,
    },
  };
}

export function buildInitialSyncFailedPatch(input: {
  error: string;
  providerConfigKey?: string | null;
  syncName?: string | null;
  model?: string | null;
  modifiedAfter?: string | null;
  at: string;
}): ProviderReadinessPatch {
  return {
    updatedAt: input.at,
    providerConfigKey: input.providerConfigKey ?? undefined,
    initialSync: {
      state: "failed",
      failedAt: input.at,
      lastError: input.error,
      syncName: input.syncName ?? null,
      model: input.model ?? null,
      modifiedAfter: input.modifiedAfter ?? null,
    },
  };
}

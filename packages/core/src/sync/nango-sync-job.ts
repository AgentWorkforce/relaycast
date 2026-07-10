export type NangoSyncType = "INCREMENTAL" | "INITIAL" | "WEBHOOK";

export type NangoCheckpointValue = string | number | boolean;
export type NangoCheckpoint = Record<string, NangoCheckpointValue>;

export interface NangoCheckpointRange {
  from: NangoCheckpoint | null;
  to: NangoCheckpoint | null;
}

export interface NangoSyncResponseResults {
  added: number;
  updated: number;
  deleted: number;
}

export interface NangoSyncJob {
  type: "nango_sync";
  provider: string;
  connectionId: string;
  providerConfigKey: string;
  syncName: string;
  model: string;
  modifiedAfter: string | null;
  syncType?: NangoSyncType;
  checkpoints?: NangoCheckpointRange | null;
  responseResults?: NangoSyncResponseResults;
  cursor: string | null;
  // Offset within the current Nango page identified by `cursor`.
  // Optional so in-flight jobs queued before mid-page checkpointing remain
  // valid; absent means start at the beginning of the page.
  recordOffset?: number;
  workspaceId: string;
  // Relayfile workspace (rw_<hex>) the sync records should be written into.
  // Legacy workspace_integrations rows store the cloud workspace UUID in
  // workspaceId; relayfile mounts are keyed by the bound rw_ id, so without
  // this the worker writes into a UUID-named workspace nobody mounts.
  // Optional for backward compatibility with in-flight jobs; the worker
  // falls back to workspaceId when absent.
  relayWorkspaceId?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(
  record: Record<string, unknown>,
  key: keyof NangoSyncJob,
): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Invalid Nango sync job: ${String(key)} must be a string`);
  }
  return value;
}

function readNullableString(
  record: Record<string, unknown>,
  key: keyof NangoSyncJob,
): string | null {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid Nango sync job: ${String(key)} must be a string or null`);
  }
  return value;
}

function optionalSyncType(value: unknown): NangoSyncType | undefined {
  return value === "INCREMENTAL" || value === "INITIAL" || value === "WEBHOOK"
    ? value
    : undefined;
}

function isCheckpointValue(value: unknown): value is NangoCheckpointValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function parseCheckpoint(value: unknown, path: string): NangoCheckpoint | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Nango sync job: ${path} must be an object or null`);
  }
  const checkpoint: NangoCheckpoint = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isCheckpointValue(raw)) {
      throw new Error(
        `Invalid Nango sync job: ${path}.${key} must be a string, number, or boolean`,
      );
    }
    checkpoint[key] = raw;
  }
  return checkpoint;
}

function parseCheckpoints(value: unknown): NangoCheckpointRange | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Nango sync job: checkpoints must be an object or null");
  }
  const record = value as Record<string, unknown>;
  return {
    from: parseCheckpoint(record.from, "checkpoints.from"),
    to: parseCheckpoint(record.to, "checkpoints.to"),
  };
}

function parseResponseResults(
  value: unknown,
): NangoSyncResponseResults | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid Nango sync job: responseResults must be an object");
  }
  const record = value as Record<string, unknown>;
  const result: Partial<NangoSyncResponseResults> = {};
  for (const key of ["added", "updated", "deleted"] as const) {
    const raw = record[key];
    if (
      typeof raw !== "number" ||
      !Number.isInteger(raw) ||
      raw < 0
    ) {
      throw new Error(
        `Invalid Nango sync job: responseResults.${key} must be a non-negative integer`,
      );
    }
    result[key] = raw;
  }
  return result as NangoSyncResponseResults;
}

export function parseNangoSyncJob(value: unknown): NangoSyncJob {
  if (!isObject(value)) {
    throw new Error("Invalid Nango sync job: message body must be an object");
  }

  if (value.type !== "nango_sync") {
    throw new Error("Invalid Nango sync job: unsupported type");
  }

  const cursor = value.cursor;
  if (cursor !== null && typeof cursor !== "string") {
    throw new Error("Invalid Nango sync job: cursor must be a string or null");
  }

  const relayWorkspaceId = value.relayWorkspaceId;
  if (relayWorkspaceId !== undefined && typeof relayWorkspaceId !== "string") {
    throw new Error("Invalid Nango sync job: relayWorkspaceId must be a string");
  }

  const syncType = optionalSyncType(value.syncType);
  const checkpoints = parseCheckpoints(value.checkpoints);
  const responseResults = parseResponseResults(value.responseResults);

  const recordOffset = value.recordOffset;
  if (
    recordOffset !== undefined &&
    (typeof recordOffset !== "number" ||
      !Number.isInteger(recordOffset) ||
      recordOffset < 0)
  ) {
    throw new Error("Invalid Nango sync job: recordOffset must be a non-negative integer");
  }

  return {
    type: "nango_sync",
    provider: requireString(value, "provider"),
    connectionId: requireString(value, "connectionId"),
    providerConfigKey: requireString(value, "providerConfigKey"),
    syncName: requireString(value, "syncName"),
    model: requireString(value, "model"),
    modifiedAfter: readNullableString(value, "modifiedAfter"),
    ...(syncType !== undefined ? { syncType } : {}),
    ...(checkpoints !== undefined ? { checkpoints } : {}),
    ...(responseResults !== undefined ? { responseResults } : {}),
    cursor,
    ...(recordOffset !== undefined ? { recordOffset } : {}),
    workspaceId: requireString(value, "workspaceId"),
    // Reconstructing parse: every hop that round-trips through this function
    // drops unknown fields, so the relay workspace MUST be carried here or
    // the bridge/SQS hops silently strip it.
    ...(relayWorkspaceId !== undefined ? { relayWorkspaceId } : {}),
  };
}

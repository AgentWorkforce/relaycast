import type { GitLabHookdeckQueueMessage, NangoSyncQueueMessage } from "./types";

export const NANGO_SYNC_DEDUP_SURFACE = "nango-sync";
export const GITLAB_HOOKDECK_DEDUP_SURFACE = "gitlab-hookdeck-delivery";
export const DEFAULT_DEDUP_LEASE_MS = 15 * 60 * 1000;

export type DedupeClaimInput = {
  surface: typeof NANGO_SYNC_DEDUP_SURFACE | typeof GITLAB_HOOKDECK_DEDUP_SURFACE;
  dedupeId: string;
  workspaceId?: string;
  provider?: string;
  connectionId?: string;
  providerConfigKey?: string;
  syncName?: string;
  model?: string;
  syncWindowKey?: string;
  cursorKey?: string;
  payloadHash?: string;
};

export type DedupeKey = {
  surface: DedupeClaimInput["surface"];
  dedupeId: string;
};

export type DedupeClaimResult =
  | {
      type: "claimed";
      key: DedupeKey;
      attemptCount: number;
      leaseExpiresAt: Date;
    }
  | {
      type: "duplicate_completed";
      key: DedupeKey;
      completedAt?: Date;
    }
  | {
      type: "duplicate_in_flight";
      key: DedupeKey;
      leaseExpiresAt?: Date;
    };

export type NangoSyncDedupStore = {
  claim(input: DedupeClaimInput, options?: { now?: Date; leaseMs?: number }): Promise<DedupeClaimResult>;
  complete(key: DedupeKey, options?: { now?: Date }): Promise<void>;
  fail(key: DedupeKey, error: unknown, options?: { now?: Date }): Promise<void>;
};

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function encodeStableParts(parts: readonly (string | undefined)[]): string {
  return parts.map((part) => {
    const value = part ?? "";
    return `${value.length}:${value}`;
  }).join("|");
}

export function buildNangoSyncDedupeInput(
  message: NangoSyncQueueMessage,
): DedupeClaimInput | null {
  const connectionId = normalizeOptional(message.dedupe.connectionId ?? message.nango.connectionId);
  const syncName = normalizeOptional(message.dedupe.syncName ?? message.nango.syncName);
  const model = normalizeOptional(message.dedupe.model ?? message.nango.model);
  const syncWindowKey = normalizeOptional(message.dedupe.windowKey ?? message.nango.queryTimeStamp);
  const cursorKey = normalizeOptional(message.dedupe.cursorKey ?? message.nango.cursor);

  if (!connectionId || !syncName || !model) {
    return null;
  }

  return {
    surface: NANGO_SYNC_DEDUP_SURFACE,
    dedupeId: `v1:${encodeStableParts([connectionId, syncName, model, syncWindowKey, cursorKey])}`,
    provider: message.provider,
    connectionId,
    providerConfigKey: normalizeOptional(message.nango.providerConfigKey),
    syncName,
    model,
    syncWindowKey,
    cursorKey,
    payloadHash: message.payload.sha256,
  };
}

export function buildGitLabHookdeckDedupeInput(
  message: GitLabHookdeckQueueMessage,
): DedupeClaimInput | null {
  const deliveryId = normalizeOptional(message.dedupe.deliveryId ?? message.gitlab.eventUuid);
  if (!deliveryId) {
    return null;
  }

  return {
    surface: GITLAB_HOOKDECK_DEDUP_SURFACE,
    dedupeId: `v1:${deliveryId}`,
    provider: message.provider,
    payloadHash: message.payload.sha256,
  };
}

export function buildDedupeInput(
  message: NangoSyncQueueMessage | GitLabHookdeckQueueMessage,
): DedupeClaimInput | null {
  return message.ingress === "gitlab-hookdeck"
    ? buildGitLabHookdeckDedupeInput(message)
    : buildNangoSyncDedupeInput(message);
}

export async function withWebhookDedup<T>(
  message: NangoSyncQueueMessage | GitLabHookdeckQueueMessage,
  process: () => Promise<T>,
  options: {
    store?: NangoSyncDedupStore;
    now?: Date;
    leaseMs?: number;
    shouldComplete?: (result: T) => boolean;
    onDuplicateInFlight?: (claim: Extract<DedupeClaimResult, { type: "duplicate_in_flight" }>) => Promise<T>;
    onDuplicateCompleted?: (claim: Extract<DedupeClaimResult, { type: "duplicate_completed" }>) => Promise<T>;
  } = {},
): Promise<T> {
  const dedupeInput = buildDedupeInput(message);
  if (!dedupeInput) {
    return process();
  }

  if (!options.store) {
    throw new Error("withWebhookDedup requires a NangoSyncDedupStore");
  }
  const store = options.store;
  const claim = await store.claim(dedupeInput, {
    now: options.now,
    leaseMs: options.leaseMs,
  });

  if (claim.type === "duplicate_completed") {
    return options.onDuplicateCompleted
      ? options.onDuplicateCompleted(claim)
      : (undefined as T);
  }

  if (claim.type === "duplicate_in_flight") {
    return options.onDuplicateInFlight
      ? options.onDuplicateInFlight(claim)
      : (undefined as T);
  }

  try {
    const result = await process();
    if (options.shouldComplete?.(result) ?? true) {
      await store.complete(claim.key, { now: options.now });
    } else {
      await store.fail(claim.key, new Error("deduped processing did not complete"), {
        now: options.now,
      });
    }
    return result;
  } catch (error) {
    await store.fail(claim.key, error, { now: options.now });
    throw error;
  }
}

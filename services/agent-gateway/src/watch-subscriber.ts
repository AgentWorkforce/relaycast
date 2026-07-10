import { RelayFileClient, type FilesystemEvent } from "@relayfile/sdk";

type WebSocketConnection = {
  on(event: "error" | "close", handler: (event: unknown) => void): void;
  close(): void;
  unsubscribe(): void;
};
import {
  agentMatchesEvent,
  deriveIntegrationWatchDeliveryId,
  type IntegrationWatchAgentRow,
} from "@cloud/core/proactive-runtime/match.js";

import { minimatch } from "minimatch";

import type { AgentEventSummary } from "./summary-builder.js";

type RelayfileSubscribeResult =
  | { close(): void }
  | (() => void)
  | void;

type RelayfileSubscribeMethod =
  | ((globs: string[], onEvent: (event: unknown) => void, options?: Record<string, unknown>) =>
      Promise<RelayfileSubscribeResult> | RelayfileSubscribeResult)
  | ((input: {
      workspace: string;
      globs: string[];
      onEvent: (event: unknown) => void;
      onError?: (error: unknown) => void;
    }) => Promise<RelayfileSubscribeResult> | RelayfileSubscribeResult);

export type RelayfileWatchEvent = Omit<FilesystemEvent, "type"> & {
  id?: string;
  type: FilesystemEvent["type"] | string;
  deliveryId?: string;
  contentHash?: string;
  digest?: string;
  eventType?: string;
  occurredAt?: string;
  paths?: string[];
  resource?: unknown;
  summary?: AgentEventSummary;
};

/**
 * Correlation-id prefix the cloud#2029 legacy-draft drain stamps on its
 * system-origin `file.deleted` tombstones. Kept in sync with the DO drain
 * handler (`relayfile/.../drain-legacy-drafts.ts`).
 */
export const LEGACY_DRAIN_CORRELATION_PREFIX = "relayfile:legacy-draft-drain:";

/**
 * cloud#2029: the legacy-draft drain removes delivered Slack drafts with a
 * system-origin `file.deleted` tombstone. That tombstone MUST stay in the
 * relayfile event feed (mounts consume it via applyRemoteDelete to clear the
 * draft), but it must NOT fan out as an agent-watch notification — else a
 * one-time drain of hundreds of delivered drafts spams subscribers (e.g.
 * @slack-comms) with bogus "deleted" events. Suppress agent-notification
 * delivery for drain-marked tombstones ONLY.
 *
 * NARROW by design: keyed on the exact (type, origin, drain correlation prefix)
 * triple. It must NOT suppress other `system` deletes (digest/sync/d1 emitters),
 * provider deletes, or agent deletes — those still deliver.
 */
export function shouldSuppressRelayfileWatchDelivery(event: {
  type?: string;
  origin?: string;
  correlationId?: string;
}): boolean {
  return (
    event.type === "file.deleted" &&
    event.origin === "system" &&
    typeof event.correlationId === "string" &&
    event.correlationId.startsWith(LEGACY_DRAIN_CORRELATION_PREFIX)
  );
}

export type VfsWatchEvent = {
  workspaceId: string;
  path: string;
  writeId: string;
  provider?: string;
  eventType?: string;
  connectionId?: string;
  payload?: unknown;
  occurredAt: string;
};

export type VfsWatchDispatchCandidate = {
  agentId: string;
  watchGlobs: readonly string[];
  spec?: Record<string, unknown> | null;
  maxBacklog?: number;
};

export type VfsWatchDispatchResult = {
  matched: number;
  delivered: number;
  failed: number;
  skipped: number;
  dedupe: "first" | "skipped";
};

type VfsDedupeRecord = {
  firstSeenAt: number;
  expiresAt: number;
};

type VfsWatchDispatchDependencies = {
  storage: DurableObjectStorage;
  readCandidateAgents(): Promise<VfsWatchDispatchCandidate[]>;
  deliver(
    candidate: VfsWatchDispatchCandidate,
    payload: RelayfileWatchEvent,
  ): Promise<unknown>;
  log(entry: Record<string, unknown>): void;
  nowMs?: () => number;
};

const VFS_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

type ProactiveRelayfileChangeEvent = {
  id?: string;
  type?: string;
  occurredAt?: string;
  resource?: {
    path?: string;
    provider?: string;
  };
  digest?: string;
  summary?: AgentEventSummary;
};

export class WorkspaceWatchSubscriber {
  private globs: string[] = [];
  private websocket: WebSocketConnection | null = null;
  private unsubscribe: (() => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private closed = false;

  constructor(
    private readonly relayfile: RelayFileClient,
    private readonly workspace: string,
    private readonly onEvent: (event: RelayfileWatchEvent) => Promise<void> | void,
    private readonly onError: (error: unknown) => Promise<void> | void,
  ) {}

  async update(globs: readonly string[]): Promise<void> {
    const normalized = [...new Set(
      globs.map((glob) => normalizeGlob(glob)).filter(Boolean),
    )];
    if (sameGlobs(this.globs, normalized)) {
      return;
    }

    this.globs = normalized;
    await this.restart();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.generation += 1;
    this.teardown();
  }

  private async restart(): Promise<void> {
    this.generation += 1;
    this.teardown();

    if (this.closed || this.globs.length === 0) {
      return;
    }

    const generation = this.generation;
    const subscribe = (this.relayfile as RelayFileClient & {
      subscribe?: RelayfileSubscribeMethod;
    }).subscribe;

    if (typeof subscribe === "function") {
      try {
        const onEvent = (event: unknown) => {
          void this.handleRawEvent(generation, event);
        };
        const cleanup = subscribe.length >= 2
          ? await (subscribe as (
              globs: string[],
              callback: (event: unknown) => void,
              options?: Record<string, unknown>,
            ) => Promise<RelayfileSubscribeResult> | RelayfileSubscribeResult)(
              this.globs,
              onEvent,
              { workspace: this.workspace },
            )
          : await (subscribe as (input: {
              workspace: string;
              globs: string[];
              onEvent: (event: unknown) => void;
              onError?: (error: unknown) => void;
            }) => Promise<RelayfileSubscribeResult> | RelayfileSubscribeResult)({
              workspace: this.workspace,
              globs: this.globs,
              onEvent,
              onError: (error) => {
                void this.handleError(generation, error);
              },
            });
        this.unsubscribe = typeof cleanup === "function"
          ? cleanup
          : cleanup && typeof cleanup === "object" && typeof cleanup.close === "function"
            ? () => cleanup.close()
            : null;
        return;
      } catch (error) {
        await this.handleError(generation, error);
      }
    }

    await this.openWebSocket(generation);
  }

  private async openWebSocket(generation: number): Promise<void> {
    try {
      const token = await this.relayfile.getToken();
      const websocket = this.relayfile.connectWebSocket(this.workspace, {
        token,
        onEvent: (event) => {
          void this.handleRawEvent(generation, event);
        },
      });
      websocket.on("error", (error) => {
        void this.handleError(generation, error);
      });
      websocket.on("close", () => {
        void this.handleError(generation, new Error("relayfile websocket closed"));
      });
      this.websocket = websocket;
    } catch (error) {
      await this.handleError(generation, error);
    }
  }

  private async handleRawEvent(generation: number, rawEvent: unknown): Promise<void> {
    if (this.closed || generation !== this.generation) {
      return;
    }

    const event = await this.normalizeEvent(rawEvent);
    if (!event || !matchesAnyGlob(event.path, this.globs)) {
      return;
    }

    await this.onEvent(event);
  }

  private async normalizeEvent(rawEvent: unknown): Promise<RelayfileWatchEvent | null> {
    if (!rawEvent || typeof rawEvent !== "object") {
      return null;
    }

    const event = rawEvent as Partial<RelayfileWatchEvent>;
    if (typeof event.type !== "string" || typeof event.path !== "string") {
      return normalizeProactiveChangeEvent(rawEvent);
    }

    if (typeof event.eventId === "string" && typeof event.timestamp === "string") {
      return event as RelayfileWatchEvent;
    }

    try {
      const recent = await this.relayfile.getEvents(this.workspace, { limit: 50 });
      const match = recent.events.find((candidate) =>
        candidate.type === event.type
        && candidate.path === event.path
        && (event.revision === undefined || candidate.revision === event.revision)
        && (event.timestamp === undefined || candidate.timestamp === event.timestamp),
      );
      if (match) {
        return match as RelayfileWatchEvent;
      }
    } catch {
      // Fall through to a synthetic best-effort event shape.
    }

    return {
      eventId: `relayfile:${this.workspace}:${event.path}:${event.revision ?? "unknown"}:${event.timestamp ?? Date.now().toString()}`,
      type: event.type as FilesystemEvent["type"],
      path: event.path,
      revision: typeof event.revision === "string" ? event.revision : "",
      timestamp:
        typeof event.timestamp === "string"
          ? event.timestamp
          : new Date().toISOString(),
      ...(typeof event.provider === "string" ? { provider: event.provider } : {}),
      ...(typeof event.origin === "string" ? { origin: event.origin } : {}),
      ...(typeof event.correlationId === "string"
        ? { correlationId: event.correlationId }
        : {}),
      ...(typeof event.contentHash === "string" ? { contentHash: event.contentHash } : {}),
      ...(typeof event.digest === "string" ? { digest: event.digest } : {}),
      ...(isChangeEventSummary(event.summary) ? { summary: event.summary } : {}),
    };
  }

  private async handleError(generation: number, error: unknown): Promise<void> {
    if (generation !== this.generation || this.closed) {
      return;
    }

    await this.onError(error);
    if (this.reconnectTimer || this.globs.length === 0) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.restart();
    }, 1_000);
  }

  private teardown(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.websocket?.close();
    this.websocket = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

export async function onVfsWatchEvent(
  event: VfsWatchEvent,
  deps: VfsWatchDispatchDependencies,
): Promise<VfsWatchDispatchResult> {
  const nowMs = deps.nowMs?.() ?? Date.now();

  try {
    const candidates = await deps.readCandidateAgents();
    const provider = event.provider?.trim() || inferProviderFromPath(event.path);
    const eventType = event.eventType?.trim() || "file.updated";
    const eventPaths = [event.path];
    const dedupeWriteId = deriveIntegrationWatchDeliveryId({
      workspaceId: event.workspaceId,
      provider,
      eventType,
      connectionId: event.connectionId,
      paths: eventPaths,
      payload: event.payload,
    });
    const matched = candidates.filter((candidate) =>
      agentMatchesEvent(
        {
          row: {
            id: candidate.agentId,
            watch_globs: [...candidate.watchGlobs],
            spec: candidate.spec ?? null,
          } satisfies IntegrationWatchAgentRow,
          provider,
          eventType,
          eventPaths,
        },
        { requireTriggerSpec: Boolean(candidate.spec) },
      ),
    );

    const payload = buildVfsRelayfileWatchEvent(event, provider);
    const outcomes = await Promise.allSettled(
      matched.map(async (candidate) => {
        const claim = await claimVfsWatchDelivery(
          deps.storage,
          event.workspaceId,
          candidate.agentId,
          dedupeWriteId,
          nowMs,
        );
        if (claim === "skipped") {
          return "skipped" as const;
        }

        try {
          await deps.deliver(candidate, payload);
          return "delivered" as const;
        } catch (error) {
          await releaseVfsWatchDelivery(
            deps.storage,
            event.workspaceId,
            candidate.agentId,
            dedupeWriteId,
          );
          throw error;
        }
      }),
    );
    const delivered = outcomes.filter((outcome) =>
      outcome.status === "fulfilled" && outcome.value === "delivered"
    ).length;
    const skipped = outcomes.filter((outcome) =>
      outcome.status === "fulfilled" && outcome.value === "skipped"
    ).length;
    const failed = outcomes.length - delivered - skipped;

    const result = {
      matched: matched.length,
      delivered,
      failed,
      skipped,
      dedupe: delivered === 0 && failed === 0 && skipped > 0 ? "skipped" as const : "first" as const,
    };
    deps.log(vfsWatchDispatchLog(event, result, failed > 0 ? outcomes : undefined));
    return result;
  } catch (error) {
    deps.log(vfsWatchDispatchLog(event, {
      matched: 0,
      delivered: 0,
      failed: 1,
      skipped: 0,
      dedupe: "first",
    }, error));
    throw error;
  }
}

export function vfsWatchDedupeKey(
  workspaceId: string,
  agentId: string,
  writeId: string,
): string {
  return `dedupe:${workspaceId}:${agentId}:${writeId}`;
}

export async function claimVfsWatchDelivery(
  storage: DurableObjectStorage,
  workspaceId: string,
  agentId: string,
  writeId: string,
  nowMs: number = Date.now(),
): Promise<"claimed" | "skipped"> {
  const key = vfsWatchDedupeKey(workspaceId, agentId, writeId);
  return storage.transaction(async (txn) => {
    const existing = await txn.get<VfsDedupeRecord>(key);
    if (existing && existing.expiresAt > nowMs) {
      return "skipped";
    }

    await txn.put(key, {
      firstSeenAt: nowMs,
      expiresAt: nowMs + VFS_DEDUPE_TTL_MS,
    } satisfies VfsDedupeRecord);
    return "claimed";
  });
}

export async function releaseVfsWatchDelivery(
  storage: DurableObjectStorage,
  workspaceId: string,
  agentId: string,
  writeId: string,
): Promise<void> {
  await storage.delete(vfsWatchDedupeKey(workspaceId, agentId, writeId));
}

function buildVfsRelayfileWatchEvent(
  event: VfsWatchEvent,
  provider: string,
): RelayfileWatchEvent {
  const eventType = event.eventType?.trim();
  const type = eventType ? `${provider}.${eventType}` : "file.updated";
  const resource = event.payload ?? {
    provider,
    path: event.path,
  };
  return {
    id: event.writeId,
    eventId: event.writeId,
    type,
    deliveryId: event.writeId,
    path: event.path,
    paths: [event.path],
    revision: event.writeId,
    timestamp: event.occurredAt,
    occurredAt: event.occurredAt,
    provider,
    ...(eventType ? { eventType } : {}),
    resource,
    ...(eventType
      ? {}
      : typeof event.payload === "object" && event.payload
        ? { summary: event.payload as AgentEventSummary }
        : {}),
  };
}

function vfsWatchDispatchLog(
  event: VfsWatchEvent,
  result: VfsWatchDispatchResult,
  errorOrOutcomes?: unknown,
): Record<string, unknown> {
  return {
    area: "vfs-watch-dispatch",
    workspaceId: event.workspaceId,
    path: event.path,
    writeId: event.writeId,
    matched: result.matched,
    dedupe: result.dedupe,
    delivered: result.delivered,
    failed: result.failed,
    skipped: result.skipped,
    ...(errorOrOutcomes ? { error: collectErrorCauses(errorOrOutcomes) } : {}),
  };
}

function collectErrorCauses(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) =>
        entry && typeof entry === "object" && "status" in entry && entry.status === "rejected"
          ? collectErrorCauses((entry as PromiseRejectedResult).reason)
          : [],
      )
      .filter(Boolean);
  }

  const messages: string[] = [];
  let current: unknown = value;
  while (current) {
    if (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
      continue;
    }
    messages.push(String(current));
    break;
  }
  return messages;
}

function inferProviderFromPath(path: string): string {
  const normalized = path.startsWith("/") ? path.slice(1) : path;
  const [provider] = normalized.split("/");
  return provider?.trim() || "relayfile";
}

function sameGlobs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeGlob(glob: string): string {
  const trimmed = glob.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return (
      minimatch(normalizedPath, glob, { dot: true })
      || minimatch(normalizedPath.slice(1), glob.slice(1), { dot: true })
    );
  });
}

function normalizeProactiveChangeEvent(rawEvent: unknown): RelayfileWatchEvent | null {
  const event = rawEvent as ProactiveRelayfileChangeEvent;
  const resource = event.resource;
  if (
    event.type !== "relayfile.changed"
    || typeof event.id !== "string"
    || typeof event.occurredAt !== "string"
    || !resource
    || typeof resource.path !== "string"
  ) {
    return null;
  }

  return {
    eventId: event.id,
    type: "file.updated",
    path: resource.path,
    revision: typeof event.digest === "string" ? event.digest : "",
    timestamp: event.occurredAt,
    ...(typeof resource.provider === "string" ? { provider: resource.provider } : {}),
    ...(typeof event.digest === "string" ? { contentHash: event.digest, digest: event.digest } : {}),
    ...(isChangeEventSummary(event.summary) ? { summary: event.summary } : {}),
  };
}

function isChangeEventSummary(value: unknown): value is AgentEventSummary {
  return Boolean(value) && typeof value === "object";
}

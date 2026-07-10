import { describe, expect, it, vi } from "vitest";
import {
  buildDedupeInput,
  GITLAB_HOOKDECK_DEDUP_SURFACE,
  NANGO_SYNC_DEDUP_SURFACE,
  withWebhookDedup,
  type DedupeClaimInput,
  type DedupeClaimResult,
  type DedupeKey,
  type NangoSyncDedupStore,
} from "../src/dedup";
import type { GitLabHookdeckQueueMessage, NangoSyncQueueMessage } from "../src/types";

type MemoryRow = DedupeClaimInput & {
  status: "processing" | "completed" | "failed";
  attemptCount: number;
  leaseExpiresAt?: Date;
  completedAt?: Date;
  lastError?: string;
};

class MemoryDedupStore implements NangoSyncDedupStore {
  rows = new Map<string, MemoryRow>();

  private key(input: DedupeClaimInput | DedupeKey): string {
    return `${input.surface}:${input.dedupeId}`;
  }

  async claim(
    input: DedupeClaimInput,
    options: { now?: Date; leaseMs?: number } = {},
  ): Promise<DedupeClaimResult> {
    const now = options.now ?? new Date();
    const leaseExpiresAt = new Date(now.getTime() + (options.leaseMs ?? 60_000));
    const key = this.key(input);
    const existing = this.rows.get(key);

    if (!existing) {
      this.rows.set(key, {
        ...input,
        status: "processing",
        attemptCount: 1,
        leaseExpiresAt,
      });
      return {
        type: "claimed",
        key: { surface: input.surface, dedupeId: input.dedupeId },
        attemptCount: 1,
        leaseExpiresAt,
      };
    }

    if (existing.status === "completed") {
      return {
        type: "duplicate_completed",
        key: { surface: input.surface, dedupeId: input.dedupeId },
        completedAt: existing.completedAt,
      };
    }

    if (
      existing.status === "processing" &&
      existing.leaseExpiresAt &&
      existing.leaseExpiresAt > now
    ) {
      return {
        type: "duplicate_in_flight",
        key: { surface: input.surface, dedupeId: input.dedupeId },
        leaseExpiresAt: existing.leaseExpiresAt,
      };
    }

    existing.status = "processing";
    existing.attemptCount += 1;
    existing.leaseExpiresAt = leaseExpiresAt;
    existing.completedAt = undefined;
    existing.lastError = undefined;
    return {
      type: "claimed",
      key: { surface: input.surface, dedupeId: input.dedupeId },
      attemptCount: existing.attemptCount,
      leaseExpiresAt,
    };
  }

  async complete(key: DedupeKey, options: { now?: Date } = {}): Promise<void> {
    const row = this.rows.get(this.key(key));
    if (!row) return;
    row.status = "completed";
    row.completedAt = options.now ?? new Date();
    row.leaseExpiresAt = undefined;
    row.lastError = undefined;
  }

  async fail(key: DedupeKey, error: unknown): Promise<void> {
    const row = this.rows.get(this.key(key));
    if (!row) return;
    row.status = "failed";
    row.leaseExpiresAt = undefined;
    row.lastError = error instanceof Error ? error.message : String(error);
  }
}

function nangoMessage(overrides: Partial<NangoSyncQueueMessage> = {}): NangoSyncQueueMessage {
  return {
    version: 2,
    provider: "nango",
    ingress: "nango-sync",
    requestId: "req-1",
    receivedAt: "2026-05-19T00:00:00Z",
    headers: {},
    payload: {
      storage: "inline",
      body: "{}",
      sizeBytes: 2,
      sha256: "payload-sha",
    },
    nango: {
      connectionId: "conn-1",
      syncName: "fetch-spaces",
      model: "ConfluenceSpace",
      queryTimeStamp: "2026-05-19T00:00:00Z",
      cursor: "cursor-1",
      providerConfigKey: "confluence-relay",
    },
    dedupe: {
      kind: "nango-sync",
      connectionId: "conn-1",
      syncName: "fetch-spaces",
      model: "ConfluenceSpace",
      windowKey: "2026-05-19T00:00:00Z",
      cursorKey: "cursor-1",
    },
    ...overrides,
  };
}

function gitlabMessage(overrides: Partial<GitLabHookdeckQueueMessage> = {}): GitLabHookdeckQueueMessage {
  return {
    version: 2,
    provider: "nango",
    ingress: "gitlab-hookdeck",
    requestId: "req-gitlab",
    receivedAt: "2026-05-19T00:00:00Z",
    headers: {
      "x-gitlab-event-uuid": "event-uuid-1",
    },
    payload: {
      storage: "inline",
      body: "{}",
      sizeBytes: 2,
      sha256: "payload-sha",
    },
    gitlab: {
      eventUuid: "event-uuid-1",
    },
    hookdeck: {},
    dedupe: {
      kind: "gitlab-hookdeck-delivery",
      deliveryId: "event-uuid-1",
    },
    ...overrides,
  };
}

describe("B2 webhook dedup seam", () => {
  it("derives stable nango sync keys from the locked v2 fields", () => {
    const first = buildDedupeInput(nangoMessage());
    const redelivery = buildDedupeInput(nangoMessage({ requestId: "req-2" }));
    const distinctCursor = buildDedupeInput(nangoMessage({
      dedupe: {
        kind: "nango-sync",
        connectionId: "conn-1",
        syncName: "fetch-spaces",
        model: "ConfluenceSpace",
        windowKey: "2026-05-19T00:00:00Z",
        cursorKey: "cursor-2",
      },
    }));

    expect(first).toMatchObject({
      surface: NANGO_SYNC_DEDUP_SURFACE,
      connectionId: "conn-1",
      syncName: "fetch-spaces",
      model: "ConfluenceSpace",
      syncWindowKey: "2026-05-19T00:00:00Z",
      cursorKey: "cursor-1",
    });
    expect(redelivery?.dedupeId).toBe(first?.dedupeId);
    expect(distinctCursor?.dedupeId).not.toBe(first?.dedupeId);
    expect(first?.dedupeId).not.toContain("req-1");
  });

  it("derives gitlab hookdeck keys from x-gitlab-event-uuid delivery id", () => {
    const first = buildDedupeInput(gitlabMessage());
    const redelivery = buildDedupeInput(gitlabMessage({ requestId: "req-gitlab-2" }));

    expect(first).toMatchObject({
      surface: GITLAB_HOOKDECK_DEDUP_SURFACE,
      dedupeId: "v1:event-uuid-1",
    });
    expect(redelivery?.dedupeId).toBe(first?.dedupeId);
  });

  it("processes only the first concurrent redelivery while the lease is active", async () => {
    const store = new MemoryDedupStore();
    const message = nangoMessage();
    let releaseFirstProcess: ((value: string) => void) | undefined;
    const processed = vi.fn(() => new Promise<string>((resolve) => {
      releaseFirstProcess = resolve;
    }));
    const duplicate = vi.fn(async () => "in-flight");
    const now = new Date("2026-05-19T00:00:00Z");

    const firstPromise = withWebhookDedup(message, processed, {
      store,
      now,
      leaseMs: 60_000,
      onDuplicateInFlight: duplicate,
    });
    const second = await withWebhookDedup(message, processed, {
      store,
      now,
      leaseMs: 60_000,
      onDuplicateInFlight: duplicate,
    });
    releaseFirstProcess?.("processed");
    const first = await firstPromise;

    expect(first).toBe("processed");
    expect(second).toBe("in-flight");
    expect(processed).toHaveBeenCalledOnce();
    expect(duplicate).toHaveBeenCalledOnce();
  });

  it("skips completed duplicates during DLQ replay/redelivery", async () => {
    const store = new MemoryDedupStore();
    const message = nangoMessage();
    const processed = vi.fn(async () => "processed");
    const duplicateCompleted = vi.fn(async () => "already-done");

    await withWebhookDedup(message, processed, { store });
    const replay = await withWebhookDedup(message, processed, {
      store,
      onDuplicateCompleted: duplicateCompleted,
    });

    expect(replay).toBe("already-done");
    expect(processed).toHaveBeenCalledOnce();
    expect(duplicateCompleted).toHaveBeenCalledOnce();
  });

  it("allows failed messages to be reclaimed by DLQ replay without bypassing dedup", async () => {
    const store = new MemoryDedupStore();
    const message = nangoMessage();
    const failure = new Error("write failed");
    const firstProcess = vi.fn(async () => {
      throw failure;
    });
    const replayProcess = vi.fn(async () => "replayed");

    await expect(withWebhookDedup(message, firstProcess, { store })).rejects.toThrow(failure);
    const replay = await withWebhookDedup(message, replayProcess, { store });

    expect(replay).toBe("replayed");
    expect(firstProcess).toHaveBeenCalledOnce();
    expect(replayProcess).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it, vi } from "vitest";
import type {
  ContinuationRecord,
  ContinuationStore,
} from "@agent-assistant/continuation";

import { createSlackUserReplyContinuation } from "./continuation-create";
import { slackUserReplyCorrelationKey } from "./continuation-correlation";

class FakeStore implements ContinuationStore {
  readonly records: ContinuationRecord[] = [];
  readonly deleted: string[] = [];
  failSecondPut = false;

  async put(record: ContinuationRecord): Promise<void> {
    if (this.failSecondPut && this.records.length === 1) {
      throw new Error("second put failed");
    }
    this.records.push(structuredClone(record));
  }

  async get(): Promise<ContinuationRecord | null> {
    return null;
  }

  async delete(continuationId: string): Promise<void> {
    this.deleted.push(continuationId);
  }
}

describe("createSlackUserReplyContinuation", () => {
  const fixedNow = new Date("2026-06-02T12:00:00.000Z");

  it("re-puts the complete created record with only waitFor.correlationKey added", async () => {
    const store = new FakeStore();

    const result = await createSlackUserReplyContinuation({
      store,
      assistantId: "agent-1",
      originTurnId: "turn-1",
      sessionId: "session-1",
      threadId: "slack:channel:C123:thread:1700000000.000100",
      userId: "U123",
      slack: {
        channel: "C123",
        thread: "1700000000.000100",
        user: "U123",
      },
      metadata: {
        workspaceId: "workspace-1",
        relayWorkspaceId: "rw_123",
      },
      now: () => fixedNow,
    });

    expect(store.records).toHaveLength(2);
    const [created, patched] = store.records;
    const expectedKey = slackUserReplyCorrelationKey({
      channel: "C123",
      thread: "1700000000.000100",
      user: "U123",
    });
    expect(result.correlationKey).toBe(expectedKey);
    expect(result.continuation.waitFor).toEqual({
      type: "user_reply",
      correlationKey: expectedKey,
    });
    expect(patched).toEqual({
      ...created,
      waitFor: {
        ...created?.waitFor,
        correlationKey: expectedKey,
      },
    });
  });

  it("deletes the uncorrelated record if the patch put fails", async () => {
    const store = new FakeStore();
    store.failSecondPut = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      createSlackUserReplyContinuation({
        store,
        assistantId: "agent-1",
        originTurnId: "turn-1",
        slack: {
          channel: "C123",
          thread: "1700000000.000100",
          user: "U123",
        },
        now: () => fixedNow,
      }),
    ).rejects.toThrow("second put failed");

    expect(store.records).toHaveLength(1);
    expect(store.deleted).toEqual([store.records[0]?.id]);
    warn.mockRestore();
  });
});

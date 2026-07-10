import {
  createContinuationRuntime,
  type ContinuationRecord,
  type ContinuationStore,
} from "@agent-assistant/continuation";

import {
  slackUserReplyCorrelationKey,
  type SlackUserReplyParts,
} from "./continuation-correlation";

export type CreateSlackUserReplyContinuationInput = {
  store: ContinuationStore;
  assistantId: string;
  originTurnId: string;
  slack: SlackUserReplyParts;
  sessionId?: string;
  threadId?: string;
  userId?: string;
  question?: string;
  bounds?: {
    expiresAt?: string;
    maxResumeAttempts?: number;
  };
  metadata?: Record<string, unknown>;
  now?: () => Date;
};

export async function createSlackUserReplyContinuation(
  input: CreateSlackUserReplyContinuationInput,
): Promise<{ continuation: ContinuationRecord; correlationKey: string }> {
  const now = input.now?.() ?? new Date();
  const createdAt = now.toISOString();
  const correlationKey = slackUserReplyCorrelationKey(input.slack);
  const runtime = createContinuationRuntime({
    store: input.store,
    harness: {
      runResumedTurn: async () => {
        throw new Error(
          "Continuation create route does not run resumed turns.",
        );
      },
    },
    clock: {
      nowMs: () => now.getTime(),
      nowIso: () => createdAt,
    },
  });

  const result = await runtime.create({
    assistantId: input.assistantId,
    originTurnId: input.originTurnId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.bounds ? { bounds: input.bounds } : {}),
    metadata: input.metadata,
    harnessResult: {
      outcome: "needs_clarification",
      stopReason: "clarification_required",
      turnId: input.originTurnId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      assistantMessage: {
        text: input.question ?? "Waiting for a Slack reply.",
      },
      continuation: {
        id: `clarification:${input.originTurnId}`,
        type: "clarification",
        createdAt,
        turnId: input.originTurnId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        resumeToken: `slack:${crypto.randomUUID()}`,
        state: {
          channel: input.slack.channel,
          thread: input.slack.thread,
          user: input.slack.user,
        },
        metadata: {
          kind: "slack_user_reply",
        },
      },
      traceSummary: {
        iterationCount: 0,
        toolCallCount: 0,
        hadContinuation: true,
        finalEventType: "clarification_request",
      },
      usage: {
        modelCalls: 0,
        toolCalls: 0,
      },
    },
  });

  // Interim until cloud#1683 lets create() persist user_reply correlation in
  // the first write.
  const patched: ContinuationRecord = {
    ...result.continuation,
    waitFor: userReplyWaitForWithCorrelation(
      result.continuation,
      correlationKey,
    ),
  };

  try {
    await input.store.put(patched);
  } catch (error) {
    if (input.store.delete) {
      try {
        await input.store.delete(result.continuation.id);
      } catch (deleteError) {
        console.warn(
          "[continuation-create] failed to delete uncorrelated continuation",
          {
            continuationId: result.continuation.id,
            error:
              deleteError instanceof Error
                ? deleteError.message
                : String(deleteError),
          },
        );
      }
    }
    throw error;
  }

  return { continuation: patched, correlationKey };
}

function userReplyWaitForWithCorrelation(
  record: ContinuationRecord,
  correlationKey: string,
): ContinuationRecord["waitFor"] {
  if (record.waitFor.type !== "user_reply") {
    throw new Error(
      `Expected a user_reply continuation from needs_clarification, received ${record.waitFor.type}`,
    );
  }
  return {
    ...record.waitFor,
    correlationKey,
  };
}

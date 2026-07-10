import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  maybeDispatchSlackConversationalAppMention,
  type SlackConversationDispatchDeps,
} from "./dispatch";

function reviewerRow() {
  return {
    id: "agent-pr-reviewer",
    deployed_name: "pr-reviewer",
    spec: {
      intent: "review",
      capabilities: {
        conversational: true,
      },
    },
  };
}

function deps(overrides: Partial<SlackConversationDispatchDeps> = {}): SlackConversationDispatchDeps {
  return {
    routingEnabled: () => true,
    isConversationalPersona: () => true,
    isPullRequestReviewerPersona: () => true,
    conversationalConfig: () => ({
      channels: ["CLOUD"],
      defaultResponder: false,
      identity: { username: "pr-reviewer" },
    }),
    threadOwnerLookup: vi.fn(async () => null),
    recordThreadOwner: vi.fn(async () => undefined),
    startStream: vi.fn(async () => ({ ok: true, ts: "1710000000.000300" })),
    enqueueDelivery: vi.fn(async () => "queued" as const),
    applyPullRequestLabel: vi.fn(async () => ({ ok: true as const })),
    logWarn: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("maybeDispatchSlackConversationalAppMention merge-on-green activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("labels the requested AgentWorkforce PR and confirms in the Slack thread", async () => {
    const testDeps = deps();

    const result = await maybeDispatchSlackConversationalAppMention({
      workspaceId: "workspace-1",
      deliveryId: "delivery-slack-merge-green",
      provider: "slack",
      eventType: "app_mention",
      matched: [reviewerRow() as never],
      enqueuePayload: { type: "slack.app_mention" },
      payload: {
        event_id: "EvMergeGreen1",
        event: {
          channel: "CLOUD",
          ts: "1710000000.000100",
          text: "<@UAPP> pr-reviewer merge-on-green <https://github.com/AgentWorkforce/cloud/pull/211|PR #211>",
        },
      },
    }, testDeps);

    expect(result).toEqual({ matched: 1, delivered: 1, failed: 0 });
    expect(testDeps.applyPullRequestLabel).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      deliveryId: "delivery-slack-merge-green",
      label: "merge-on-green",
      target: {
        owner: "AgentWorkforce",
        repo: "cloud",
        number: 211,
      },
    });
    expect(testDeps.startStream).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      channel: "CLOUD",
      threadTs: "1710000000.000100",
      markdownText: "Enabled merge-on-green for AgentWorkforce/cloud#211.",
      identity: { username: "pr-reviewer" },
    });
    expect(testDeps.enqueueDelivery).not.toHaveBeenCalled();
  });

  it("coalesces concurrent duplicate Slack deliveries for the same event and PR", async () => {
    let resolveLabel!: (value: { ok: true }) => void;
    const labelPromise = new Promise<{ ok: true }>((resolve) => {
      resolveLabel = resolve;
    });
    const testDeps = deps({
      applyPullRequestLabel: vi.fn(async () => labelPromise),
    });
    const input = {
      workspaceId: "workspace-1",
      deliveryId: "delivery-slack-merge-green-duplicate",
      provider: "slack",
      eventType: "app_mention",
      matched: [reviewerRow() as never],
      enqueuePayload: { type: "slack.app_mention" },
      payload: {
        event_id: "EvMergeGreenDuplicate",
        event: {
          channel: "CLOUD",
          ts: "1710000000.000200",
          text: "<@UAPP> pr-reviewer auto-merge AgentWorkforce/cloud#212",
        },
      },
    };

    const first = maybeDispatchSlackConversationalAppMention(input, testDeps);
    const second = maybeDispatchSlackConversationalAppMention(input, testDeps);
    await Promise.resolve();
    expect(testDeps.applyPullRequestLabel).toHaveBeenCalledTimes(1);

    resolveLabel({ ok: true });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { matched: 1, delivered: 1, failed: 0 },
      { matched: 1, delivered: 1, failed: 0 },
    ]);
    expect(testDeps.startStream).toHaveBeenCalledTimes(1);
  });
});

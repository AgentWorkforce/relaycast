import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import * as dispatchModule from "../../../packages/web/lib/integrations/slack-conversation/dispatch.ts";
import * as finalizeModule from "../../../packages/web/lib/proactive-runtime/slack-conversation-dispatch-finalize.ts";
import * as loggerModule from "../../../packages/web/lib/logger.ts";

const resolvedDispatchModule =
  "maybeDispatchSlackConversationalAppMention" in dispatchModule
    ? dispatchModule
    : (dispatchModule as {
      default: typeof dispatchModule;
    }).default;

const { maybeDispatchSlackConversationalAppMention } = resolvedDispatchModule;
const resolvedFinalizeModule =
  "finalizeSlackConversationDispatchResult" in finalizeModule
    ? finalizeModule
    : (finalizeModule as {
      default: typeof finalizeModule;
    }).default;
const resolvedLoggerModule =
  "logger" in loggerModule
    ? loggerModule
    : (loggerModule as {
      default: typeof loggerModule;
    }).default;
const { finalizeSlackConversationDispatchResult } = resolvedFinalizeModule as {
  finalizeSlackConversationDispatchResult: typeof finalizeModule.finalizeSlackConversationDispatchResult;
};
const { logger } = resolvedLoggerModule as {
  logger: typeof loggerModule.logger;
};

afterEach(() => {
  mock.restoreAll();
});

function isConversationalPersona(spec: unknown): boolean {
  const capabilities = (spec as { persona?: { capabilities?: Record<string, unknown> }; capabilities?: Record<string, unknown> })
    ?.persona?.capabilities ?? (spec as { capabilities?: Record<string, unknown> })?.capabilities;
  return Boolean(capabilities?.conversational);
}

function conversationalConfig(spec: unknown) {
  const capabilities = (spec as { persona?: { capabilities?: Record<string, unknown> }; capabilities?: Record<string, unknown> })
    ?.persona?.capabilities ?? (spec as { capabilities?: Record<string, unknown> })?.capabilities;
  const value = capabilities?.conversational;
  const config = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const identity = config.identity && typeof config.identity === "object"
    ? config.identity as { username?: string; iconUrl?: string }
    : undefined;
  return {
    channels: Array.isArray(config.channels) ? config.channels.filter((entry): entry is string => typeof entry === "string") : [],
    defaultResponder: config.defaultResponder === true,
    ...(identity ? { identity } : {}),
  };
}

function matchedRow(input: {
  id: string;
  deployedName?: string;
  channels?: string[];
  defaultResponder?: boolean;
  identity?: {
    username?: string;
    iconUrl?: string;
  };
  conversational?: boolean;
}) {
  return {
    id: input.id,
    deployed_name: input.deployedName ?? input.id,
    watch_globs: ["/slack/channels/**"],
    spec: input.conversational === false
      ? { capabilities: {} }
      : {
        persona: {
          capabilities: {
            conversational: {
              enabled: true,
              defaultResponder: input.defaultResponder ?? false,
              channels: input.channels ?? [],
              ...(input.identity ? { identity: input.identity } : {}),
            },
          },
        },
        agent: {},
      },
  };
}

describe("maybeDispatchSlackConversationalAppMention", () => {
  it("does nothing while the flag is off", async () => {
    const startStream = mock.fn(async () => ({ ok: true as const, ts: "1710000000.000100" }));
    const enqueueDelivery = mock.fn(async () => "queued" as const);
    const threadOwnerLookup = mock.fn(async () => "alpha");
    const recordThreadOwner = mock.fn(async () => undefined);

    const result = await maybeDispatchSlackConversationalAppMention({
      workspaceId: "workspace-1",
      deliveryId: "delivery-1",
      provider: "slack",
      eventType: "app_mention",
      matched: [matchedRow({ id: "agent-1", channels: ["C123"] })],
      payload: {
        channel: "C123",
        text: "<@Ubot> hello there",
      },
      enqueuePayload: {
        type: "slack.app_mention",
        provider: "slack",
      },
    }, {
      routingEnabled: () => false,
      threadOwnerLookup,
      recordThreadOwner,
      isConversationalPersona,
      conversationalConfig,
      startStream,
      enqueueDelivery,
    });

    assert.equal(result, null);
    assert.equal(threadOwnerLookup.mock.callCount(), 0);
    assert.equal(recordThreadOwner.mock.callCount(), 0);
    assert.equal(startStream.mock.callCount(), 0);
    assert.equal(enqueueDelivery.mock.callCount(), 0);
  });

  it("posts exactly one ack and enqueues one delivery for a unique conversational match", async () => {
    const startStream = mock.fn(async () => ({ ok: true as const, ts: "1710000000.000200" }));
    const enqueueDelivery = mock.fn(async () => "queued" as const);
    const recordThreadOwner = mock.fn(async () => undefined);

    const result = await maybeDispatchSlackConversationalAppMention({
      workspaceId: "workspace-1",
      deliveryId: "delivery-2",
      provider: "slack",
      eventType: "app_mention",
      matched: [
        matchedRow({
          id: "agent-1",
          deployedName: "router-one",
          channels: ["C123"],
          defaultResponder: true,
          identity: {
            username: "Router One",
            iconUrl: "https://example.com/router-one.png",
          },
        }),
        matchedRow({
          id: "agent-2",
          deployedName: "observer",
          conversational: false,
        }),
      ],
      payload: {
        channel: "C123",
        text: "<@Ubot> hello there",
      },
      enqueuePayload: {
        type: "slack.app_mention",
        provider: "slack",
        eventType: "app_mention",
      },
    }, {
      routingEnabled: () => true,
      isConversationalPersona,
      conversationalConfig,
      startStream,
      enqueueDelivery,
      recordThreadOwner,
    });

    assert.deepEqual(result, {
      matched: 2,
      delivered: 1,
      failed: 0,
    });
    assert.equal(startStream.mock.callCount(), 1);
    assert.equal(startStream.mock.calls[0]?.arguments[0]?.workspaceId, "workspace-1");
    assert.equal(startStream.mock.calls[0]?.arguments[0]?.channel, "C123");
    assert.equal(startStream.mock.calls[0]?.arguments[0]?.markdownText, "Routing to router-one.");
    assert.equal(startStream.mock.calls[0]?.arguments[0]?.threadTs, undefined);
    assert.deepEqual(startStream.mock.calls[0]?.arguments[0]?.identity, {
      username: "Router One",
      iconUrl: "https://example.com/router-one.png",
    });
    assert.equal(enqueueDelivery.mock.callCount(), 1);
    assert.deepEqual(enqueueDelivery.mock.calls[0]?.arguments[0], {
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-2",
      payload: {
        type: "slack.app_mention",
        provider: "slack",
        eventType: "app_mention",
        slackConversation: {
          channel: "C123",
          threadTs: "1710000000.000200",
          ackTs: "1710000000.000200",
          selectedVia: "channel",
        },
      },
    });
  });

  it("accepts a raw Slack event_callback envelope as well as the normalized relayfile record", async () => {
    const startStream = mock.fn(async () => ({ ok: true as const, ts: "1710000000.000201" }));
    const enqueueDelivery = mock.fn(async () => "queued" as const);

    const result = await maybeDispatchSlackConversationalAppMention({
      workspaceId: "workspace-1",
      deliveryId: "delivery-raw-envelope",
      provider: "slack",
      eventType: "app_mention",
      matched: [
        matchedRow({
          id: "agent-1",
          deployedName: "router-one",
          channels: ["C123"],
        }),
      ],
      payload: {
        type: "event_callback",
        team_id: "T123",
        event: {
          type: "app_mention",
          channel: "C123",
          thread_ts: "1710000000.000001",
          text: "<@Ubot> hello from raw Slack",
        },
      },
      enqueuePayload: {
        type: "slack.app_mention",
        provider: "slack",
      },
    }, {
      routingEnabled: () => true,
      isConversationalPersona,
      conversationalConfig,
      startStream,
      enqueueDelivery,
      recordThreadOwner: async () => undefined,
    });

    assert.deepEqual(result, {
      matched: 1,
      delivered: 1,
      failed: 0,
    });
    assert.deepEqual(startStream.mock.calls[0]?.arguments[0], {
      workspaceId: "workspace-1",
      channel: "C123",
      threadTs: "1710000000.000001",
      markdownText: "Routing to router-one.",
    });
    const enqueued = enqueueDelivery.mock.calls[0]?.arguments[0] as {
      payload?: { slackConversation?: { threadTs?: string } };
    } | undefined;
    assert.equal(
      enqueued?.payload?.slackConversation?.threadTs,
      "1710000000.000001",
    );
  });

  it("normalizes suffixed Relayfile channel segments before routing and marker creation", async () => {
    const startStream = mock.fn(async () => ({ ok: true as const, ts: "1710000000.000202" }));
    const enqueueDelivery = mock.fn(async () => "queued" as const);
    const threadOwnerLookup = mock.fn(async ({ channel }: { channel: string }) => {
      assert.equal(channel, "C123");
      return "router-one";
    });
    const recordThreadOwner = mock.fn(async ({ channel }: { channel: string }) => {
      assert.equal(channel, "C123");
    });

    const result = await maybeDispatchSlackConversationalAppMention({
      workspaceId: "workspace-1",
      deliveryId: "delivery-suffixed-channel",
      provider: "slack",
      eventType: "app_mention",
      matched: [
        matchedRow({
          id: "agent-1",
          deployedName: "router-one",
          channels: ["C123"],
        }),
      ],
      payload: {
        channel: "C123__proj-cloud",
        thread_ts: "1710000000.000001",
        text: "<@Ubot> hello from suffixed path",
      },
      enqueuePayload: {
        type: "slack.app_mention",
        provider: "slack",
      },
    }, {
      routingEnabled: () => true,
      threadOwnerLookup,
      isConversationalPersona,
      conversationalConfig,
      startStream,
      enqueueDelivery,
      recordThreadOwner,
    });

    assert.deepEqual(result, {
      matched: 1,
      delivered: 1,
      failed: 0,
    });
    assert.deepEqual(startStream.mock.calls[0]?.arguments[0], {
      workspaceId: "workspace-1",
      channel: "C123",
      threadTs: "1710000000.000001",
      markdownText: "Routing to router-one.",
    });
    assert.deepEqual(enqueueDelivery.mock.calls[0]?.arguments[0], {
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-suffixed-channel",
      payload: {
        type: "slack.app_mention",
        provider: "slack",
        slackConversation: {
          channel: "C123",
          threadTs: "1710000000.000001",
          ackTs: "1710000000.000202",
          selectedVia: "thread",
        },
      },
    });
  });

  it("normalizes suffixed conversational config channels before channel fallback routing", async () => {
    const startStream = mock.fn(async () => ({ ok: true as const, ts: "1710000000.000203" }));
    const enqueueDelivery = mock.fn(async () => "queued" as const);
    const recordThreadOwner = mock.fn(async ({ channel, threadTs }: { channel: string; threadTs: string }) => {
      assert.equal(channel, "C123");
      assert.equal(threadTs, "1710000000.000203");
    });

    const result = await maybeDispatchSlackConversationalAppMention({
      workspaceId: "workspace-1",
      deliveryId: "delivery-suffixed-config-channel",
      provider: "slack",
      eventType: "app_mention",
      matched: [
        matchedRow({
          id: "agent-1",
          deployedName: "router-one",
          channels: ["C123__support"],
        }),
      ],
      payload: {
        channel: "C123",
        text: "<@Ubot> hello there",
      },
      enqueuePayload: {
        type: "slack.app_mention",
        provider: "slack",
      },
    }, {
      routingEnabled: () => true,
      isConversationalPersona,
      conversationalConfig,
      startStream,
      enqueueDelivery,
      recordThreadOwner,
    });

    assert.deepEqual(result, {
      matched: 1,
      delivered: 1,
      failed: 0,
    });
    assert.deepEqual(startStream.mock.calls[0]?.arguments[0], {
      workspaceId: "workspace-1",
      channel: "C123",
      threadTs: undefined,
      markdownText: "Routing to router-one.",
    });
    assert.deepEqual(enqueueDelivery.mock.calls[0]?.arguments[0], {
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-suffixed-config-channel",
      payload: {
        type: "slack.app_mention",
        provider: "slack",
        slackConversation: {
          channel: "C123",
          threadTs: "1710000000.000203",
          ackTs: "1710000000.000203",
          selectedVia: "channel",
        },
      },
    });
    await Promise.resolve();
    assert.equal(recordThreadOwner.mock.callCount(), 1);
  });

  it("falls through unchanged when conversational candidates produce no route", async () => {
    const startStream = mock.fn(async () => ({ ok: true as const, ts: "1710000000.000250" }));
    const enqueueDelivery = mock.fn(async () => "queued" as const);

    const result = await maybeDispatchSlackConversationalAppMention({
      workspaceId: "workspace-1",
      deliveryId: "delivery-none",
      provider: "slack",
      eventType: "app_mention",
      matched: [matchedRow({ id: "agent-1", deployedName: "alpha", channels: ["C999"] })],
      payload: {
        channel: "C123",
        text: "<@Ubot> hello there",
      },
      enqueuePayload: {
        type: "slack.app_mention",
        provider: "slack",
      },
    }, {
      routingEnabled: () => true,
      isConversationalPersona,
      conversationalConfig,
      startStream,
      enqueueDelivery,
    });

    assert.equal(result, null);
    assert.equal(startStream.mock.callCount(), 0);
    assert.equal(enqueueDelivery.mock.callCount(), 0);
  });

  it("prefers the thread owner over a lower-precedence prefix match", async () => {
    const startStream = mock.fn(async () => ({ ok: true as const, ts: "1710000000.000400" }));
    const enqueueDelivery = mock.fn(async () => "queued" as const);
    const recordThreadOwner = mock.fn(async () => undefined);
    const threadOwnerLookup = mock.fn(async ({ workspaceId, channel, threadTs }: {
      workspaceId: string;
      channel: string;
      threadTs: string;
    }) => {
      assert.equal(workspaceId, "workspace-1");
      assert.equal(channel, "C123");
      assert.equal(threadTs, "1710000000.000001");
      return "beta";
    });

    const result = await maybeDispatchSlackConversationalAppMention({
      workspaceId: "workspace-1",
      deliveryId: "delivery-thread",
      provider: "slack",
      eventType: "app_mention",
      matched: [
        matchedRow({
          id: "agent-1",
          deployedName: "alpha",
          channels: ["C123"],
          defaultResponder: true,
        }),
        matchedRow({
          id: "agent-2",
          deployedName: "beta",
          channels: ["C999"],
          identity: {
            username: "Beta Bot",
            iconUrl: "https://example.com/beta.png",
          },
        }),
      ],
      payload: {
        channel: "C123",
        thread_ts: "1710000000.000001",
        text: "<@Ubot> alpha: please help",
      },
      enqueuePayload: {
        type: "slack.app_mention",
        provider: "slack",
      },
    }, {
      routingEnabled: () => true,
      threadOwnerLookup,
      isConversationalPersona,
      conversationalConfig,
      startStream,
      enqueueDelivery,
      recordThreadOwner,
    });

    assert.deepEqual(result, {
      matched: 2,
      delivered: 1,
      failed: 0,
    });
    assert.equal(threadOwnerLookup.mock.callCount(), 1);
    assert.deepEqual(startStream.mock.calls[0]?.arguments[0], {
      workspaceId: "workspace-1",
      channel: "C123",
      threadTs: "1710000000.000001",
      markdownText: "Routing to beta.",
      identity: {
        username: "Beta Bot",
        iconUrl: "https://example.com/beta.png",
      },
    });
    assert.deepEqual(enqueueDelivery.mock.calls[0]?.arguments[0], {
      workspaceId: "workspace-1",
      agentId: "agent-2",
      deliveryId: "delivery-thread",
      payload: {
        type: "slack.app_mention",
        provider: "slack",
        slackConversation: {
          channel: "C123",
          threadTs: "1710000000.000001",
          ackTs: "1710000000.000400",
          selectedVia: "thread",
        },
      },
    });
  });

  it("records the selected thread owner with the ack ts when the ack starts the thread", async () => {
    const startStream = mock.fn(async () => ({ ok: true as const, ts: "1710000000.000555" }));
    const enqueueDelivery = mock.fn(async () => "queued" as const);
    const recordThreadOwner = mock.fn(async () => undefined);

    const result = await maybeDispatchSlackConversationalAppMention({
      workspaceId: "workspace-1",
      deliveryId: "delivery-record-ack-thread",
      provider: "slack",
      eventType: "app_mention",
      matched: [
        matchedRow({
          id: "agent-1",
          deployedName: "alpha",
          channels: ["C123"],
          defaultResponder: true,
        }),
      ],
      payload: {
        channel: "C123",
        text: "<@Ubot> hello there",
      },
      enqueuePayload: {
        type: "slack.app_mention",
        provider: "slack",
      },
    }, {
      routingEnabled: () => true,
      isConversationalPersona,
      conversationalConfig,
      startStream,
      enqueueDelivery,
      recordThreadOwner,
    });

    assert.deepEqual(result, {
      matched: 1,
      delivered: 1,
      failed: 0,
    });
    await Promise.resolve();
    assert.equal(recordThreadOwner.mock.callCount(), 1);
    assert.deepEqual(recordThreadOwner.mock.calls[0]?.arguments[0], {
      workspaceId: "workspace-1",
      channel: "C123",
      threadTs: "1710000000.000555",
      deployedName: "alpha",
      agentId: "agent-1",
    });
  });

  it("swallows thread owner recording failures after a successful dispatch", async () => {
    const warn = mock.method(logger, "warn", async () => undefined);
    const startStream = mock.fn(async () => ({ ok: true as const, ts: "1710000000.000556" }));
    const enqueueDelivery = mock.fn(async () => "queued" as const);
    const recordThreadOwner = mock.fn(async () => {
      throw new Error("db down");
    });

    const result = await maybeDispatchSlackConversationalAppMention({
      workspaceId: "workspace-1",
      deliveryId: "delivery-record-failure",
      provider: "slack",
      eventType: "app_mention",
      matched: [
        matchedRow({
          id: "agent-1",
          deployedName: "alpha",
          channels: ["C123"],
          defaultResponder: true,
        }),
      ],
      payload: {
        channel: "C123",
        text: "<@Ubot> hello there",
      },
      enqueuePayload: {
        type: "slack.app_mention",
        provider: "slack",
      },
    }, {
      routingEnabled: () => true,
      isConversationalPersona,
      conversationalConfig,
      startStream,
      enqueueDelivery,
      recordThreadOwner,
      // Inject the warn sink so the spy observes the call regardless of how
      // the source module resolves @/lib/logger (module-instance duality
      // broke this assertion in CI while passing locally).
      logWarn: (message, fields) => logger.warn(message, fields),
    });

    assert.deepEqual(result, {
      matched: 1,
      delivered: 1,
      failed: 0,
    });
    await Promise.resolve();
    assert.equal(recordThreadOwner.mock.callCount(), 1);
    assert.equal(
      warn.mock.calls.some(
        (call) => call.arguments[1]?.diag === "slack-conversation-thread-owner-record-dispatch-failed",
      ),
      true,
    );
  });

  it("posts a disambiguation message and skips enqueue when routing is ambiguous", async () => {
    const startStream = mock.fn(async () => ({ ok: true as const, ts: "1710000000.000300" }));
    const enqueueDelivery = mock.fn(async () => "queued" as const);
    const threadOwnerLookup = mock.fn(async () => null);

    const result = await maybeDispatchSlackConversationalAppMention({
      workspaceId: "workspace-1",
      deliveryId: "delivery-3",
      provider: "slack",
      eventType: "app_mention",
      matched: [
        matchedRow({ id: "agent-1", deployedName: "alpha", channels: ["C123"] }),
        matchedRow({ id: "agent-2", deployedName: "beta", channels: ["C123"] }),
      ],
      payload: {
        channel: "C123",
        thread_ts: "1710000000.000001",
        text: "<@Ubot> help",
      },
      enqueuePayload: {
        type: "slack.app_mention",
        provider: "slack",
      },
    }, {
      routingEnabled: () => true,
      threadOwnerLookup,
      isConversationalPersona,
      conversationalConfig,
      startStream,
      enqueueDelivery,
    });

    assert.deepEqual(result, {
      matched: 2,
      delivered: 0,
      failed: 0,
    });
    assert.equal(startStream.mock.callCount(), 1);
    assert.deepEqual(startStream.mock.calls[0]?.arguments[0], {
      workspaceId: "workspace-1",
      channel: "C123",
      threadTs: "1710000000.000001",
      markdownText: "Please specify one of: alpha, beta",
    });
    assert.equal(enqueueDelivery.mock.callCount(), 0);
  });

  it("counts a failed disambiguation post as a failed dispatch", async () => {
    const warn = mock.method(logger, "warn", async () => undefined);
    const startStream = mock.fn(async () => ({
      ok: false as const,
      error: "channel not found",
      errorDetail: {
        code: "channel_not_found",
        message: "channel not found",
      },
    }));
    const enqueueDelivery = mock.fn(async () => "queued" as const);
    const threadOwnerLookup = mock.fn(async () => null);

    const result = await maybeDispatchSlackConversationalAppMention({
      workspaceId: "workspace-1",
      deliveryId: "delivery-ambiguous-failure",
      provider: "slack",
      eventType: "app_mention",
      matched: [
        matchedRow({ id: "agent-1", deployedName: "alpha", channels: ["C123"] }),
        matchedRow({ id: "agent-2", deployedName: "beta", channels: ["C123"] }),
      ],
      payload: {
        channel: "C123",
        thread_ts: "1710000000.000001",
        text: "<@Ubot> help",
      },
      enqueuePayload: {
        type: "slack.app_mention",
        provider: "slack",
      },
    }, {
      routingEnabled: () => true,
      threadOwnerLookup,
      recordThreadOwner: async () => undefined,
      isConversationalPersona,
      conversationalConfig,
      startStream,
      enqueueDelivery,
      logWarn: (message, fields) => logger.warn(message, fields),
    });

    assert.deepEqual(result, {
      matched: 2,
      delivered: 0,
      failed: 1,
    });
    assert.equal(startStream.mock.callCount(), 1);
    assert.equal(enqueueDelivery.mock.callCount(), 0);
    assert.equal(warn.mock.callCount(), 1);
    assert.equal(warn.mock.calls[0]?.arguments[1]?.diag, "slack-conversation-disambiguation-failed");
  });

  it("preserves the matched breadcrumb when conversational dispatch returns early", async () => {
    const info = mock.method(logger, "info", async () => undefined);
    const result = await finalizeSlackConversationDispatchResult({
      workspaceId: "workspace-1",
      relayWorkspaceId: null,
      provider: "slack",
      eventType: "app_mention",
      deliveryId: "delivery-dispatch-early-return",
      matched: [
        matchedRow({ id: "agent-1", deployedName: "router-one", channels: ["C123"] }),
      ],
      result: {
        matched: 1,
        delivered: 1,
        failed: 0,
      },
    }, {
      logInfo: (message, fields) => logger.info(message, fields),
    });

    assert.deepEqual(result, {
      matched: 1,
      delivered: 1,
      failed: 0,
    });
    assert.equal(
      info.mock.calls.some((call) => call.arguments[1]?.diag === "matched"),
      true,
    );
  });

  it("leaves dispatcher fallback paths untouched when conversational routing does not claim the event", async () => {
    const info = mock.method(logger, "info", async () => undefined);
    const result = await finalizeSlackConversationDispatchResult({
      workspaceId: "workspace-1",
      relayWorkspaceId: null,
      provider: "slack",
      eventType: "app_mention",
      deliveryId: "delivery-dispatch-no-match",
      matched: [
        matchedRow({ id: "agent-1", deployedName: "router-one", channels: ["C123"] }),
      ],
      result: null,
    }, {
      logInfo: (message, fields) => logger.info(message, fields),
    });

    assert.equal(result, null);
    assert.equal(
      info.mock.calls.some((call) => call.arguments[1]?.diag === "matched"),
      false,
    );
  });
});

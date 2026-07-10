import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as routerModule from "../../../packages/web/lib/integrations/slack-conversation/router.ts";
import * as flagModule from "../../../packages/web/lib/integrations/slack-conversation/flag.ts";

type ConversationalCandidate = {
  deployedName: string;
  channels?: readonly string[] | null;
  defaultResponder?: boolean;
};

// tsx CJS interop can land the named exports on `.default`; resolve like the
// sibling egress/dispatcher-flag tests do. A bare namespace destructure here
// has broken CI twice ("selectConversationalAgent is not a function").
const resolvedRouterModule = (
  "selectConversationalAgent" in routerModule
    ? routerModule
    : (routerModule as { default: typeof routerModule }).default
) as typeof routerModule;
const resolvedFlagModule = (
  "isSlackConversationRoutingEnabled" in flagModule
    ? flagModule
    : (flagModule as { default: typeof flagModule }).default
) as typeof flagModule;

const { selectConversationalAgent } = resolvedRouterModule;
const {
  isSlackConversationRoutingEnabled,
  SLACK_CONVERSATION_ROUTING_TEST_ENV,
} = resolvedFlagModule;

function candidate(
  deployedName: string,
  overrides: Partial<ConversationalCandidate> = {},
): ConversationalCandidate {
  return {
    deployedName,
    channels: [],
    defaultResponder: false,
    ...overrides,
  };
}

describe("selectConversationalAgent", () => {
  it("prefers the thread owner over every lower-precedence tier", () => {
    const result = selectConversationalAgent({
      candidates: [
        candidate("alpha", { defaultResponder: true }),
        candidate("beta", { channels: ["C123"] }),
      ],
      event: {
        channel: "C123",
        text: "<@Ubot> beta: please take this",
      },
      threadOwner: "alpha",
    });

    assert.deepEqual(result, {
      kind: "selected",
      agent: candidate("alpha", { defaultResponder: true }),
      via: "thread",
    });
  });

  it("marks duplicate thread-owner matches ambiguous", () => {
    const duplicate = candidate("alpha");
    const result = selectConversationalAgent({
      candidates: [duplicate, candidate("Alpha"), candidate("beta", { defaultResponder: true })],
      event: { channel: "C123", text: "<@Ubot> beta: hello" },
      threadOwner: "ALPHA",
    });

    assert.equal(result.kind, "ambiguous");
    assert.deepEqual(result.candidates, [duplicate, candidate("Alpha")]);
  });

  it("matches the first token after the bot mention case-insensitively", () => {
    const beta = candidate("beta");
    const result = selectConversationalAgent({
      candidates: [candidate("alpha"), beta],
      event: {
        channel: "C123",
        text: "  <@Ubot>   BeTa: please investigate",
      },
    });

    assert.deepEqual(result, {
      kind: "selected",
      agent: beta,
      via: "prefix",
    });
  });

  it("treats duplicate prefix matches as ambiguous", () => {
    const first = candidate("beta");
    const second = candidate("BETA");
    const result = selectConversationalAgent({
      candidates: [candidate("alpha"), first, second],
      event: {
        channel: "C123",
        text: "<@Ubot> beta: please investigate",
      },
    });

    assert.equal(result.kind, "ambiguous");
    assert.deepEqual(result.candidates, [first, second]);
  });

  it("falls back to an exact channel match when no thread or prefix owner matches", () => {
    const channelOwner = candidate("alpha", { channels: ["C123", "#support"] });
    const result = selectConversationalAgent({
      candidates: [
        channelOwner,
        candidate("beta", { channels: ["C999"] }),
      ],
      event: {
        channel: "#support",
        text: "<@Ubot> hello team",
      },
    });

    assert.deepEqual(result, {
      kind: "selected",
      agent: channelOwner,
      via: "channel",
    });
  });

  it("treats multiple matching channel responders as ambiguous", () => {
    const first = candidate("alpha", { channels: ["C123"] });
    const second = candidate("beta", { channels: ["C123"] });
    const result = selectConversationalAgent({
      candidates: [first, second, candidate("gamma", { defaultResponder: true })],
      event: {
        channel: "C123",
        text: "<@Ubot> hello team",
      },
    });

    assert.equal(result.kind, "ambiguous");
    assert.deepEqual(result.candidates, [first, second]);
  });

  it("uses the unique default responder when higher tiers do not match", () => {
    const defaultResponder = candidate("alpha", { defaultResponder: true });
    const result = selectConversationalAgent({
      candidates: [
        defaultResponder,
        candidate("beta", { channels: ["C999"] }),
      ],
      event: {
        channel: "C123",
        text: "<@Ubot> hello team",
      },
    });

    assert.deepEqual(result, {
      kind: "selected",
      agent: defaultResponder,
      via: "default",
    });
  });

  it("treats multiple default responders as ambiguous", () => {
    const first = candidate("alpha", { defaultResponder: true });
    const second = candidate("beta", { defaultResponder: true });
    const result = selectConversationalAgent({
      candidates: [first, second],
      event: {
        channel: "C123",
        text: "<@Ubot> hello team",
      },
    });

    assert.equal(result.kind, "ambiguous");
    assert.deepEqual(result.candidates, [first, second]);
  });

  it("returns none when every tier misses", () => {
    const result = selectConversationalAgent({
      candidates: [candidate("alpha"), candidate("beta", { channels: ["C999"] })],
      event: {
        channel: "C123",
        text: "<@Ubot> hello team",
      },
    });

    assert.deepEqual(result, { kind: "none" });
  });
});

describe("isSlackConversationRoutingEnabled", () => {
  it("keeps the flag default-off", () => {
    delete process.env.CLOUD_SLACK_CONVERSATION_ROUTING_ENABLED;
    delete process.env[SLACK_CONVERSATION_ROUTING_TEST_ENV];

    assert.equal(isSlackConversationRoutingEnabled(), false);
  });

  it("honors the test env toggle", () => {
    delete process.env.CLOUD_SLACK_CONVERSATION_ROUTING_ENABLED;
    process.env[SLACK_CONVERSATION_ROUTING_TEST_ENV] = "enabled";

    assert.equal(isSlackConversationRoutingEnabled(), true);

    delete process.env[SLACK_CONVERSATION_ROUTING_TEST_ENV];
  });
});

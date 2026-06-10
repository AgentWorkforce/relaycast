import { describe, expect, it } from "vitest";
import {
  extractAgentRelayDistinctId,
  extractOriginActor,
  UNKNOWN_ORIGIN_ACTOR,
} from "../origin.js";

function req(
  init: {
    agentRelayDistinctId?: string;
    agentRelayDistinctQuery?: string;
    header?: string;
    query?: string;
  } = {},
): Request {
  const url = new URL("https://gateway.relaycast.dev/v1/activity");
  if (init.query !== undefined) url.searchParams.set("origin_actor", init.query);
  if (init.agentRelayDistinctQuery !== undefined) {
    url.searchParams.set("agent_relay_distinct_id", init.agentRelayDistinctQuery);
  }
  const headers = new Headers();
  if (init.header !== undefined)
    headers.set("X-Relaycast-Origin-Actor", init.header);
  if (init.agentRelayDistinctId !== undefined) {
    headers.set("X-Agent-Relay-Distinct-Id", init.agentRelayDistinctId);
  }
  return new Request(url, { headers });
}

describe("extractOriginActor", () => {
  it("reads the X-Relaycast-Origin-Actor header, lowercased", () => {
    expect(extractOriginActor(req({ header: "Claude-Code" }))).toBe("claude-code");
  });

  it("accepts a UA-style token", () => {
    expect(
      extractOriginActor(req({ header: "claude-code/2.3 (model=opus-4.8; fast)" })),
    ).toBe("claude-code/2.3 (model=opus-4.8; fast)");
  });

  it("falls back to the `origin_actor` query param (browser WS path)", () => {
    expect(extractOriginActor(req({ query: "codex" }))).toBe("codex");
  });

  it("prefers the header over the query param", () => {
    expect(extractOriginActor(req({ header: "claude-code", query: "codex" }))).toBe(
      "claude-code",
    );
  });

  it("returns unknown when neither is present", () => {
    expect(extractOriginActor(req())).toBe(UNKNOWN_ORIGIN_ACTOR);
  });

  it("rejects disallowed characters in the header", () => {
    expect(extractOriginActor(req({ header: "claude<script>" }))).toBe(
      UNKNOWN_ORIGIN_ACTOR,
    );
  });

  it("rejects CRLF smuggled through the query param", () => {
    // The runtime Headers object already blocks CRLF header values, so the only
    // way control characters reach us is the query string — drop them there too.
    expect(extractOriginActor(req({ query: "evil\r\nX-Inject: bad" }))).toBe(
      UNKNOWN_ORIGIN_ACTOR,
    );
  });

  it("rejects empty / whitespace-only values", () => {
    expect(extractOriginActor(req({ header: "   " }))).toBe(UNKNOWN_ORIGIN_ACTOR);
  });

  it("truncates to 128 characters", () => {
    expect(extractOriginActor(req({ header: "a".repeat(200) }))).toBe(
      "a".repeat(128),
    );
  });

  it("accepts a {app}/{type}/{name} path", () => {
    expect(
      extractOriginActor(req({ header: "agent-relay-cli/agent/claude-code" })),
    ).toBe("agent-relay-cli/agent/claude-code");
    expect(extractOriginActor(req({ header: "pear/user/send-message-box" }))).toBe(
      "pear/user/send-message-box",
    );
    expect(extractOriginActor(req({ header: "agent-relay-cli/cli" }))).toBe(
      "agent-relay-cli/cli",
    );
  });
});

describe("extractAgentRelayDistinctId", () => {
  it("reads a sanitized Agent Relay distinct id header", () => {
    expect(
      extractAgentRelayDistinctId(req({ agentRelayDistinctId: "abc123def4567890" })),
    ).toBe("abc123def4567890");
  });

  it("falls back to the Agent Relay distinct id query param", () => {
    expect(
      extractAgentRelayDistinctId(
        req({ agentRelayDistinctQuery: "abc123def4567890" }),
      ),
    ).toBe("abc123def4567890");
  });

  it("prefers the Agent Relay distinct id header over the query param", () => {
    expect(
      extractAgentRelayDistinctId(
        req({
          agentRelayDistinctId: "from-header",
          agentRelayDistinctQuery: "from-query",
        }),
      ),
    ).toBe("from-header");
  });

  it("rejects empty or malformed ids", () => {
    expect(extractAgentRelayDistinctId(req())).toBeUndefined();
    expect(
      extractAgentRelayDistinctId(req({ agentRelayDistinctId: "   " })),
    ).toBeUndefined();
    expect(
      extractAgentRelayDistinctId(req({ agentRelayDistinctId: "abc<script>" })),
    ).toBeUndefined();
    expect(
      extractAgentRelayDistinctId(
        req({ agentRelayDistinctQuery: "evil\r\nX-Inject: bad" }),
      ),
    ).toBeUndefined();
  });

  it("truncates long ids", () => {
    expect(
      extractAgentRelayDistinctId(req({ agentRelayDistinctId: "a".repeat(200) })),
    ).toBe("a".repeat(128));
  });
});

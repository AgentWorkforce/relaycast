import { describe, expect, it } from "vitest";
import {
  extractAgentRelayAnonymousId,
  extractHarness,
  UNKNOWN_HARNESS,
} from "../origin.js";

function req(
  init: {
    agentRelayId?: string;
    agentRelayQuery?: string;
    header?: string;
    query?: string;
  } = {},
): Request {
  const url = new URL("https://gateway.relaycast.dev/v1/activity");
  if (init.query !== undefined) url.searchParams.set("harness", init.query);
  if (init.agentRelayQuery !== undefined) {
    url.searchParams.set("agent_relay_anonymous_id", init.agentRelayQuery);
  }
  const headers = new Headers();
  if (init.header !== undefined)
    headers.set("X-Relaycast-Harness", init.header);
  if (init.agentRelayId !== undefined) {
    headers.set("X-Agent-Relay-Anonymous-Id", init.agentRelayId);
  }
  return new Request(url, { headers });
}

describe("extractHarness", () => {
  it("reads the X-Relaycast-Harness header, lowercased", () => {
    expect(extractHarness(req({ header: "Claude-Code" }))).toBe("claude-code");
  });

  it("accepts a UA-style token", () => {
    expect(
      extractHarness(req({ header: "claude-code/2.3 (model=opus-4.8; fast)" })),
    ).toBe("claude-code/2.3 (model=opus-4.8; fast)");
  });

  it("falls back to the `harness` query param (browser WS path)", () => {
    expect(extractHarness(req({ query: "codex" }))).toBe("codex");
  });

  it("prefers the header over the query param", () => {
    expect(extractHarness(req({ header: "claude-code", query: "codex" }))).toBe(
      "claude-code",
    );
  });

  it("returns unknown when neither is present", () => {
    expect(extractHarness(req())).toBe(UNKNOWN_HARNESS);
  });

  it("rejects disallowed characters in the header", () => {
    expect(extractHarness(req({ header: "claude<script>" }))).toBe(
      UNKNOWN_HARNESS,
    );
  });

  it("rejects CRLF smuggled through the query param", () => {
    // The runtime Headers object already blocks CRLF header values, so the only
    // way control characters reach us is the query string — drop them there too.
    expect(extractHarness(req({ query: "evil\r\nX-Inject: bad" }))).toBe(
      UNKNOWN_HARNESS,
    );
  });

  it("rejects empty / whitespace-only values", () => {
    expect(extractHarness(req({ header: "   " }))).toBe(UNKNOWN_HARNESS);
  });

  it("truncates to 120 characters", () => {
    expect(extractHarness(req({ header: "a".repeat(200) }))).toBe(
      "a".repeat(120),
    );
  });
});

describe("extractAgentRelayAnonymousId", () => {
  it("reads a sanitized Agent Relay anonymous id header", () => {
    expect(
      extractAgentRelayAnonymousId(req({ agentRelayId: "abc123def4567890" })),
    ).toBe("abc123def4567890");
  });

  it("falls back to the Agent Relay anonymous id query param", () => {
    expect(
      extractAgentRelayAnonymousId(
        req({ agentRelayQuery: "abc123def4567890" }),
      ),
    ).toBe("abc123def4567890");
  });

  it("prefers the Agent Relay anonymous id header over the query param", () => {
    expect(
      extractAgentRelayAnonymousId(
        req({
          agentRelayId: "from-header",
          agentRelayQuery: "from-query",
        }),
      ),
    ).toBe("from-header");
  });

  it("rejects empty or malformed ids", () => {
    expect(extractAgentRelayAnonymousId(req())).toBeUndefined();
    expect(
      extractAgentRelayAnonymousId(req({ agentRelayId: "   " })),
    ).toBeUndefined();
    expect(
      extractAgentRelayAnonymousId(req({ agentRelayId: "abc<script>" })),
    ).toBeUndefined();
    expect(
      extractAgentRelayAnonymousId(
        req({ agentRelayQuery: "evil\r\nX-Inject: bad" }),
      ),
    ).toBeUndefined();
  });

  it("truncates long ids", () => {
    expect(
      extractAgentRelayAnonymousId(req({ agentRelayId: "a".repeat(200) })),
    ).toBe("a".repeat(128));
  });
});

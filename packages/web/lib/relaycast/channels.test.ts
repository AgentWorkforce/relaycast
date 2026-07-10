import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRelayApiKeyForWorkspace: vi.fn(),
  resolveRelaycastUrl: vi.fn(),
}));

vi.mock("@/lib/workflows/relay-api-key", () => ({
  resolveRelayApiKeyForWorkspace: mocks.resolveRelayApiKeyForWorkspace,
}));

vi.mock("@/lib/workspace-registry", () => ({
  resolveRelaycastUrl: mocks.resolveRelaycastUrl,
}));

import { createRelaycastChannel } from "./channels";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveRelaycastUrl.mockReturnValue("https://relaycast.test/");
  mocks.resolveRelayApiKeyForWorkspace.mockResolvedValue("rk_live_abc");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createRelaycastChannel", () => {
  it("POSTs to /v1/channels with the workspace bearer key and normalized name", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    }) as typeof fetch;

    const result = await createRelaycastChannel({
      workspaceId: "ws-1",
      name: "#team-team_abc",
      topic: "issue-421",
    });

    expect(result).toEqual({ channel: "team-team_abc", created: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://relaycast.test/v1/channels");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
      "Bearer rk_live_abc",
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "team-team_abc",
      topic: "issue-421",
    });
  });

  it("treats 409 (already exists) as success with created:false", async () => {
    globalThis.fetch = (async () =>
      new Response("conflict", { status: 409 })) as typeof fetch;

    const result = await createRelaycastChannel({ workspaceId: "ws-1", name: "team-x" });
    expect(result).toEqual({ channel: "team-x", created: false });
  });

  it("throws on a non-2xx, non-409 response", async () => {
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500, statusText: "Internal Server Error" })) as typeof fetch;

    await expect(
      createRelaycastChannel({ workspaceId: "ws-1", name: "team-x" }),
    ).rejects.toThrow(/Relaycast channel create failed: 500/);
  });

  it("throws when the workspace has no relaycast key", async () => {
    mocks.resolveRelayApiKeyForWorkspace.mockResolvedValue(null);
    await expect(
      createRelaycastChannel({ workspaceId: "ws-1", name: "team-x" }),
    ).rejects.toThrow(/Relaycast API key is not configured/);
  });

  it("rejects an empty channel name", async () => {
    await expect(
      createRelaycastChannel({ workspaceId: "ws-1", name: "#" }),
    ).rejects.toThrow(/non-empty/);
  });
});

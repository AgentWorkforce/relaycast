import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloud/core/relayfile/client.js", () => ({
  mintRelayfileToken: vi.fn(async () => "relayfile-token"),
  mintScopedRelayfileToken: vi.fn(),
  mintWorkspaceApiKey: vi.fn(),
}));

vi.mock("@/lib/relayfile", () => ({
  resolveRelayAuthConfig: () => ({
    relayAuthUrl: "https://api.relayauth.test",
    relayAuthApiKey: "relayauth-key",
  }),
  resolveRelayfileConfig: () => ({
    relayfileUrl: "https://relayfile.test",
    relayAuthUrl: "https://api.relayauth.test",
    relayAuthApiKey: "relayauth-key",
  }),
}));

import { ensureRelayWorkspace } from "../packages/web/lib/relay-workspaces";

describe("relay workspace ACL setup", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("bounds relayfile ACL fetches so launch workers fail before the Lambda hard timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      }),
    ));

    const result = expect(
      ensureRelayWorkspace("rw_timeout1", { ignored: [], readonly: [] }),
    ).rejects.toThrow(
      "relayfile ACL GET /.relayfile.acl timed out after 15000ms",
    );

    await vi.advanceTimersByTimeAsync(15_000);

    await result;
  });
});

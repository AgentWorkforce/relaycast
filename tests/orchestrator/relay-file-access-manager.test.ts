import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { RelayFileAccessManager } from "../../packages/core/src/relay-file-access.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubRelayAuth(): void {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/identities")) {
      return new Response(JSON.stringify({ id: "id_access" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/v1/tokens")) {
      return new Response(JSON.stringify({ accessToken: "access-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  };
}

describe("RelayFileAccessManager", () => {
  it("mints unified rw_ workspace IDs by default", async () => {
    stubRelayAuth();
    const manager = new RelayFileAccessManager({
      relayfileUrl: "https://relayfile.example",
      relayAuthUrl: "https://relayauth.example",
      relayAuthApiKey: "test-api-key",
    });

    const access = await manager.provisionAgent("worker-agent", ["fs:read"], []);

    assert.match(access.workspace, /^rw_[a-f0-9]{8}$/);
    assert.match(access.wsUrl, /\/v1\/workspaces\/rw_[a-f0-9]{8}\/fs\/ws\?/);
  });

  it("preserves explicit legacy prefixes when callers opt into them", async () => {
    stubRelayAuth();
    const manager = new RelayFileAccessManager({
      relayfileUrl: "https://relayfile.example",
      relayAuthUrl: "https://relayauth.example",
      relayAuthApiKey: "test-api-key",
      workspacePrefix: "wf",
    });

    const access = await manager.provisionAgent("worker-agent", ["fs:read"], []);

    assert.match(access.workspace, /^wf-[a-f0-9-]+$/);
  });
});

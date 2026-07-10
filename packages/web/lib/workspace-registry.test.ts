import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// workspace-registry pulls in @cloud/core + relay-workspaces + relayfile config
// transitively; stub those so the test can exercise the pure URL-resolution
// helpers in isolation.
vi.mock("@cloud/core/workspace/registry.js", () => ({
  CloudWorkspaceRegistry: class {},
}));
vi.mock("@/lib/relayfile", () => ({
  resolveRelayfileConfig: () => ({ relayfileUrl: "", relayAuthApiKey: "" }),
}));
vi.mock("@/lib/relay-workspaces", () => ({
  createRelayWorkspaceRecord: () => undefined,
  createWorkspaceJoinAccess: () => undefined,
  ensureRelayWorkspace: () => undefined,
  getRelayWorkspace: () => undefined,
}));

import {
  resolveConfiguredRelaycastUrl,
  resolveRelaycastUrl,
} from "./workspace-registry";

const RELAYCAST_ENV_KEYS = ["RELAYCAST_URL", "RELAYCAST_API_URL"] as const;

describe("resolveRelaycastUrl", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of RELAYCAST_ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of RELAYCAST_ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("resolves to the gateway host when RELAYCAST_URL is set (issue #2308)", () => {
    // This is the binding infra/web-worker.ts + infra/web.ts now provide,
    // sourced from infra/relaycast.ts `relaycastApiUrl` (gateway host).
    process.env.RELAYCAST_URL = "https://gateway.relaycast.dev";
    expect(resolveConfiguredRelaycastUrl()).toBe("https://gateway.relaycast.dev");
    expect(resolveRelaycastUrl()).toBe("https://gateway.relaycast.dev");
  });

  it("honors the RELAYCAST_API_URL alias when RELAYCAST_URL is absent", () => {
    process.env.RELAYCAST_API_URL = "https://staging-gateway.relaycast.dev";
    expect(resolveConfiguredRelaycastUrl()).toBe(
      "https://staging-gateway.relaycast.dev",
    );
    expect(resolveRelaycastUrl()).toBe("https://staging-gateway.relaycast.dev");
  });

  it("prefers RELAYCAST_URL over the RELAYCAST_API_URL alias", () => {
    process.env.RELAYCAST_URL = "https://gateway.relaycast.dev";
    process.env.RELAYCAST_API_URL = "https://api.relaycast.dev";
    expect(resolveConfiguredRelaycastUrl()).toBe("https://gateway.relaycast.dev");
  });

  it("falls back to the canonical cast gateway when nothing is configured", () => {
    expect(resolveConfiguredRelaycastUrl()).toBeUndefined();
    // Default is the canonical relaycast-cloud gateway (cast.agentrelay.com);
    // prod still sets RELAYCAST_URL explicitly via infra. (workforce#254)
    expect(resolveRelaycastUrl()).toBe("https://cast.agentrelay.com");
  });
});

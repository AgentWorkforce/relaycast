import { describe, expect, it } from "vitest";
import { WORKSPACE_PROVIDER_SHARDS } from "../src/durable-objects/sharding.js";
import {
  normalizeWorkspacePath,
  resolveVfsPlaneRoute,
} from "../src/durable-objects/vfs-plane.js";

describe("normalizeWorkspacePath", () => {
  it.each([
    ["", "/"],
    [undefined, "/"],
    [null, "/"],
    [42, "/"],
    ["google-mail/messages/a.json", "/google-mail/messages/a.json"],
    ["//google-mail//messages//a.json", "/google-mail/messages/a.json"],
    ["/google-mail/messages/", "/google-mail/messages"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeWorkspacePath(input)).toBe(expected);
  });
});

describe("resolveVfsPlaneRoute", () => {
  it.each([
    ["/google-mail/messages/19e5.json", "integration", "google-mail"],
    ["/slack/channels/C123/messages/171.json", "integration", "slack"],
    ["/memory/context/user.json", "integration", "memory"],
    ["/notion/pages/page-a.md", "integration", "notion"],
    [
      "/discovery/google-mail/messages/index.json",
      "integration",
      "google-mail",
    ],
  ])("routes %s to the integration plane", (path, plane, provider) => {
    const route = resolveVfsPlaneRoute("ws_1", path);
    expect(route.plane).toBe(plane);
    expect(route.provider).toBe(provider);
    expect(route.shardKey).toBe(`ws_1:integration:${provider}`);
  });

  it("keeps provider roots aligned with the workspace sharding provider list", () => {
    for (const provider of WORKSPACE_PROVIDER_SHARDS) {
      const route = resolveVfsPlaneRoute("ws_1", `/${provider}/index.json`);
      expect(route.plane).toBe("integration");
      expect(route.provider).toBe(provider);
    }
  });

  it.each([
    "/github/repos/AgentWorkforce/cloud/contents/packages/web/app.ts@sha.json",
    "/.relayfile/clone.json",
    "/github/repos/AgentWorkforce/cloud/issues/1307__docs-clean-up/meta.json",
    "/discovery/unknown-provider/index.json",
    "/unknown/root.json",
    "/",
  ])("keeps %s on the runtime/code plane", (path) => {
    const route = resolveVfsPlaneRoute("ws_1", path);
    expect(route.plane).toBe("runtime-code");
    expect(route.provider).toBeUndefined();
    expect(route.shardKey).toBe("ws_1:runtime-code");
  });

  it("matches roots case-insensitively", () => {
    const route = resolveVfsPlaneRoute(
      "ws_1",
      "/Google-Mail/Messages/19e5.json",
    );
    expect(route.plane).toBe("integration");
    expect(route.provider).toBe("google-mail");
  });

  it("builds deterministic workspace-scoped integration shard keys", () => {
    const first = resolveVfsPlaneRoute("ws_1", "/google-mail/messages/a.json");
    const second = resolveVfsPlaneRoute("ws_1", "/google-mail/threads/b.json");
    const otherWorkspace = resolveVfsPlaneRoute(
      "ws_2",
      "/google-mail/messages/a.json",
    );

    expect(first.shardKey).toBe("ws_1:integration:google-mail");
    expect(second.shardKey).toBe(first.shardKey);
    expect(otherWorkspace.shardKey).toBe("ws_2:integration:google-mail");
    expect(otherWorkspace.shardKey).not.toBe(first.shardKey);
  });
});

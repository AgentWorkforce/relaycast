import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as availabilityModule from "../../packages/web/lib/ricky/agent-availability-snapshot.ts";

const { resolveAgentAvailabilityFromSnapshot: resolveAgentAvailability } = availabilityModule as {
  resolveAgentAvailabilityFromSnapshot: typeof import("../../packages/web/lib/ricky/agent-availability-snapshot.ts").resolveAgentAvailabilityFromSnapshot;
};
const { extractRequestedClis } = await import("../../packages/web/lib/ricky/agent-availability.ts") as {
  extractRequestedClis: typeof import("../../packages/web/lib/ricky/agent-availability.ts").extractRequestedClis;
};

const CHECKED_AT = "2026-05-03T12:00:00.000Z";

describe("Ricky agent availability resolver", () => {
  it("extracts requested CLIs from raw YAML workflow text", () => {
    assert.deepEqual(
      extractRequestedClis({
        fileType: "yaml",
        workflow: [
          "agents:",
          "  - name: repair",
          "    cli: claude",
          "  - name: verify",
          "    cli: codex",
        ].join("\n"),
      }),
      ["claude", "codex"],
    );
  });

  it("classifies usable subscription-backed agents and OpenRouter fallback readiness", () => {
    const availability = resolveAgentAvailability({
      workspaceId: "workspace-1",
      userId: "user-1",
      requestedClis: ["claude", "codex"],
      checkedAt: CHECKED_AT,
      cloudAgents: [
        {
          cli: "claude",
          status: "connected",
          credentialExpiresAt: "2026-05-04T12:00:00.000Z",
          lastAuthenticatedAt: "2026-05-02T12:00:00.000Z",
        },
      ],
      cliCredentials: [
        {
          provider: "openai",
          status: "connected",
          credentialExpiresAt: "2026-05-05T12:00:00.000Z",
        },
      ],
      openRouter: {
        proxyUrl: "https://credential-proxy.test",
        jwtSecret: "secret",
        upstreamKey: "openrouter-key",
        model: "openrouter/auto",
      },
    });

    assert.deepEqual(
      availability.subscriptionAgents.map((agent) => ({
        cli: agent.cli,
        source: agent.source,
        status: agent.status,
      })),
      [
        { cli: "claude", source: "cloud_agents", status: "usable" },
        { cli: "codex", source: "cli_credentials", status: "usable" },
      ],
    );
    assert.equal(availability.openRouterFallback.status, "usable");
    assert.equal(availability.openRouterFallback.model, "openrouter/auto");
  });

  it("classifies expired, missing, and unhealthy agent paths deterministically", () => {
    const availability = resolveAgentAvailability({
      workspaceId: "workspace-1",
      userId: "user-1",
      requestedClis: ["claude", "codex", "opencode"],
      checkedAt: CHECKED_AT,
      cloudAgents: [
        {
          cli: "claude",
          status: "connected",
          credentialExpiresAt: "2026-05-01T12:00:00.000Z",
        },
        {
          cli: "opencode",
          status: "unhealthy",
          reason: "worker heartbeat stale",
        },
      ],
      openRouter: {
        proxyUrl: "https://credential-proxy.test",
        jwtSecret: "secret",
      },
    });

    assert.deepEqual(
      availability.subscriptionAgents.map((agent) => ({
        cli: agent.cli,
        status: agent.status,
        reason: agent.reason,
      })),
      [
        { cli: "claude", status: "expired", reason: "cloud agent credential expired" },
        {
          cli: "codex",
          status: "missing",
          reason: "no usable codex subscription-backed agent found",
        },
        { cli: "opencode", status: "unhealthy", reason: "worker heartbeat stale" },
      ],
    );
    assert.equal(availability.openRouterFallback.status, "missing");
  });

  it("marks OpenRouter fallback disabled or unhealthy when policy or readiness blocks it", () => {
    const disabled = resolveAgentAvailability({
      workspaceId: "workspace-1",
      userId: "user-1",
      requestedClis: [],
      checkedAt: CHECKED_AT,
      policy: { allowOpenRouterFallback: false },
      openRouter: {
        proxyUrl: "https://credential-proxy.test",
        jwtSecret: "secret",
        upstreamKey: "openrouter-key",
      },
    });
    const unhealthy = resolveAgentAvailability({
      workspaceId: "workspace-1",
      userId: "user-1",
      requestedClis: [],
      checkedAt: CHECKED_AT,
      openRouter: {
        proxyUrl: "https://credential-proxy.test",
        jwtSecret: "secret",
        upstreamKey: "openrouter-key",
        healthy: false,
        reason: "upstream 503",
      },
    });

    assert.equal(disabled.openRouterFallback.status, "disabled");
    assert.equal(unhealthy.openRouterFallback.status, "unhealthy");
    assert.equal(unhealthy.openRouterFallback.reason, "upstream 503");
  });

  it("requires every OpenRouter credential proxy component before marking fallback usable", () => {
    const missingUpstreamKey = resolveAgentAvailability({
      workspaceId: "workspace-1",
      userId: "user-1",
      requestedClis: [],
      checkedAt: CHECKED_AT,
      openRouter: {
        proxyUrl: "https://credential-proxy.test",
        jwtSecret: "secret",
      },
    });

    assert.deepEqual(missingUpstreamKey.openRouterFallback, {
      status: "missing",
      provider: "openrouter",
      model: "openrouter/auto",
      reason: "credential proxy URL, JWT secret, and OpenRouter upstream key are required",
    });
  });
});

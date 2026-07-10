import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRelayfileConfig: vi.fn(),
  resolveRelayfileInternalHmacSecret: vi.fn(),
  signRelayfileInternalRequest: vi.fn(),
}));

// Stub the workspace-binding module so the push path does not transitively
// load the `@cloud/core` db layer. For a relay-workspace id (`rw_…`) the push
// resolves the id directly and never calls `readBoundRelayWorkspaceId`.
vi.mock("../workspaces/relay-workspace-binding", () => ({
  isRelayWorkspaceId: (value: string) => /^rw_[A-Za-z0-9_-]+$/.test(value.trim()),
  isAppWorkspaceId: () => false,
  readBoundRelayWorkspaceId: vi.fn(),
}));

vi.mock("../relayfile", () => ({
  resolveRelayfileConfig: mocks.resolveRelayfileConfig,
}));

vi.mock("./relayfile-writeback-auth", () => ({
  resolveRelayfileInternalHmacSecret: mocks.resolveRelayfileInternalHmacSecret,
  signRelayfileInternalRequest: mocks.signRelayfileInternalRequest,
}));

import {
  GATE2_DEV_WORKSPACE_ID,
  GATE2_SLACK_CONNECTION_ID,
  GATE2_SLACK_PROVIDER_CONFIG_KEY,
  buildGate2SlackIntegrationRecord,
  seedGate2SlackCredential,
} from "./gate2-setup";

describe("buildGate2SlackIntegrationRecord", () => {
  it("defaults to the dev slack-relay seed parameters", () => {
    const now = new Date("2026-06-20T00:00:00.000Z");
    const record = buildGate2SlackIntegrationRecord({ now });

    expect(record.workspaceId).toBe(GATE2_DEV_WORKSPACE_ID);
    expect(record.workspaceId).toBe("rw_dev0000");
    expect(record.connectionId).toBe(GATE2_SLACK_CONNECTION_ID);
    expect(record.providerConfigKey).toBe(GATE2_SLACK_PROVIDER_CONFIG_KEY);
    // `provider` must normalize to slack via normalizeWritebackProvider.
    expect(record.provider).toBe("slack-relay");
    expect(record.writebackDispatchVia).toBe("bridge");
    expect(record.metadata).toEqual({});
    expect(record.updatedAt).toEqual(now);
  });

  it("honors overrides", () => {
    const record = buildGate2SlackIntegrationRecord({
      workspaceId: "rw_other",
      connectionId: "conn-override",
      providerConfigKey: "slack",
      metadata: { seeded: true },
    });

    expect(record.workspaceId).toBe("rw_other");
    expect(record.connectionId).toBe("conn-override");
    expect(record.providerConfigKey).toBe("slack");
    expect(record.metadata).toEqual({ seeded: true });
  });
});

describe("seedGate2SlackCredential", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.resolveRelayfileConfig.mockReturnValue({
      relayfileUrl: "https://dev.file.agentrelay.com/",
    });
    mocks.resolveRelayfileInternalHmacSecret.mockReturnValue("secret");
    mocks.signRelayfileInternalRequest.mockReturnValue("signature");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("seeds the dev slack-relay credential via the canonical signed PUT", async () => {
    const result = await seedGate2SlackCredential();

    expect(result).toEqual({ ok: true, provider: "slack", status: 204 });

    // The relay-workspace id resolves directly (no DB), and the slack provider
    // is normalized to "slack" in the path.
    expect(fetchMock).toHaveBeenCalledWith(
      "https://dev.file.agentrelay.com/v1/workspaces/rw_dev0000/integrations/slack",
      expect.objectContaining({ method: "PUT" }),
    );

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;
    // Proves we go through the canonical HMAC signer, not a bearer token.
    expect(headers["X-Relay-Signature"]).toBe("signature");
    expect(headers["X-Relay-Timestamp"]).toBeTruthy();
    expect(headers.Authorization).toBeUndefined();

    const body = JSON.parse(String(requestInit.body));
    expect(body).toMatchObject({
      provider: "slack",
      providerConfigKey: "slack-relay",
      connectionId: GATE2_SLACK_CONNECTION_ID,
      revoked: false,
    });
    expect(mocks.signRelayfileInternalRequest).toHaveBeenCalledTimes(1);
  });

  it("returns a non-ok result when relayfile rejects the seed", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("nope", { status: 401, statusText: "Unauthorized" }),
    );

    const result = await seedGate2SlackCredential();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });
});

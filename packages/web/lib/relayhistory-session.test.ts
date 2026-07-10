import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tryResourceValue: vi.fn<(name: string) => string | undefined>(() => undefined),
}));

vi.mock("./env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./env")>();
  return { ...actual, tryResourceValue: mocks.tryResourceValue };
});

async function loadModule() {
  vi.resetModules();
  return import("./relayhistory-session");
}

describe("relayhistory-session helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryResourceValue.mockReturnValue(undefined);
    vi.stubEnv("WEB_RELAYAUTH_URL", "https://relayauth.test");
    vi.stubEnv("RELAYHISTORY_ASSERTION_RELAYAUTH_API_KEY", "relayhistory-assertion-key");
    vi.stubEnv("RELAYHISTORY_URL", "https://history.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("maps modes to least-privilege relayhistory scopes", async () => {
    const { relayhistoryScopesForMode } = await loadModule();
    expect(relayhistoryScopesForMode("read")).toEqual(["rth:read"]);
    expect(relayhistoryScopesForMode("sync")).toEqual(["rth:read", "rth:sync"]);
  });

  it("uses server-side configured relayhistory URL", async () => {
    vi.stubEnv("RELAYHISTORY_URL", "https://history.env.test/");
    const { resolveRelayhistoryUrl } = await loadModule();
    expect(resolveRelayhistoryUrl()).toBe("https://history.env.test");
  });

  it("resolves the configured relayhistory assertion api key", async () => {
    vi.stubEnv("RELAYHISTORY_ASSERTION_RELAYAUTH_API_KEY", "real-key");
    const { resolveRelayhistoryAssertionApiKey } = await loadModule();
    expect(resolveRelayhistoryAssertionApiKey()).toBe("real-key");
  });

  it.each([
    "production-relayhistory-assertion-disabled",
    "preview-relayhistory-assertion-disabled",
    "dev-relayhistory-assertion-disabled",
    "staging-relayhistory-assertion-disabled",
  ])("treats the per-env disabled-marker placeholder %s as not configured", async (placeholder) => {
    vi.stubEnv("RELAYHISTORY_ASSERTION_RELAYAUTH_API_KEY", placeholder);
    const { resolveRelayhistoryAssertionApiKey } = await loadModule();
    expect(resolveRelayhistoryAssertionApiKey()).toBe("");
  });

  it("trims surrounding whitespace and still detects a padded placeholder", async () => {
    vi.stubEnv(
      "RELAYHISTORY_ASSERTION_RELAYAUTH_API_KEY",
      "  production-relayhistory-assertion-disabled\n",
    );
    const { resolveRelayhistoryAssertionApiKey } = await loadModule();
    expect(resolveRelayhistoryAssertionApiKey()).toBe("");
  });

  it("trims a real env key with surrounding whitespace", async () => {
    vi.stubEnv("RELAYHISTORY_ASSERTION_RELAYAUTH_API_KEY", "  rak_real_key  ");
    const { resolveRelayhistoryAssertionApiKey } = await loadModule();
    expect(resolveRelayhistoryAssertionApiKey()).toBe("rak_real_key");
  });

  it("lets a real env key override an SST Resource placeholder default", async () => {
    mocks.tryResourceValue.mockReturnValue("production-relayhistory-assertion-disabled");
    vi.stubEnv("RELAYHISTORY_ASSERTION_RELAYAUTH_API_KEY", "real-override-key");
    const { resolveRelayhistoryAssertionApiKey } = await loadModule();
    expect(resolveRelayhistoryAssertionApiKey()).toBe("real-override-key");
  });

  it("prefers a real SST Resource key over the env value", async () => {
    mocks.tryResourceValue.mockReturnValue("resource-real-key");
    vi.stubEnv("RELAYHISTORY_ASSERTION_RELAYAUTH_API_KEY", "env-key");
    const { resolveRelayhistoryAssertionApiKey } = await loadModule();
    expect(resolveRelayhistoryAssertionApiKey()).toBe("resource-real-key");
  });

  it("returns not-configured when both Resource and env are disabled placeholders", async () => {
    mocks.tryResourceValue.mockReturnValue("production-relayhistory-assertion-disabled");
    vi.stubEnv("RELAYHISTORY_ASSERTION_RELAYAUTH_API_KEY", "dev-relayhistory-assertion-disabled");
    const { resolveRelayhistoryAssertionApiKey } = await loadModule();
    expect(resolveRelayhistoryAssertionApiKey()).toBe("");
  });

  it("does not treat a real key that merely contains 'disabled' as a placeholder", async () => {
    vi.stubEnv("RELAYHISTORY_ASSERTION_RELAYAUTH_API_KEY", "rak_disabled_features_real_key");
    const { resolveRelayhistoryAssertionApiKey } = await loadModule();
    expect(resolveRelayhistoryAssertionApiKey()).toBe("rak_disabled_features_real_key");
  });

  it("fails closed (not configured) instead of minting with the disabled placeholder", async () => {
    vi.stubEnv(
      "RELAYHISTORY_ASSERTION_RELAYAUTH_API_KEY",
      "dev-relayhistory-assertion-disabled",
    );
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch must not be called when relayhistory is disabled");
    });
    vi.stubGlobal("fetch", fetchMock);

    const { createRelayhistorySession } = await loadModule();
    await expect(createRelayhistorySession({
      userId: "user_cloud_1",
      orgId: "org_1",
      workspaceId: "workspace_1",
      mode: "read",
    })).rejects.toThrow("Relayhistory assertion RelayAuth API key is not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mints a dedicated aud=relayhistory assertion and exchanges it for only rth session fields", async () => {
    const assertion = fakeJwt({
      org: "org_1",
      wks: "workspace_1",
      sponsorId: "user_cloud_1",
      aud: ["relayhistory"],
      scopes: ["rth:read", "rth:sync"],
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (url === "https://relayauth.test/v1/tokens/relayhistory-assertion") {
        expect(init?.headers).toBeInstanceOf(Headers);
        expect((init?.headers as Headers).get("x-api-key")).toBe("relayhistory-assertion-key");
        expect(body).toEqual({
          orgId: "org_1",
          workspaceId: "workspace_1",
          sponsorId: "user_cloud_1",
          scopes: ["rth:read", "rth:sync"],
          expiresIn: 60,
          metadata: {
            productId: "cloud",
            purpose: "relayhistory-login",
            cloudUserId: "user_cloud_1",
            cloudOrgId: "org_1",
            cloudWorkspaceId: "workspace_1",
            requestedMode: "sync",
            grantedMode: "sync",
          },
        });
        return Response.json({ accessToken: assertion }, { status: 201 });
      }
      if (url === "https://history.test/v1/cli/login") {
        expect(body).toEqual({
          agentRelayToken: assertion,
          label: "ai-hist",
        });
        return Response.json({
          sessionId: "sess_1",
          accessToken: "rth_at_token",
          accessTokenExpiresAt: "2026-06-22T15:00:00.000Z",
          refreshToken: "rth_rt_token",
          refreshTokenExpiresAt: "2026-09-20T15:00:00.000Z",
          tokenType: "Bearer",
          scopes: ["rth:read", "rth:sync"],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { createRelayhistorySession } = await loadModule();
    const session = await createRelayhistorySession({
      userId: "user_cloud_1",
      orgId: "org_1",
      workspaceId: "workspace_1",
      mode: "sync",
      label: "ai-hist",
    });

    expect(session).toEqual({
      baseUrl: "https://history.test",
      sessionId: "sess_1",
      accessToken: "rth_at_token",
      accessTokenExpiresAt: "2026-06-22T15:00:00.000Z",
      refreshToken: "rth_rt_token",
      refreshTokenExpiresAt: "2026-09-20T15:00:00.000Z",
      tokenType: "Bearer",
      scopes: ["rth:read", "rth:sync"],
      orgId: "org_1",
      workspaceId: "workspace_1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when RelayAuth assertion org does not match Cloud auth context", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://relayauth.test/v1/tokens/relayhistory-assertion") {
        return Response.json({
          accessToken: fakeJwt({
            org: "wrong_org",
            wks: "workspace_1",
            sponsorId: "user_cloud_1",
            aud: ["relayhistory"],
            scopes: ["rth:read"],
          }),
        }, { status: 201 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));

    const { createRelayhistorySession } = await loadModule();
    await expect(createRelayhistorySession({
      userId: "user_cloud_1",
      orgId: "org_1",
      workspaceId: "workspace_1",
      mode: "read",
    })).rejects.toThrow("RelayAuth assertion claims did not match Cloud auth context");
  });

  it("fails closed when RelayAuth assertion contains broader scopes than Cloud requested", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://relayauth.test/v1/tokens/relayhistory-assertion") {
        return Response.json({
          accessToken: fakeJwt({
            org: "org_1",
            wks: "workspace_1",
            sponsorId: "user_cloud_1",
            aud: ["relayhistory"],
            scopes: ["rth:read", "rth:sync"],
          }),
        }, { status: 201 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));

    const { createRelayhistorySession } = await loadModule();
    await expect(createRelayhistorySession({
      userId: "user_cloud_1",
      orgId: "org_1",
      workspaceId: "workspace_1",
      mode: "read",
    })).rejects.toThrow("RelayAuth assertion claims did not match Cloud auth context");
  });
});

function fakeJwt(payload: Record<string, unknown>): string {
  return [
    base64url({ alg: "RS256", kid: "test" }),
    base64url(payload),
    "sig",
  ].join(".");
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

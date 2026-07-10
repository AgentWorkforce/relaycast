import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getEnabledNangoSyncNamesForProviderConfigKey,
  getComposioBridgeProviderConfigKey,
  getNangoSyncScheduleStatuses,
  getProviderConfigKey,
  getSlackProviderConfigKey,
  listNangoConnections,
  listNangoIntegrations,
  pauseNangoSyncSchedules,
  startNangoSyncSchedules,
  upsertNangoComposioBridgeConnection,
} from "./nango-service";

const ORIGINAL_NANGO_HOST = process.env.NANGO_HOST;
const ORIGINAL_NANGO_SECRET_KEY = process.env.NANGO_SECRET_KEY;

function restoreEnv(name: "NANGO_HOST" | "NANGO_SECRET_KEY", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function requestPath(input: RequestInfo | URL): string {
  return new URL(String(input)).pathname;
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

beforeEach(() => {
  process.env.NANGO_HOST = "https://api.nango.test";
  process.env.NANGO_SECRET_KEY = "nango-secret";
});

afterEach(() => {
  vi.unstubAllGlobals();
  restoreEnv("NANGO_HOST", ORIGINAL_NANGO_HOST);
  restoreEnv("NANGO_SECRET_KEY", ORIGINAL_NANGO_SECRET_KEY);
});

describe("upsertNangoComposioBridgeConnection", () => {
  it("creates an unauthenticated Nango bridge integration before importing the connection", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      const method = init?.method ?? "GET";
      const integrationGetCount = fetchMock.mock.calls.filter(
        ([request]) =>
          requestPath(request as RequestInfo | URL) === "/integrations/github-composio-relay",
      ).length;

      if (
        method === "GET" &&
        path === "/integrations/github-composio-relay" &&
        integrationGetCount === 1
      ) {
        return jsonResponse({ error: "not_found" }, { status: 404 });
      }

      if (method === "POST" && path === "/integrations") {
        return jsonResponse(
          { data: { unique_key: "github-composio-relay", provider: "unauthenticated" } },
          { status: 201 },
        );
      }

      if (method === "GET" && path === "/integrations/github-composio-relay") {
        return jsonResponse({
          data: { unique_key: "github-composio-relay", provider: "unauthenticated" },
        });
      }

      if (method === "POST" && path === "/connections") {
        return jsonResponse({ data: { connection_id: "ca_123" } }, { status: 201 });
      }

      return jsonResponse({ error: `unexpected ${method} ${path}` }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      upsertNangoComposioBridgeConnection({
        provider: "github",
        providerConfigKey: "github-composio-relay",
        connectionId: "ca_123",
        workspaceId: "rw_12345678",
        metadata: { backend: "composio" },
      }),
    ).resolves.toEqual({ ok: true });

    const integrationCreate = fetchMock.mock.calls.find(
      ([input, init]) =>
        requestPath(input as RequestInfo | URL) === "/integrations" && init?.method === "POST",
    );
    expect(requestBody(integrationCreate?.[1])).toMatchObject({
      unique_key: "github-composio-relay",
      provider: "unauthenticated",
      display_name: "GitHub Composio Relay",
    });

    const connectionImport = fetchMock.mock.calls.find(
      ([input, init]) =>
        requestPath(input as RequestInfo | URL) === "/connections" && init?.method === "POST",
    );
    expect(requestBody(connectionImport?.[1])).toMatchObject({
      provider_config_key: "github-composio-relay",
      connection_id: "ca_123",
      credentials: { type: "NONE" },
      metadata: { backend: "composio" },
    });
  });

  it("guards against manual bridge-key collisions with authenticated Nango integrations", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (requestPath(input) === "/integrations/github-composio-relay") {
        return jsonResponse({
          data: { unique_key: "github-composio-relay", provider: "github" },
        });
      }
      return jsonResponse({ error: "unexpected" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      upsertNangoComposioBridgeConnection({
        provider: "github",
        providerConfigKey: "github-composio-relay",
        connectionId: "ca_123",
        workspaceId: "rw_12345678",
        metadata: { backend: "composio" },
      }),
    ).rejects.toThrow("expected unauthenticated");

    expect(
      fetchMock.mock.calls.some(
        ([input]) => requestPath(input as RequestInfo | URL) === "/connections",
      ),
    ).toBe(false);
  });

  it("creates generated unauthenticated bridge integrations for dynamic providers", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      const method = init?.method ?? "GET";
      const integrationGetCount = fetchMock.mock.calls.filter(
        ([request]) =>
          requestPath(request as RequestInfo | URL) === "/integrations/dockerhub-composio-relay",
      ).length;

      if (
        method === "GET" &&
        path === "/integrations/dockerhub-composio-relay" &&
        integrationGetCount === 1
      ) {
        return jsonResponse({ error: "not_found" }, { status: 404 });
      }

      if (method === "POST" && path === "/integrations") {
        return jsonResponse(
          { data: { unique_key: "dockerhub-composio-relay", provider: "unauthenticated" } },
          { status: 201 },
        );
      }

      if (method === "GET" && path === "/integrations/dockerhub-composio-relay") {
        return jsonResponse({
          data: { unique_key: "dockerhub-composio-relay", provider: "unauthenticated" },
        });
      }

      if (method === "POST" && path === "/connections") {
        return jsonResponse({ data: { connection_id: "ca_dockerhub" } }, { status: 201 });
      }

      return jsonResponse({ error: `unexpected ${method} ${path}` }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      upsertNangoComposioBridgeConnection({
        provider: "dockerhub",
        providerConfigKey: "dockerhub-composio-relay",
        connectionId: "ca_dockerhub",
        workspaceId: "rw_12345678",
        metadata: { backend: "composio" },
      }),
    ).resolves.toEqual({ ok: true });

    const integrationCreate = fetchMock.mock.calls.find(
      ([input, init]) =>
        requestPath(input as RequestInfo | URL) === "/integrations" && init?.method === "POST",
    );
    expect(requestBody(integrationCreate?.[1])).toMatchObject({
      unique_key: "dockerhub-composio-relay",
      provider: "unauthenticated",
      display_name: "Dockerhub Composio Relay",
    });
  });

  it("normalizes transport failures while checking the bridge integration", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network unavailable");
      }),
    );

    await expect(
      upsertNangoComposioBridgeConnection({
        provider: "github",
        providerConfigKey: "github-composio-relay",
        connectionId: "ca_123",
        workspaceId: "rw_12345678",
        metadata: { backend: "composio" },
      }),
    ).resolves.toEqual({ ok: false, status: 0, payload: null });
  });

  it("normalizes transport failures while importing the bridge connection", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && path === "/integrations/github-composio-relay") {
        return jsonResponse({
          data: { unique_key: "github-composio-relay", provider: "unauthenticated" },
        });
      }

      if (method === "POST" && path === "/connections") {
        throw new Error("network unavailable");
      }

      return jsonResponse({ error: `unexpected ${method} ${path}` }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      upsertNangoComposioBridgeConnection({
        provider: "github",
        providerConfigKey: "github-composio-relay",
        connectionId: "ca_123",
        workspaceId: "rw_12345678",
        metadata: { backend: "composio" },
      }),
    ).resolves.toEqual({ ok: false, status: 0, payload: null });
  });
});

describe("startNangoSyncSchedules", () => {
  it("derives enabled sync names from the generated Nango provider registry", () => {
    expect(getEnabledNangoSyncNamesForProviderConfigKey("linear-relay")).toEqual([
      "fetch-active-issues",
      "fetch-comments",
      "fetch-labels",
      "fetch-users",
      "fetch-teams",
      "fetch-projects",
      "fetch-milestones",
      "fetch-roadmaps",
      "fetch-cycles",
      "states",
    ]);
    expect(getEnabledNangoSyncNamesForProviderConfigKey("slack-relay")).toEqual([
      "fetch-channel-history",
      "fetch-users",
      "fetch-channels",
    ]);
  });

  it("starts schedules through Nango's idempotent sync start API", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(requestPath(input)).toBe("/sync/start");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer nango-secret",
        "Content-Type": "application/json",
      });
      expect(requestBody(init)).toEqual({
        provider_config_key: "slack-relay",
        connection_id: "conn-slack-1",
        syncs: [
          "fetch-channel-history",
          "fetch-users",
          "fetch-channels",
        ],
      });
      return jsonResponse({ success: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      startNangoSyncSchedules({
        providerConfigKey: "slack-relay",
        connectionId: "conn-slack-1",
      }),
    ).resolves.toEqual({
      ok: true,
      syncs: [
        "fetch-channel-history",
        "fetch-users",
        "fetch-channels",
      ],
    });
  });

  it("pauses schedules through Nango's sync pause API before re-registration", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(requestPath(input)).toBe("/sync/pause");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer nango-secret",
        "Content-Type": "application/json",
      });
      expect(requestBody(init)).toEqual({
        provider_config_key: "slack-relay",
        connection_id: "conn-slack-1",
        syncs: [
          "fetch-channel-history",
          "fetch-users",
          "fetch-channels",
        ],
      });
      return jsonResponse({ success: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      pauseNangoSyncSchedules({
        providerConfigKey: "slack-relay",
        connectionId: "conn-slack-1",
      }),
    ).resolves.toEqual({
      ok: true,
      syncs: [
        "fetch-channel-history",
        "fetch-users",
        "fetch-channels",
      ],
    });
  });

  it("reads schedule state through Nango's sync status API", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/sync/status");
      expect(init?.method).toBeUndefined();
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer nango-secret",
      });
      expect(url.searchParams.get("provider_config_key")).toBe("slack-relay");
      expect(url.searchParams.get("connection_id")).toBe("conn-slack-1");
      expect(url.searchParams.get("syncs")).toBe(
        "fetch-channel-history,fetch-users,fetch-channels",
      );
      return jsonResponse({
        syncs: [
          {
            id: "sync_1",
            connection_id: "conn-slack-1",
            name: "fetch-channel-history",
            status: "RUNNING",
            frequency: "every hour",
            nextScheduledSyncAt: "2026-06-04T18:00:00.000Z",
            finishedAt: "2026-06-04T17:00:00.000Z",
            latestResult: { success: true },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getNangoSyncScheduleStatuses({
        providerConfigKey: "slack-relay",
        connectionId: "conn-slack-1",
      }),
    ).resolves.toEqual({
      ok: true,
      syncs: [
        {
          name: "fetch-channel-history",
          status: "RUNNING",
          frequency: "every hour",
          nextScheduledSyncAt: "2026-06-04T18:00:00.000Z",
          finishedAt: "2026-06-04T17:00:00.000Z",
        },
      ],
    });
  });
});

describe("getProviderConfigKey override safety", () => {
  const OVERRIDE_VARS = [
    "NANGO_SLACK_PROVIDER_CONFIG_KEY",
    "NANGO_GITHUB_PROVIDER_CONFIG_KEY",
    "NANGO_NOTION_PROVIDER_CONFIG_KEY",
    "NANGO_LINEAR_PROVIDER_CONFIG_KEY",
    "NANGO_JIRA_PROVIDER_CONFIG_KEY",
    "NANGO_CONFLUENCE_PROVIDER_CONFIG_KEY",
    "NANGO_COMPOSIO_SLACK_PROVIDER_CONFIG_KEY",
    "NANGO_COMPOSIO_GITHUB_PROVIDER_CONFIG_KEY",
  ] as const;

  const originalValues: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of OVERRIDE_VARS) {
      originalValues[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of OVERRIDE_VARS) {
      restoreEnv(name as "NANGO_HOST", originalValues[name]);
    }
  });

  it("returns the registry canonical key for slack when no override is set", () => {
    expect(getProviderConfigKey("slack")).toBe("slack-relay");
    expect(getSlackProviderConfigKey()).toBe("slack-relay");
  });

  it("ignores NANGO_SLACK_PROVIDER_CONFIG_KEY when it holds the demoted slack-sage alias", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.NANGO_SLACK_PROVIDER_CONFIG_KEY = "slack-sage";

    expect(getProviderConfigKey("slack")).toBe("slack-relay");
    expect(getSlackProviderConfigKey()).toBe("slack-relay");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("demoted alias (slack-sage)"),
    );

    warnSpy.mockRestore();
  });

  it("ignores NANGO_*_PROVIDER_CONFIG_KEY when it holds an unrecognized value", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.NANGO_SLACK_PROVIDER_CONFIG_KEY = "slack-mystery";

    expect(getProviderConfigKey("slack")).toBe("slack-relay");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unrecognized value (slack-mystery)"),
    );

    warnSpy.mockRestore();
  });

  it("honors NANGO_*_PROVIDER_CONFIG_KEY when it matches the canonical key (stage pinning)", () => {
    process.env.NANGO_SLACK_PROVIDER_CONFIG_KEY = "slack-relay";
    expect(getProviderConfigKey("slack")).toBe("slack-relay");
  });

  it("protects every renamed provider against stale alias env vars", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const aliasFixtures: ReadonlyArray<{
      provider: Parameters<typeof getProviderConfigKey>[0];
      envName: string;
      staleAlias: string;
      canonical: string;
    }> = [
      {
        provider: "github",
        envName: "NANGO_GITHUB_PROVIDER_CONFIG_KEY",
        staleAlias: "github-sage",
        canonical: "github-relay",
      },
      {
        provider: "notion",
        envName: "NANGO_NOTION_PROVIDER_CONFIG_KEY",
        staleAlias: "notion-sage",
        canonical: "notion-relay",
      },
      {
        provider: "jira",
        envName: "NANGO_JIRA_PROVIDER_CONFIG_KEY",
        staleAlias: "jira-sage",
        canonical: "jira-relay",
      },
    ];

    for (const fixture of aliasFixtures) {
      process.env[fixture.envName] = fixture.staleAlias;
      expect(getProviderConfigKey(fixture.provider)).toBe(fixture.canonical);
      delete process.env[fixture.envName];
    }

    warnSpy.mockRestore();
  });

  it("returns the canonical Composio bridge key when no override is set", () => {
    expect(getComposioBridgeProviderConfigKey("slack")).toBe("slack-composio-relay");
    expect(getComposioBridgeProviderConfigKey("github")).toBe("github-composio-relay");
  });

  it("ignores NANGO_COMPOSIO_*_PROVIDER_CONFIG_KEY when it does not match the canonical bridge key", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.NANGO_COMPOSIO_SLACK_PROVIDER_CONFIG_KEY = "slack-sage";

    expect(getComposioBridgeProviderConfigKey("slack")).toBe("slack-composio-relay");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("slack-sage"),
    );

    warnSpy.mockRestore();
  });

  it("honors NANGO_COMPOSIO_*_PROVIDER_CONFIG_KEY when it matches the canonical bridge key", () => {
    process.env.NANGO_COMPOSIO_SLACK_PROVIDER_CONFIG_KEY = "slack-composio-relay";
    expect(getComposioBridgeProviderConfigKey("slack")).toBe("slack-composio-relay");
  });
});

describe("Nango discovery helpers", () => {
  it("lists configured Nango integrations through the public config API", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      expect(requestPath(input)).toBe("/integrations");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer nango-secret",
        Accept: "application/json",
      });
      return jsonResponse({
        data: [
          { unique_key: "jira-relay", provider: "jira" },
          { unique_key: "confluence-relay", provider: "confluence" },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listNangoIntegrations()).resolves.toEqual([
      {
        providerConfigKey: "jira-relay",
        provider: "jira",
        raw: { unique_key: "jira-relay", provider: "jira" },
      },
      {
        providerConfigKey: "confluence-relay",
        provider: "confluence",
        raw: { unique_key: "confluence-relay", provider: "confluence" },
      },
    ]);
  });

  it("filters Nango connection discovery by connection id", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/connections");
      return jsonResponse({
        connections: [
          {
            connection_id: "conn_other",
            provider_config_key: "slack-relay",
            provider: "slack",
          },
          {
            connection_id: "conn_123",
            provider_config_key: "linear-relay",
            provider: "linear",
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listNangoConnections({ connectionId: "conn_123" })).resolves.toEqual([
      {
        connectionId: "conn_123",
        providerConfigKey: "linear-relay",
        provider: "linear",
        raw: {
          connection_id: "conn_123",
          provider_config_key: "linear-relay",
          provider: "linear",
        },
      },
    ]);
  });
});

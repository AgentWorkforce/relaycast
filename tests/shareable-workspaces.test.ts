import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateWorkspaceId,
  isValidWorkspaceId,
  isValidWorkspaceIdAny,
} from "../packages/core/src/workspace-id.js";

type ShareableWorkspaceRoute = {
  POST: (request: Request, context?: unknown) => Promise<Response>;
};

type RelayfileTokenClaims = {
  aud?: string | string[];
  workspace_id: string;
  agent_name: string;
  scopes?: string[];
};

const resolveRequestAuthMock = vi.fn();
const requireSessionAuthMock = vi.fn();
const requireAuthScopeMock = vi.fn();
const resolveRelayfileConfigMock = vi.fn();
const relayWorkspaceMock = vi.hoisted(() => ({
  records: new Map<string, {
    id: string;
    ownerUserId: string;
    name: string;
    relaycastApiKey: string;
    permissions: { ignored: string[]; readonly: string[] };
    createdAt: Date;
    updatedAt: Date;
  }>(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: (...args: unknown[]) => resolveRequestAuthMock(...args),
  requireSessionAuth: (...args: unknown[]) => requireSessionAuthMock(...args),
  requireAuthScope: (...args: unknown[]) => requireAuthScopeMock(...args),
}));

vi.mock("@/lib/relayfile", () => ({
  resolveRelayfileConfig: (...args: unknown[]) => resolveRelayfileConfigMock(...args),
}));

vi.mock("@/lib/relay-workspaces", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createRelayWorkspaceRecord: vi.fn(async (input: {
      id: string;
      ownerUserId: string;
      name: string;
      relaycastApiKey: string;
      permissions: { ignored: string[]; readonly: string[] };
    }) => {
      const record = {
        ...input,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      };
      relayWorkspaceMock.records.set(input.id, record);
      return record;
    }),
    getRelayWorkspace: vi.fn(async (workspaceId: string) =>
      relayWorkspaceMock.records.get(workspaceId) ?? {
        id: workspaceId,
        ownerUserId: "user_123",
        name: workspaceId,
        relaycastApiKey: "rk_live_existing",
        permissions: { ignored: [], readonly: [] },
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ),
  };
});

beforeEach(() => {
  relayWorkspaceMock.records.clear();
  vi.stubEnv("RELAYAUTH_URL", "https://api.relayauth.test");
  resolveRequestAuthMock.mockResolvedValue({
    userId: "user_123",
    workspaceId: "ws_local",
    organizationId: "org_123",
    source: "session",
    context: {
      user: { id: "user_123" },
      currentWorkspace: { id: "ws_local" },
      currentOrganization: { id: "org_123" },
    },
  });
  requireSessionAuthMock.mockReturnValue(true);
  requireAuthScopeMock.mockReturnValue(true);
  resolveRelayfileConfigMock.mockReturnValue({
    relayfileUrl: "https://relayfile.test",
    relayJwtSecret: "test-relayfile-secret",
    relayAuthUrl: "https://api.relayauth.test",
    relayAuthApiKey: "relayauth-api-key",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) {
    return input.url;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return String(input);
}

function decodeRelayfileToken(token: string): RelayfileTokenClaims {
  const parts = token.split(".");
  if (parts.length < 2) {
    throw new Error("Invalid JWT");
  }

  const payload = parts[1]
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const pad = (4 - (payload.length % 4)) % 4;
  const normalized = payload + "=".repeat(pad);
  return JSON.parse(Buffer.from(normalized, "base64").toString("utf8")) as RelayfileTokenClaims;
}

function nextParams<T extends Record<string, string>>(value: T): T & PromiseLike<T> {
  return {
    ...value,
    then<TResult1 = T, TResult2 = never>(
      onFulfilled?: ((resolvedValue: T) => TResult1 | PromiseLike<TResult1>) | null,
      onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve(value).then(onFulfilled, onRejected);
    },
  } as T & PromiseLike<T>;
}

async function loadCreateWorkspaceRoute(): Promise<ShareableWorkspaceRoute> {
  const routeUrl = new URL(
    "../packages/web/app/api/v1/workspaces/create/route.ts",
    import.meta.url,
  ).href;
  // @ts-ignore The route is created by the paired shareable-workspaces implementation.
  return import(routeUrl);
}

async function loadJoinWorkspaceRoute(): Promise<ShareableWorkspaceRoute> {
  const routeUrl = new URL(
    "../packages/web/app/api/v1/workspaces/[workspaceId]/join/route.ts",
    import.meta.url,
  ).href;
  // @ts-ignore The route is created by the paired shareable-workspaces implementation.
  return import(routeUrl);
}

describe("shareable workspaces", () => {
  it("TestGenerateWorkspaceId", () => {
    const first = generateWorkspaceId();
    const second = generateWorkspaceId();

    expect(first.startsWith("rw_")).toBe(true);
    expect(first).toHaveLength(11);
    expect(first).toMatch(/^rw_[a-f0-9]{8}$/);
    expect(second).toMatch(/^rw_[a-f0-9]{8}$/);
    expect(second).not.toBe(first);
  });

  it("TestIsValidWorkspaceId", () => {
    expect(isValidWorkspaceId("rw_a7f3x9k2")).toBe(true);
    expect(isValidWorkspaceId("rw_12345678")).toBe(true);
    expect(isValidWorkspaceId("wf-abc123")).toBe(false);
    expect(isValidWorkspaceIdAny("wf-abc123")).toBe(true);
    expect(isValidWorkspaceId("invalid")).toBe(false);
    expect(isValidWorkspaceId("")).toBe(false);
    expect(isValidWorkspaceIdAny("invalid")).toBe(false);
    expect(isValidWorkspaceIdAny("")).toBe(false);
  });

  it("TestCreateWorkspace", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = getRequestUrl(input);
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.endsWith("/v1/workspaces") && method === "POST") {
        return jsonResponse({ api_key: "rk_live_created" }, { status: 201 });
      }

      if (url.endsWith("/v1/identities")) {
        return jsonResponse({ id: "id_shareable" });
      }
      if (url.endsWith("/v1/tokens")) {
        return jsonResponse({ accessToken: "shareable-token" });
      }

      if (url.includes("/fs/tree")) {
        return jsonResponse({ entries: [] });
      }

      if (url.includes("/fs/file")) {
        if (method === "GET") {
          return jsonResponse({
            revision: "rev_root_acl",
            content: "# relayfile acl\n",
            contentType: "text/plain",
            encoding: "utf-8",
            semantics: { permissions: [] },
          });
        }

        return jsonResponse({
          revision: "rev_root_acl_updated",
          content: "# relayfile acl\n",
        });
      }

      return jsonResponse({ ok: true });
    });

    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await loadCreateWorkspaceRoute();
    const response = await POST(
      new Request("http://localhost/api/v1/workspaces/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "my-project",
        }),
      }),
    );

    expect(response.ok).toBe(true);

    const body = (await response.json()) as {
      workspaceId: string;
      joinCommand: string;
      name?: string;
    };

    expect(body.workspaceId).toMatch(/^rw_[a-z0-9]{8}$/);
    expect(body.joinCommand).toContain(body.workspaceId);
    expect(body.joinCommand).toContain("--workspace");
    expect(body.name).toBe("my-project");
    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls.some((call) => getRequestUrl(call[0]).includes("https://relayfile.test"))).toBe(true);
  });

  it("TestJoinWorkspace", async () => {
    const workspaceId = "rw_12345678";
    const agentName = "claude";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = getRequestUrl(input);
      if (url.endsWith("/v1/identities")) {
        return jsonResponse({ id: "id_shareable" });
      }
      if (url.endsWith("/v1/tokens")) {
        return jsonResponse({ accessToken: "shareable-token" });
      }
      if (url.includes(`/v1/workspaces/${workspaceId}/`)) {
        return jsonResponse({ entries: [] });
      }

      return jsonResponse({ ok: true });
    });

    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await loadJoinWorkspaceRoute();
    const response = await POST(
      new Request(`http://localhost/api/v1/workspaces/${workspaceId}/join`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentName,
        }),
      }),
      {
        params: nextParams({ workspaceId }),
      },
    );

    expect(response.ok).toBe(true);

    const body = (await response.json()) as {
      workspaceId: string;
      token: string;
      tokenIssuedAt: string | null;
      tokenExpiresAt: string | null;
      suggestedRefreshAt: string | null;
      relayfileUrl: string;
      wsUrl: string;
      scopes: string[];
    };

    expect(body.workspaceId).toBe(workspaceId);
    expect(body.relayfileUrl).toBe("https://relayfile.test");
    expect(body.wsUrl).toContain(`/v1/workspaces/${workspaceId}/fs/ws`);
    expect(body.token).toBe("shareable-token");
    expect(body.tokenIssuedAt).toBeNull();
    expect(body.tokenExpiresAt).toBeNull();
    expect(body.suggestedRefreshAt).toBeNull();
    expect(body.scopes).toEqual([
      "relayfile:fs:read:*",
      "relayfile:fs:write:*",
    ]);
    expect(fetchMock.mock.calls.map((call) => getRequestUrl(call[0]))).toEqual([
      "https://api.relayauth.test/v1/identities",
      "https://api.relayauth.test/v1/tokens",
    ]);
    expect(fetchMock.mock.calls.some((call) => getRequestUrl(call[0]).includes("/fs/file"))).toBe(false);
  });

  it("TestJoinWorkspaceWithPermissionOverridesUpdatesAcl", async () => {
    const workspaceId = "rw_12345678";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = getRequestUrl(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/v1/identities")) {
        return jsonResponse({ id: "id_shareable" });
      }
      if (url.endsWith("/v1/tokens")) {
        return jsonResponse({ accessToken: "shareable-token" });
      }
      if (url.includes(`/v1/workspaces/${workspaceId}/fs/file`)) {
        if (method === "GET") {
          return jsonResponse({
            revision: "rev_root_acl",
            content: "# relayfile acl\n",
            contentType: "text/plain",
            encoding: "utf-8",
            semantics: { permissions: [] },
          });
        }

        return jsonResponse({
          revision: "rev_root_acl_updated",
          content: "# relayfile acl\n",
        });
      }

      return jsonResponse({ ok: true });
    });

    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await loadJoinWorkspaceRoute();
    const response = await POST(
      new Request(`http://localhost/api/v1/workspaces/${workspaceId}/join`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentName: "claude",
          permissions: {
            readonly: ["/docs"],
          },
        }),
      }),
      {
        params: nextParams({ workspaceId }),
      },
    );

    expect(response.ok).toBe(true);
    const relayfileCalls = fetchMock.mock.calls.filter((call) =>
      getRequestUrl(call[0]).includes(`/v1/workspaces/${workspaceId}/fs/file`),
    );
    expect(relayfileCalls.map((call) => (call[1]?.method ?? "GET").toUpperCase())).toEqual([
      "GET",
      "PUT",
    ]);
    expect(JSON.parse(String(relayfileCalls[1]?.[1]?.body))).toEqual(
      expect.objectContaining({
        semantics: expect.objectContaining({
          permissions: expect.arrayContaining([
            "deny:scope:relayfile:fs:write:/docs",
          ]),
        }),
      }),
    );
  });
});

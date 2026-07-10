import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialBundle } from "../packages/core/src/auth/credentials.js";
import { launchOrchestratorSandbox } from "../packages/core/src/bootstrap/launcher.js";
import { generateWorkspaceId } from "../packages/core/src/workspace/id.js";
import {
  CloudWorkspaceRegistry,
  InMemoryWorkspaceRegistryStore,
  mintWorkspaceToken,
} from "../packages/core/src/workspace/registry.js";

const daytonaMocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("@daytonaio/sdk", () => ({
  Daytona: class {
    constructor(_auth: unknown) {}

    create = daytonaMocks.create;
  },
}));

type JwtClaims = {
  wks?: string;
  workspace_id?: string;
  workspaceId?: string;
  agent_name?: string;
  [key: string]: unknown;
};

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

function getRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (input instanceof Request) {
    return input.method.toUpperCase();
  }
  return (init?.method ?? "GET").toUpperCase();
}

function decodeJwt(token: string): JwtClaims {
  const [, payload = ""] = token.split(".");
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (normalized.length % 4)) % 4;
  return JSON.parse(
    Buffer.from(normalized + "=".repeat(pad), "base64").toString("utf8"),
  ) as JwtClaims;
}

function parseExportedEnv(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const match = /^export ([A-Za-z_][A-Za-z0-9_]*)='([\s\S]*)'$/.exec(line.trim());
    if (!match) {
      continue;
    }

    parsed[match[1]] = match[2].replace(/'\\''/g, "'");
  }

  return parsed;
}

function createRegistryFetchMock(apiKey: string) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = getRequestUrl(input);
    const method = getRequestMethod(input, init);

    if (url === "https://relaycast.test/v1/workspaces" && method === "POST") {
      return jsonResponse(
        {
          workspace_id: "rw_serverecho",
          api_key: apiKey,
        },
        { status: 201 },
      );
    }

    if (url === "https://api.relayauth.dev/v1/identities" && method === "POST") {
      return jsonResponse({ id: "id_registry" });
    }

    if (url === "https://api.relayauth.dev/v1/tokens" && method === "POST") {
      return jsonResponse({ accessToken: "relayauth-registry-token" });
    }

    if (url.startsWith("https://relayfile.test/")) {
      return jsonResponse({ ok: true });
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  daytonaMocks.create.mockReset();
});

describe("unified workspace creation and cross-service resolution", () => {
  it("TestGenerateWorkspaceId", () => {
    const first = generateWorkspaceId();
    const second = generateWorkspaceId();

    expect(first.startsWith("rw_")).toBe(true);
    expect(first).toHaveLength(11);
    expect(second).toHaveLength(11);
    expect(first).not.toBe(second);
  });

  it("TestCloudWorkspaceRegistryCreate", async () => {
    const fetchMock = createRegistryFetchMock("rk_live_registry_create");
    const registry = new CloudWorkspaceRegistry(
      "https://relaycast.test",
      "https://relayfile.test",
      "registry-relayauth-api-key",
      {
        fetchImpl: fetchMock,
        persistence: new InMemoryWorkspaceRegistryStore(),
        workspaceIdFactory: () => "rw_a7f3x9k2",
      },
    );

    const entry = await registry.create({
      name: "unified-project",
      createdBy: "user_123",
    });

    expect(entry).toMatchObject({
      id: "rw_a7f3x9k2",
      relaycastApiKey: "rk_live_registry_create",
      relayfileWorkspaceId: "rw_a7f3x9k2",
      relayauthWorkspaceId: "rw_a7f3x9k2",
      createdBy: "user_123",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getRequestUrl(fetchMock.mock.calls[0][0])).toBe(
      "https://relaycast.test/v1/workspaces",
    );
    expect(getRequestMethod(fetchMock.mock.calls[0][0], fetchMock.mock.calls[0][1])).toBe(
      "POST",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      name: "unified-project",
    });
  });

  it("TestCloudWorkspaceRegistryJoin", async () => {
    const fetchMock = createRegistryFetchMock("rk_live_registry_join");
    const registry = new CloudWorkspaceRegistry(
      "https://relaycast.test",
      "https://relayfile.test",
      "join-secret",
      {
        fetchImpl: fetchMock,
        persistence: new InMemoryWorkspaceRegistryStore(),
        workspaceIdFactory: () => "rw_b4c5d6e7",
      },
    );

    const workspace = await registry.create({
      name: "joinable-project",
      createdBy: "user_join",
    });
    vi.stubGlobal("fetch", fetchMock);
    const joined = await registry.join(workspace.id, "claude");

    expect(joined.token).toBe("relayauth-registry-token");
    expect(joined.relaycastApiKey).toBe(workspace.relaycastApiKey);
    expect(joined.entry.relaycastApiKey).toBe(workspace.relaycastApiKey);
  });

  it("TestUnifiedIdInRelayAuthMint", async () => {
    const fetchMock = createRegistryFetchMock("rk_unused");
    vi.stubGlobal("fetch", fetchMock);
    const token = await mintWorkspaceToken({
      workspaceId: "rw_a7f3x9k2",
      agentName: "claude",
      relayAuthUrl: "https://api.relayauth.dev",
      relayAuthApiKey: "relayauth-api-key",
    });

    expect(token).toBe("relayauth-registry-token");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      workspaceId: "rw_a7f3x9k2",
      sponsorId: "claude",
    });
  });

  it("TestLauncherUsesUnifiedId", async () => {
    const uploadedFiles = new Map<string, string>();
    const sandbox = {
      id: "sandbox-unified",
      process: {
        executeCommand: vi.fn(async () => ({ exitCode: 0, result: "" })),
      },
      fs: {
        uploadFile: vi.fn(async (content: Buffer, remotePath: string) => {
          if (remotePath.endsWith("/.bootstrap-env")) {
            uploadedFiles.set(remotePath, content.toString("utf8"));
          }
        }),
      },
      getUserHomeDir: vi.fn(async () => "/home/daytona"),
    };

    daytonaMocks.create.mockResolvedValue(sandbox);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = getRequestUrl(input);
      const method = getRequestMethod(input, init);

      if (url === "https://relayfile.test/health" && method === "GET") {
        return jsonResponse({ status: "ok" });
      }

      if (url.startsWith("https://relayfile.test/")) {
        return jsonResponse({ ok: true });
      }

      if (url === "https://api.relayauth.dev/v1/identities" && method === "POST") {
        return jsonResponse({ id: "id_launcher" });
      }

      if (url === "https://api.relayauth.dev/v1/tokens" && method === "POST") {
        return jsonResponse({ accessToken: "relayauth-launcher-token" });
      }

      if (url.startsWith("https://relaycast.test/")) {
        return jsonResponse({ ok: true });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const credentialBundle: CredentialBundle = {
      s3Credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        sessionToken: "session-token",
        bucket: "workspace-bucket",
        prefix: "user-123/run-456",
      },
      cliCredentials: "{}",
      workspaceId: "rw_a7f3x9k2",
      relayApiKey: "rk_live_launcher",
      relayBaseUrl: "https://api.relaycast.test",
      runId: "run-456",
      userId: "user-123",
      daytonaApiKey: "daytona-key",
    };

    const result = await launchOrchestratorSandbox({
      credentialBundle,
      runId: "run-456",
      relayfileUrl: "https://relayfile.test",
      relayAuthUrl: "https://api.relayauth.dev",
      relayAuthApiKey: "launcher-relayauth-api-key",
      fileType: "config",
      interactive: false,
    });

    expect(result.workspaceId).toBe("rw_a7f3x9k2");
    expect(getRequestUrl(fetchMock.mock.calls[0][0])).toBe("https://relayfile.test/health");

    const envText = uploadedFiles.get("/home/daytona/.bootstrap-env");
    expect(envText).toBeTruthy();

    const env = parseExportedEnv(envText ?? "");
    expect(env.RELAYFILE_WORKSPACE).toBe("rw_a7f3x9k2");
    expect(env.RELAYFILE_WORKSPACE).not.toMatch(/^wf-/);
    expect(env.RELAY_WORKSPACE_ID).toBe("rw_a7f3x9k2");
    expect(env.RELAY_API_KEY).toBe("rk_live_launcher");
    expect(env.RELAYFILE_TOKEN).toBe("relayauth-launcher-token");
  });
});

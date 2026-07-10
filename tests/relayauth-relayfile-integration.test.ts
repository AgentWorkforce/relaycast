import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  compileAgentPermissions,
  mergeAgentPermissions,
} from "../packages/core/src/permissions/compiler.js";
import { seedAgentPermissions } from "../packages/core/src/permissions/seeder.js";
import type { AgentPermissions } from "../packages/core/src/types/permissions.js";
import { DEFAULT_SYSTEM_PERMISSIONS as defaultSystemPermissions } from "../packages/core/src/types/permissions.js";
import type { CloudRelayYamlConfig } from "../packages/core/src/types/workflows.js";

type BulkSeedFile = {
  path: string;
  contentType: string;
  content: string;
  semantics: {
    permissions: string[];
  };
};

type BulkSeedBody = {
  workspaceId: string;
  files: BulkSeedFile[];
};

function getRequestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) {
    return input.url;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return String(input);
}

function getSeedBody(call: unknown[]): BulkSeedBody {
  const [, init] = call as [RequestInfo | URL, RequestInit | undefined];
  return JSON.parse(String(init?.body ?? "{}")) as BulkSeedBody;
}

function getSeedHeaders(call: unknown[]): Record<string, string> {
  const [, init] = call as [RequestInfo | URL, RequestInit | undefined];
  const headers = init?.headers;

  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, String(value)]),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("relayauth relayfile integration", () => {

  it("TestCompileAgentPermissions", () => {
    const compiled = compileAgentPermissions("alpha", {
      ignored: [".env", "secrets/"],
      readonly: ["README.md"],
    });

    expect(compiled.agentName).toBe("alpha");
    expect(compiled.scopes).toEqual(
      expect.arrayContaining([
        "fs:read",
        "fs:write",
        "sync:read",
        "workspace:alpha:read:*",
        "workspace:alpha:read:/.env",
        "workspace:alpha:read:/secrets/*",
        "workspace:alpha:write:*",
        "workspace:alpha:write:/README.md",
      ]),
    );
    expect(compiled.aclRules).toEqual({
      "/": expect.arrayContaining([
        "allow:agent:cloud-orchestrator",
        "allow:scope:workspace:alpha:read:*",
        "allow:scope:workspace:alpha:write:*",
        "deny:scope:workspace:alpha:read:/secrets/*",
        "deny:scope:workspace:alpha:write:/README.md",
      ]),
    });
  });

  it("TestSystemPermissionsApplied", () => {
    const merged = mergeAgentPermissions();
    const compiled = compileAgentPermissions("system-agent");

    expect(merged.ignored).toEqual(
      expect.arrayContaining(defaultSystemPermissions.alwaysIgnored),
    );
    expect(merged.readonly).toEqual(
      expect.arrayContaining(defaultSystemPermissions.alwaysReadonly),
    );
    expect(compiled.scopes).toEqual(
      expect.arrayContaining([
        "workspace:system-agent:read:/.env",
        "workspace:system-agent:read:/.env.*",
        "workspace:system-agent:read:/**/*.pem",
        "workspace:system-agent:write:/.env",
        "workspace:system-agent:write:/.github/workflows/*",
        "workspace:system-agent:write:/docker-compose*.yml",
      ]),
    );
    expect(compiled.aclRules["/"]).toContain("allow:agent:cloud-orchestrator");
  });

  it("TestPermissionsFlowEndToEnd", async () => {
    const alpha = compileAgentPermissions("alpha", {
      ignored: ["secrets/"],
      readonly: ["README.md"],
    });
    const beta = compileAgentPermissions("beta", {
      ignored: ["logs/"],
      readonly: ["docs/**"],
    });

    expect(alpha.scopes).not.toEqual(beta.scopes);
    expect(alpha.aclRules["/"]).toEqual(
      expect.arrayContaining(["deny:scope:workspace:alpha:read:/secrets/*"]),
    );
    expect(beta.aclRules["/"]).toEqual(
      expect.arrayContaining(["deny:scope:workspace:beta:read:/logs/*"]),
    );

    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 200, statusText: "OK" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await seedAgentPermissions(
      "https://relayfile.test/",
      "rw_aclflow01",
      "relay-admin-token",
      [alpha, beta],
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();

    const [input] = firstCall;
    const headers = getSeedHeaders(firstCall);
    const body = getSeedBody(firstCall);
    const filesByPath = new Map(body.files.map((file) => [file.path, file]));

    expect(getRequestUrl(input)).toBe(
      "https://relayfile.test/v1/workspaces/rw_aclflow01/fs/bulk",
    );
    expect(headers.Authorization).toBe("Bearer relay-admin-token");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Correlation-Id"]).toMatch(
      /^corr_relayauth_relayfile_permissions_/,
    );
    expect(body.workspaceId).toBe("rw_aclflow01");
    expect([...filesByPath.keys()]).toEqual(["/.relayfile.acl"]);
    expect(filesByPath.get("/.relayfile.acl")?.semantics.permissions).toEqual(
      expect.arrayContaining([
        "allow:agent:cloud-orchestrator",
        "allow:scope:workspace:alpha:read:*",
        "allow:scope:workspace:alpha:write:*",
        "allow:scope:workspace:beta:read:*",
        "allow:scope:workspace:beta:write:*",
        "deny:scope:workspace:alpha:read:/secrets/*",
        "deny:scope:workspace:alpha:write:/README.md",
        "deny:scope:workspace:beta:read:/logs/*",
        "deny:scope:workspace:beta:write:/docs/*",
      ]),
    );
  });

  it("TestWorkflowYAMLWithPermissions", () => {
    const workflowYaml = `
agents:
  - name: alpha
    permissions:
      ignored:
        - .env
        - secrets/
      readonly:
        - README.md
workflows:
  - name: provision
    steps:
      - id: inspect
        agent: alpha
        prompt: Inspect the workspace
`;

    const parsed = parseYaml(workflowYaml) as CloudRelayYamlConfig;
    const permissions = parsed.agents[0]?.permissions as AgentPermissions | undefined;

    expectTypeOf(permissions).toEqualTypeOf<AgentPermissions | undefined>();
    expect(permissions).toEqual({
      ignored: [".env", "secrets/"],
      readonly: ["README.md"],
    });
  });
});

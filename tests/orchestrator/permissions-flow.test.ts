import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectWorkflowAgentConfigs,
  provisionAgentAccess,
} from "../../packages/core/src/bootstrap/launcher.js";
import { generateBootstrapScript } from "../../packages/core/src/bootstrap/script-generator.js";
import {
  compileAgentPermissions,
  type CompiledAgentPermissions,
} from "../../packages/core/src/permissions/compiler.js";
import {
  RelayfilePathScopeError,
  relayfilePathsForIntegrations,
} from "../../packages/core/src/relayfile/path-scopes.js";
import { seedAgentPermissions } from "../../packages/core/src/permissions/seeder.js";

function relayPaTokenPair(accessToken: string): Record<string, string> {
  return {
    accessToken,
    accessTokenExpiresAt: "2027-01-15T08:00:00.000Z",
    refreshToken: "relay_pa_refresh-token",
    refreshTokenExpiresAt: "2027-01-16T08:00:00.000Z",
    tokenType: "Bearer",
  };
}

describe("compileAgentPermissions", () => {
  it("emits root scope ACL rules for per-agent access control", () => {
    const compiled = compileAgentPermissions("worker", {
      ignored: ["secrets/**"],
      readonly: ["docs/**"],
    });

    assert.deepEqual(Object.keys(compiled.aclRules), ["/"]);
    for (const permission of [
      "allow:agent:cloud-orchestrator",
      "allow:scope:workspace:worker:read:*",
      "allow:scope:workspace:worker:write:*",
      "deny:scope:workspace:worker:read:/secrets/*",
      "deny:scope:workspace:worker:write:/docs/*",
    ]) {
      assert.ok(compiled.aclRules["/"]?.includes(permission));
    }
    assert.ok(compiled.scopes.includes("fs:read"));
    assert.ok(compiled.scopes.includes("fs:write"));
    assert.ok(compiled.scopes.includes("sync:read"));
    assert.ok(compiled.scopes.includes("workspace:worker:read:*"));
    assert.ok(compiled.scopes.includes("workspace:worker:read:/secrets/*"));
    assert.ok(compiled.scopes.includes("workspace:worker:write:/docs/*"));
  });
});

describe("provisionAgentAccess", () => {
  it("mints path-scoped per-agent relayfile tokens from declared relayfile scopes", async () => {
    const originalFetch = globalThis.fetch;
    const relayAuthRequests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      relayAuthRequests.push({ url, init });
      if (url.endsWith("/v1/tokens/path")) {
        return new Response(JSON.stringify(relayPaTokenPair("relay_pa_worker-token")), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const access = await provisionAgentAccess({
        workspaceId: "ws-test",
        relayfileUrl: "https://relayfile.example",
        relayAuthUrl: "https://relayauth.example",
        relayAuthApiKey: "relayauth-api-key",
        workspaceToken: "relay_ws_workspace-token",
        agents: [
          {
            name: "worker",
            scopes: [
              "relayfile:fs:read:/github/pull_requests/**",
              "relayfile:fs:write:/github/pull_requests/**",
            ],
            permissions: {
              ignored: ["secrets/**"],
              readonly: ["docs/**"],
            },
          },
        ],
      });

      const worker = access.get("worker");
      assert.ok(worker);
      assert.ok(worker.scopes.includes("fs:read"));
      assert.ok(worker.scopes.includes("fs:write"));
      assert.ok(worker.scopes.includes("workspace:worker:read:/github/pull_requests/*"));
      assert.ok(worker.scopes.includes("workspace:worker:write:/github/pull_requests/*"));
      assert.equal(worker.token, "relay_pa_worker-token");
      assert.equal(relayAuthRequests.length, 1);
      assert.equal(
        (relayAuthRequests[0]?.init?.headers as Headers).get("authorization"),
        "Bearer relay_ws_workspace-token",
      );
      assert.deepEqual(JSON.parse(String(relayAuthRequests[0]?.init?.body)), {
        workspaceId: "ws-test",
        paths: ["/github/pull_requests/**"],
        ttlSeconds: 3600,
        agentName: "worker",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to legacy broad-scoped tokens for agents without path grants", async () => {
    const originalFetch = globalThis.fetch;
    const relayAuthRequests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      relayAuthRequests.push({ url, init });
      if (url.endsWith("/v1/identities")) {
        return new Response(JSON.stringify({ id: "id_generalist" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/v1/tokens")) {
        return new Response(JSON.stringify({ accessToken: "legacy-generalist-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const access = await provisionAgentAccess({
        workspaceId: "ws-test",
        relayfileUrl: "https://relayfile.example",
        relayAuthUrl: "https://relayauth.example",
        relayAuthApiKey: "relayauth-api-key",
        workspaceToken: "relay_ws_workspace-token",
        agents: [{ name: "generalist" }],
      });

      const generalist = access.get("generalist");
      assert.ok(generalist);
      assert.equal(generalist.token, "legacy-generalist-token");
      assert.ok(generalist.scopes.includes("workspace:generalist:read:*"));
      assert.ok(generalist.scopes.includes("workspace:generalist:write:*"));
      assert.equal(relayAuthRequests.length, 2);
      assert.equal(relayAuthRequests[0]?.url, "https://relayauth.example/v1/identities");
      assert.equal(relayAuthRequests[1]?.url, "https://relayauth.example/v1/tokens");
      assert.deepEqual(JSON.parse(String(relayAuthRequests[1]?.init?.body)), {
        identityId: "id_generalist",
        scopes: generalist.scopes,
        audience: ["relayfile"],
        expiresIn: 3600,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("derives sandbox relayfile token scopes from persona integration triggers", async () => {
    const originalFetch = globalThis.fetch;
    const relayAuthRequests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      relayAuthRequests.push({ url, init });
      if (url.endsWith("/v1/tokens/path")) {
        return new Response(JSON.stringify(relayPaTokenPair("relay_pa_review-agent-token")), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const agents = collectWorkflowAgentConfigs(`
agents:
  - name: review-agent
    integrations:
      github:
        triggers:
          - trigger:
              on: pull_request.opened
`);

      assert.deepEqual(agents, [
        {
          name: "review-agent",
          integrations: {
            github: {
              triggers: ["pull_request.opened"],
            },
          },
          scopes: [
            "relayfile:fs:read:/github/repos/**/**/pulls/**",
            "relayfile:fs:write:/github/repos/**/**/pulls/**",
          ],
          permissions: undefined,
        },
      ]);

      const access = await provisionAgentAccess({
        workspaceId: "ws-test",
        relayfileUrl: "https://relayfile.example",
        relayAuthUrl: "https://relayauth.example",
        relayAuthApiKey: "relayauth-api-key",
        workspaceToken: "relay_ws_workspace-token",
        agents,
      });

      const reviewAgent = access.get("review-agent");
      assert.ok(reviewAgent);
      assert.equal(reviewAgent.token, "relay_pa_review-agent-token");

      const pathTokenBody = JSON.parse(String(relayAuthRequests[0]?.init?.body)) as {
        paths: string[];
      };
      assert.deepEqual(pathTokenBody.paths, ["/github/repos/**/**/pulls/**"]);
      assert.ok(!pathTokenBody.paths.includes("*"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("maps Track G integration triggers to relayfile provider paths", () => {
    assert.deepEqual(
      relayfilePathsForIntegrations({
        linear: { triggers: [{ trigger: { on: "issue.created" } }] },
        slack: { triggers: [{ trigger: { on: "message.created" } }] },
        notion: { triggers: [{ trigger: { on: "page.updated" } }] },
        jira: { triggers: [{ trigger: { on: "issue.updated" } }] },
      }),
      [
        "/jira/issues/**",
        "/linear/issues/**",
        "/notion/databases/**/pages/**",
        "/notion/pages/**",
        "/slack/channels/**/messages/**",
        "/slack/users/**/messages/**",
      ],
    );
  });

  it("fails closed for unsupported relayfile trigger contracts", () => {
    assert.throws(
      () => relayfilePathsForIntegrations({
        linear: { triggers: [{ trigger: { on: "customer.created" } }] },
      }),
      RelayfilePathScopeError,
    );
    assert.throws(
      () => relayfilePathsForIntegrations({
        unknown: { triggers: [{ trigger: { on: "issue.created" } }] },
      }),
      RelayfilePathScopeError,
    );
  });

  it("merges triggers per provider when the same agent appears multiple times", () => {
    const agents = collectWorkflowAgentConfigs(`
agents:
  - name: review-agent
    integrations:
      github:
        triggers:
          - pull_request.opened
  - name: review-agent
    integrations:
      github:
        triggers:
          - issue.opened
`);

    assert.equal(agents.length, 1);
    const triggers = agents[0]?.integrations?.github?.triggers ?? [];
    assert.ok(triggers.includes("pull_request.opened"));
    assert.ok(triggers.includes("issue.opened"));
  });

  it("fails closed when explicit watch paths normalize to empty", () => {
    assert.throws(
      () => relayfilePathsForIntegrations({
        github: { triggers: [{ watchGlobs: ["*"] }] },
      }),
      RelayfilePathScopeError,
    );
    assert.throws(
      () => relayfilePathsForIntegrations({
        github: { triggers: [{ watchPaths: ["/**"] }] },
      }),
      RelayfilePathScopeError,
    );
  });
});

describe("seedAgentPermissions", () => {
  it("merges ACL rules and writes relayfile marker files in bulk", async () => {
    const requests: Array<{
      url: string;
      init?: RequestInit;
    }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    try {
      const compiledPermissions: CompiledAgentPermissions[] = [
        {
          agentName: "worker",
          scopes: [],
          aclRules: {
            "/": [
              "allow:agent:cloud-orchestrator",
              "allow:scope:workspace:worker:read:*",
              "deny:scope:workspace:worker:write:/docs/*",
            ],
          },
        },
        {
          agentName: "reviewer",
          scopes: [],
          aclRules: {
            "/": [
              "allow:agent:cloud-orchestrator",
              "allow:scope:workspace:reviewer:read:*",
              "deny:scope:workspace:reviewer:write:*",
            ],
          },
        },
      ];

      await seedAgentPermissions(
        "https://relayfile.example/",
        "ws-test",
        "admin-token",
        compiledPermissions,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(requests.length, 1);
    assert.equal(
      requests[0]?.url,
      "https://relayfile.example/v1/workspaces/ws-test/fs/bulk",
    );
    assert.equal(
      (requests[0]?.init?.headers as Record<string, string>).Authorization,
      "Bearer admin-token",
    );

    const body = JSON.parse(String(requests[0]?.init?.body)) as {
      workspaceId: string;
      files: Array<{
        path: string;
        content: string;
        semantics?: { permissions?: string[] };
      }>;
    };

    assert.equal(body.workspaceId, "ws-test");
    assert.deepEqual(
      body.files.map((file) => file.path),
      ["/.relayfile.acl"],
    );
    assert.deepEqual(body.files[0]?.semantics?.permissions, [
      "allow:agent:cloud-orchestrator",
      "allow:scope:workspace:reviewer:read:*",
      "allow:scope:workspace:worker:read:*",
      "deny:scope:workspace:reviewer:write:*",
      "deny:scope:workspace:worker:write:/docs/*",
    ]);
    assert.equal(
      body.files[0]?.content,
      [
        "allow:agent:cloud-orchestrator",
        "allow:scope:workspace:reviewer:read:*",
        "allow:scope:workspace:worker:read:*",
        "deny:scope:workspace:reviewer:write:*",
        "deny:scope:workspace:worker:write:/docs/*",
      ].join("\n"),
    );
  });
});

describe("generateBootstrapScript", () => {
  it("preserves RELAY_AGENT_TOKENS for non-interactive worker sandboxes", () => {
    const { inner: script } = generateBootstrapScript({ fileType: "yaml" });

    assert.match(script, /const relayAgentTokens = env\.RELAY_AGENT_TOKENS \?\? '';/);
    assert.match(script, /envSecrets\.RELAY_AGENT_TOKENS = relayAgentTokens;/);
  });
});

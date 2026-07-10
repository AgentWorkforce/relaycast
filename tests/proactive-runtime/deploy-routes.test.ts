import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { AgentDeployRouteDeps } from "../../packages/web/app/api/v1/agents/deploy/route.ts";
import type { CloudAgentDetailRouteDeps } from "../../packages/web/app/api/v1/cloud-agents/[agentId]/route.ts";
import type { LegacyDeployRouteDeps } from "../../packages/web/app/api/v1/deploy/route.ts";
import type { HostedDeploymentsRouteDeps } from "../../packages/web/app/v1/hosted-agents/deployments/route.ts";
import type { RequestAuth } from "../../packages/web/lib/auth/request-auth";
import type { AuthContext } from "../../packages/web/lib/auth/types";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const ORGANIZATION_ID = "33333333-3333-4333-8333-333333333333";

type SessionRequestAuth = RequestAuth & { source: "session"; context: AuthContext };
type TokenRequestAuth = RequestAuth & { source: "token"; scopes: string[] };
type CliRequestAuth = SessionRequestAuth | TokenRequestAuth;
type DeployResponse = Awaited<ReturnType<AgentDeployRouteDeps["deployEntrypoint"]>>;

function buildAuthContext(): AuthContext {
  return {
    user: {
      id: USER_ID,
      email: "support@example.com",
      name: "Support User",
      avatarUrl: null,
    },
    organizations: [{
      id: ORGANIZATION_ID,
      slug: "support-org",
      name: "Support Org",
      role: "owner",
      status: "active",
    }],
    currentOrganization: {
      id: ORGANIZATION_ID,
      slug: "support-org",
      name: "Support Org",
      role: "owner",
      status: "active",
    },
    workspaces: [{
      id: WORKSPACE_ID,
      organization_id: ORGANIZATION_ID,
      slug: "support-workspace",
      name: "Support Workspace",
    }],
    currentWorkspace: {
      id: WORKSPACE_ID,
      organization_id: ORGANIZATION_ID,
      slug: "support-workspace",
      name: "Support Workspace",
    },
  };
}

const requireSessionAuth: AgentDeployRouteDeps["requireSessionAuth"] = (
  candidate,
): candidate is SessionRequestAuth => candidate?.source === "session" && candidate.context !== undefined;

const requireAuthScope: AgentDeployRouteDeps["requireAuthScope"] = (candidate, scope) => {
  if (!candidate) {
    return false;
  }
  if (candidate.source === "session") {
    return true;
  }
  return candidate.scopes?.includes(scope) ?? false;
};

function sessionAuth(): SessionRequestAuth {
  return {
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    organizationId: ORGANIZATION_ID,
    source: "session",
    context: buildAuthContext(),
  };
}

function tokenAuth(): TokenRequestAuth {
  return {
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    organizationId: ORGANIZATION_ID,
    source: "token",
    scopes: ["cli:auth"],
  };
}

function createCliDeps(auth: CliRequestAuth = sessionAuth()) {
  return {
    resolveRequestAuth: mock.fn(async (
      _request: Parameters<AgentDeployRouteDeps["resolveRequestAuth"]>[0],
    ) => auth),
    requireSessionAuth,
    requireAuthScope,
    deployEntrypoint: mock.fn(async (
      _context: Parameters<AgentDeployRouteDeps["deployEntrypoint"]>[0],
      _input: Parameters<AgentDeployRouteDeps["deployEntrypoint"]>[1],
    ): Promise<DeployResponse> => ({
      deploymentId: "dep_123",
      agentId: "support-agent",
      workspaceId: "rw_support",
      status: "running",
    })),
  } satisfies AgentDeployRouteDeps;
}

function createSelectDbMock<T>(rows: T[]) {
  const limit = mock.fn(async (_count: number) => rows);
  const where = mock.fn((_predicate: unknown) => ({ limit }));
  const from = mock.fn((_table: unknown) => ({ where }));
  const select = mock.fn((_projection: unknown) => ({ from }));
  return {
    db: { select },
    select,
    from,
    where,
    limit,
  };
}

describe("proactive deploy routes", () => {
  it("creates a managed deploy from the CLI route", async () => {
    const { createAgentDeployRouteHandlers } = await import(
      "../../packages/web/app/api/v1/agents/deploy/route.ts"
    );
    const deps = createCliDeps(sessionAuth());
    const { POST } = createAgentDeployRouteHandlers(deps);
    const response = await POST(new Request("https://cloud.test/api/v1/agents/deploy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entrypoint: "src/agent.ts",
        source: "await agent({ workspace: 'support', onEvent: async () => {} });",
        name: "support-agent",
      }),
    }) as never);

    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      deploymentId: "dep_123",
      agentId: "support-agent",
      workspaceId: "rw_support",
      status: "running",
    });
    assert.equal(deps.deployEntrypoint.mock.calls.length, 1);
    assert.deepEqual(deps.deployEntrypoint.mock.calls[0].arguments[0], {
      userId: sessionAuth().userId,
      relayWorkspaceId: "",
      workspaceToken: "",
      appWorkspaceId: sessionAuth().workspaceId,
      organizationId: sessionAuth().organizationId,
      source: "session",
    });
    assert.deepEqual(deps.deployEntrypoint.mock.calls[0].arguments[1], {
      entrypoint: "src/agent.ts",
      source: "await agent({ workspace: 'support', onEvent: async () => {} });",
      name: "support-agent",
    });
  });

  it("returns the legacy deploy alias shape", async () => {
    const { createLegacyDeployRouteHandlers } = await import(
      "../../packages/web/app/api/v1/deploy/route.ts"
    );
    const deps = createCliDeps(tokenAuth());
    deps.deployEntrypoint = mock.fn(async (
      _context: Parameters<LegacyDeployRouteDeps["deployEntrypoint"]>[0],
      _input: Parameters<LegacyDeployRouteDeps["deployEntrypoint"]>[1],
    ): Promise<DeployResponse> => ({
      deploymentId: "dep_456",
      agentId: "ops-agent",
      workspaceId: "rw_ops",
      status: "running",
    }));

    const { POST } = createLegacyDeployRouteHandlers(deps);
    const response = await POST(new Request("https://cloud.test/api/v1/deploy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        file: "await agent({ workspace: 'ops', onEvent: async () => {} });",
        name: "ops-agent",
      }),
    }) as never);

    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      agentId: "ops-agent",
      deployId: "dep_456",
      deploymentId: "dep_456",
      workspaceId: "rw_ops",
      status: "running",
    });
  });

  it("accepts hosted custom deployments via workspace token auth", async () => {
    const { createHostedDeploymentsRouteHandlers } = await import(
      "../../packages/web/app/v1/hosted-agents/deployments/route.ts"
    );
    const deps = {
      requireHostedDeployContext: mock.fn(async (
        _request: Parameters<HostedDeploymentsRouteDeps["requireHostedDeployContext"]>[0],
      ): Promise<Exclude<Awaited<ReturnType<HostedDeploymentsRouteDeps["requireHostedDeployContext"]>>, Response>> => ({
        userId: "user_1",
        relayWorkspaceId: "rw_hosted",
        workspaceToken: "relay_ws_token",
        appWorkspaceId: "ws_app",
        organizationId: "org_app",
        source: "relay-workspace-token",
      })),
      deployHostedAgent: mock.fn(async (
        _context: Parameters<HostedDeploymentsRouteDeps["deployHostedAgent"]>[0],
        _input: Parameters<HostedDeploymentsRouteDeps["deployHostedAgent"]>[1],
      ): Promise<Awaited<ReturnType<HostedDeploymentsRouteDeps["deployHostedAgent"]>>> => ({
        deploymentId: "dep_hosted",
        agentId: "custom-agent",
        workspaceId: "rw_hosted",
        status: "running",
      })),
    } satisfies HostedDeploymentsRouteDeps;

    const { POST } = createHostedDeploymentsRouteHandlers(deps);
    const response = await POST(new Request("https://cloud.test/v1/hosted-agents/deployments", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer relay_ws_token" },
      body: JSON.stringify({
        name: "custom-agent",
        model: "claude-sonnet-4-5",
        instructions: "Handle inbox events carefully.",
        provider: {
          mode: "byok",
          secretRef: "anthropic-api-key",
        },
        runtime: {
          mode: "custom",
          onEventSource: "async (_ctx, _event) => {}",
        },
        schedule: "*/5 * * * *",
      }),
    }) as never);

    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      id: "dep_hosted",
      deployId: "dep_hosted",
      agentId: "custom-agent",
      deploymentId: "dep_hosted",
      workspaceId: "rw_hosted",
      status: "running",
    });
    assert.deepEqual(deps.deployHostedAgent.mock.calls[0].arguments[0], {
      userId: "user_1",
      relayWorkspaceId: "rw_hosted",
      workspaceToken: "relay_ws_token",
      appWorkspaceId: "ws_app",
      organizationId: "org_app",
      source: "relay-workspace-token",
    });
    assert.deepEqual(deps.deployHostedAgent.mock.calls[0].arguments[1], {
      name: "custom-agent",
      model: "claude-sonnet-4-5",
      instructions: "Handle inbox events carefully.",
      provider: {
        mode: "byok",
        secretRef: "anthropic-api-key",
      },
      runtime: {
        mode: "custom",
        onEventSource: "async (_ctx, _event) => {}",
      },
      schedule: "*/5 * * * *",
    });
  });

  it("surfaces proactive agent detail via the cloud-agents alias", async () => {
    const { createCloudAgentDetailRouteHandlers } = await import(
      "../../packages/web/app/api/v1/cloud-agents/[agentId]/route.ts"
    );
    const detailRecord = {
      id: "support-agent",
      displayName: "support-agent",
      status: "running",
      harness: "relay-agent",
    };
    const db = createSelectDbMock([detailRecord]);
    const deps = {
      resolveRequestAuth: mock.fn(async (
        _request: Parameters<CloudAgentDetailRouteDeps["resolveRequestAuth"]>[0],
      ) => tokenAuth()),
      requireSessionAuth,
      requireAuthScope,
      getDb: mock.fn(() => db.db as ReturnType<CloudAgentDetailRouteDeps["getDb"]>),
    } satisfies CloudAgentDetailRouteDeps;

    const { GET } = createCloudAgentDetailRouteHandlers(deps);
    const response = await GET(
      new Request("https://cloud.test/api/v1/cloud-agents/support-agent") as never,
      { params: Promise.resolve({ agentId: "support-agent" }) },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      id: "support-agent",
      displayName: "support-agent",
      status: "running",
      harness: "relay-agent",
    });
    assert.equal(deps.getDb.mock.calls.length, 1);
    assert.equal(db.select.mock.calls.length, 1);
    assert.equal(db.from.mock.calls.length, 1);
    assert.equal(db.where.mock.calls.length, 1);
    assert.equal(db.limit.mock.calls.length, 1);
  });
});

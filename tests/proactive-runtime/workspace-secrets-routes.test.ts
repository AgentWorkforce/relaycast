import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { WorkspaceSecretDetailRouteDeps } from "../../packages/web/app/api/v1/workspaces/[workspaceId]/secrets/[secretName]/route.ts";
import type { WorkspaceSecretsCollectionRouteDeps } from "../../packages/web/app/api/v1/workspaces/[workspaceId]/secrets/route.ts";
import type { RequestAuth } from "../../packages/web/lib/auth/request-auth";
import type { AuthContext } from "../../packages/web/lib/auth/types";
import type { WorkspaceRequestContext } from "../../packages/web/lib/proactive-runtime/api";
import type { ProactiveWorkspaceSecretRecord } from "../../packages/web/lib/proactive-runtime/secret-store";

const USER_ID = "user_1";
const WORKSPACE_ID = "ws_app";
const ORGANIZATION_ID = "org_app";
const CREATED_AT = "2026-05-12T00:00:00.000Z";
const UPDATED_AT = "2026-05-12T01:00:00.000Z";

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

function sessionAuth(): RequestAuth & { source: "session"; context: AuthContext } {
  return {
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    organizationId: ORGANIZATION_ID,
    source: "session",
    context: buildAuthContext(),
  };
}

function workspaceRequestContext(): WorkspaceRequestContext {
  return {
    auth: sessionAuth(),
    workspace: buildAuthContext().currentWorkspace,
  };
}

function secretRecord(
  name: string,
  envVar: string,
  maskedValue: string,
): ProactiveWorkspaceSecretRecord {
  return {
    name,
    envVar,
    maskedValue,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
}

function createDeps() {
  return {
    requireWorkspaceRequestContext: mock.fn(async (
      _request: Parameters<WorkspaceSecretsCollectionRouteDeps["requireWorkspaceRequestContext"]>[0],
      _workspaceId: Parameters<WorkspaceSecretsCollectionRouteDeps["requireWorkspaceRequestContext"]>[1],
    ): Promise<WorkspaceRequestContext> => workspaceRequestContext()),
    resolveOrProvisionRelayWorkspace: mock.fn(async (
      _input: Parameters<WorkspaceSecretsCollectionRouteDeps["resolveOrProvisionRelayWorkspace"]>[0],
    ): Promise<Awaited<ReturnType<WorkspaceSecretsCollectionRouteDeps["resolveOrProvisionRelayWorkspace"]>>> => ({
      id: "rw_support",
      relaycastApiKey: "relay_ws_key",
      provisioned: false,
    })),
    listWorkspaceSecrets: mock.fn(async (
      _relayWorkspaceId: Parameters<WorkspaceSecretsCollectionRouteDeps["listWorkspaceSecrets"]>[0],
    ): Promise<ProactiveWorkspaceSecretRecord[]> => []),
    writeWorkspaceSecret: mock.fn(async (
      _input: Parameters<WorkspaceSecretsCollectionRouteDeps["writeWorkspaceSecret"]>[0],
    ): Promise<ProactiveWorkspaceSecretRecord> => secretRecord(
      "anthropic-api-key",
      "ANTHROPIC_API_KEY",
      "sk****89",
    )),
    readWorkspaceSecret: mock.fn(async (
      _relayWorkspaceId: Parameters<WorkspaceSecretDetailRouteDeps["readWorkspaceSecret"]>[0],
      _name: Parameters<WorkspaceSecretDetailRouteDeps["readWorkspaceSecret"]>[1],
      _options?: Parameters<WorkspaceSecretDetailRouteDeps["readWorkspaceSecret"]>[2],
    ): Promise<ProactiveWorkspaceSecretRecord | null> => null),
    deleteWorkspaceSecret: mock.fn(async (
      _relayWorkspaceId: Parameters<WorkspaceSecretDetailRouteDeps["deleteWorkspaceSecret"]>[0],
      _name: Parameters<WorkspaceSecretDetailRouteDeps["deleteWorkspaceSecret"]>[1],
    ): Promise<ProactiveWorkspaceSecretRecord | null> => null),
  } satisfies WorkspaceSecretsCollectionRouteDeps & WorkspaceSecretDetailRouteDeps;
}

describe("workspace secret routes", () => {
  it("lists workspace secrets through the proactive secret store", async () => {
    const { createWorkspaceSecretsCollectionRouteHandlers } = await import(
      "../../packages/web/app/api/v1/workspaces/[workspaceId]/secrets/route.ts"
    );
    const deps = createDeps();
    deps.listWorkspaceSecrets = mock.fn(async (
      _relayWorkspaceId: Parameters<WorkspaceSecretsCollectionRouteDeps["listWorkspaceSecrets"]>[0],
    ): Promise<ProactiveWorkspaceSecretRecord[]> => [secretRecord(
      "anthropic-api-key",
      "ANTHROPIC_API_KEY",
      "sk****89",
    )]);

    const { GET } = createWorkspaceSecretsCollectionRouteHandlers(deps);
    const response = await GET(
      new Request("https://cloud.test/api/v1/workspaces/ws_app/secrets") as never,
      { params: Promise.resolve({ workspaceId: "ws_app" }) },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      data: {
        items: [{
          name: "anthropic-api-key",
          envVar: "ANTHROPIC_API_KEY",
          maskedValue: "sk****89",
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
        }],
      },
    });
    assert.equal(deps.listWorkspaceSecrets.mock.calls.length, 1);
    assert.deepEqual(deps.listWorkspaceSecrets.mock.calls[0].arguments, ["rw_support"]);
  });

  it("creates workspace secrets and returns the stored metadata", async () => {
    const { createWorkspaceSecretsCollectionRouteHandlers } = await import(
      "../../packages/web/app/api/v1/workspaces/[workspaceId]/secrets/route.ts"
    );
    const deps = createDeps();

    const { POST } = createWorkspaceSecretsCollectionRouteHandlers(deps);
    const response = await POST(
      new Request("https://cloud.test/api/v1/workspaces/ws_app/secrets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "anthropic-api-key",
          value: "sk-ant-test-123456789",
        }),
      }) as never,
      { params: Promise.resolve({ workspaceId: "ws_app" }) },
    );

    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      name: "anthropic-api-key",
      envVar: "ANTHROPIC_API_KEY",
      maskedValue: "sk****89",
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
    assert.equal(deps.writeWorkspaceSecret.mock.calls.length, 1);
    assert.deepEqual(deps.writeWorkspaceSecret.mock.calls[0].arguments, [{
      relayWorkspaceId: "rw_support",
      name: "anthropic-api-key",
      value: "sk-ant-test-123456789",
    }]);
  });

  it("reads and deletes individual workspace secrets", async () => {
    const { createWorkspaceSecretDetailRouteHandlers } = await import(
      "../../packages/web/app/api/v1/workspaces/[workspaceId]/secrets/[secretName]/route.ts"
    );
    const deps = createDeps();
    deps.readWorkspaceSecret = mock.fn(async (
      _relayWorkspaceId: Parameters<WorkspaceSecretDetailRouteDeps["readWorkspaceSecret"]>[0],
      _name: Parameters<WorkspaceSecretDetailRouteDeps["readWorkspaceSecret"]>[1],
      _options?: Parameters<WorkspaceSecretDetailRouteDeps["readWorkspaceSecret"]>[2],
    ): Promise<ProactiveWorkspaceSecretRecord | null> => secretRecord(
      "openai-api-key",
      "OPENAI_API_KEY",
      "sk****yz",
    ));
    deps.deleteWorkspaceSecret = mock.fn(async (
      _relayWorkspaceId: Parameters<WorkspaceSecretDetailRouteDeps["deleteWorkspaceSecret"]>[0],
      _name: Parameters<WorkspaceSecretDetailRouteDeps["deleteWorkspaceSecret"]>[1],
    ): Promise<ProactiveWorkspaceSecretRecord | null> => secretRecord(
      "openai-api-key",
      "OPENAI_API_KEY",
      "sk****yz",
    ));

    const { GET, DELETE } = createWorkspaceSecretDetailRouteHandlers(deps);
    const getResponse = await GET(
      new Request("https://cloud.test/api/v1/workspaces/ws_app/secrets/openai-api-key") as never,
      { params: Promise.resolve({ workspaceId: "ws_app", secretName: "openai-api-key" }) },
    );

    assert.equal(getResponse.status, 200);
    assert.deepEqual(await getResponse.json(), {
      name: "openai-api-key",
      envVar: "OPENAI_API_KEY",
      maskedValue: "sk****yz",
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });

    const deleteResponse = await DELETE(
      new Request("https://cloud.test/api/v1/workspaces/ws_app/secrets/openai-api-key", {
        method: "DELETE",
      }) as never,
      { params: Promise.resolve({ workspaceId: "ws_app", secretName: "openai-api-key" }) },
    );

    assert.equal(deleteResponse.status, 200);
    assert.deepEqual(await deleteResponse.json(), {
      name: "openai-api-key",
      envVar: "OPENAI_API_KEY",
      maskedValue: "sk****yz",
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
    assert.deepEqual(deps.readWorkspaceSecret.mock.calls[0].arguments, ["rw_support", "openai-api-key"]);
    assert.deepEqual(deps.deleteWorkspaceSecret.mock.calls[0].arguments, ["rw_support", "openai-api-key"]);
  });
});

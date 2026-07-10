import { describe, expect, it, vi } from "vitest";
import {
  CLOUD_INTEGRATIONS_WRITE_SCOPE,
  hasCloudControlScope,
} from "./integration-route-handler";
import type { RequestAuth } from "@/lib/auth/request-auth";

vi.mock("sst", () => ({
  Resource: {
    AuthSessionSecret: { value: "test-session-secret" },
  },
}));

vi.mock("@/lib/integrations/nango-service", () => ({
  getNangoConnectionDetails: vi.fn(),
  getProviderConfigKey: vi.fn(),
}));

vi.mock("@/lib/integrations/nango-slack", () => ({
  getSlackConnectionIdentity: vi.fn(),
}));

vi.mock("@/lib/integrations/disconnect-integration-backend", () => ({
  disconnectIntegrationBackend: vi.fn(),
}));

vi.mock("@/lib/integrations/slack-identity", () => ({
  mergeSlackConnectionIdentityMetadata: vi.fn(),
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  findSlackIntegrationByTeamId: vi.fn(),
  getWorkspaceIntegration: vi.fn(),
  looksLikeSlackTeamId: vi.fn(),
  upsertWorkspaceIntegration: vi.fn(),
}));

function auth(source: RequestAuth["source"], scopes: string[] = []): RequestAuth {
  return {
    userId: "user_123",
    workspaceId: "workspace_123",
    organizationId: "org_123",
    source,
    scopes,
    context: {
      user: { id: "user_123", email: "user@example.com" },
      workspaces: [{ id: "workspace_123", name: "Workspace" }],
    } as RequestAuth["context"],
  };
}

describe("hasCloudControlScope", () => {
  it("allows session auth", () => {
    expect(hasCloudControlScope(auth("session"), CLOUD_INTEGRATIONS_WRITE_SCOPE)).toBe(true);
  });

  it("allows explicit control scope tokens", () => {
    expect(
      hasCloudControlScope(
        auth("token", [CLOUD_INTEGRATIONS_WRITE_SCOPE]),
        CLOUD_INTEGRATIONS_WRITE_SCOPE,
      ),
    ).toBe(true);
  });

  it("allows cli auth tokens", () => {
    expect(
      hasCloudControlScope(auth("token", ["cli:auth"]), CLOUD_INTEGRATIONS_WRITE_SCOPE),
    ).toBe(true);
  });

  it("rejects relayfile path tokens even when they carry broad-looking scopes", () => {
    expect(
      hasCloudControlScope(
        auth("relayfile", ["cli:auth", CLOUD_INTEGRATIONS_WRITE_SCOPE]),
        CLOUD_INTEGRATIONS_WRITE_SCOPE,
      ),
    ).toBe(false);
  });

  it("rejects missing auth and tokens without a control scope", () => {
    expect(hasCloudControlScope(null, CLOUD_INTEGRATIONS_WRITE_SCOPE)).toBe(false);
    expect(hasCloudControlScope(auth("token"), CLOUD_INTEGRATIONS_WRITE_SCOPE)).toBe(false);
  });
});

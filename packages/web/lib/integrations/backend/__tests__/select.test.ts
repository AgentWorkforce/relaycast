import { describe, expect, it } from "vitest";
import {
  WORKSPACE_INTEGRATION_PROVIDERS,
  type WorkspaceIntegrationProvider,
  getProviderConfigKey,
} from "@/lib/integrations/providers";
import { BackendPolicyError, selectIntegrationBackend } from "..";

describe("selectIntegrationBackend", () => {
  it("defaults every known provider to Nango", () => {
    for (const provider of WORKSPACE_INTEGRATION_PROVIDERS) {
      expect(
        selectIntegrationBackend({
          workspaceId: "workspace-1",
          provider,
        }),
      ).toMatchObject({
        provider,
        backend: "nango",
        backendIntegrationId: getProviderConfigKey(provider),
      });
    }
  });

  it("honors an explicit Nango backend request", () => {
    expect(
      selectIntegrationBackend({
        workspaceId: "workspace-1",
        provider: "github",
        requestedBackend: "nango",
      }),
    ).toEqual({
      provider: "github",
      backend: "nango",
      backendIntegrationId: "github-relay",
    });
  });

  it("throws for unknown providers via the catalog resolver", () => {
    expect(() =>
      selectIntegrationBackend({
        workspaceId: "workspace-1",
        provider: "definitely-not-a-provider" as WorkspaceIntegrationProvider,
      }),
    ).toThrow(/Unknown workspace integration provider/);
  });

  it("honors an explicit Composio backend request for GitHub", () => {
    expect(
      selectIntegrationBackend({
        workspaceId: "workspace-1",
        provider: "github",
        requestedBackend: "composio",
      }),
    ).toEqual({
      provider: "github",
      backend: "composio",
      backendIntegrationId: "github",
    });
  });

  it("rejects Composio for providers that have not opted in", () => {
    try {
      selectIntegrationBackend({
        workspaceId: "workspace-1",
        provider: "notion",
        requestedBackend: "composio",
      });
      throw new Error("Expected BackendPolicyError");
    } catch (error) {
      expect(error).toBeInstanceOf(BackendPolicyError);
      expect((error as BackendPolicyError).code).toBe("backend_not_allowed");
    }
  });
});

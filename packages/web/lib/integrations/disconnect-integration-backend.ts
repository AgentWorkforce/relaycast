import {
  BackendPolicyError,
  getIntegrationBackend,
  selectIntegrationBackend,
} from "@/lib/integrations/backend";
import { logger } from "@/lib/logger";
import { isWorkspaceIntegrationProvider } from "@/lib/integrations/providers";
import {
  deleteWorkspaceIntegration,
  recordWorkspaceIntegrationDisconnect,
  type WorkspaceIntegrationRecord,
} from "@/lib/integrations/workspace-integrations";
import { isGithubInstallationCentricEnabled } from "@/lib/integrations/github-installation-centric-flag";
import { getDb } from "@/lib/db";
import { workspaceGithubInstallationLinks } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

type DisconnectIntegrationBackendInput = {
  workspaceId: string;
  provider: string;
  integration: WorkspaceIntegrationRecord | null;
};

export type DisconnectIntegrationBackendResult = {
  localDeleted: boolean;
  upstreamDelete: {
    success: boolean;
    backend: "nango" | "composio" | null;
    error: string | null;
  };
};

// Disconnect is operator-initiated and must be idempotent. If upstream cleanup
// fails, still clear the local binding so the operator has an escape hatch from
// broken status checks. The disconnect tombstone makes Nango sync self-heal
// ignore late webhooks for this exact connection instead of recreating the row.
export async function disconnectIntegrationBackend({
  workspaceId,
  provider,
  integration,
}: DisconnectIntegrationBackendInput): Promise<DisconnectIntegrationBackendResult> {
  if (!integration) {
    return {
      localDeleted: false,
      upstreamDelete: {
        success: true,
        backend: null,
        error: null,
      },
    };
  }

  if (isGithubInstallationCentricDisconnect({ provider, integration })) {
    await recordWorkspaceIntegrationDisconnect({
      workspaceId,
      provider,
      connectionId: integration.connectionId,
      providerConfigKey: integration.providerConfigKey,
    });
    await deleteWorkspaceGithubInstallationReference({
      workspaceId,
      installationId: integration.installationId,
    });
    await deleteWorkspaceIntegration(workspaceId, provider);
    return {
      localDeleted: true,
      upstreamDelete: {
        success: true,
        backend: null,
        error: null,
      },
    };
  }

  const selection = isWorkspaceIntegrationProvider(provider)
    ? selectIntegrationBackend({ workspaceId, provider })
    : {
      backend: "composio" as const,
      backendIntegrationId:
        integration.providerConfigKey?.replace(/-composio-relay$/, "") ??
        provider,
    };
  const backend = await getIntegrationBackend(selection.backend);
  if (!backend.deleteConnection) {
    throw new BackendPolicyError(
      "backend_not_implemented",
      `${selection.backend} backend does not support connection deletion`,
      selection.backend,
    );
  }

  let upstreamDeleteError: string | null = null;
  try {
    await backend.deleteConnection({
      connectionId: integration.connectionId,
      backendIntegrationId:
        selection.backend === "composio"
          ? selection.backendIntegrationId
          : integration.providerConfigKey ?? selection.backendIntegrationId,
      provider,
    });
  } catch (error) {
    upstreamDeleteError = error instanceof Error ? error.message : String(error);
    await logger.warn(
      "Upstream backend deleteConnection failed; proceeding to clear local workspace_integrations row",
      {
        area: "integration-disconnect",
        workspaceId,
        provider,
        backend: selection.backend,
        connectionId: integration.connectionId,
        error: upstreamDeleteError,
      },
    );
  }
  await recordWorkspaceIntegrationDisconnect({
    workspaceId,
    provider,
    connectionId: integration.connectionId,
    providerConfigKey: integration.providerConfigKey,
  });
  await deleteWorkspaceIntegration(workspaceId, provider);

  return {
    localDeleted: true,
    upstreamDelete: {
      success: upstreamDeleteError === null,
      backend: selection.backend,
      error: upstreamDeleteError,
    },
  };
}

function isGithubInstallationCentricDisconnect(input: {
  provider: string;
  integration: WorkspaceIntegrationRecord;
}): boolean {
  return normalizeGithubProvider(input.provider) &&
    normalizeGithubProvider(input.integration.provider) &&
    isGithubInstallationCentricEnabled();
}

function normalizeGithubProvider(provider: string): boolean {
  return provider.trim().toLowerCase().startsWith("github");
}

async function deleteWorkspaceGithubInstallationReference(input: {
  workspaceId: string;
  installationId: string | null;
}): Promise<void> {
  const conditions = [
    eq(workspaceGithubInstallationLinks.workspaceId, input.workspaceId),
  ];
  const installationId = input.installationId?.trim();
  if (installationId) {
    conditions.push(eq(workspaceGithubInstallationLinks.installationId, installationId));
  }
  await getDb()
    .delete(workspaceGithubInstallationLinks)
    .where(and(...conditions));
}

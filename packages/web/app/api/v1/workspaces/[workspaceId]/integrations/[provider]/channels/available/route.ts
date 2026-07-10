import { NextRequest, NextResponse } from "next/server";
import { resolveRequestAuth } from "@/lib/auth/request-auth";
import { listChannels, type SlackChannel } from "@/lib/integrations/nango-slack";
import { getProviderConfigKey } from "@/lib/integrations/nango-service";
import { resolveWorkspaceIntegrationProvider } from "@/lib/integrations/providers";
import {
  listWorkspaceIntegrationsByProviderAlias,
  type WorkspaceIntegrationRecord,
} from "@/lib/integrations/workspace-integrations";
import {
  hasWorkspaceIntegrationReadAccess,
  resolveWorkspaceIntegrationIdentity,
} from "@/lib/workspaces/workspace-integration-identity";

const SLACK_PROVIDERS = [
  "slack",
  "slack-my-senior-dev",
  "slack-nightcto",
] as const;

const SLACK_CHANNEL_PAGE_SIZE = 200;

type SlackProvider = (typeof SLACK_PROVIDERS)[number];

type AvailableChannelsRouteContext = {
  params: Promise<{ workspaceId: string; provider: string }>;
};

type ErrorResponse = {
  error: string;
};

type AvailableChannelsResponse = {
  channels: SlackChannel[];
  nextCursor?: string;
};

function isSlackProvider(value: string): value is SlackProvider {
  return (SLACK_PROVIDERS as readonly string[]).includes(value);
}

async function findSlackIntegrationForWorkspace(
  workspaceIds: readonly string[],
  provider: SlackProvider,
): Promise<WorkspaceIntegrationRecord | null> {
  for (const workspaceId of workspaceIds) {
    const integrations = await listWorkspaceIntegrationsByProviderAlias(
      workspaceId,
      provider,
    );
    if (integrations.length > 0) {
      return (
        integrations.find((integration) => !integration.name) ??
        integrations[0] ??
        null
      );
    }
  }
  return null;
}

function getSlackProviderConfigKey(
  integration: WorkspaceIntegrationRecord,
  fallbackProvider: SlackProvider,
): string {
  if (integration.providerConfigKey) {
    return integration.providerConfigKey;
  }

  const rowProvider = resolveWorkspaceIntegrationProvider(integration.provider);
  return getProviderConfigKey(rowProvider ?? fallbackProvider);
}

export async function GET(
  request: NextRequest,
  context: AvailableChannelsRouteContext,
) {
  const auth = await resolveRequestAuth(request);
  const { workspaceId, provider } = await context.params;

  if (!isSlackProvider(provider)) {
    return NextResponse.json<ErrorResponse>(
      { error: "Integration provider not found" },
      { status: 404 },
    );
  }

  if (!auth) {
    return NextResponse.json<ErrorResponse>(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  const identity = await resolveWorkspaceIntegrationIdentity(workspaceId);
  if (!hasWorkspaceIntegrationReadAccess(auth, identity)) {
    return NextResponse.json<ErrorResponse>(
      { error: "Forbidden" },
      { status: 403 },
    );
  }

  const integrationWorkspaceIds = [
    identity.relayWorkspaceId,
    ...identity.candidateWorkspaceIds,
  ].filter((entry, index, entries) => entry && entries.indexOf(entry) === index);
  const integration = await findSlackIntegrationForWorkspace(
    integrationWorkspaceIds,
    provider,
  );
  if (!integration) {
    return NextResponse.json<ErrorResponse>(
      { error: "Slack integration is not connected" },
      { status: 409 },
    );
  }

  try {
    const cursor = request.nextUrl.searchParams.get("cursor")?.trim() || undefined;
    const response = await listChannels(
      integration.connectionId,
      getSlackProviderConfigKey(integration, provider),
      {
        cursor,
        limit: SLACK_CHANNEL_PAGE_SIZE,
      },
    );

    return NextResponse.json<AvailableChannelsResponse>({
      channels: response.channels,
      ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
    });
  } catch (error) {
    console.error("Slack channel availability lookup failed:", error);
    return NextResponse.json<ErrorResponse>(
      { error: "Failed to list available Slack channels" },
      { status: 502 },
    );
  }
}

import { and, desc, eq, like, notInArray, sql, type SQL } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { resolveRequestAuth } from "@/lib/auth/request-auth";
import { getDb } from "@/lib/db";
import { integrationScopes, workspaceIntegrations } from "@/lib/db/schema";
import { joinChannel, listChannels, type SlackChannel } from "@/lib/integrations/nango-slack";
import { getProviderConfigKey } from "@/lib/integrations/nango-service";
import {
  hasWorkspaceIntegrationAccess,
  hasWorkspaceIntegrationReadAccess,
  resolveWorkspaceIntegrationIdentity,
} from "@/lib/workspaces/workspace-integration-identity";

const SLACK_PROVIDERS = [
  "slack",
  "slack-my-senior-dev",
  "slack-nightcto",
] as const;

const SLACK_CHANNEL_PAGE_SIZE = 200;
const SLACK_CHANNEL_SCOPE_KIND = "slack_channel";

type SlackProvider = (typeof SLACK_PROVIDERS)[number];

type SlackChannelsRouteContext = {
  params: Promise<{ workspaceId: string; provider: string }>;
};

type ErrorResponse = {
  error: string;
};

type SaveChannelsBody = {
  channelIds: string[];
};

type ConfiguredSlackChannel = {
  id: string;
  slackChannelId: string;
  slackChannelName: string | null;
  isPrivate: boolean;
  isEnabled: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type ConfiguredChannelsResponse = {
  channels: ConfiguredSlackChannel[];
};

type SaveChannelsError = {
  channelId: string;
  error: string;
};

type SaveChannelsResponse = {
  channels: ConfiguredSlackChannel[];
  errors: SaveChannelsError[];
};

type PersistedSlackChannel = {
  id: string;
  slackChannelId: string;
  slackChannelName: string | null;
  isPrivate: boolean;
  isEnabled: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type SuccessfulChannelUpsert = {
  slackChannelId: string;
  slackChannelName: string | null;
  isPrivate: boolean;
  metadata: Record<string, unknown>;
};

type DefaultWorkspaceIntegrationRow = typeof workspaceIntegrations.$inferSelect;

type SlackChannelScopeRow = {
  id: string;
  scopeId: string;
  configJson: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

function isSlackProvider(value: string): value is SlackProvider {
  return (SLACK_PROVIDERS as readonly string[]).includes(value);
}

function orderedIntegrationWorkspaceIds(
  relayWorkspaceId: string,
  candidateWorkspaceIds: readonly string[],
): string[] {
  return [relayWorkspaceId, ...candidateWorkspaceIds].filter(
    (entry, index, entries) => entry && entries.indexOf(entry) === index,
  );
}

function resolveSlackProvider(
  value: string | null | undefined,
  fallbackProvider: SlackProvider,
): SlackProvider {
  return value && isSlackProvider(value) ? value : fallbackProvider;
}

function isSaveChannelsBody(value: unknown): value is SaveChannelsBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const body = value as Record<string, unknown>;
  return Array.isArray(body.channelIds) && body.channelIds.every((entry) => typeof entry === "string");
}

function normalizeChannelIds(channelIds: string[]): string[] {
  return [...new Set(channelIds.map((channelId) => channelId.trim()).filter(Boolean))];
}

function toMetadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function buildMetadata(
  channel: SlackChannel | null,
  fallback: Record<string, unknown> = {},
): Record<string, unknown> {
  if (!channel) {
    return fallback;
  }

  return {
    isMember: channel.isMember,
    ...(channel.numMembers === undefined ? {} : { numMembers: channel.numMembers }),
    ...(channel.topic ? { topic: channel.topic } : {}),
    ...(channel.purpose ? { purpose: channel.purpose } : {}),
  };
}

function getStringConfigValue(
  config: Record<string, unknown>,
  key: string,
): string | null {
  const value = config[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function buildChannelConfig(
  provider: SlackProvider,
  channel: SuccessfulChannelUpsert,
): Record<string, unknown> {
  return {
    provider,
    is_enabled: true,
    is_private: channel.isPrivate,
    display_name: channel.slackChannelName,
    metadata: channel.metadata,
  };
}

function disabledChannelConfig(): SQL {
  return sql`jsonb_set(${integrationScopes.configJson}, '{is_enabled}', 'false'::jsonb, true)`;
}

function mapConfiguredChannel(record: SlackChannelScopeRow): ConfiguredSlackChannel {
  const config = toMetadataObject(record.configJson);
  const metadata = toMetadataObject(config.metadata);
  const slackChannelName =
    getStringConfigValue(config, "display_name") ??
    getStringConfigValue(config, "slack_channel_name");

  return {
    id: record.id,
    slackChannelId: record.scopeId,
    slackChannelName,
    isPrivate: config.is_private === true,
    isEnabled: config.is_enabled !== false,
    metadata,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function getDefaultWorkspaceIntegrationRow(
  workspaceIds: readonly string[],
  provider: SlackProvider,
): Promise<DefaultWorkspaceIntegrationRow | null> {
  const providerPredicate =
    provider === "slack"
      ? like(workspaceIntegrations.provider, `${provider}%`)
      : eq(workspaceIntegrations.provider, provider);

  for (const workspaceId of workspaceIds) {
    const integrations = await getDb()
      .select()
      .from(workspaceIntegrations)
      .where(
        and(
          eq(workspaceIntegrations.workspaceId, workspaceId),
          providerPredicate,
        ),
      )
      .orderBy(desc(workspaceIntegrations.updatedAt))
      .limit(10);

    const integration =
      integrations.find((entry) => !entry.name) ?? integrations[0] ?? null;

    if (integration) {
      return integration;
    }
  }

  return null;
}

async function listChannelScopes(
  workspaceIntegrationId: string,
): Promise<SlackChannelScopeRow[]> {
  const rows = await getDb()
    .select({
      id: integrationScopes.id,
      scopeId: integrationScopes.scopeId,
      configJson: integrationScopes.configJson,
      createdAt: integrationScopes.createdAt,
      updatedAt: integrationScopes.updatedAt,
    })
    .from(integrationScopes)
    .where(
      and(
        eq(integrationScopes.workspaceIntegrationId, workspaceIntegrationId),
        eq(integrationScopes.scopeKind, SLACK_CHANNEL_SCOPE_KIND),
      ),
    );

  return rows;
}

async function listConfiguredChannels(
  workspaceIntegrationId: string,
): Promise<ConfiguredSlackChannel[]> {
  const channels = (await listChannelScopes(workspaceIntegrationId))
    .map(mapConfiguredChannel)
    .filter((channel) => channel.isEnabled);

  return channels.sort((left, right) => {
    const leftName = left.slackChannelName ?? left.slackChannelId;
    const rightName = right.slackChannelName ?? right.slackChannelId;
    return leftName.localeCompare(rightName) || left.slackChannelId.localeCompare(right.slackChannelId);
  });
}

async function loadPersistedChannelsById(
  workspaceIntegrationId: string,
): Promise<Map<string, PersistedSlackChannel>> {
  const rows = await listChannelScopes(workspaceIntegrationId);

  return new Map(
    rows.map((row) => {
      const mapped = mapConfiguredChannel(row);
      return [mapped.slackChannelId, mapped] as const;
    }),
  );
}

async function loadRequestedChannelsById(
  connectionId: string,
  providerConfigKey: string,
  channelIds: string[],
): Promise<Map<string, SlackChannel>> {
  const requestedIds = new Set(channelIds);
  const channelsById = new Map<string, SlackChannel>();
  let cursor: string | undefined;

  while (channelsById.size < requestedIds.size) {
    const response = await listChannels(connectionId, providerConfigKey, {
      cursor,
      limit: SLACK_CHANNEL_PAGE_SIZE,
    });

    for (const channel of response.channels) {
      if (requestedIds.has(channel.id)) {
        channelsById.set(channel.id, channel);
      }
    }

    if (!response.nextCursor) {
      break;
    }

    cursor = response.nextCursor;
  }

  return channelsById;
}

function isJoinSuccessful(
  result: Awaited<ReturnType<typeof joinChannel>>,
  channel: SlackChannel | null,
): boolean {
  if (result.ok || result.error === "already_in_channel") {
    return true;
  }

  return (
    result.error === "method_not_supported_for_channel_type" &&
    channel?.isPrivate === true &&
    channel.isMember === true
  );
}

function buildSuccessfulChannelUpsert(
  channelId: string,
  channel: SlackChannel | null,
  existingChannel: PersistedSlackChannel | null,
  joinResult: Awaited<ReturnType<typeof joinChannel>>,
): SuccessfulChannelUpsert {
  return {
    slackChannelId: channelId,
    slackChannelName:
      channel?.name ??
      joinResult.channel?.name ??
      existingChannel?.slackChannelName ??
      null,
    isPrivate: channel?.isPrivate ?? existingChannel?.isPrivate ?? false,
    metadata: buildMetadata(channel, existingChannel?.metadata ?? {}),
  };
}

export async function GET(
  request: NextRequest,
  context: SlackChannelsRouteContext,
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

  try {
    const integration = await getDefaultWorkspaceIntegrationRow(
      orderedIntegrationWorkspaceIds(
        identity.relayWorkspaceId,
        identity.candidateWorkspaceIds,
      ),
      provider,
    );
    if (!integration) {
      return NextResponse.json<ConfiguredChannelsResponse>({ channels: [] });
    }

    const channels = await listConfiguredChannels(integration.id);
    return NextResponse.json<ConfiguredChannelsResponse>({ channels });
  } catch (error) {
    // If the table doesn't exist yet (migration pending), return empty channels
    // rather than a 500. PostgreSQL error code 42P01 = undefined_table.
    const isUndefinedTable =
      error instanceof Error &&
      (error.message.includes("relation") && error.message.includes("does not exist") ||
        (error as { code?: string }).code === "42P01");

    if (isUndefinedTable) {
      console.warn("integration_scopes table not found; migration may be pending");
      return NextResponse.json<ConfiguredChannelsResponse>({ channels: [] });
    }

    console.error("Slack channel config lookup failed:", error);
    const message = error instanceof Error ? error.message : "Failed to list configured Slack channels";
    return NextResponse.json<ErrorResponse>(
      { error: message },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  context: SlackChannelsRouteContext,
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
  if (!hasWorkspaceIntegrationAccess(auth, identity)) {
    return NextResponse.json<ErrorResponse>(
      { error: "Forbidden" },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ErrorResponse>(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  if (!isSaveChannelsBody(body)) {
    return NextResponse.json<ErrorResponse>(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  const channelIds = normalizeChannelIds(body.channelIds);

  try {
    const integration = await getDefaultWorkspaceIntegrationRow(
      orderedIntegrationWorkspaceIds(
        identity.relayWorkspaceId,
        identity.candidateWorkspaceIds,
      ),
      provider,
    );
    if (!integration) {
      if (channelIds.length === 0) {
        return NextResponse.json<SaveChannelsResponse>({
          channels: [],
          errors: [],
        });
      }

      return NextResponse.json<ErrorResponse>(
        { error: "Slack integration is not connected" },
        { status: 409 },
      );
    }
    if (!integration.connectionId) {
      return NextResponse.json<ErrorResponse>(
        { error: "Slack integration is missing a connection id" },
        { status: 409 },
      );
    }

    const persistedChannelsById = await loadPersistedChannelsById(integration.id);
    const successfulUpserts: SuccessfulChannelUpsert[] = [];
    const errors: SaveChannelsError[] = [];
    const integrationProvider = resolveSlackProvider(
      integration.provider,
      provider,
    );

    if (channelIds.length > 0) {
      const providerConfigKey =
        integration.providerConfigKey ?? getProviderConfigKey(integrationProvider);

      let requestedChannelsById = new Map<string, SlackChannel>();
      try {
        requestedChannelsById = await loadRequestedChannelsById(
          integration.connectionId,
          providerConfigKey,
          channelIds,
        );
      } catch (error) {
        console.error("Slack channel prefetch failed:", error);
      }

      for (const channelId of channelIds) {
        const requestedChannel = requestedChannelsById.get(channelId) ?? null;
        const existingChannel = persistedChannelsById.get(channelId) ?? null;

        try {
          const joinResult = await joinChannel(
            integration.connectionId,
            providerConfigKey,
            channelId,
          );

          if (!isJoinSuccessful(joinResult, requestedChannel)) {
            errors.push({
              channelId,
              error: joinResult.error ?? "Failed to join channel",
            });
            continue;
          }

          successfulUpserts.push(
            buildSuccessfulChannelUpsert(
              channelId,
              requestedChannel,
              existingChannel,
              joinResult,
            ),
          );
        } catch (error) {
          console.error("Slack channel join failed:", error);
          errors.push({
            channelId,
            error:
              error instanceof Error
                ? error.message
                : "Failed to join channel",
          });
        }
      }
    }

    const db = getDb();
    await db.transaction(async (tx) => {
      const timestamp = new Date();

      for (const channel of successfulUpserts) {
        await tx
          .insert(integrationScopes)
          .values({
            id: crypto.randomUUID(),
            workspaceIntegrationId: integration.id,
            scopeKind: SLACK_CHANNEL_SCOPE_KIND,
            scopeId: channel.slackChannelId,
            configJson: buildChannelConfig(integrationProvider, channel),
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .onConflictDoUpdate({
            target: [
              integrationScopes.workspaceIntegrationId,
              integrationScopes.scopeKind,
              integrationScopes.scopeId,
            ],
            targetWhere: sql`${integrationScopes.workspaceIntegrationId} IS NOT NULL`,
            set: {
              configJson: buildChannelConfig(integrationProvider, channel),
              updatedAt: timestamp,
            },
          });
      }

      const disableSet = {
        configJson: disabledChannelConfig(),
        updatedAt: timestamp,
      };

      if (channelIds.length === 0) {
        await tx
          .update(integrationScopes)
          .set(disableSet)
          .where(
            and(
              eq(integrationScopes.workspaceIntegrationId, integration.id),
              eq(integrationScopes.scopeKind, SLACK_CHANNEL_SCOPE_KIND),
            ),
          );
        return;
      }

      await tx
        .update(integrationScopes)
        .set(disableSet)
        .where(
          and(
            eq(integrationScopes.workspaceIntegrationId, integration.id),
            eq(integrationScopes.scopeKind, SLACK_CHANNEL_SCOPE_KIND),
            notInArray(integrationScopes.scopeId, channelIds),
          ),
        );
    });

    return NextResponse.json<SaveChannelsResponse>({
      channels: await listConfiguredChannels(integration.id),
      errors,
    });
  } catch (error) {
    console.error("Slack channel config save failed:", error);
    return NextResponse.json<ErrorResponse>(
      { error: "Failed to save Slack channel configuration" },
      { status: 500 },
    );
  }
}

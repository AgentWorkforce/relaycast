export type SlackConnectionIdentity = {
  teamId: string | null;
  enterpriseId: string | null;
  botUserId: string | null;
  workspaceName: string | null;
  workspaceUrl: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readRecord(record: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  const value = record?.[key];
  return isRecord(value) ? value : null;
}

function readFirstString(...values: unknown[]): string | null {
  for (const value of values) {
    const parsed = readString(value);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function readPrimaryAuthorization(
  value: unknown,
): Record<string, unknown> | null {
  if (!Array.isArray(value)) {
    return null;
  }

  for (const entry of value) {
    if (isRecord(entry)) {
      return entry;
    }
  }

  return null;
}

function emptySlackConnectionIdentity(): SlackConnectionIdentity {
  return {
    teamId: null,
    enterpriseId: null,
    botUserId: null,
    workspaceName: null,
    workspaceUrl: null,
  };
}

export function hasSlackConnectionIdentity(
  identity: Partial<SlackConnectionIdentity> | null | undefined,
): boolean {
  return Boolean(
    readString(identity?.teamId) ||
      readString(identity?.enterpriseId) ||
      readString(identity?.botUserId) ||
      readString(identity?.workspaceName) ||
      readString(identity?.workspaceUrl),
  );
}

export function mergeSlackConnectionIdentity(
  primary: Partial<SlackConnectionIdentity> | null | undefined,
  fallback: Partial<SlackConnectionIdentity> | null | undefined,
): SlackConnectionIdentity {
  return {
    teamId: readFirstString(primary?.teamId, fallback?.teamId),
    enterpriseId: readFirstString(primary?.enterpriseId, fallback?.enterpriseId),
    botUserId: readFirstString(primary?.botUserId, fallback?.botUserId),
    workspaceName: readFirstString(primary?.workspaceName, fallback?.workspaceName),
    workspaceUrl: readFirstString(primary?.workspaceUrl, fallback?.workspaceUrl),
  };
}

export function extractSlackConnectionIdentityFromMetadata(
  metadata: Record<string, unknown>,
): SlackConnectionIdentity {
  const team = readRecord(metadata, "team");
  const authedUser = readRecord(metadata, "authed_user");
  const incomingWebhook = readRecord(metadata, "incoming_webhook");
  const primaryAuthorization = readPrimaryAuthorization(metadata.authorizations);

  return {
    teamId: readFirstString(
      metadata.slackTeamId,
      metadata.context_team_id,
      metadata.team_id,
      metadata.teamId,
      team?.id,
      incomingWebhook?.team_id,
      authedUser?.team_id,
      primaryAuthorization?.team_id,
    ),
    enterpriseId: readFirstString(
      metadata.slackEnterpriseId,
      metadata.context_enterprise_id,
      metadata.enterprise_id,
      metadata.enterpriseId,
      readRecord(metadata, "enterprise")?.id,
      primaryAuthorization?.enterprise_id,
    ),
    botUserId: readFirstString(
      metadata.slackBotUserId,
      metadata.bot_user_id,
      metadata.botUserId,
      metadata.user_id,
      authedUser?.id,
      primaryAuthorization?.user_id,
    ),
    workspaceName: readFirstString(
      metadata.slackWorkspaceName,
      metadata.team_name,
      metadata.teamName,
      team?.name,
      incomingWebhook?.team,
      metadata.team,
    ),
    workspaceUrl: readFirstString(
      metadata.slackWorkspaceUrl,
      incomingWebhook?.url,
      metadata.url,
    ),
  };
}

export function extractSlackConnectionIdentityFromForwardPayload(
  payload: unknown,
): SlackConnectionIdentity {
  if (!isRecord(payload)) {
    return emptySlackConnectionIdentity();
  }

  const event = readRecord(payload, "event");
  const primaryAuthorization = readPrimaryAuthorization(payload.authorizations);

  return {
    teamId: readFirstString(
      payload.context_team_id,
      payload.team_id,
      event?.team,
      primaryAuthorization?.team_id,
    ),
    enterpriseId: readFirstString(
      payload.context_enterprise_id,
      payload.enterprise_id,
      primaryAuthorization?.enterprise_id,
    ),
    botUserId: readFirstString(
      primaryAuthorization?.user_id,
    ),
    workspaceName: null,
    workspaceUrl: null,
  };
}

export function mergeSlackConnectionIdentityMetadata(
  metadata: Record<string, unknown>,
  identity: Partial<SlackConnectionIdentity> | null | undefined,
): Record<string, unknown> {
  const normalized = mergeSlackConnectionIdentity(identity, undefined);
  if (!hasSlackConnectionIdentity(normalized)) {
    return metadata;
  }

  return {
    ...metadata,
    ...(normalized.teamId ? { slackTeamId: normalized.teamId } : {}),
    ...(normalized.enterpriseId ? { slackEnterpriseId: normalized.enterpriseId } : {}),
    ...(normalized.botUserId ? { slackBotUserId: normalized.botUserId } : {}),
    ...(normalized.workspaceName ? { slackWorkspaceName: normalized.workspaceName } : {}),
    ...(normalized.workspaceUrl ? { slackWorkspaceUrl: normalized.workspaceUrl } : {}),
  };
}

export function metadataMatchesSlackTeamId(
  metadata: Record<string, unknown>,
  teamId: string,
): boolean {
  const trimmed = readString(teamId);
  return Boolean(trimmed) && extractSlackConnectionIdentityFromMetadata(metadata).teamId === trimmed;
}

import {
  mintPathScopedRelayfileTokenPair,
  mintWorkspaceScopedRelayfileTokenPair,
  mintWorkspacePathScopedRelayfileTokenPair,
  type MintPathScopedRelayfileTokenOptions,
} from "@cloud/core/relayfile/client.js";
import {
  normalizeRelayfilePath,
  RelayfilePathScopeError,
  relayfilePathsForIntegrations,
  resilienceScopedRelayfileMountPaths,
  type RelayfileTriggerDescriptor,
  type RelayfileTriggerIntegrations,
} from "@cloud/core/relayfile/path-scopes.js";
import {
  relayfileTriggerIntegrationsFromAgentOrLegacy,
} from "@cloud/core/proactive-runtime/agent-spec.js";
import {
  assertSafeMemberWritePath,
  MemberTokenScopeError,
} from "@cloud/core/proactive-runtime/member-token-scope.js";
import { resolveRelayAuthConfig, resolveRelayfileConfig } from "@/lib/relayfile";
import {
  normalizePersonaIntegrationSource,
  type PersonaIntegrationConfigWithSource,
} from "./persona-integration-config";
import { resolveRelayfileCredentialWorkspaceId } from "./relayfile-integration-push";

export type RuntimeRelayfileCredentials = {
  relayfileUrl: string;
  relayauthUrl: string;
  refreshUrl: string;
  relayfileWorkspaceId: string;
  relayfileToken: string | null;
  relayfileTokenExpiresAt: string | null;
  relayfileRefreshToken: string | null;
  relayfileRefreshTokenExpiresAt: string | null;
  relayfileScopes: string[];
  delegationNotAfter: string | null;
  relayfileMountPaths: string[];
};

export type MintRuntimeRelayfileCredentialsInput = {
  workspaceId: string;
  workspaceToken?: string | null;
  useRelayAuthApiKey?: boolean;
  relayfileMountPaths: string[];
  relayfileScopes?: string[];
  ttlSeconds: number;
  delegationNotAfter?: string | null;
  agentName: string;
  agentId?: string | null;
  auditLogger?: MintPathScopedRelayfileTokenOptions["auditLogger"];
  includeRelayfileUrl?: boolean;
};

export const RELAYFILE_DELEGATED_REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90;

function relayfileFsScopesForMountPaths(paths: readonly string[]): string[] {
  return paths.flatMap((path) => [
    `relayfile:fs:read:${canonicalRelayAuthFsScopePath(path)}`,
    `relayfile:fs:write:${canonicalRelayAuthFsScopePath(path)}`,
  ]);
}

function defaultRuntimeRelayfileScopes(paths: readonly string[]): string[] {
  return [
    ...relayfileFsScopesForMountPaths(paths),
    "relayfile:ops:read:*",
  ];
}

function isRelayfileFsScope(scope: string): boolean {
  return /^relayfile:fs:(?:read|write):/.test(scope.trim());
}

function canonicalRelayAuthFsScopePath(path: string): string {
  const trimmed = path.trim();
  return trimmed.endsWith("/**") ? `${trimmed.slice(0, -3)}/*` : trimmed;
}

function canonicalRelayAuthWorkspaceScopes(scopes: readonly string[]): string[] {
  return scopes.map((scope) => {
    const match = /^(relayfile:fs:(?:read|write):)(.+)$/.exec(scope.trim());
    return match ? `${match[1]}${canonicalRelayAuthFsScopePath(match[2] ?? "")}` : scope.trim();
  });
}

export function normalizePersonaIntegrationConfigs(
  value: unknown,
): Record<string, PersonaIntegrationConfigWithSource> | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return null;
  }

  const normalized: Record<string, PersonaIntegrationConfigWithSource> = {};
  for (const [rawProvider, rawConfig] of Object.entries(value)) {
    const provider = rawProvider.trim();
    if (!provider || rawConfig === null || !isRecord(rawConfig)) {
      return null;
    }

    try {
      normalized[provider] = {
        ...rawConfig,
        source: normalizePersonaIntegrationSource(rawConfig),
      };
    } catch {
      return null;
    }
  }
  return normalized;
}

export function normalizeRelayfileMountPaths(value: readonly string[] | undefined): string[] {
  return resilienceScopedRelayfileMountPaths(
    (value ?? [])
      .map(normalizeRuntimeRelayfileMountPath)
      .filter((entry): entry is string => entry !== null),
  );
}

export function relayfileTriggerIntegrationsFromPersonaIntegrations(
  value: unknown,
): RelayfileTriggerIntegrations | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const integrations = new Map<string, { triggers?: RelayfileTriggerDescriptor[] }>();
  for (const [provider, config] of Object.entries(value)) {
    const normalizedProvider = provider.trim().toLowerCase();
    if (!normalizedProvider || !isRecord(config)) {
      continue;
    }

    const triggers = normalizeTriggerArray(config.triggers);
    if (triggers) {
      integrations.set(normalizedProvider, { triggers });
    }
  }

  return integrations.size > 0 ? Object.fromEntries(integrations) : undefined;
}

export function resolveRuntimeRelayfileMountPaths(input: {
  relayfileMountPaths?: readonly string[];
  integrations?: unknown;
  agent?: unknown;
}): string[] {
  if (input.relayfileMountPaths !== undefined) {
    return normalizeRelayfileMountPaths(input.relayfileMountPaths);
  }

  const triggerIntegrations = relayfileTriggerIntegrationsFromAgentOrLegacy({
    agent: input.agent,
    integrations: input.integrations,
  });
  assertAgentTriggerProvidersHaveIntegrations(input.agent, input.integrations);
  return relayfilePathsForIntegrations(triggerIntegrations);
}

export async function mintRuntimeRelayfileCredentials(
  input: MintRuntimeRelayfileCredentialsInput,
): Promise<RuntimeRelayfileCredentials> {
  const config = input.includeRelayfileUrl === false
    ? { ...resolveRelayAuthConfig(), relayfileUrl: "" }
    : resolveRelayfileConfig();
  // Resolve app workspace UUID → relay workspace ID (rw_*) so delegated tokens
  // target the same Durable Object DO namespace as the Cloud sync workflow writes.
  const resolvedWorkspaceId = await resolveRelayfileCredentialWorkspaceId(input.workspaceId);
  const relayfileMountPaths = normalizeRelayfileMountPaths(input.relayfileMountPaths);
  const workspaceToken = input.workspaceToken?.trim();
  const relayAuthApiKey = input.useRelayAuthApiKey ? config.relayAuthApiKey.trim() : "";
  let relayfileToken: string | null = null;
  let relayfileTokenExpiresAt: string | null = null;
  let relayfileRefreshToken: string | null = null;
  let relayfileRefreshTokenExpiresAt: string | null = null;
  let relayfileScopes: string[] = [];
  const requestedRelayfileScopes = input.relayfileScopes ?? [];

  if (relayfileMountPaths.length > 0 && (workspaceToken || relayAuthApiKey)) {
    const scopes = requestedRelayfileScopes.length > 0
      ? requestedRelayfileScopes
      : defaultRuntimeRelayfileScopes(relayfileMountPaths);
    const hasOnlyFsScopes = scopes.every(isRelayfileFsScope);
    const tokenPair = relayAuthApiKey
      ? hasOnlyFsScopes
        ? await mintWorkspacePathScopedRelayfileTokenPair({
          workspaceId: resolvedWorkspaceId,
          relayAuthUrl: config.relayAuthUrl,
          relayAuthApiKey,
          paths: relayfileMountPaths,
          scopes,
          ttlSeconds: input.ttlSeconds,
          refreshTokenTtlSeconds: RELAYFILE_DELEGATED_REFRESH_TOKEN_TTL_SECONDS,
          delegationNotAfter: input.delegationNotAfter ?? undefined,
          agentName: input.agentName,
          agentId: input.agentId ?? input.agentName,
          auditLogger: input.auditLogger,
        })
        : await mintWorkspaceScopedRelayfileTokenPair({
          workspaceId: resolvedWorkspaceId,
          relayAuthUrl: config.relayAuthUrl,
          relayAuthApiKey,
          scopes: canonicalRelayAuthWorkspaceScopes(scopes),
          ttlSeconds: input.ttlSeconds,
          refreshTokenTtlSeconds: RELAYFILE_DELEGATED_REFRESH_TOKEN_TTL_SECONDS,
          delegationNotAfter: input.delegationNotAfter ?? undefined,
          agentName: input.agentName,
          agentId: input.agentId ?? input.agentName,
          auditLogger: input.auditLogger,
        })
      : await mintPathScopedRelayfileTokenPair({
          workspaceId: resolvedWorkspaceId,
          relayAuthUrl: config.relayAuthUrl,
          workspaceToken: workspaceToken || undefined,
          paths: relayfileMountPaths,
          ttlSeconds: input.ttlSeconds,
          refreshTokenTtlSeconds: RELAYFILE_DELEGATED_REFRESH_TOKEN_TTL_SECONDS,
          delegationNotAfter: input.delegationNotAfter ?? undefined,
          agentName: input.agentName,
          agentId: input.agentId ?? input.agentName,
          auditLogger: input.auditLogger,
        });
    relayfileToken = tokenPair.accessToken;
    relayfileTokenExpiresAt = tokenPair.accessTokenExpiresAt;
    relayfileRefreshToken = tokenPair.refreshToken;
    relayfileRefreshTokenExpiresAt = tokenPair.refreshTokenExpiresAt;
    relayfileScopes = tokenPair.scopes;
  } else if (requestedRelayfileScopes.length > 0 && relayAuthApiKey) {
    const tokenPair = await mintWorkspaceScopedRelayfileTokenPair({
      workspaceId: resolvedWorkspaceId,
      relayAuthUrl: config.relayAuthUrl,
      relayAuthApiKey,
      scopes: canonicalRelayAuthWorkspaceScopes(requestedRelayfileScopes),
      ttlSeconds: input.ttlSeconds,
      refreshTokenTtlSeconds: RELAYFILE_DELEGATED_REFRESH_TOKEN_TTL_SECONDS,
      delegationNotAfter: input.delegationNotAfter ?? undefined,
      agentName: input.agentName,
      agentId: input.agentId ?? input.agentName,
      auditLogger: input.auditLogger,
    });
    relayfileToken = tokenPair.accessToken;
    relayfileTokenExpiresAt = tokenPair.accessTokenExpiresAt;
    relayfileRefreshToken = tokenPair.refreshToken;
    relayfileRefreshTokenExpiresAt = tokenPair.refreshTokenExpiresAt;
    relayfileScopes = tokenPair.scopes;
  }

  if (relayfileToken && relayfileTokenExpiresAt && input.auditLogger) {
    const nowMs = Date.now();
    const credExpiresInSeconds = Math.floor(
      (new Date(relayfileTokenExpiresAt).getTime() - nowMs) / 1000,
    );
    const refreshCredExpiresInSeconds = relayfileRefreshTokenExpiresAt
      ? Math.floor((new Date(relayfileRefreshTokenExpiresAt).getTime() - nowMs) / 1000)
      : null;
    input.auditLogger.info("Relayfile delegated credentials minted", {
      area: "relayfile",
      outcome: "delegated_credentials_minted",
      workspaceId: resolvedWorkspaceId,
      agentName: input.agentName,
      cred_expires_in_seconds: credExpiresInSeconds,
      refresh_cred_expires_in_seconds: refreshCredExpiresInSeconds,
      scopes: relayfileScopes,
    });
  }

  return {
    relayfileUrl: config.relayfileUrl,
    relayauthUrl: config.relayAuthUrl,
    refreshUrl: refreshUrlForRelayauth(config.relayAuthUrl),
    relayfileWorkspaceId: resolvedWorkspaceId,
    relayfileToken,
    relayfileTokenExpiresAt,
    relayfileRefreshToken,
    relayfileRefreshTokenExpiresAt,
    relayfileScopes,
    delegationNotAfter: input.delegationNotAfter ?? null,
    relayfileMountPaths,
  };
}

function refreshUrlForRelayauth(relayauthUrl: string): string {
  const baseUrl = relayauthUrl.endsWith("/") ? relayauthUrl : `${relayauthUrl}/`;
  return new URL("/v1/tokens/refresh", baseUrl).toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRuntimeRelayfileMountPath(entry: string): string | null {
  const normalized = normalizeRelayfilePath(entry);
  if (!normalized || hasParentTraversalSegment(normalized)) {
    return null;
  }

  try {
    // Reuse the launchMember root guard as a detector: invalid roots drop to no
    // runtime token, while valid paths keep the normalized Relayfile shape.
    assertSafeMemberWritePath(normalized);
  } catch (error) {
    if (error instanceof MemberTokenScopeError) {
      if (hasParentTraversalSegment(normalized)) {
        throw error;
      }
      return null;
    }
    throw error;
  }

  return normalized;
}

function hasParentTraversalSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === "..");
}

function normalizeTriggerArray(value: unknown): RelayfileTriggerDescriptor[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = [...new Set(
    value
      .map((entry): RelayfileTriggerDescriptor | null => {
        if (typeof entry === "string") {
          const trimmed = entry.trim();
          return trimmed || null;
        }
        return isRecord(entry) ? entry : null;
      })
      .filter((entry): entry is RelayfileTriggerDescriptor => entry !== null),
  )];
  return normalized.length > 0 ? normalized : undefined;
}

function assertAgentTriggerProvidersHaveIntegrations(agent: unknown, integrations: unknown): void {
  if (!isRecord(agent) || !isRecord(agent.triggers)) {
    return;
  }
  const personaIntegrations = isRecord(integrations) ? integrations : {};
  for (const [provider, triggers] of Object.entries(agent.triggers)) {
    if (!Array.isArray(triggers) || triggers.length === 0) {
      continue;
    }
    if (!isRecord(personaIntegrations[provider])) {
      throw new RelayfilePathScopeError(
        `agent.triggers.${provider} requires a matching integrations.${provider} connection`,
      );
    }
  }
}

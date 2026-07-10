import { NextRequest, NextResponse } from "next/server";
import { buildPendingProviderMetadata } from "@cloud/core/provider-readiness.js";
import { resolveRequestAuth } from "@/lib/auth/request-auth";
import { getConfiguredAppOrigin } from "@/lib/app-origin";
import { toAbsoluteAppUrl } from "@/lib/app-path";
import { logger } from "@/lib/logger";
import {
  buildIntegrationConnectionScopeTags,
  parseIntegrationConnectionScope,
  type IntegrationConnectionScope,
} from "@/lib/integrations/integration-scope";
import {
  GITHUB_OAUTH_IDENTITY_CONFIG_KEY,
  GITHUB_OAUTH_IDENTITY_PROVIDER,
  isGithubOauthIdentityConfigKey,
} from "@/lib/integrations/github-oauth-identity";
import { isGithubInstallationCentricEnabled } from "@/lib/integrations/github-installation-centric-flag";
import { insertUserIntegrationIfAbsent } from "@/lib/integrations/user-integrations";
import { insertWorkspaceIntegrationIfAbsent } from "@/lib/integrations/workspace-integrations";
import {
  BackendPolicyError,
  getIntegrationBackend,
  selectIntegrationBackend,
  type BackendIntegrationRef,
  type IntegrationBackend,
  type SetupSessionResult,
} from "@/lib/integrations/backend";
import {
  CLOUD_INTEGRATIONS_WRITE_SCOPE,
  hasCloudControlScope,
  type WorkspaceIntegrationRouteContext,
} from "@/lib/integrations/integration-route-handler";
import {
  isWorkspaceIntegrationProvider,
  type WorkspaceIntegrationProvider,
  getBackendIntegrationId,
  getProviderConfigKey,
  getWorkspaceIntegrationProviderDefinition,
  listWorkspaceIntegrationCatalogEntries,
  resolveWorkspaceIntegrationProvider,
} from "@/lib/integrations/providers";
import {
  hasWorkspaceIntegrationAccess,
  resolveWorkspaceIntegrationIdentity,
} from "@/lib/workspaces/workspace-integration-identity";

type ConnectSessionBody = {
  allowedIntegrations?: string[];
  requestedBackend?: IntegrationBackend;
  dockerHubUsername?: string;
  scope?: IntegrationConnectionScope;
  githubInstallationFlow?: boolean;
};

type ResolvedAllowedIntegration = {
  provider?: string;
  backendIntegrationId: string;
  preserveBackendIntegrationId: boolean;
  displayName?: string;
  vfsRoot?: string;
  /**
   * User-identity connects (github-oauth-relay): Nango-backed, forced to
   * deployer_user scope, persisted only as user_integrations rows. Never a
   * workspace integration, never in the provider registry.
   */
  userIdentity?: boolean;
};

const INTEGRATION_BACKENDS: ReadonlySet<string> = new Set(["nango", "composio"]);

function isConnectSessionBody(value: unknown): value is ConnectSessionBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const body = value as Record<string, unknown>;
  const scope = parseIntegrationConnectionScope(body.scope);

  return (
    body.allowedIntegrations === undefined ||
    (Array.isArray(body.allowedIntegrations) &&
      body.allowedIntegrations.every((entry) => typeof entry === "string"))
  ) && (
    body.requestedBackend === undefined ||
    (typeof body.requestedBackend === "string" &&
      INTEGRATION_BACKENDS.has(body.requestedBackend))
  ) && (
    body.dockerHubUsername === undefined ||
    typeof body.dockerHubUsername === "string"
  ) && (
    body.githubInstallationFlow === undefined ||
    typeof body.githubInstallationFlow === "boolean"
  ) && scope !== null;
}

// Legacy Nango config keys. Older clients (Ricky CLI / SDK) may still send
// selected `-sage` keys; we accept them and let Nango resolve via the
// integration alias map until the integrations are republished and clients update.
//
// `slack-sage` historically doubled as both the legacy Nango config-key and
// the legacy provider id (the provider id has since been renamed to
// `slack`). It stays in this set to keep the legacy config-key path
// working for clients that send it as a Nango config-key directly.
const LEGACY_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "github-sage",
  "slack-sage",
  "slack-sage-preview",
  "notion-sage",
  "linear-sage",
]);

function resolveAllowedIntegration(
  value: string,
  allowedConfigKeys: ReadonlySet<string>,
  requestedBackend?: IntegrationBackend,
): ResolvedAllowedIntegration | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (isGithubOauthIdentityConfigKey(trimmed)) {
    return {
      provider: GITHUB_OAUTH_IDENTITY_PROVIDER,
      backendIntegrationId: GITHUB_OAUTH_IDENTITY_CONFIG_KEY,
      preserveBackendIntegrationId: true,
      displayName: "GitHub (user identity)",
      userIdentity: true,
    };
  }

  const provider = resolveWorkspaceIntegrationProvider(trimmed);
  if (provider) {
    const isDirectProviderId = trimmed.toLowerCase() === provider;
    return {
      provider,
      backendIntegrationId: isDirectProviderId
        ? getProviderConfigKey(provider)
        : trimmed,
      preserveBackendIntegrationId: !isDirectProviderId,
    };
  }

  if (allowedConfigKeys.has(trimmed) || LEGACY_CONFIG_KEYS.has(trimmed)) {
    return {
      backendIntegrationId: trimmed,
      preserveBackendIntegrationId: true,
    };
  }

  if (requestedBackend === "composio") {
    const toolkitSlug = trimmed.toLowerCase();
    return {
      provider: toolkitSlug,
      backendIntegrationId: toolkitSlug,
      preserveBackendIntegrationId: false,
      displayName: toolkitSlug,
      vfsRoot: `/${toolkitSlug}`,
    };
  }

  return null;
}

function resolveAllowedIntegrations(
  values?: string[],
  requestedBackend?: IntegrationBackend,
): ResolvedAllowedIntegration[] | undefined {
  if (!values) {
    return undefined;
  }

  const providerByConfigKey = new Map<string, WorkspaceIntegrationProvider>(
    listWorkspaceIntegrationCatalogEntries().map((provider) => [
      getProviderConfigKey(provider.id as WorkspaceIntegrationProvider),
      provider.id as WorkspaceIntegrationProvider,
    ]),
  );
  const allowedConfigKeys = new Set(providerByConfigKey.keys());
  const resolved = values.map((value) => {
    const entry = resolveAllowedIntegration(value, allowedConfigKeys, requestedBackend);
    if (!entry) {
      return null;
    }

    if (entry.provider) {
      return entry;
    }

    const provider = providerByConfigKey.get(entry.backendIntegrationId);
    return provider
      ? {
        provider,
        backendIntegrationId: entry.backendIntegrationId,
        preserveBackendIntegrationId: true,
      }
      : entry;
  });

  return resolved.every((value): value is ResolvedAllowedIntegration => value !== null)
    ? resolved
    : undefined;
}

function resolveRequestedProviders(values?: ResolvedAllowedIntegration[]): string[] {
  if (!values) {
    return listWorkspaceIntegrationCatalogEntries().map(
      (entry) => entry.id as WorkspaceIntegrationProvider,
    );
  }

  const providers: string[] = [];
  for (const value of values) {
    if (value.provider && !providers.includes(value.provider)) {
      providers.push(value.provider);
    }
  }
  return providers;
}

function isDockerHubComposioRequest(
  requestedBackend: IntegrationBackend | undefined,
  allowedIntegrations: ResolvedAllowedIntegration[] | undefined,
): boolean {
  if (requestedBackend !== "composio") {
    return false;
  }

  return allowedIntegrations?.some((entry) => {
    const provider = entry.provider?.toLowerCase();
    const backendIntegrationId = entry.backendIntegrationId.toLowerCase();
    return (
      provider === "docker_hub" ||
      provider === "dockerhub" ||
      backendIntegrationId === "docker_hub" ||
      backendIntegrationId === "dockerhub"
    );
  }) ?? false;
}

function readDockerHubUsername(body: ConnectSessionBody): string | null {
  return body.dockerHubUsername?.trim() || null;
}

function isGithubWorkspaceConnectRequest(
  allowedIntegrations: ResolvedAllowedIntegration[] | undefined,
): boolean {
  return allowedIntegrations?.length === 1 &&
    allowedIntegrations[0]?.provider === "github" &&
    allowedIntegrations[0]?.userIdentity !== true;
}

function buildBackendIntegrationRefs(
  backend: IntegrationBackend,
  values?: ResolvedAllowedIntegration[],
): BackendIntegrationRef[] {
  const providers = resolveRequestedProviders(values);
  if (providers.length === 0 && values) {
    return values.map((value) => ({
      provider: value.provider ?? value.backendIntegrationId,
      backendIntegrationId: value.backendIntegrationId,
    }));
  }

  return values?.map((value) => {
    if (!value.provider) {
      return {
        provider: value.backendIntegrationId,
        backendIntegrationId: value.backendIntegrationId,
      };
    }

    if (!isWorkspaceIntegrationProvider(value.provider)) {
      return {
        provider: value.provider,
        backendIntegrationId: value.backendIntegrationId,
        displayName: value.displayName,
        backendMetadata: {},
      };
    }

    const definition = getWorkspaceIntegrationProviderDefinition(value.provider);
    const backendIntegrationId =
      getBackendIntegrationId(value.provider, backend) ??
      getProviderConfigKey(value.provider);
    const shouldPreserveBackendIntegrationId =
      value.preserveBackendIntegrationId &&
      backend === definition.defaultBackend;

    return {
      provider: value.provider,
      backendIntegrationId: shouldPreserveBackendIntegrationId
        ? value.backendIntegrationId
        : backendIntegrationId,
      displayName: definition.displayName,
      backendMetadata: {},
    };
  }) ?? [];
}

function backendPolicyStatus(error: BackendPolicyError): number {
  switch (error.code) {
    case "backend_not_configured":
    case "backend_not_implemented":
      return 501;
    case "backend_misconfigured":
    case "backend_not_allowed":
      return 400;
    default: {
      const unreachableCode: never = error.code;
      throw new Error(`Unhandled backend policy error code: ${unreachableCode}`);
    }
  }
}

function readSetupSessionConnectionId(session: SetupSessionResult): string | null {
  const record = session as SetupSessionResult & { connection_id?: unknown };
  const connectionId =
    session.connectionId ??
    (typeof record.connection_id === "string"
      ? record.connection_id
      : null);
  return connectionId?.trim() || null;
}

function isComposioStyleConnectionId(connectionId: string): boolean {
  return /^ca_[A-Za-z0-9_-]+$/u.test(connectionId.trim());
}

/**
 * Eagerly write a pending `workspace_integrations` row for every Nango-backed
 * workspace-integration provider in this connect session, BEFORE the user
 * completes OAuth in the browser.
 *
 * Root cause this guards against: the Nango connection-created ("auth")
 * webhook is the only thing that writes the workspace_integrations row, and
 * `handleAuthEvent` can only map a connection back to a workspace via
 * (a) an existing row keyed by connectionId, or (b) `end_user.id`/tags in the
 * webhook payload. If the webhook misroutes, arrives with stripped end-user
 * tags, or never reaches this deployment, there is no row, the event is
 * dropped with a warn, and the status endpoint reports `oauth.connected:false`
 * forever (the CLI then polls until "context deadline exceeded").
 *
 * The legacy `cli-connect-link-route.ts` already pre-creates this row (added
 * in #461). The newer `connect-session` route — which `relayfile integration
 * connect` now uses — never did, so the #461 safety net regressed for it.
 * This mirrors that proven logic, generically, for any Nango provider.
 *
 * Only pre-create when the setup-session response includes the actual Nango
 * connection id. Falling back to `workspaceId` corrupts the lookup key used by
 * sync/forward webhooks; the auth webhook and sync self-heal paths can still
 * create the row from Nango connection metadata when no id is available yet.
 *
 * The insert is atomic INSERT ... ON CONFLICT DO NOTHING keyed on
 * (workspaceId, provider) and only fires when `name IS NULL`, so it never
 * clobbers a live row the auth webhook may have already written.
 */
async function preCreatePendingNangoRows(
  workspaceId: string,
  userId: string,
  scope: IntegrationConnectionScope,
  connectionId: string | null,
  backend: IntegrationBackend,
  allowedIntegrations: ResolvedAllowedIntegration[] | undefined,
): Promise<void> {
  if (backend !== "nango" || !allowedIntegrations) {
    return;
  }
  if (!connectionId) {
    await logger.info("connect-session skipped pending workspace integration pre-create without connection id", {
      area: "integrations-connect-session",
      workspaceId,
    });
    return;
  }
  if (isComposioStyleConnectionId(connectionId)) {
    await logger.warn(
      "connect-session skipped Nango pending integration pre-create with non-Nango connection id",
      {
        area: "integrations-connect-session",
        workspaceId,
        connectionId,
      },
    );
    return;
  }

  const seen = new Set<string>();
  for (const entry of allowedIntegrations) {
    const provider = entry.provider;
    if (!provider) {
      continue;
    }
    if (seen.has(provider)) {
      continue;
    }

    let providerConfigKey: string;
    if (entry.userIdentity) {
      // User-identity entries (github-oauth-relay) are valid pre-create
      // targets even though they are not registry providers — they always
      // land in user_integrations via the deployer_user branch below.
      // POST validation forces deployer_user for them; belt-and-braces here.
      if (scope.kind !== "deployer_user") {
        continue;
      }
      providerConfigKey = entry.backendIntegrationId;
    } else if (!isWorkspaceIntegrationProvider(provider)) {
      continue;
    } else {
      providerConfigKey =
        entry.preserveBackendIntegrationId &&
        getWorkspaceIntegrationProviderDefinition(provider).defaultBackend === "nango"
          ? entry.backendIntegrationId
          : getProviderConfigKey(provider);
    }
    seen.add(provider);

    try {
      const metadata = buildPendingProviderMetadata({
        connectionId,
        providerConfigKey,
      });
      const { inserted } = scope.kind === "deployer_user"
        ? await insertUserIntegrationIfAbsent({
          userId,
          provider,
          connectionId,
          providerConfigKey,
          installationId: null,
          metadata,
        })
        : await insertWorkspaceIntegrationIfAbsent({
          workspaceId,
          provider,
          name: scope.kind === "workspace_service_account" ? scope.name : null,
          connectionId,
          providerConfigKey,
          installationId: null,
          // Seed explicit pending readiness so status routes don't treat the
          // empty-metadata placeholder as a legacy "connected" row and
          // prematurely report initialSync=complete / ready=true before OAuth
          // actually completes.
          metadata,
        });
      await logger.info("connect-session pre-created pending integration", {
        area: "integrations-connect-session",
        workspaceId,
        userId,
        scope,
        provider,
        providerConfigKey,
        connectionId,
        inserted,
      });
    } catch (error) {
      // Never fail the connect-session request on the placeholder insert; the
      // auth webhook + handleSyncEvent self-heal still cover this case. We log
      // (not just warn-to-console) so a missing-webhook failure mode is
      // diagnosable from structured logs rather than an opaque CLI hang.
      await logger.warn("connect-session failed to pre-create pending integration", {
        area: "integrations-connect-session",
        workspaceId,
        userId,
        scope,
        provider,
        providerConfigKey,
        connectionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export async function POST(
  request: NextRequest,
  context: WorkspaceIntegrationRouteContext,
) {
  const auth = await resolveRequestAuth(request);
  const { workspaceId } = await context.params;

  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const identity = await resolveWorkspaceIntegrationIdentity(workspaceId);
  const integrationWorkspaceId = identity.relayWorkspaceId;

  if (!hasWorkspaceIntegrationAccess(auth, identity)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!hasCloudControlScope(auth, CLOUD_INTEGRATIONS_WRITE_SCOPE)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown = {};
  try {
    const contentLength = request.headers.get("content-length");
    if (contentLength !== "0") {
      body = await request.json();
    }
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  if (!isConnectSessionBody(body)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const scope = parseIntegrationConnectionScope(body.scope);
  if (!scope) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const allowedIntegrations = resolveAllowedIntegrations(
    body.allowedIntegrations,
    body.requestedBackend,
  );
  if (body.allowedIntegrations && !allowedIntegrations) {
    const providers = listWorkspaceIntegrationCatalogEntries().map((entry) => ({
      id: entry.id,
      displayName: entry.displayName,
      configKey: getProviderConfigKey(entry.id as WorkspaceIntegrationProvider),
      vfsRoot: entry.vfsRoot,
    }));
    return NextResponse.json(
      {
        error: "unknown_provider",
        providers,
      },
      { status: 409 },
    );
  }

  const githubInstallationFlowRequested =
    body.githubInstallationFlow === true &&
    body.requestedBackend === undefined &&
    isGithubWorkspaceConnectRequest(allowedIntegrations);
  const githubInstallationFlowEnabled =
    githubInstallationFlowRequested && isGithubInstallationCentricEnabled();
  const effectiveAllowedIntegrations =
    githubInstallationFlowEnabled
      ? resolveAllowedIntegrations([GITHUB_OAUTH_IDENTITY_CONFIG_KEY])
      : allowedIntegrations;
  const effectiveScope: IntegrationConnectionScope =
    githubInstallationFlowEnabled ? { kind: "deployer_user" } : scope;

  const hasUserIdentityIntegration =
    effectiveAllowedIntegrations?.some((entry) => entry.userIdentity) ?? false;
  if (hasUserIdentityIntegration) {
    // Identity connects (github-oauth-relay) are user-scoped by definition
    // and must not be mixed with workspace-integration connects in one
    // session — the auth webhook would otherwise have to disambiguate two
    // persistence models from a single connection event.
    if (effectiveScope.kind !== "deployer_user") {
      return NextResponse.json(
        {
          error: "user_identity_scope_required",
          message: `${GITHUB_OAUTH_IDENTITY_CONFIG_KEY} requires scope {"kind":"deployer_user"}.`,
        },
        { status: 400 },
      );
    }
    if ((effectiveAllowedIntegrations?.length ?? 0) !== 1) {
      return NextResponse.json(
        {
          error: "user_identity_exclusive",
          message: `${GITHUB_OAUTH_IDENTITY_CONFIG_KEY} must be the only entry in allowedIntegrations.`,
        },
        { status: 400 },
      );
    }
  }

  const dockerHubUsername = readDockerHubUsername(body);
  if (isDockerHubComposioRequest(body.requestedBackend, effectiveAllowedIntegrations) && !dockerHubUsername) {
    return NextResponse.json(
      {
        error: "missing_docker_hub_username",
        message: "dockerHubUsername is required when connecting Docker Hub through Composio.",
      },
      { status: 400 },
    );
  }

  const requestedProviders = resolveRequestedProviders(effectiveAllowedIntegrations);
  const providerForSelection = requestedProviders[0] ?? "github";

  let session: SetupSessionResult;
  let backend: IntegrationBackend;
  let backendIntegrationId: string;
  try {
    if (hasUserIdentityIntegration) {
      // User-identity connects are always Nango-backed; there is no
      // workspace backend policy to consult for them.
      backend = "nango";
      backendIntegrationId = GITHUB_OAUTH_IDENTITY_CONFIG_KEY;
    } else if (isWorkspaceIntegrationProvider(providerForSelection)) {
      const selection = selectIntegrationBackend({
        workspaceId: integrationWorkspaceId,
        provider: providerForSelection,
        requestedBackend: body.requestedBackend,
      });
      backend = selection.backend;
      backendIntegrationId = selection.backendIntegrationId;
    } else if (body.requestedBackend === "composio") {
      backend = "composio";
      backendIntegrationId = providerForSelection;
    } else {
      throw new BackendPolicyError(
        "backend_not_allowed",
        `${providerForSelection} is not a registered workspace integration provider`,
        body.requestedBackend,
      );
    }

    const providerBackend = getIntegrationBackend(backend);
    session = await providerBackend.createSetupSession({
      workspaceId: integrationWorkspaceId,
      endUserId: integrationWorkspaceId,
      endUserEmail: auth.source === "session" ? auth.context?.user.email : null,
      successRedirectUrl: toAbsoluteAppUrl(
        getConfiguredAppOrigin(),
        "/api/v1/webhooks/composio/connect/callback",
      ).toString(),
      allowedIntegrations: body.allowedIntegrations
        ? buildBackendIntegrationRefs(backend, effectiveAllowedIntegrations)
        : [],
      metadata: backend === "composio" && dockerHubUsername
        ? { dockerHubUsername }
        : backend === "nango"
          ? buildIntegrationConnectionScopeTags({
            scope: effectiveScope,
            workspaceId: integrationWorkspaceId,
            userId: auth.userId,
          })
          : undefined,
    });
  } catch (error) {
    if (error instanceof BackendPolicyError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: backendPolicyStatus(error) },
      );
    }
    throw error;
  }

  const connectionId = readSetupSessionConnectionId(session);
  const responseBackendIntegrationId =
    backend === "composio" &&
    typeof session.backendMetadata?.toolkitSlug === "string"
      ? session.backendMetadata.toolkitSlug
      : backendIntegrationId;

  // Belt-and-braces self-heal: pre-create the pending workspace_integrations
  // row(s) so a successful Nango OAuth is recorded even if the
  // connection-created webhook misroutes / arrives with stripped end-user
  // tags / never reaches this deployment.
  await preCreatePendingNangoRows(
    integrationWorkspaceId,
    auth.userId,
    effectiveScope,
    connectionId,
    backend,
    effectiveAllowedIntegrations,
  );

  return NextResponse.json({
    connectLink: session.connectLink,
    ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
    ...(connectionId ? { connectionId } : {}),
    ...(session.backendMetadata
      ? { backendMetadata: session.backendMetadata }
      : {}),
    token: session.sessionToken,
    sessionToken: session.sessionToken,
    workspaceId,
    relayWorkspaceId: integrationWorkspaceId,
    backend,
    backendIntegrationId: responseBackendIntegrationId,
    ...(githubInstallationFlowRequested
      ? {
        githubInstallationFlow: githubInstallationFlowEnabled
          ? {
            enabled: true,
            oauthProviderConfigKey: GITHUB_OAUTH_IDENTITY_CONFIG_KEY,
            reconcileUrl: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/github/reconcile`,
            installProviderConfigKey: getProviderConfigKey("github"),
          }
          : { enabled: false },
      }
      : {}),
    providers:
      effectiveAllowedIntegrations?.map((entry) => {
        if (!entry.provider) {
          return null;
        }
        if (entry.userIdentity) {
          return {
            id: entry.provider,
            displayName: entry.displayName ?? entry.provider,
            backend,
            backendIntegrationId: entry.backendIntegrationId,
            configKey: entry.backendIntegrationId,
            providerConfigKey: entry.backendIntegrationId,
            backendMetadata: {},
            vfsRoot: null,
          };
        }
        if (!isWorkspaceIntegrationProvider(entry.provider)) {
          const dynamicBackendIntegrationId =
            typeof session.backendMetadata?.toolkitSlug === "string"
              ? session.backendMetadata.toolkitSlug
              : entry.backendIntegrationId;
          const dynamicDisplayName =
            typeof session.backendMetadata?.displayName === "string"
              ? session.backendMetadata.displayName
              : entry.displayName ?? entry.provider;
          return {
            id: dynamicBackendIntegrationId,
            displayName: dynamicDisplayName,
            backend,
            backendIntegrationId: dynamicBackendIntegrationId,
            configKey: `${dynamicBackendIntegrationId}-composio-relay`,
            providerConfigKey: `${dynamicBackendIntegrationId}-composio-relay`,
            backendMetadata: session.backendMetadata ?? {},
            vfsRoot:
              typeof session.backendMetadata?.toolkitSlug === "string"
                ? `/${dynamicBackendIntegrationId}`
                : entry.vfsRoot ?? `/${dynamicBackendIntegrationId}`,
          };
        }
        const definition = getWorkspaceIntegrationProviderDefinition(entry.provider);
        return {
          id: entry.provider,
          displayName: definition.displayName,
          backend,
          backendIntegrationId:
            entry.preserveBackendIntegrationId &&
            backend === definition.defaultBackend
              ? entry.backendIntegrationId
              : getBackendIntegrationId(entry.provider, backend) ??
                getProviderConfigKey(entry.provider),
          configKey: getProviderConfigKey(entry.provider),
          providerConfigKey: getProviderConfigKey(entry.provider),
          backendMetadata: {},
          vfsRoot: definition.vfsRoot,
        };
      }).filter((item): item is NonNullable<typeof item> => item !== null) ?? [],
  });
}

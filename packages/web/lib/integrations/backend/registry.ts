import {
  createConnectSession,
  deleteNangoConnection,
  getNangoConnection,
  getNangoSecretKey,
} from "@/lib/integrations/nango-service";
import {
  createComposioAuthConfig,
  createComposioConnectionLink,
  deleteComposioConnectedAccount,
  getComposioConnectedAccount,
  isComposioManagedAuthUnavailable,
  listComposioAuthConfigs,
  resolveComposioToolkit,
} from "@/lib/integrations/composio-service";
import { buildComposioConnectCallbackUrl } from "@/lib/integrations/composio-connect-callback";
import { BackendNotConfiguredError } from "@/lib/integrations/backend-config";
import { isWorkspaceIntegrationProvider } from "@/lib/integrations/providers";
import { BackendPolicyError } from "./errors";
import type {
  BackendConnection,
  ConnectionLookupInput,
  CreateSetupSessionInput,
  IntegrationBackend,
  ProviderBackend,
  SetupSessionResult,
} from "./types";

type NangoConnectSession = {
  token: string;
  expiresAt?: string;
  connectLink: string;
  connectionId?: string;
  connection_id?: string;
};

type CreateConnectSession = (input: {
  endUserId: string;
  endUserEmail?: string | null;
  allowedIntegrations?: string[];
  tags?: Record<string, unknown>;
  integrationConfigDefaults?: Record<
    string,
    { authorization_params?: Record<string, string> }
  >;
}) => Promise<NangoConnectSession>;

type GetNangoConnection = (
  connectionId: string,
  providerConfigKey?: string | null,
  options?: { provider?: string },
) => Promise<BackendConnection | null>;

type DeleteNangoConnection = (
  connectionId: string,
  providerConfigKey?: string | null,
) => Promise<boolean>;

type ListComposioAuthConfigs = typeof listComposioAuthConfigs;
type CreateComposioAuthConfig = typeof createComposioAuthConfig;
type CreateComposioConnectionLink = typeof createComposioConnectionLink;
type GetComposioConnectedAccount = typeof getComposioConnectedAccount;
type DeleteComposioConnectedAccount = typeof deleteComposioConnectedAccount;
type ResolveComposioToolkit = typeof resolveComposioToolkit;

export type IntegrationBackendRegistryDeps = {
  createConnectSession?: CreateConnectSession;
  deleteNangoConnection?: DeleteNangoConnection;
  getNangoConnection?: GetNangoConnection;
  listComposioAuthConfigs?: ListComposioAuthConfigs;
  createComposioAuthConfig?: CreateComposioAuthConfig;
  createComposioConnectionLink?: CreateComposioConnectionLink;
  getComposioConnectedAccount?: GetComposioConnectedAccount;
  deleteComposioConnectedAccount?: DeleteComposioConnectedAccount;
  resolveComposioToolkit?: ResolveComposioToolkit;
};

function readConnectionId(session: NangoConnectSession): string | undefined {
  const connectionId = session.connectionId ?? session.connection_id;
  return connectionId?.trim() || undefined;
}

function createNangoBackend(deps: IntegrationBackendRegistryDeps): ProviderBackend {
  const createSession = deps.createConnectSession ?? createConnectSession;
  const deleteConnection = deps.deleteNangoConnection ?? deleteNangoConnection;
  const lookupConnection = deps.getNangoConnection ?? getNangoConnection;

  return {
    backend: "nango",
    async createSetupSession(
      input: CreateSetupSessionInput,
    ): Promise<SetupSessionResult> {
      const session = await createSession({
        endUserId: input.endUserId,
        endUserEmail: input.endUserEmail,
        allowedIntegrations:
          input.allowedIntegrations.length > 0
            ? input.allowedIntegrations.map((entry) => entry.backendIntegrationId)
            : undefined,
        tags: input.metadata,
        integrationConfigDefaults: buildNangoIntegrationConfigDefaults(
          input.allowedIntegrations,
        ),
      });

      return {
        backend: "nango",
        connectLink: session.connectLink,
        sessionToken: session.token,
        expiresAt: session.expiresAt,
        connectionId: readConnectionId(session),
        raw: session,
      };
    },
    async getConnection(
      input: ConnectionLookupInput,
    ): Promise<BackendConnection | null> {
      if (!deps.getNangoConnection && !getNangoSecretKey()?.trim()) {
        throw new BackendPolicyError(
          "backend_not_configured",
          "Nango backend not configured",
          "nango",
        );
      }

      return lookupConnection(input.connectionId, input.backendIntegrationId, {
        provider: input.provider,
      });
    },
    deleteConnection(input) {
      return deleteConnection(input.connectionId, input.backendIntegrationId);
    },
  };
}

function buildNangoIntegrationConfigDefaults(
  allowedIntegrations: readonly { backendIntegrationId: string }[],
): Record<string, { authorization_params?: Record<string, string> }> | undefined {
  const defaults: Record<string, { authorization_params?: Record<string, string> }> = {};

  for (const integration of allowedIntegrations) {
    if (
      integration.backendIntegrationId === "linear-relay" ||
      integration.backendIntegrationId === "linear-sage" ||
      integration.backendIntegrationId === "linear-ricky"
    ) {
      defaults[integration.backendIntegrationId] = {
        authorization_params: { actor: "app" },
      };
    }
  }

  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

function readComposioAuthConfigId(config: unknown): string | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return null;
  }
  const record = config as Record<string, unknown>;
  if (typeof record.id === "string" && record.id.trim()) {
    return record.id.trim();
  }
  return (
    readComposioAuthConfigId(record.data) ??
    readComposioAuthConfigId(record.auth_config) ??
    readComposioAuthConfigId(record.authConfig)
  );
}

function readFirstComposioAuthConfigId(configs: unknown[]): string | null {
  for (const config of configs) {
    const id = readComposioAuthConfigId(config);
    if (id) {
      return id;
    }
  }
  return null;
}

function humanizeComposioSlug(value: string): string {
  return value
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function readComposioStatus(account: Record<string, unknown>): BackendConnection["status"] {
  const status = typeof account.status === "string" ? account.status.trim().toUpperCase() : "";
  if (status === "ACTIVE") {
    return "active";
  }
  if (status === "INACTIVE" || status === "EXPIRED" || status === "DISABLED") {
    return "inactive";
  }
  return "unknown";
}

function mapComposioBackendError(error: unknown): never {
  if (error instanceof BackendNotConfiguredError && error.backend === "composio") {
    throw new BackendPolicyError(
      "backend_not_configured",
      "Composio backend not configured",
      "composio",
    );
  }
  if (error instanceof Error) {
    throw new BackendPolicyError(
      "backend_misconfigured",
      error.message || "Composio backend request failed",
      "composio",
    );
  }
  throw error;
}

function createComposioBackend(deps: IntegrationBackendRegistryDeps): ProviderBackend {
  const listAuthConfigs = deps.listComposioAuthConfigs ?? listComposioAuthConfigs;
  const createAuthConfig = deps.createComposioAuthConfig ?? createComposioAuthConfig;
  const createConnectionLink = deps.createComposioConnectionLink ?? createComposioConnectionLink;
  const lookupConnection = deps.getComposioConnectedAccount ?? getComposioConnectedAccount;
  const deleteConnection = deps.deleteComposioConnectedAccount ?? deleteComposioConnectedAccount;
  const resolveToolkit = deps.resolveComposioToolkit ?? resolveComposioToolkit;

  return {
    backend: "composio",
    async createSetupSession(
      input: CreateSetupSessionInput,
    ): Promise<SetupSessionResult> {
      if (input.allowedIntegrations.length !== 1) {
        throw new BackendPolicyError(
          "backend_misconfigured",
          "Composio setup requires exactly one allowed integration",
          "composio",
        );
      }

      const integration = input.allowedIntegrations[0];
      if (!integration.provider.trim() || !integration.backendIntegrationId.trim()) {
        throw new BackendPolicyError(
          "backend_misconfigured",
          "Composio setup requires a provider and toolkit slug",
          "composio",
        );
      }

      const requestedToolkitSlug = integration.backendIntegrationId;
      const toolkit = await resolveToolkit(requestedToolkitSlug).catch((error) => {
        mapComposioBackendError(error);
      });
      if (!toolkit?.slug?.trim()) {
        throw new BackendPolicyError(
          "backend_misconfigured",
          `Unknown Composio toolkit: ${requestedToolkitSlug}`,
          "composio",
        );
      }

      const toolkitSlug = toolkit.slug.trim();
      const provider = isWorkspaceIntegrationProvider(integration.provider)
        ? integration.provider
        : toolkitSlug;
      const displayName =
        typeof toolkit.name === "string" && toolkit.name.trim()
          ? toolkit.name.trim()
          : integration.displayName ?? humanizeComposioSlug(toolkitSlug);
      let authConfigs: Awaited<ReturnType<ListComposioAuthConfigs>>;
      try {
        authConfigs = await listAuthConfigs(toolkitSlug);
      } catch (error) {
        mapComposioBackendError(error);
      }
      let authConfigId = readFirstComposioAuthConfigId(authConfigs);
      if (!authConfigId) {
        try {
          authConfigId = readFirstComposioAuthConfigId([
            await createAuthConfig(toolkitSlug),
          ]);
        } catch (error) {
          if (isComposioManagedAuthUnavailable(error)) {
            try {
              authConfigId = readFirstComposioAuthConfigId(
                await listAuthConfigs(toolkitSlug),
              );
            } catch (lookupError) {
              mapComposioBackendError(lookupError);
            }
            if (!authConfigId) {
              throw new BackendPolicyError(
                "backend_misconfigured",
                `Composio toolkit "${toolkitSlug}" does not support automatic managed auth config creation. Add a custom auth config for toolkit "${toolkitSlug}" in Composio Authentication Management, then retry; Cloud will discover it dynamically.`,
                "composio",
              );
            }
          } else {
            mapComposioBackendError(error);
          }
        }
      }
      if (!authConfigId) {
        throw new BackendPolicyError(
          "backend_misconfigured",
          `No Composio auth config found for ${toolkitSlug}`,
          "composio",
        );
      }

      const dockerHubUsername =
        typeof input.metadata?.dockerHubUsername === "string"
          ? input.metadata.dockerHubUsername.trim() || null
          : null;
      const callbackUrl = input.successRedirectUrl
        ? buildComposioConnectCallbackUrl({
          baseUrl: input.successRedirectUrl,
          state: {
            workspaceId: input.workspaceId,
            provider,
            authConfigId,
            toolkitSlug,
            ...(toolkitSlug === "docker_hub" && dockerHubUsername
              ? { dockerHubUsername }
              : {}),
          },
        })
        : undefined;

      let session: Awaited<ReturnType<CreateComposioConnectionLink>>;
      try {
        session = await createConnectionLink({
          userId: input.endUserId,
          authConfigId,
          callbackUrl,
          connectionData: {
            workspaceId: input.workspaceId,
            provider,
            backendIntegrationId: toolkitSlug,
          },
        });
      } catch (error) {
        mapComposioBackendError(error);
      }
      const connectLink = typeof session.redirect_url === "string" && session.redirect_url.trim()
        ? session.redirect_url.trim()
        : "";
      if (!connectLink) {
        throw new BackendPolicyError(
          "backend_misconfigured",
          "Composio did not return a connection redirect URL",
          "composio",
        );
      }

      return {
        backend: "composio",
        connectLink,
        sessionToken: typeof session.link_token === "string" ? session.link_token : undefined,
        expiresAt: typeof session.expires_at === "string" ? session.expires_at : undefined,
        connectionId: typeof session.connected_account_id === "string"
          ? session.connected_account_id
          : undefined,
        backendMetadata: {
          authConfigId,
          toolkitSlug,
          provider,
          displayName,
        },
        raw: session,
      };
    },
    async getConnection(
      input: ConnectionLookupInput,
    ): Promise<BackendConnection | null> {
      let account: Awaited<ReturnType<GetComposioConnectedAccount>>;
      try {
        account = await lookupConnection(input.connectionId);
      } catch (error) {
        mapComposioBackendError(error);
      }
      if (!account) {
        return null;
      }

      return {
        backend: "composio",
        connectionId: input.connectionId,
        provider: input.provider,
        backendIntegrationId: input.backendIntegrationId,
        status: readComposioStatus(account),
        raw: account,
      };
    },
    async deleteConnection(input) {
      try {
        return await deleteConnection(input.connectionId);
      } catch (error) {
        mapComposioBackendError(error);
      }
    },
  };
}

export function getIntegrationBackend(
  backend: IntegrationBackend,
  deps: IntegrationBackendRegistryDeps = {},
): ProviderBackend {
  switch (backend) {
    case "nango":
      return createNangoBackend(deps);
    case "composio":
      return createComposioBackend(deps);
  }
}

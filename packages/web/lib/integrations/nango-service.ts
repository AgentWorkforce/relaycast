import { Resource } from "sst";
import { Nango } from "@nangohq/node";
import { enabledGeneratedNangoProviderModelsForProviderConfigKey } from "@cloud/core/sync/nango-provider-parity.js";
import { optionalEnv } from "../env";
import {
  getProviderConfigKey as getDefaultProviderConfigKey,
  getWorkspaceIntegrationProviderDefinition,
  isWorkspaceIntegrationProvider,
  listWorkspaceIntegrationCatalogEntries,
  type WorkspaceIntegrationProvider,
} from "./providers";

/**
 * Decide whether a value supplied via `NANGO_<PROVIDER>_PROVIDER_CONFIG_KEY`
 * should be honored. The env-var is a legacy escape hatch from before the
 * provider registry existed and is retained only as a per-stage pinning
 * mechanism. It must NOT silently leak a value the registry has demoted to a
 * backwards-compat alias (e.g. a stale `slack-sage` value left on a Lambda
 * after the canonical Nango config-key was renamed to `slack-relay`).
 *
 * Returns the configured value when it matches the registry's canonical
 * `defaultConfigKey`. Otherwise logs and returns null so the caller falls
 * back to the registry default.
 */
function resolveOverrideProviderConfigKey(
  envName: string,
  canonicalKey: string,
  aliases: readonly string[],
): string | null {
  const configured = optionalEnv(envName);
  if (!configured) {
    return null;
  }
  if (configured === canonicalKey) {
    return configured;
  }
  if (aliases.includes(configured)) {
    console.warn(
      `${envName} is set to a demoted alias (${configured}); ignoring in favor of registry canonical key ${canonicalKey}. Unset the env var on this deployment.`,
    );
    return null;
  }
  console.warn(
    `${envName} is set to an unrecognized value (${configured}); ignoring in favor of registry canonical key ${canonicalKey}.`,
  );
  return null;
}

const DEFAULT_NANGO_HOST = "https://api.nango.dev";
let nangoClient: Nango | null = null;

type NangoConnectionServiceConfig = {
  secretKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
};

type NangoConnectSessionIntegrationConfigDefault = {
  user_scopes?: string;
  authorization_params?: Record<string, string>;
  connection_config?: Record<string, unknown>;
};

type NangoConnectSessionIntegrationConfigDefaults = Record<
  string,
  NangoConnectSessionIntegrationConfigDefault
>;

type ProviderNangoModule = {
  createNangoConnectSession?: (
    config: NangoConnectionServiceConfig,
    input: {
      endUserId: string;
      endUserEmail?: string | null;
      endUserTags?: Record<string, unknown>;
      tags?: Record<string, unknown>;
      allowedIntegrations?: string[];
      integrationConfigDefaults?: NangoConnectSessionIntegrationConfigDefaults;
    },
  ) => Promise<{
    token: string;
    expiresAt: string;
    connectLink: string;
    connectionId?: string;
    raw: Record<string, unknown>;
  }>;
  deleteNangoConnection?: (
    config: NangoConnectionServiceConfig,
    connectionId: string,
    options?: { providerConfigKey?: string },
  ) => Promise<boolean>;
  findNangoInstallationId?: (value: unknown) => string | null;
  getNangoConnectionDetail?: (
    config: NangoConnectionServiceConfig,
    connectionId: string,
    options?: { providerConfigKey?: string },
  ) => Promise<{ raw: unknown | null }>;
};

type NangoConnectionDetails = {
  payload: Record<string, unknown>;
  installationId: string | null;
};

export type NangoBackendConnection = {
  backend: "nango";
  connectionId: string;
  provider?: string;
  backendIntegrationId?: string;
  backendMetadata?: Record<string, unknown>;
  status?: "active" | "inactive" | "unknown";
  identity?: Record<string, unknown>;
  raw?: unknown;
};

export type NangoIntegrationSummary = {
  providerConfigKey: string;
  provider?: string;
  raw: Record<string, unknown>;
};

export type NangoProviderSummary = {
  id: string;
  displayName?: string;
  authMode?: string;
  categories?: string[];
  docs?: string;
  raw: Record<string, unknown>;
};

export type NangoConnectionSummary = {
  connectionId: string;
  providerConfigKey: string;
  provider?: string;
  raw: Record<string, unknown>;
};

export type NangoSyncScheduleStatus = {
  name: string;
  status: string | null;
  frequency: string | null;
  nextScheduledSyncAt: string | null;
  finishedAt: string | null;
};

type NangoConnectSession = {
  token: string;
  expiresAt: string;
  connectLink: string;
  connectionId?: string;
};

const DEFAULT_COMPOSIO_BRIDGE_SYNCS: Record<WorkspaceIntegrationProvider, string[]> = {
  github: ["fetch-repos", "fetch-open-prs", "fetch-open-issues"],
  gitlab: [
    "fetch-projects",
    "fetch-merge-requests",
    "fetch-issues",
    "fetch-commits",
    "fetch-pipelines",
    "fetch-deployments",
    "fetch-tags",
  ],
  slack: ["fetch-channel-history"],
  telegram: [],
  "slack-ricky": [],
  "slack-my-senior-dev": [],
  "slack-nightcto": [],
  notion: ["fetch-pages", "fetch-databases"],
  hubspot: [],
  granola: ["fetch-notes", "fetch-folders"],
  recall: ["fetch-recordings", "fetch-transcripts"],
  fathom: [],
  linear: [
    "fetch-active-issues",
    "fetch-comments",
    "fetch-users",
    "fetch-teams",
    "fetch-projects",
    "fetch-milestones",
    "fetch-roadmaps",
  ],
  "linear-ricky": [],
  x: [],
  jira: ["fetch-issues", "fetch-comments", "fetch-projects", "fetch-sprints"],
  confluence: ["fetch-spaces", "fetch-pages"],
  "google-mail": [],
  "google-calendar": [],
  "docker-hub": ["fetch-repositories", "fetch-tags", "fetch-webhooks"],
  reddit: [
    "fetch-subreddits",
    "fetch-posts",
    "fetch-hot-posts",
    "fetch-rising-posts",
    "fetch-top-posts",
    "fetch-best-posts",
  ],
  dropbox: [],
  daytona: [],
  gcp: [],
  cloudflare: [],
  neon: [],
};

const DEFAULT_COMPOSIO_BRIDGE_PROVIDER_CONFIG_KEYS: Record<WorkspaceIntegrationProvider, string | null> = {
  github: "github-composio-relay",
  gitlab: null,
  slack: "slack-composio-relay",
  telegram: null,
  "slack-ricky": null,
  "slack-my-senior-dev": null,
  "slack-nightcto": null,
  notion: "notion-composio-relay",
  hubspot: null,
  granola: null,
  recall: null,
  fathom: null,
  linear: "linear-composio-relay",
  "linear-ricky": null,
  x: null,
  jira: null,
  confluence: null,
  "google-mail": null,
  "google-calendar": null,
  "docker-hub": "docker_hub-composio-relay",
  reddit: "reddit-composio-relay",
  dropbox: null,
  daytona: null,
  gcp: null,
  cloudflare: null,
  neon: null,
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function getNangoHost(): string {
  return trimTrailingSlash(
    optionalEnv("NANGO_HOST") ?? DEFAULT_NANGO_HOST,
  );
}

export function getNangoSecretKey(): string | null {
  try {
    return Resource.NangoSecretKey.value;
  } catch {
    return optionalEnv("NANGO_SECRET_KEY") ?? null;
  }
}

function readBooleanResourceFlag(resourceName: string, envName: string): boolean {
  let rawValue: string | undefined;
  try {
    // Deployed path: Resource.SlackRelayBridgeOutboundEnabled.value.
    rawValue = (Resource as unknown as Record<string, { value?: string }>)[resourceName]?.value;
  } catch {
    rawValue = undefined;
  }

  rawValue ??= optionalEnv(envName);
  return rawValue?.trim().toLowerCase() === "true";
}

export function isSlackRelayBridgeOutboundEnabled(): boolean {
  return readBooleanResourceFlag(
    "SlackRelayBridgeOutboundEnabled",
    "SLACK_RELAY_BRIDGE_OUTBOUND_ENABLED",
  );
}

export function getNangoClient(): Nango {
  if (!nangoClient) {
    const secretKey = getNangoSecretKey();
    if (!secretKey) {
      throw new Error("NANGO_SECRET_KEY is not configured.");
    }

    nangoClient = new Nango({
      secretKey,
      host: getNangoHost(),
    });
  }

  return nangoClient;
}

export function resetNangoClientForTests(): void {
  nangoClient = null;
}

async function getProviderNangoModule(): Promise<ProviderNangoModule> {
  try {
    return await import("@relayfile/provider-nango") as ProviderNangoModule;
  } catch (error) {
    if (!isMissingProviderNangoModuleError(error)) {
      throw error;
    }

    console.warn("getProviderNangoModule: @relayfile/provider-nango unavailable; using compatibility fallback", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

export function getProviderConfigKey(
  provider: WorkspaceIntegrationProvider,
): string {
  const definition = getWorkspaceIntegrationProviderDefinition(provider);
  const canonicalKey = definition.defaultConfigKey;
  const override = resolveOverrideProviderConfigKey(
    `NANGO_${provider.toUpperCase()}_PROVIDER_CONFIG_KEY`,
    canonicalKey,
    definition.aliases,
  );
  return override ?? canonicalKey;
}

export function getGitHubProviderConfigKey(): string {
  return getProviderConfigKey("github");
}

export function getSlackProviderConfigKey(): string {
  return getProviderConfigKey("slack");
}

export async function createConnectSession(input: {
  endUserId: string;
  endUserEmail?: string | null;
  allowedIntegrations?: string[];
  tags?: Record<string, unknown>;
  integrationConfigDefaults?: NangoConnectSessionIntegrationConfigDefaults;
}): Promise<NangoConnectSession> {
  const config = getNangoServiceConfig();
  const workspaceTags = {
    workspaceId: input.endUserId,
    end_user_id: input.endUserId,
    ...(input.tags ?? {}),
  };
  const integrationConfigDefaults =
    input.integrationConfigDefaults &&
    Object.keys(input.integrationConfigDefaults).length > 0
      ? input.integrationConfigDefaults
      : undefined;

  const providerNango = await getProviderNangoModule();
  if (providerNango.createNangoConnectSession && !integrationConfigDefaults) {
    const session = await providerNango.createNangoConnectSession(config, {
      endUserId: input.endUserId,
      endUserEmail: input.endUserEmail,
      endUserTags: workspaceTags,
      tags: workspaceTags,
      allowedIntegrations:
        input.allowedIntegrations && input.allowedIntegrations.length > 0
          ? input.allowedIntegrations
          : listWorkspaceIntegrationCatalogEntries().map((entry) =>
              getProviderConfigKey(entry.id as WorkspaceIntegrationProvider),
            ),
    });

    return {
      token: session.token,
      expiresAt: session.expiresAt,
      connectLink: session.connectLink,
      ...(session.connectionId ? { connectionId: session.connectionId } : {}),
    };
  }

  // Compatibility bridge until the cloud dependency has picked up the
  // provider-owned connect-session primitive.
  const response = await getNangoClient().createConnectSession({
    end_user: {
      id: input.endUserId,
      ...(input.endUserEmail ? { email: input.endUserEmail } : {}),
      tags: workspaceTags,
    },
    tags: workspaceTags,
    allowed_integrations:
      input.allowedIntegrations && input.allowedIntegrations.length > 0
        ? input.allowedIntegrations
        : listWorkspaceIntegrationCatalogEntries().map((entry) =>
            getProviderConfigKey(entry.id as WorkspaceIntegrationProvider),
          ),
    ...(integrationConfigDefaults
      ? { integrations_config_defaults: integrationConfigDefaults }
      : {}),
  });

  const data = response.data as {
    token: string;
    expires_at: string;
    connect_link: string;
    connection_id?: unknown;
    connectionId?: unknown;
  };

  const connectionId = readNonEmptyString(data.connection_id) ?? readNonEmptyString(data.connectionId);
  return {
    token: data.token,
    expiresAt: data.expires_at,
    connectLink: data.connect_link,
    ...(connectionId ? { connectionId } : {}),
  };
}

function resolveProviderConfigKey(providerConfigKey?: string | null): string {
  return providerConfigKey ?? getGitHubProviderConfigKey();
}

function getConnectionUrl(
  connectionId: string,
  providerConfigKey?: string | null,
): URL {
  const url = new URL(
    `/connection/${encodeURIComponent(connectionId)}`,
    `${getNangoHost()}/`,
  );
  url.searchParams.set(
    "provider_config_key",
    resolveProviderConfigKey(providerConfigKey),
  );
  return url;
}

function getNangoUrl(path: string): URL {
  return new URL(path, `${getNangoHost()}/`);
}

function getAuthorizedHeaders(secretKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${secretKey}`,
    Accept: "application/json",
  };
}

function getJsonHeaders(secretKey: string): Record<string, string> {
  return {
    ...getAuthorizedHeaders(secretKey),
    "Content-Type": "application/json",
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingProviderNangoModuleError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = isObject(error) ? error.code : undefined;
  const isMissingModule = code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
  const namesProviderPackage =
    error.message.includes("Cannot find package '@relayfile/provider-nango'") ||
    error.message.includes("Cannot find module '@relayfile/provider-nango'") ||
    error.message.includes("Cannot find module @relayfile/provider-nango");

  return isMissingModule && namesProviderPackage;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function parseJsonResponse(
  response: Response,
): Promise<Record<string, unknown> | null> {
  return (await response.json().catch(() => null)) as Record<string, unknown> | null;
}

async function requestNangoGet(
  path: string,
  searchParams?: Record<string, string | undefined>,
): Promise<{ ok: boolean; status: number; payload: Record<string, unknown> | null }> {
  const secretKey = getSecretKeyOrNull();
  if (!secretKey) {
    throw new Error("NANGO_SECRET_KEY is not configured.");
  }

  const url = getNangoUrl(path);
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }

  let response: Response;
  try {
    response = await globalThis.fetch(url, {
      headers: getAuthorizedHeaders(secretKey),
      cache: "no-store",
    });
  } catch {
    return { ok: false, status: 0, payload: null };
  }

  return {
    ok: response.ok,
    status: response.status,
    payload: await parseJsonResponse(response),
  };
}

async function requestConnection(
  connectionId: string,
  init: RequestInit,
  providerConfigKey?: string | null,
): Promise<Response | null> {
  const secretKey = getSecretKeyOrNull();
  if (!secretKey) {
    return null;
  }

  return fetch(getConnectionUrl(connectionId, providerConfigKey), {
    ...init,
    headers: {
      ...getAuthorizedHeaders(secretKey),
      ...(init.headers ?? {}),
    },
    cache: init.cache ?? "no-store",
  });
}

function findInstallationId(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findInstallationId(entry);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (!isObject(value)) {
    return null;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (
      (key === "installation_id" || key === "installationId" || key === "github_installation_id") &&
      (typeof entry === "string" || typeof entry === "number")
    ) {
      return String(entry);
    }
  }

  for (const entry of Object.values(value)) {
    const found = findInstallationId(entry);
    if (found) {
      return found;
    }
  }

  return null;
}

function getSecretKeyOrNull(): string | null {
  const secretKey = getNangoSecretKey();
  return secretKey && secretKey.length > 0 ? secretKey : null;
}

function getNangoServiceConfigOrNull(): NangoConnectionServiceConfig | null {
  const secretKey = getSecretKeyOrNull();
  if (!secretKey) {
    return null;
  }

  return {
    secretKey,
    baseUrl: getNangoHost(),
  };
}

function getNangoServiceConfig(): NangoConnectionServiceConfig {
  const config = getNangoServiceConfigOrNull();
  if (!config) {
    throw new Error("NANGO_SECRET_KEY is not configured.");
  }
  return config;
}

export async function getNangoConnectionDetails(
  connectionId: string,
  providerConfigKey?: string | null,
): Promise<NangoConnectionDetails | null> {
  const config = getNangoServiceConfigOrNull();
  if (!config) {
    console.error("getNangoConnectionDetails: no response", { connectionId, providerConfigKey });
    return null;
  }

  const providerNango = await getProviderNangoModule();
  if (providerNango.getNangoConnectionDetail) {
    const detail = await providerNango.getNangoConnectionDetail(config, connectionId, {
      providerConfigKey: providerConfigKey ?? undefined,
    }).catch((error) => {
      console.error("getNangoConnectionDetails: response not ok", {
        connectionId,
        providerConfigKey,
        error,
      });
      return null;
    });

    const payload = asRecordOrNull(detail?.raw);
    if (!payload) {
      return null;
    }

    return {
      payload,
      installationId: providerNango.findNangoInstallationId
        ? providerNango.findNangoInstallationId(payload)
        : findInstallationId(payload),
    };
  }

  const response = await requestConnection(connectionId, {}, providerConfigKey);
  if (!response) {
    console.error("getNangoConnectionDetails: no response", { connectionId, providerConfigKey });
    return null;
  }
  if (!response.ok) {
    console.error("getNangoConnectionDetails: response not ok", { connectionId, providerConfigKey, status: response.status, statusText: response.statusText });
    return null;
  }

  const payload = await parseJsonResponse(response);
  if (!payload) {
    console.error("getNangoConnectionDetails: failed to parse response payload", { connectionId, providerConfigKey });
    return null;
  }

  return {
    payload,
    installationId: findInstallationId(payload),
  };
}

function readConnectionStatus(value: Record<string, unknown>): "active" | "inactive" | "unknown" {
  const status =
    readNonEmptyString(value.status) ??
    readNonEmptyString(value.connection_status) ??
    readNonEmptyString(value.connectionStatus);

  if (!status) {
    return "active";
  }

  const normalized = status.toLowerCase();
  if (normalized === "active" || normalized === "connected" || normalized === "success") {
    return "active";
  }
  if (normalized === "inactive" || normalized === "disconnected" || normalized === "deleted") {
    return "inactive";
  }
  return "unknown";
}

export async function getNangoConnection(
  connectionId: string,
  providerConfigKey?: string | null,
  options?: { provider?: string },
): Promise<NangoBackendConnection | null> {
  const details = await getNangoConnectionDetails(connectionId, providerConfigKey);
  if (!details) {
    return null;
  }

  return {
    backend: "nango",
    connectionId,
    ...(options?.provider ? { provider: options.provider } : {}),
    ...(providerConfigKey ? { backendIntegrationId: providerConfigKey } : {}),
    backendMetadata: {
      ...(details.installationId ? { installationId: details.installationId } : {}),
    },
    status: readConnectionStatus(details.payload),
    raw: details.payload,
  };
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return isObject(value) ? value : null;
}

// Probe whether a connection exists upstream. Distinguishes definitive
// "gone" (Nango HTTP 404) from indeterminate states (401/5xx/network) so
// callers like `selfHealMissingWorkspaceIntegration` can safely replace
// stale rows only when the upstream is truly deleted, while leaving live
// rows untouched on transient Nango blips.
//
// Provider-nango's `getNangoConnectionDetail` swallows the HTTP status,
// returning a parsed payload on 2xx and `null` on anything else (404 or
// otherwise). Because of that, we bypass the provider-nango helper here
// and inspect `response.status` directly. That makes this probe specific
// to the Nango HTTP backend; non-Nango backends should add their own.
export async function probeNangoConnectionLiveness(
  connectionId: string,
  providerConfigKey?: string | null,
): Promise<"alive" | "gone" | "unknown"> {
  const config = getNangoServiceConfigOrNull();
  if (!config) {
    return "unknown";
  }

  let response: Response | null;
  try {
    response = await requestConnection(connectionId, {}, providerConfigKey);
  } catch (error) {
    console.error("probeNangoConnectionLiveness: fetch threw", {
      connectionId,
      providerConfigKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return "unknown";
  }

  if (!response) {
    return "unknown";
  }
  if (response.status === 404) {
    return "gone";
  }
  if (response.ok) {
    return "alive";
  }
  // Any other non-OK (401 stale secret, 5xx Nango down, etc.) is
  // indeterminate. Treat as alive to preserve the "don't trample a
  // possibly-live tenant" safety property.
  return "unknown";
}

export async function deleteNangoConnection(
  connectionId: string,
  providerConfigKey?: string | null,
): Promise<boolean> {
  const config = getNangoServiceConfigOrNull();
  if (!config) {
    return false;
  }

  const providerNango = await getProviderNangoModule();
  if (providerNango.deleteNangoConnection) {
    return providerNango.deleteNangoConnection(config, connectionId, {
      providerConfigKey: providerConfigKey ?? undefined,
    });
  }

  const response = await requestConnection(connectionId, {
    method: "DELETE",
  }, providerConfigKey);

  return response?.ok ?? false;
}

function envProviderName(provider: string): string {
  return provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function humanizeProviderName(provider: string): string {
  return provider
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function getComposioBridgeProviderConfigKey(
  provider: string,
): string {
  const canonicalKey =
    (isWorkspaceIntegrationProvider(provider)
      ? DEFAULT_COMPOSIO_BRIDGE_PROVIDER_CONFIG_KEYS[provider]
      : undefined) ?? `${provider}-composio-relay`;

  // Mirror the protection on getProviderConfigKey: the env-var override is
  // retained only as a per-stage pinning mechanism and MUST NOT leak a stale
  // value (notably a leftover Nango canonical or alias from a pre-rename
  // deploy, e.g. `slack-sage`). Honor the env-var only when it matches the
  // computed canonical bridge key; otherwise warn and fall back.
  const envName = `NANGO_COMPOSIO_${envProviderName(provider)}_PROVIDER_CONFIG_KEY`;
  const configured = optionalEnv(envName);
  if (configured && configured !== canonicalKey) {
    console.warn(
      `${envName} is set to ${configured} which does not match the registry canonical Composio bridge key ${canonicalKey}; ignoring. Unset the env var on this deployment.`,
    );
  }

  return canonicalKey;
}

export function getComposioBridgeSyncNames(
  provider: string,
): string[] {
  const configured = optionalEnv(`NANGO_COMPOSIO_${envProviderName(provider)}_SYNCS`);
  if (configured !== undefined) {
    return splitCsv(configured);
  }

  return isWorkspaceIntegrationProvider(provider)
    ? DEFAULT_COMPOSIO_BRIDGE_SYNCS[provider] ?? []
    : [];
}

export function getEnabledNangoSyncNamesForProviderConfigKey(
  providerConfigKey: string,
): string[] {
  return [
    ...new Set(
      enabledGeneratedNangoProviderModelsForProviderConfigKey(providerConfigKey)
        .map((entry) => entry.sync),
    ),
  ];
}

async function requestNangoJson(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; payload: Record<string, unknown> | null }> {
  const secretKey = getSecretKeyOrNull();
  if (!secretKey) {
    throw new Error("NANGO_SECRET_KEY is not configured.");
  }

  let response: Response;
  try {
    response = await globalThis.fetch(new URL(path, `${getNangoHost()}/`), {
      method: "POST",
      headers: getJsonHeaders(secretKey),
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return { ok: false, status: 0, payload: null };
  }

  return {
    ok: response.ok,
    status: response.status,
    payload: await parseJsonResponse(response),
  };
}

function readNestedRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!isObject(value)) {
    return null;
  }
  const nested = value[key];
  return isObject(nested) ? nested : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readRecordArray(value: Record<string, unknown> | null, key: string): Record<string, unknown>[] {
  const raw = value?.[key];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(isObject);
}

export async function listNangoIntegrations(): Promise<NangoIntegrationSummary[]> {
  const response = await requestNangoGet("/integrations");
  if (!response.ok) {
    const legacyResponse = await requestNangoGet("/config");
    if (!legacyResponse.ok) {
      return [];
    }
    return toNangoIntegrationSummaries(readRecordArray(legacyResponse.payload, "configs"));
  }

  const records = readRecordArray(response.payload, "data");
  return toNangoIntegrationSummaries(records.length > 0 ? records : readRecordArray(response.payload, "configs"));
}

export async function listNangoProviders(): Promise<NangoProviderSummary[]> {
  const response = await requestNangoGet("/providers");
  if (!response.ok) {
    return [];
  }

  return toNangoProviderSummaries(readRecordArray(response.payload, "data"));
}

function toNangoIntegrationSummaries(records: Record<string, unknown>[]): NangoIntegrationSummary[] {
  return records.flatMap((config): NangoIntegrationSummary[] => {
    const providerConfigKey = readString(config.unique_key) ?? readString(config.provider_config_key);
    if (!providerConfigKey) {
      return [];
    }
    const provider = readString(config.provider) ?? undefined;
    return [{
      providerConfigKey,
      ...(provider ? { provider } : {}),
      raw: config,
    }];
  });
}

function toNangoProviderSummaries(records: Record<string, unknown>[]): NangoProviderSummary[] {
  return records.flatMap((provider): NangoProviderSummary[] => {
    const id = readString(provider.name);
    if (!id) {
      return [];
    }
    const displayName = readString(provider.display_name) ?? undefined;
    const authMode = readString(provider.auth_mode) ?? undefined;
    const docs = readString(provider.docs) ?? undefined;
    const categories = Array.isArray(provider.categories)
      ? provider.categories.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    return [{
      id,
      ...(displayName ? { displayName } : {}),
      ...(authMode ? { authMode } : {}),
      ...(categories && categories.length > 0 ? { categories } : {}),
      ...(docs ? { docs } : {}),
      raw: provider,
    }];
  });
}

export async function listNangoConnections(input: {
  connectionId?: string;
} = {}): Promise<NangoConnectionSummary[]> {
  const response = await requestNangoGet("/connections");
  if (!response.ok) {
    const legacyResponse = await requestNangoGet("/connection", {
      connectionId: input.connectionId,
    });
    if (!legacyResponse.ok) {
      return [];
    }
    return toNangoConnectionSummaries(readRecordArray(legacyResponse.payload, "configs"), input.connectionId);
  }

  const records = readRecordArray(response.payload, "connections");
  return toNangoConnectionSummaries(records.length > 0 ? records : readRecordArray(response.payload, "configs"), input.connectionId);
}

function toNangoConnectionSummaries(
  records: Record<string, unknown>[],
  connectionIdFilter: string | undefined,
): NangoConnectionSummary[] {
  return records.flatMap((connection): NangoConnectionSummary[] => {
    const connectionId = readString(connection.connection_id) ?? readString(connection.connectionId);
    const providerConfigKey =
      readString(connection.provider_config_key) ?? readString(connection.providerConfigKey);
    if (connectionIdFilter && connectionId !== connectionIdFilter) {
      return [];
    }
    if (!connectionId || !providerConfigKey) {
      return [];
    }
    const provider = readString(connection.provider) ?? undefined;
    return [{
      connectionId,
      providerConfigKey,
      ...(provider ? { provider } : {}),
      raw: connection,
    }];
  });
}

async function requestNangoIntegration(
  providerConfigKey: string,
): Promise<{ ok: boolean; status: number; payload: Record<string, unknown> | null }> {
  const secretKey = getSecretKeyOrNull();
  if (!secretKey) {
    throw new Error("NANGO_SECRET_KEY is not configured.");
  }

  let response: Response;
  try {
    response = await globalThis.fetch(
      new URL(`/integrations/${encodeURIComponent(providerConfigKey)}`, `${getNangoHost()}/`),
      {
        headers: getAuthorizedHeaders(secretKey),
        cache: "no-store",
      },
    );
  } catch {
    return { ok: false, status: 0, payload: null };
  }

  return {
    ok: response.ok,
    status: response.status,
    payload: await parseJsonResponse(response),
  };
}

async function createNangoUnauthenticatedIntegration(input: {
  provider: string;
  providerConfigKey: string;
}): Promise<{ ok: true } | { ok: false; status: number; payload: Record<string, unknown> | null }> {
  const providerDisplayName = isWorkspaceIntegrationProvider(input.provider)
    ? getWorkspaceIntegrationProviderDefinition(input.provider).displayName
    : humanizeProviderName(input.provider);
  const displayName = `${providerDisplayName} Composio Relay`;
  const response = await requestNangoJson("/integrations", {
    unique_key: input.providerConfigKey,
    provider: "unauthenticated",
    display_name: displayName,
  });

  return response.ok || response.status === 409
    ? { ok: true }
    : { ok: false, status: response.status, payload: response.payload };
}

export async function ensureNangoComposioBridgeIntegration(input: {
  provider: string;
  providerConfigKey: string;
}): Promise<{ ok: true } | { ok: false; status: number; payload: Record<string, unknown> | null }> {
  const existing = await requestNangoIntegration(input.providerConfigKey);
  if (existing.ok) {
    const data = readNestedRecord(existing.payload, "data");
    const provider = readString(data?.provider);
    if (provider && provider !== "unauthenticated") {
      throw new Error(
        `Nango integration ${input.providerConfigKey} uses provider ${provider}; expected unauthenticated.`,
      );
    }
    return { ok: true };
  }

  if (existing.status !== 404) {
    return { ok: false, status: existing.status, payload: existing.payload };
  }

  const created = await createNangoUnauthenticatedIntegration(input);
  if (!created.ok) {
    return created;
  }

  const verified = await requestNangoIntegration(input.providerConfigKey);
  if (!verified.ok) {
    return { ok: false, status: verified.status, payload: verified.payload };
  }

  const data = readNestedRecord(verified.payload, "data");
  const provider = readString(data?.provider);
  if (provider && provider !== "unauthenticated") {
    throw new Error(
      `Nango integration ${input.providerConfigKey} uses provider ${provider}; expected unauthenticated.`,
    );
  }

  return { ok: true };
}

export async function upsertNangoComposioBridgeConnection(input: {
  providerConfigKey: string;
  connectionId: string;
  workspaceId: string;
  provider: string;
  metadata: Record<string, unknown>;
}): Promise<{ ok: true } | { ok: false; status: number; payload: Record<string, unknown> | null }> {
  const integration = await ensureNangoComposioBridgeIntegration({
    provider: input.provider,
    providerConfigKey: input.providerConfigKey,
  });
  if (!integration.ok) {
    return integration;
  }

  const response = await requestNangoJson("/connections", {
    provider_config_key: input.providerConfigKey,
    connection_id: input.connectionId,
    // This bridge connection gives deployed Nango syncs a concrete execution
    // target. Metadata is non-secret correlation only; Composio access should
    // go through Cloud-owned APIs rather than storing upstream credentials here.
    credentials: { type: "NONE" },
    metadata: input.metadata,
    tags: {
      workspaceId: input.workspaceId,
      end_user_id: input.workspaceId,
      relayfile_backend: "composio",
      relayfile_provider: input.provider,
      composio_connected_account_id: input.connectionId,
    },
  });

  return response.ok
    ? { ok: true }
    : { ok: false, status: response.status, payload: response.payload };
}

export async function triggerNangoSyncs(input: {
  providerConfigKey: string;
  connectionId: string;
  syncs: string[];
  syncMode?: "incremental" | "full_refresh" | "full_refresh_and_clear_cache";
}): Promise<{ ok: true } | { ok: false; status: number; payload: Record<string, unknown> | null }> {
  const response = await requestNangoJson("/sync/trigger", {
    provider_config_key: input.providerConfigKey,
    connection_id: input.connectionId,
    syncs: input.syncs,
    sync_mode: input.syncMode ?? "incremental",
  });

  return response.ok
    ? { ok: true }
    : { ok: false, status: response.status, payload: response.payload };
}

export async function startNangoSyncSchedules(input: {
  providerConfigKey: string;
  connectionId: string;
  syncs?: string[];
}): Promise<{
  ok: boolean;
  status?: number;
  payload?: Record<string, unknown> | null;
  syncs: string[];
}> {
  const syncs = input.syncs ?? getEnabledNangoSyncNamesForProviderConfigKey(
    input.providerConfigKey,
  );
  if (syncs.length === 0) {
    return { ok: true, syncs };
  }

  const response = await requestNangoJson("/sync/start", {
    provider_config_key: input.providerConfigKey,
    connection_id: input.connectionId,
    syncs,
  });

  return response.ok
    ? { ok: true, syncs }
    : {
      ok: false,
      status: response.status,
      payload: response.payload,
      syncs,
    };
}

export async function pauseNangoSyncSchedules(input: {
  providerConfigKey: string;
  connectionId: string;
  syncs?: string[];
}): Promise<{
  ok: boolean;
  status?: number;
  payload?: Record<string, unknown> | null;
  syncs: string[];
}> {
  const syncs = input.syncs ?? getEnabledNangoSyncNamesForProviderConfigKey(
    input.providerConfigKey,
  );
  if (syncs.length === 0) {
    return { ok: true, syncs };
  }

  const response = await requestNangoJson("/sync/pause", {
    provider_config_key: input.providerConfigKey,
    connection_id: input.connectionId,
    syncs,
  });

  return response.ok
    ? { ok: true, syncs }
    : {
      ok: false,
      status: response.status,
      payload: response.payload,
      syncs,
    };
}

export async function getNangoSyncScheduleStatuses(input: {
  providerConfigKey: string;
  connectionId: string;
  syncs?: string[];
}): Promise<{
  ok: boolean;
  status?: number;
  error?: string | null;
  syncs: NangoSyncScheduleStatus[];
}> {
  const syncs = input.syncs ?? getEnabledNangoSyncNamesForProviderConfigKey(
    input.providerConfigKey,
  );
  const response = await requestNangoGet("/sync/status", {
    provider_config_key: input.providerConfigKey,
    connection_id: input.connectionId,
    syncs: syncs.length > 0 ? syncs.join(",") : "*",
  });

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error:
        readString(response.payload?.error) ??
        readString(response.payload?.message),
      syncs: [],
    };
  }

  const rows = Array.isArray(response.payload?.syncs)
    ? response.payload.syncs
    : [];

  return {
    ok: true,
    syncs: rows.flatMap((row) => {
      if (!isObject(row)) {
        return [];
      }
      const name = readString(row.name);
      if (!name) {
        return [];
      }
      return [{
        name,
        status: readString(row.status),
        frequency: readString(row.frequency),
        nextScheduledSyncAt: readString(row.nextScheduledSyncAt),
        finishedAt: readString(row.finishedAt),
      }];
    }),
  };
}

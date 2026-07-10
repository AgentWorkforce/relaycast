import { DEFAULT_RELAYFILE_BASE_URL } from "@relayfile/sdk";

import type { VfsConventionFragment } from "./conventions.js";
import { mintCatalogingToken, type CatalogingTokenSigner } from "./context.js";
import type { InsightGenerator } from "./insight.js";

export interface CatalogingWorkerEnv {
  CLOUD_API_URL?: string;
  CATALOGING_CLOUD_API_URL?: string;
  CATALOGING_CLOUD_API_TOKEN?: string;
  RELAYFILE_URL?: string;
  RelayfileUrl?: string;
  RELAYFILE_TOKEN?: string;
  CATALOG_RELAYFILE_TOKEN?: string;
  [binding: string]: unknown;
}

export interface CatalogingAgentConfig<TEnv extends CatalogingWorkerEnv = CatalogingWorkerEnv> {
  domain: string;
  insights: readonly InsightGenerator<TEnv>[];
  subscriberBinding?: string;
  subscriberNamespace?: (env: TEnv) => DurableObjectNamespace;
  workspaceList?: (env: TEnv) => readonly string[] | Promise<readonly string[]>;
  relayfileUrl?: string | ((env: TEnv) => string | Promise<string>);
  tokenFactory?: (input: {
    env: TEnv;
    workspaceId: string;
    domain: string;
  }) => string | Promise<string>;
  relayauthSigner?: CatalogingTokenSigner;
  /**
   * Factory may return `undefined` so callers can opt out at runtime when a
   * prerequisite binding (e.g. CATALOGING_RELAYAUTH_API_KEY) is missing — the
   * resolver then falls through to `config.relayauthSigner`, and finally to
   * the CATALOG_RELAYFILE_TOKEN / RELAYFILE_TOKEN env fallback.
   */
  getRelayauthSigner?: (
    env: TEnv,
  ) =>
    | CatalogingTokenSigner
    | undefined
    | Promise<CatalogingTokenSigner | undefined>;
  tokenScopes?: readonly string[];
  tokenTtlSeconds?: number;
  /**
   * Optional factory returning the VFS convention fragment this cataloging
   * agent publishes to `/_conventions/<provider>.json`. Invoked on subscribe
   * and idempotently written via the existing RelayFile client. Omit to
   * opt out of convention emission.
   */
  conventions?: () => VfsConventionFragment;
}

export interface CloudWorkspaceListOptions<TEnv extends CatalogingWorkerEnv = CatalogingWorkerEnv> {
  provider: string;
  cloudApiUrl?: string | ((env: TEnv) => string | Promise<string>);
  serviceToken?: string | ((env: TEnv) => string | Promise<string>);
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_SUBSCRIBER_BINDING = "CATALOGING_SUBSCRIBER";
const DEFAULT_WORKSPACE_DISCOVERY_TIMEOUT_MS = 10_000;

let activeConfig: CatalogingAgentConfig<CatalogingWorkerEnv> | undefined;

export function registerCatalogingAgentConfig<TEnv extends CatalogingWorkerEnv>(
  config: CatalogingAgentConfig<TEnv>,
): CatalogingAgentConfig<TEnv> {
  validateConfig(config);
  activeConfig = config as CatalogingAgentConfig<CatalogingWorkerEnv>;
  return config;
}

export function getCatalogingAgentConfig<TEnv extends CatalogingWorkerEnv>(): CatalogingAgentConfig<TEnv> {
  if (!activeConfig) {
    throw new Error("createCatalogingAgent() must be called before CatalogingSubscriber is used");
  }
  return activeConfig as CatalogingAgentConfig<TEnv>;
}

export function getInsight<TEnv extends CatalogingWorkerEnv>(
  config: CatalogingAgentConfig<TEnv>,
  insightId: string,
): InsightGenerator<TEnv> | undefined {
  return config.insights.find((insight) => insight.id === insightId);
}

export async function resolveCatalogWorkspaces<TEnv extends CatalogingWorkerEnv>(
  config: CatalogingAgentConfig<TEnv>,
  env: TEnv,
): Promise<string[]> {
  if (!config.workspaceList) {
    throw new Error("cataloging agent requires workspaceList for workspace discovery");
  }
  return cleanWorkspaceList(await config.workspaceList(env));
}

export function createCloudWorkspaceList<TEnv extends CatalogingWorkerEnv>(
  options: CloudWorkspaceListOptions<TEnv>,
): (env: TEnv) => Promise<string[]> {
  const provider = readString(options.provider);
  if (!provider) {
    throw new Error("cataloging cloud workspace discovery requires a provider");
  }

  return (env) => fetchCloudWorkspaceList({ ...options, provider, env });
}

export async function resolveRelayfileBaseUrl<TEnv extends CatalogingWorkerEnv>(
  config: CatalogingAgentConfig<TEnv>,
  env: TEnv,
): Promise<string> {
  if (typeof config.relayfileUrl === "function") {
    return stripTrailingSlash(await config.relayfileUrl(env));
  }
  return stripTrailingSlash(
    config.relayfileUrl ?? readString(env.RELAYFILE_URL) ?? readString(env.RelayfileUrl) ?? DEFAULT_RELAYFILE_BASE_URL,
  );
}

export async function resolveCatalogingToken<TEnv extends CatalogingWorkerEnv>(
  config: CatalogingAgentConfig<TEnv>,
  env: TEnv,
  workspaceId: string,
): Promise<string> {
  if (config.tokenFactory) {
    return config.tokenFactory({ env, workspaceId, domain: config.domain });
  }

  const signer = config.getRelayauthSigner ? await config.getRelayauthSigner(env) : config.relayauthSigner;
  if (signer) {
    return mintCatalogingToken(signer, workspaceId, {
      domain: config.domain,
      scopes: config.tokenScopes,
      ttlSeconds: config.tokenTtlSeconds,
    });
  }

  const envToken = readString(env.CATALOG_RELAYFILE_TOKEN) ?? readString(env.RELAYFILE_TOKEN);
  if (envToken) {
    return envToken;
  }

  throw new Error("cataloging agent requires tokenFactory, relayauthSigner, or RELAYFILE_TOKEN");
}

export function resolveSubscriberNamespace<TEnv extends CatalogingWorkerEnv>(
  config: CatalogingAgentConfig<TEnv>,
  env: TEnv,
): DurableObjectNamespace {
  if (config.subscriberNamespace) {
    return config.subscriberNamespace(env);
  }
  const bindingName = config.subscriberBinding ?? DEFAULT_SUBSCRIBER_BINDING;
  const namespace = env[bindingName];
  if (!isDurableObjectNamespace(namespace)) {
    throw new Error(`missing Durable Object binding: ${bindingName}`);
  }
  return namespace;
}

export function subscriberObjectName(domain: string, workspaceId: string): string {
  return `${domain}:${workspaceId}`;
}

function validateConfig<TEnv extends CatalogingWorkerEnv>(config: CatalogingAgentConfig<TEnv>): void {
  if (!config.domain.trim()) {
    throw new Error("cataloging domain is required");
  }
  const ids = new Set<string>();
  for (const insight of config.insights) {
    if (!insight.id.trim()) {
      throw new Error("insight id is required");
    }
    if (ids.has(insight.id)) {
      throw new Error(`duplicate insight id: ${insight.id}`);
    }
    ids.add(insight.id);
  }
}

function cleanWorkspaceList(values: readonly unknown[]): string[] {
  return [...new Set(values.map(readString).filter((value): value is string => Boolean(value)))];
}

async function fetchCloudWorkspaceList<TEnv extends CatalogingWorkerEnv>(
  input: CloudWorkspaceListOptions<TEnv> & { env: TEnv; provider: string },
): Promise<string[]> {
  const cloudApiUrl = await resolveCloudApiUrl(input);
  const serviceToken = await resolveCatalogingCloudToken(input);
  const url = catalogingWorkspacesUrl(cloudApiUrl, input.provider);
  const timeoutMs = input.timeoutMs ?? DEFAULT_WORKSPACE_DISCOVERY_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await (input.fetcher ?? fetch)(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${serviceToken}`,
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `cataloging workspace discovery failed for ${input.provider}: timed out after ${timeoutMs}ms`,
      );
    }
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new Error(
      `cataloging workspace discovery failed for ${input.provider}: ${reason}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `cataloging workspace discovery failed for ${input.provider}: cloud returned ${response.status}${formatErrorBody(body)}`,
    );
  }

  const payload = await response.json().catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new Error(
      `cataloging workspace discovery failed for ${input.provider}: invalid JSON response (${reason})`,
    );
  });
  return validateCloudWorkspacePayload(payload, input.provider);
}

async function resolveCloudApiUrl<TEnv extends CatalogingWorkerEnv>(
  input: CloudWorkspaceListOptions<TEnv> & { env: TEnv },
): Promise<string> {
  const configured = await resolveConfigString(input.cloudApiUrl, input.env);
  const value =
    configured ??
    readString(input.env.CATALOGING_CLOUD_API_URL) ??
    readString(input.env.CLOUD_API_URL);
  if (!value) {
    throw new Error(
      "cataloging workspace discovery requires CATALOGING_CLOUD_API_URL or CLOUD_API_URL",
    );
  }
  return value;
}

async function resolveCatalogingCloudToken<TEnv extends CatalogingWorkerEnv>(
  input: CloudWorkspaceListOptions<TEnv> & { env: TEnv },
): Promise<string> {
  const configured = await resolveConfigString(input.serviceToken, input.env);
  const value = configured ?? readString(input.env.CATALOGING_CLOUD_API_TOKEN);
  if (!value) {
    throw new Error(
      "cataloging workspace discovery requires CATALOGING_CLOUD_API_TOKEN",
    );
  }
  return value;
}

async function resolveConfigString<TEnv extends CatalogingWorkerEnv>(
  value: string | ((env: TEnv) => string | Promise<string>) | undefined,
  env: TEnv,
): Promise<string | undefined> {
  if (typeof value === "function") {
    return readString(await value(env));
  }
  return readString(value);
}

function catalogingWorkspacesUrl(cloudApiUrl: string, provider: string): URL {
  const url = new URL(cloudApiUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/api/internal/cataloging/workspaces/${encodeURIComponent(provider)}`;
  url.search = "";
  url.hash = "";
  return url;
}

function validateCloudWorkspacePayload(payload: unknown, provider: string): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(
      `cataloging workspace discovery failed for ${provider}: response must be an object`,
    );
  }

  const record = payload as Record<string, unknown>;
  if (record.provider !== provider) {
    throw new Error(
      `cataloging workspace discovery failed for ${provider}: response provider mismatch`,
    );
  }

  if (!Array.isArray(record.workspaces)) {
    throw new Error(
      `cataloging workspace discovery failed for ${provider}: response workspaces must be an array`,
    );
  }

  const seen = new Set<string>();
  const workspaces: string[] = [];
  for (const workspace of record.workspaces) {
    const workspaceId = readString(workspace);
    if (!workspaceId) {
      throw new Error(
        `cataloging workspace discovery failed for ${provider}: workspace ids must be non-empty strings`,
      );
    }
    if (seen.has(workspaceId)) {
      throw new Error(
        `cataloging workspace discovery failed for ${provider}: duplicate workspace id ${workspaceId}`,
      );
    }
    seen.add(workspaceId);
    workspaces.push(workspaceId);
  }

  return workspaces;
}

function formatErrorBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return "";
  }
  return `: ${trimmed.slice(0, 500)}`;
}

function isDurableObjectNamespace(value: unknown): value is DurableObjectNamespace {
  return (
    typeof value === "object" &&
    value !== null &&
    "idFromName" in value &&
    "get" in value &&
    typeof (value as { idFromName?: unknown }).idFromName === "function" &&
    typeof (value as { get?: unknown }).get === "function"
  );
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

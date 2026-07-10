import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { workspaces } from "@/lib/db/schema";
import {
  commitViaGitDatabaseRequest,
  type GitHubCommitPatchOperation,
} from "./relayfile-writeback-bridge";
import {
  getNangoClient,
  getNangoConnectionDetails,
  getProviderConfigKey,
} from "./nango-service";
import { isWorkspaceIntegrationProvider } from "./providers";
import {
  listUserIntegrations,
  type UserIntegrationRecord,
} from "./user-integrations";
import {
  findWorkspaceGithubIntegrationByInstallation,
  listWorkspaceIntegrationsByProviderAlias,
  type WorkspaceIntegrationRecord,
} from "./workspace-integrations";
import { resolveRepoAllowlistOrRelaxed } from "./workflow-repository-allowlists";

export type GithubProxyAuthorshipMode = "user" | "app";

export type GithubProxyPullRequestFile = {
  path: string;
  content?: string;
  encoding?: "utf-8" | "base64";
  deleted?: boolean;
};

export type GithubProxyPullRequestInput = {
  userId: string;
  workspaceId: string;
  owner: string;
  repo: string;
  branch: string;
  baseSha: string;
  baseBranch?: string;
  title: string;
  body: string;
  files: GithubProxyPullRequestFile[];
  authorshipMode?: GithubProxyAuthorshipMode;
};

export type GithubProxyPullRequestResult = {
  prUrl: string;
  branch: string;
  sha: string;
};

export type GithubProxyIssueCommentInput = {
  userId: string;
  workspaceId: string;
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
  authorshipMode?: GithubProxyAuthorshipMode;
};

export type GithubProxyIssueCommentResult = {
  commentUrl: string | null;
};

export type GithubProxyPullRequestReadInput = {
  userId: string;
  workspaceId: string;
  owner: string;
  repo: string;
  pullNumber: number;
};

export type GithubProxyCommitCheckRunsInput = {
  userId: string;
  workspaceId: string;
  owner: string;
  repo: string;
  sha: string;
};

type GithubIntegrationCandidate = {
  source: "user_integrations" | "workspace_integrations";
  userId?: string;
  workspaceId?: string;
  provider: string;
  connectionId: string;
  providerConfigKey: string | null;
  installationId: string | null;
};

type ProxyGithubRequestInput = {
  credential: GithubRequestCredential;
  method: "GET" | "POST" | "PATCH";
  endpoint: string;
  data?: unknown;
};

type GithubRequestCredential =
  | {
      mode: "user_oauth";
      candidate: GithubIntegrationCandidate;
      token: string;
      tokenPrefix: string;
    }
  | {
      mode: "nango_proxy";
      candidate: GithubIntegrationCandidate;
    };

type GithubRequestCredentialSelection = {
  credential: GithubRequestCredential;
  writeFallbackCredentials: GithubRequestCredential[];
};

type GithubProxyErrorDetails = {
  payload?: unknown;
  headers?: Record<string, string>;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class GithubProxyPullRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly payload: unknown;
  readonly headers: Record<string, string>;

  constructor(
    code: string,
    message: string,
    status = 500,
    details: GithubProxyErrorDetails = {},
  ) {
    super(message);
    this.name = "GithubProxyPullRequestError";
    this.status = status;
    this.code = code;
    this.payload = details.payload;
    this.headers = details.headers ?? {};
  }
}

function repoEndpoint(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPayloadMessage(payload: unknown, fallback: string): string {
  if (isRecord(payload) && typeof payload.message === "string" && payload.message.trim()) {
    return payload.message;
  }
  return fallback;
}

function githubRequestFailureMessage(input: {
  kind: "request" | "proxy request";
  method: string;
  endpoint: string;
  status: number;
  payload: unknown;
}): string {
  const payloadMessage = readPayloadMessage(input.payload, "").trim();
  const prefix = `GitHub ${input.kind} ${input.method} ${input.endpoint} failed with status ${input.status}`;
  return payloadMessage ? `${prefix}: ${payloadMessage}` : `${prefix}.`;
}

function readNestedRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const nested = value[key];
  return isRecord(nested) ? nested : null;
}

function readUserOAuthTokenFromConnectionPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;

  const connectionConfig =
    readNestedRecord(payload, "connection_config") ??
    readNestedRecord(payload, "connectionConfig");
  const userCredentials =
    readNestedRecord(payload, "userCredentials") ??
    readNestedRecord(payload, "user_credentials") ??
    (connectionConfig
      ? readNestedRecord(connectionConfig, "userCredentials") ??
        readNestedRecord(connectionConfig, "user_credentials")
      : null);
  const rawUserCredentials = userCredentials
    ? readNestedRecord(userCredentials, "raw")
    : null;
  const candidates = [
    userCredentials?.access_token,
    userCredentials?.accessToken,
    userCredentials?.token,
    rawUserCredentials?.access_token,
    rawUserCredentials?.accessToken,
    rawUserCredentials?.token,
    connectionConfig?.access_token,
    connectionConfig?.token,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function readTokenFromNangoTokenResponse(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (!isRecord(value)) return null;
  for (const key of ["access_token", "accessToken", "token"]) {
    const token = value[key];
    if (typeof token === "string" && token.trim()) {
      return token.trim();
    }
  }
  return null;
}

function tokenPrefix(token: string): string {
  return token.slice(0, 4);
}

function isGithubInstallationToken(token: string): boolean {
  return token.startsWith("ghs_");
}

function isGithubUserOAuthToken(token: string): boolean {
  return token.startsWith("ghu_") || token.startsWith("gho_");
}

function resolveProviderConfigKey(integration: {
  provider: string;
  providerConfigKey: string | null;
}): string {
  return (
    integration.providerConfigKey ??
    (isWorkspaceIntegrationProvider(integration.provider)
      ? getProviderConfigKey(integration.provider)
      : integration.provider)
  );
}

function sortGithubIntegrations<T extends {
  provider: string;
  providerConfigKey: string | null;
}>(integrations: T[]): T[] {
  return [...integrations].sort((left, right) => {
    const leftScore = resolveProviderConfigKey(left) === "github-relay" ? 0 : 1;
    const rightScore = resolveProviderConfigKey(right) === "github-relay" ? 0 : 1;
    return leftScore - rightScore;
  });
}

function describeCandidate(candidate: GithubIntegrationCandidate): Record<string, string | null> {
  return {
    source: candidate.source,
    userId: candidate.userId ?? null,
    workspaceId: candidate.workspaceId ?? null,
    provider: candidate.provider,
    providerConfigKey: resolveProviderConfigKey(candidate),
    connectionId: candidate.connectionId,
    installationId: candidate.installationId ?? "",
  };
}

function describeCredential(
  credential: GithubRequestCredential,
): Record<string, string | null> {
  return {
    ...describeCandidate(credential.candidate),
    credentialMode: credential.mode,
    tokenPrefix: credential.mode === "user_oauth" ? credential.tokenPrefix : null,
  };
}

function toUserCandidate(userId: string, integration: UserIntegrationRecord): GithubIntegrationCandidate {
  return {
    source: "user_integrations",
    userId,
    provider: integration.provider,
    connectionId: integration.connectionId,
    providerConfigKey: integration.providerConfigKey,
    installationId: integration.installationId,
  };
}

function toWorkspaceCandidate(
  workspaceId: string,
  integration: WorkspaceIntegrationRecord,
): GithubIntegrationCandidate {
  return {
    source: "workspace_integrations",
    workspaceId,
    provider: integration.provider,
    connectionId: integration.connectionId,
    providerConfigKey: integration.providerConfigKey,
    installationId: integration.installationId,
  };
}

async function readBoundRelayWorkspaceId(appWorkspaceId: string): Promise<string | null> {
  if (!UUID_PATTERN.test(appWorkspaceId)) return null;
  const db = getDb();
  const [row] = await db
    .select({ relayWorkspaceId: workspaces.relayWorkspaceId })
    .from(workspaces)
    .where(eq(workspaces.id, appWorkspaceId))
    .limit(1);
  const value = row?.relayWorkspaceId?.trim() ?? "";
  return value.length > 0 ? value : null;
}

async function resolveGithubIntegrationWorkspaceIds(appWorkspaceId: string): Promise<string[]> {
  const relayWorkspaceId = await readBoundRelayWorkspaceId(appWorkspaceId);
  if (relayWorkspaceId && relayWorkspaceId !== appWorkspaceId) {
    return [relayWorkspaceId, appWorkspaceId];
  }
  return [appWorkspaceId];
}

async function listUserGithubCandidates(userId: string): Promise<GithubIntegrationCandidate[]> {
  const integrations = (await listUserIntegrations(userId))
    .filter((integration) => integration.provider.startsWith("github"));
  return sortGithubIntegrations(integrations).map((integration) =>
    toUserCandidate(userId, integration),
  );
}

async function listWorkspaceGithubCandidates(
  workspaceIds: string[],
): Promise<GithubIntegrationCandidate[]> {
  const groups = await Promise.all(
    workspaceIds.map(async (workspaceId) =>
      sortGithubIntegrations(
        await listWorkspaceIntegrationsByProviderAlias(workspaceId, "github"),
      ).map((integration) => toWorkspaceCandidate(workspaceId, integration)),
    ),
  );
  return groups.flat();
}

function readProxyErrorStatus(error: unknown): number | null {
  if (!isRecord(error)) return null;
  for (const value of [
    error.status,
    error.statusCode,
    isRecord(error.response) ? error.response.status : undefined,
  ]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function readProxyErrorPayload(error: unknown): unknown {
  if (!isRecord(error)) return null;
  return (
    (isRecord(error.response) ? error.response.data : undefined) ??
    error.payload ??
    error.data ??
    null
  );
}

function readErrorField(error: unknown, field: "name" | "message"): string | null {
  if (!isRecord(error)) return null;
  const value = error[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function describeProxyTransportError(error: unknown): string | null {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (!isRecord(error)) return null;

  const name = readErrorField(error, "name");
  const message = readErrorField(error, "message");
  const primary = name && message ? `${name}: ${message}` : message ?? name;
  const cause = error.cause;
  const causeName = readErrorField(cause, "name");
  const causeMessage = readErrorField(cause, "message");
  const causeText = causeName && causeMessage
    ? `${causeName}: ${causeMessage}`
    : causeMessage ??
      causeName ??
      (typeof cause === "string" && cause.trim() ? cause.trim() : null);

  if (primary && causeText) return `${primary}; cause: ${causeText}`;
  return primary ?? causeText;
}

function proxyTransportErrorPayload(error: unknown): { message: string } | null {
  const message = describeProxyTransportError(error);
  if (!message) return null;
  return {
    message,
  };
}

function responseHeadersToRecord(headers: Headers): Record<string, string> {
  const entries: Record<string, string> = {};
  headers.forEach((value, key) => {
    entries[key.toLowerCase()] = value;
  });
  return entries;
}

function readHeaderValue(value: unknown): string | null {
  if (Array.isArray(value)) {
    const first = value.find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    return first?.trim() ?? null;
  }
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function normalizeHeaderEntries(headers: unknown): Record<string, string> {
  const normalized: Record<string, string> = {};
  const addHeader = (key: unknown, value: unknown) => {
    if (typeof key !== "string" || !key.trim()) return;
    const header = readHeaderValue(value);
    if (header !== null) {
      normalized[key.toLowerCase()] = header;
    }
  };

  if (
    typeof Headers !== "undefined" &&
    headers instanceof Headers
  ) {
    headers.forEach((value, key) => addHeader(key, value));
    return normalized;
  }

  if (!isRecord(headers)) return normalized;

  const forEach = headers.forEach;
  if (typeof forEach === "function") {
    try {
      forEach.call(headers, (value: unknown, key: unknown) => addHeader(key, value));
      if (Object.keys(normalized).length > 0) return normalized;
    } catch {
      // Fall through to object/toJSON handling below.
    }
  }

  const toJSON = headers.toJSON;
  if (typeof toJSON === "function") {
    try {
      const json = toJSON.call(headers);
      if (isRecord(json)) {
        for (const [key, value] of Object.entries(json)) {
          addHeader(key, value);
        }
        if (Object.keys(normalized).length > 0) return normalized;
      }
    } catch {
      // Fall through to plain object handling below.
    }
  }

  for (const [key, value] of Object.entries(headers)) {
    addHeader(key, value);
  }
  return normalized;
}

function readProxyErrorHeaders(error: unknown): Record<string, string> {
  if (!isRecord(error)) return {};
  const response = isRecord(error.response) ? error.response : null;
  return normalizeHeaderEntries(response?.headers ?? error.headers);
}

function payloadSearchText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (isRecord(payload)) {
    const message = typeof payload.message === "string" ? payload.message : "";
    const documentation = typeof payload.documentation_url === "string"
      ? payload.documentation_url
      : "";
    return `${message}\n${documentation}`;
  }
  try {
    return JSON.stringify(payload ?? "");
  } catch {
    return "";
  }
}

function isGithubRateLimitProxyError(error: GithubProxyPullRequestError): boolean {
  if (error.status === 429) return true;
  if (error.status !== 403) return false;
  if (error.headers["retry-after"]) return true;
  if (error.headers["x-ratelimit-remaining"] === "0") return true;

  const normalized = `${error.message}\n${payloadSearchText(error.payload)}`.toLowerCase();
  return (
    normalized.includes("secondary rate limit") ||
    normalized.includes("rate limit exceeded") ||
    normalized.includes("api rate limit exceeded") ||
    normalized.includes("abuse detection") ||
    normalized.includes("abuse-rate-limits")
  );
}

function retryableGithubRateLimitError(error: GithubProxyPullRequestError): GithubProxyPullRequestError {
  return new GithubProxyPullRequestError(
    "github_rate_limited",
    error.message,
    503,
    {
      payload: error.payload,
      headers: error.headers,
    },
  );
}

function githubApiBaseUrl(): string {
  return (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
}

async function fetchGithubUserOAuthCredential(
  candidate: GithubIntegrationCandidate,
): Promise<GithubRequestCredential> {
  const providerConfigKey = resolveProviderConfigKey(candidate);
  const details = await getNangoConnectionDetails(candidate.connectionId, providerConfigKey);
  let token = readUserOAuthTokenFromConnectionPayload(details?.payload ?? null);
  if (!token) {
    const tokenResponse = await getNangoClient().getToken(
      providerConfigKey,
      candidate.connectionId,
    );
    token = readTokenFromNangoTokenResponse(tokenResponse);
  }
  if (!token) {
    throw new GithubProxyPullRequestError(
      "user_oauth_token_not_found",
      "GitHub user OAuth token was not available for the selected GitHub integration.",
      404,
    );
  }
  if (isGithubInstallationToken(token)) {
    throw new GithubProxyPullRequestError(
      "user_oauth_token_not_found",
      "GitHub integration exposed an installation token instead of a user OAuth token.",
      403,
    );
  }
  if (!isGithubUserOAuthToken(token)) {
    throw new GithubProxyPullRequestError(
      "user_oauth_token_not_found",
      "GitHub integration exposed an unsupported token class for user-authored writes.",
      403,
    );
  }
  return {
    mode: "user_oauth",
    candidate,
    token,
    tokenPrefix: tokenPrefix(token),
  };
}

async function resolveGithubRequestCredentials(
  candidate: GithubIntegrationCandidate,
  authorshipMode: GithubProxyAuthorshipMode = "user",
): Promise<GithubRequestCredential[]> {
  if (authorshipMode === "app") {
    return [{ mode: "nango_proxy", candidate }];
  }
  if (candidate.source === "user_integrations") {
    return [await fetchGithubUserOAuthCredential(candidate)];
  }
  try {
    return [
      await fetchGithubUserOAuthCredential(candidate),
      { mode: "nango_proxy", candidate },
    ];
  } catch (error) {
    if (error instanceof GithubProxyPullRequestError) {
      console.warn("[github-proxy-pr] GitHub integration user OAuth unavailable; falling back to Nango proxy", {
        ...describeCandidate(candidate),
        code: error.code,
        status: error.status,
        message: error.message,
      });
      return [{ mode: "nango_proxy", candidate }];
    }
    throw error;
  }
}

async function directGithubRequest<T = Record<string, unknown>>(input: {
  credential: Extract<GithubRequestCredential, { mode: "user_oauth" }>;
  method: "GET" | "POST" | "PATCH";
  endpoint: string;
  data?: unknown;
}): Promise<{ status: number; data: T | null }> {
  const response = await fetch(`${githubApiBaseUrl()}${input.endpoint}`, {
    method: input.method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${input.credential.token}`,
      "x-github-api-version": "2022-11-28",
      ...(input.data === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(input.data === undefined ? {} : { body: JSON.stringify(input.data) }),
  });

  const text = await response.text();
  let data: unknown = null;
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }

  if (!response.ok) {
    throw new GithubProxyPullRequestError(
      "github_api_error",
      githubRequestFailureMessage({
        kind: "request",
        method: input.method,
        endpoint: input.endpoint,
        status: response.status,
        payload: data,
      }),
      response.status,
      {
        payload: data,
        headers: responseHeadersToRecord(response.headers),
      },
    );
  }

  return { status: response.status, data: (data ?? null) as T | null };
}

async function proxyGithubRequest<T = Record<string, unknown>>(
  input: ProxyGithubRequestInput,
): Promise<{ status: number; data: T | null }> {
  if (input.credential.mode === "user_oauth") {
    return directGithubRequest<T>({
      credential: input.credential,
      method: input.method,
      endpoint: input.endpoint,
      ...(input.data === undefined ? {} : { data: input.data }),
    });
  }

  const providerConfigKey = resolveProviderConfigKey(input.credential.candidate);
  try {
    const response = await getNangoClient().proxy<T>({
      method: input.method,
      endpoint: input.endpoint,
      connectionId: input.credential.candidate.connectionId,
      providerConfigKey,
      ...(input.data === undefined ? {} : { data: input.data }),
    });
    const status = typeof response.status === "number" ? response.status : 200;
    if (status < 200 || status >= 300) {
      const headers = isRecord(response) && isRecord((response as { headers?: unknown }).headers)
        ? readProxyErrorHeaders({ headers: (response as { headers?: unknown }).headers })
        : {};
      const code = status >= 500 ? "github_nango_proxy_unavailable" : "github_api_error";
      throw new GithubProxyPullRequestError(
        code,
        githubRequestFailureMessage({
          kind: "proxy request",
          method: input.method,
          endpoint: input.endpoint,
          status,
          payload: response.data,
        }),
        status,
        {
          payload: response.data,
          headers,
        },
      );
    }
    return { status, data: (response.data ?? null) as T | null };
  } catch (error) {
    if (error instanceof GithubProxyPullRequestError) throw error;
    const status = readProxyErrorStatus(error) ?? 503;
    const payload = readProxyErrorPayload(error) ?? proxyTransportErrorPayload(error);
    const headers = readProxyErrorHeaders(error);
    const code = status >= 500 ? "github_nango_proxy_unavailable" : "github_api_error";
    throw new GithubProxyPullRequestError(
      code,
      githubRequestFailureMessage({
        kind: "proxy request",
        method: input.method,
        endpoint: input.endpoint,
        status,
        payload,
      }),
      status,
      {
        payload,
        headers,
      },
    );
  }
}

async function probeRepoAccess(input: {
  credential: GithubRequestCredential;
  owner: string;
  repo: string;
}): Promise<GithubProxyPullRequestError | null> {
  try {
    await proxyGithubRequest({
      credential: input.credential,
      method: "GET",
      endpoint: repoEndpoint(input.owner, input.repo),
    });
    return null;
  } catch (error) {
    if (
      error instanceof GithubProxyPullRequestError &&
      isGithubRateLimitProxyError(error)
    ) {
      throw retryableGithubRateLimitError(error);
    }
    if (
      error instanceof GithubProxyPullRequestError &&
      (error.status === 403 || error.status === 404)
    ) {
      return error;
    }
    throw error;
  }
}

async function resolveGithubProxyCredentialSelection(input: {
  userId: string;
  workspaceId: string;
  owner: string;
  repo: string;
  authorshipMode?: GithubProxyAuthorshipMode;
}): Promise<GithubRequestCredentialSelection> {
  const authorshipMode = input.authorshipMode ?? "user";
  const allow = await resolveRepoAllowlistOrRelaxed(
    input.workspaceId,
    input.owner,
    input.repo,
  );
  if (!allow || !allow.pushAllowed) {
    throw new GithubProxyPullRequestError(
      "repo_push_not_allowed",
      `Workflow GitHub write is not allowed for ${input.owner}/${input.repo}.`,
      403,
    );
  }

  const workspaceIds = await resolveGithubIntegrationWorkspaceIds(input.workspaceId);
  if (allow.installationId) {
    const installationFailures: GithubProxyPullRequestError[] = [];
    for (const workspaceId of workspaceIds) {
      const integration = await findWorkspaceGithubIntegrationByInstallation(
        workspaceId,
        allow.installationId,
      );
      if (integration) {
        const candidate = toWorkspaceCandidate(workspaceId, integration);
        const credentials = await resolveGithubRequestCredentials(candidate, authorshipMode);
        for (const [index, credential] of credentials.entries()) {
          const accessError = await probeRepoAccess({ credential, owner: input.owner, repo: input.repo });
          if (!accessError) {
            return {
              credential,
              writeFallbackCredentials: credentials.slice(index + 1),
            };
          }
          console.warn("[github-proxy-pr] GitHub request credential repo probe failed", {
            ...describeCredential(credential),
            repo: `${input.owner}/${input.repo}`,
            code: accessError.code,
            status: accessError.status,
            message: accessError.message,
          });
          installationFailures.push(accessError);
        }
      }
    }
    if (installationFailures.length > 0) {
      const configFailure = installationFailures.find(
        (failure) => failure.status >= 500 || failure.code === "integration_not_found",
      );
      throw configFailure ?? new GithubProxyPullRequestError(
        "repo_push_not_allowed",
        `GitHub installation ${allow.installationId} cannot access ${input.owner}/${input.repo}.`,
        403,
      );
    }
    throw new GithubProxyPullRequestError(
      "integration_not_found",
      `No GitHub integration owns installation ${allow.installationId}.`,
      404,
    );
  }

  const candidates = [
    ...await listUserGithubCandidates(input.userId),
    ...await listWorkspaceGithubCandidates(workspaceIds),
  ];
  if (candidates.length === 0) {
    throw new GithubProxyPullRequestError(
      "integration_not_found",
      `User ${input.userId} and workspaces ${workspaceIds.join(", ")} have no GitHub integration connections.`,
      404,
    );
  }

  const failures: GithubProxyPullRequestError[] = [];
  for (const candidate of candidates) {
    try {
      const credentials = await resolveGithubRequestCredentials(candidate, authorshipMode);
      for (const [index, credential] of credentials.entries()) {
        const accessError = await probeRepoAccess({ credential, owner: input.owner, repo: input.repo });
        if (!accessError) {
          console.log("[github-proxy-pr] selected GitHub request credential", {
            ...describeCredential(credential),
            repo: `${input.owner}/${input.repo}`,
          });
          return {
            credential,
            writeFallbackCredentials: credentials.slice(index + 1),
          };
        }
        console.warn("[github-proxy-pr] GitHub request credential repo probe failed", {
          ...describeCredential(credential),
          repo: `${input.owner}/${input.repo}`,
          code: accessError.code,
          status: accessError.status,
          message: accessError.message,
        });
        failures.push(accessError);
      }
    } catch (error) {
      if (error instanceof GithubProxyPullRequestError) {
        console.warn("[github-proxy-pr] GitHub request credential candidate failed", {
          ...describeCandidate(candidate),
          repo: `${input.owner}/${input.repo}`,
          code: error.code,
          status: error.status,
          message: error.message,
        });
        failures.push(error);
        continue;
      }
      throw error;
    }
  }

  const configFailure = failures.find(
    (failure) => failure.status >= 500 || failure.code === "integration_not_found",
  );
  throw configFailure ?? new GithubProxyPullRequestError(
    "repo_push_not_allowed",
    `No GitHub integration can access ${input.owner}/${input.repo}.`,
    403,
  );
}

async function resolveGithubProxyCandidate(input: {
  userId: string;
  workspaceId: string;
  owner: string;
  repo: string;
  authorshipMode?: GithubProxyAuthorshipMode;
}): Promise<GithubRequestCredential> {
  return (await resolveGithubProxyCredentialSelection(input)).credential;
}

function isRetryableCredentialWriteError(error: GithubProxyPullRequestError): boolean {
  return error.code === "github_api_error" && (error.status === 403 || error.status === 404);
}

function validateBranch(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.endsWith("/") || trimmed.includes("..")) {
    throw new GithubProxyPullRequestError("invalid_request", "Invalid branch name.", 400);
  }
  return trimmed;
}

function validateRepoPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\0")) {
    throw new GithubProxyPullRequestError("invalid_request", `Invalid file path: ${value}`, 400);
  }
  const normalized = trimmed.split("/").filter(Boolean).join("/");
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new GithubProxyPullRequestError("invalid_request", `Invalid file path: ${value}`, 400);
  }
  return normalized;
}

function validateIssueNumber(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new GithubProxyPullRequestError("invalid_request", "Invalid GitHub issue number.", 400);
  }
  return value;
}

function validatePullRequestNumber(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new GithubProxyPullRequestError("invalid_request", "Invalid GitHub pull request number.", 400);
  }
  return value;
}

function fileContentToBase64(file: GithubProxyPullRequestFile): string {
  if (file.encoding === "base64") {
    return file.content ?? "";
  }
  return Buffer.from(file.content ?? "", "utf8").toString("base64");
}

function toCommitOperations(files: GithubProxyPullRequestFile[]): GitHubCommitPatchOperation[] {
  return files.map((file) => {
    const repoFilePath = validateRepoPath(file.path);
    if (file.deleted) {
      return {
        kind: "delete",
        path: repoFilePath,
      };
    }

    return {
      kind: "upsert",
      path: repoFilePath,
      content: fileContentToBase64(file),
      contentEncoding: "base64",
    };
  });
}

export async function createGithubProxyPullRequest(
  input: GithubProxyPullRequestInput,
): Promise<GithubProxyPullRequestResult> {
  const selection = await resolveGithubProxyCredentialSelection({
    userId: input.userId,
    workspaceId: input.workspaceId,
    owner: input.owner,
    repo: input.repo,
    authorshipMode: input.authorshipMode,
  });
  const branch = validateBranch(input.branch);
  const operations = toCommitOperations(input.files);
  if (operations.length === 0) {
    throw new GithubProxyPullRequestError("invalid_request", "No changed files supplied.", 400);
  }

  const credentials = [selection.credential, ...selection.writeFallbackCredentials];
  let lastRetryableError: GithubProxyPullRequestError | null = null;
  for (const [index, credential] of credentials.entries()) {
    try {
      const commitSha = await commitViaGitDatabaseRequest({
        owner: input.owner,
        repo: input.repo,
        branch,
        baseSha: input.baseSha,
        message: input.title,
        operations,
        branchMode: "create_or_update",
        request: (request) => proxyGithubRequest({
          credential,
          method: request.method as "GET" | "POST" | "PATCH",
          endpoint: request.endpoint,
          ...(request.data === undefined ? {} : { data: request.data }),
        }),
      });

      const pull = await proxyGithubRequest<Record<string, unknown>>({
        credential,
        method: "POST",
        endpoint: `${repoEndpoint(input.owner, input.repo)}/pulls`,
        data: {
          title: input.title,
          head: branch,
          base: input.baseBranch?.trim() || "main",
          body: input.body,
          draft: false,
        },
      });
      const prUrl = typeof pull.data?.html_url === "string" ? pull.data.html_url : null;
      if (!prUrl) {
        throw new GithubProxyPullRequestError(
          "github_api_error",
          "GitHub pull request response did not include html_url.",
        );
      }

      return {
        prUrl,
        branch,
        sha: commitSha,
      };
    } catch (error) {
      if (
        error instanceof GithubProxyPullRequestError &&
        isRetryableCredentialWriteError(error) &&
        index < credentials.length - 1
      ) {
        lastRetryableError = error;
        console.warn("[github-proxy-pr] GitHub request credential write failed; trying fallback credential", {
          ...describeCredential(credential),
          repo: `${input.owner}/${input.repo}`,
          branch,
          code: error.code,
          status: error.status,
          message: error.message,
        });
        continue;
      }
      throw error;
    }
  }

  throw lastRetryableError ?? new GithubProxyPullRequestError(
    "github_api_error",
    "No GitHub credential completed pull request creation.",
  );
}

export async function createGithubProxyIssueComment(
  input: GithubProxyIssueCommentInput,
): Promise<GithubProxyIssueCommentResult> {
  const credential = await resolveGithubProxyCandidate({
    userId: input.userId,
    workspaceId: input.workspaceId,
    owner: input.owner,
    repo: input.repo,
    authorshipMode: input.authorshipMode,
  });
  const issueNumber = validateIssueNumber(input.issueNumber);
  const comment = await proxyGithubRequest<Record<string, unknown>>({
    credential,
    method: "POST",
    endpoint: `${repoEndpoint(input.owner, input.repo)}/issues/${issueNumber}/comments`,
    data: { body: input.body },
  });
  return {
    commentUrl: typeof comment.data?.html_url === "string" ? comment.data.html_url : null,
  };
}

export async function readGithubProxyPullRequest(
  input: GithubProxyPullRequestReadInput,
): Promise<Record<string, unknown>> {
  const credential = await resolveGithubProxyCandidate({
    userId: input.userId,
    workspaceId: input.workspaceId,
    owner: input.owner,
    repo: input.repo,
    authorshipMode: "app",
  });
  const pullNumber = validatePullRequestNumber(input.pullNumber);
  try {
    const pull = await proxyGithubRequest<Record<string, unknown>>({
      credential,
      method: "GET",
      endpoint: `${repoEndpoint(input.owner, input.repo)}/pulls/${pullNumber}`,
    });
    if (!isRecord(pull.data)) {
      throw new GithubProxyPullRequestError(
        "github_api_error",
        "GitHub pull request response did not include an object payload.",
        502,
      );
    }
    return pull.data;
  } catch (error) {
    if (error instanceof GithubProxyPullRequestError && isGithubRateLimitProxyError(error)) {
      throw retryableGithubRateLimitError(error);
    }
    throw error;
  }
}

export async function readGithubProxyCommitCheckRuns(
  input: GithubProxyCommitCheckRunsInput,
): Promise<Record<string, unknown>[]> {
  const credential = await resolveGithubProxyCandidate({
    userId: input.userId,
    workspaceId: input.workspaceId,
    owner: input.owner,
    repo: input.repo,
    authorshipMode: "app",
  });
  try {
    const response = await proxyGithubRequest<Record<string, unknown>>({
      credential,
      method: "GET",
      endpoint: `${repoEndpoint(input.owner, input.repo)}/commits/${encodeURIComponent(input.sha)}/check-runs?per_page=100`,
    });
    const checkRuns = Array.isArray(response.data?.check_runs)
      ? response.data.check_runs
      : [];
    return checkRuns.filter(isRecord);
  } catch (error) {
    if (error instanceof GithubProxyPullRequestError && isGithubRateLimitProxyError(error)) {
      throw retryableGithubRateLimitError(error);
    }
    throw error;
  }
}

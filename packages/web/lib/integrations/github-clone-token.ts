import {
  isMissingNangoConnectionError,
  selectRepoCapableConnection,
} from "@cloud/core/clone/github-clone-production.js";
import { getNangoClient, getNangoSecretKey, getProviderConfigKey } from "./nango-service";
import { isWorkspaceIntegrationProvider } from "./providers";
import { resolveWorkspaceIntegrationIdentity } from "@/lib/workspaces/workspace-integration-identity-core";
import {
  listUserIntegrations,
  type UserIntegrationRecord,
} from "./user-integrations";
import {
  listWorkspaceIntegrationsByProviderAlias,
  type WorkspaceIntegrationRecord,
} from "./workspace-integrations";
import { isGithubInstallationCentricEnabled } from "./github-installation-centric-flag";
import {
  resolveGithubConnectionForWorkspace,
  type GithubInstallationConnection,
} from "./github-installation-connection";

export type GitCloneCredentials = {
  provider: "github" | "gitlab";
  username: string;
  token: string;
};

type GitCloneProvider = GitCloneCredentials["provider"];

type GitCloneTokenCandidate = {
  source:
    | "user_integrations"
    | "workspace_integrations"
    | "github_installation_connection";
  userId?: string;
  workspaceId?: string;
  provider: string;
  connectionId: string;
  providerConfigKey: string | null;
  installationId: string | null;
};

type NangoTokenClient = {
  getToken(
    providerConfigKey: string,
    connectionId: string,
    forceRefresh?: boolean,
    refreshGithubAppJwtToken?: boolean,
  ): Promise<string | { access_token?: unknown; token?: unknown }>;
  proxy(config: Record<string, unknown>): Promise<{ status?: unknown }>;
};

type ParsedGitRemote = {
  provider: GitCloneProvider;
  repoLabel: string;
  probeEndpoint: string;
  cloneUsername: string;
  refreshGithubAppJwtToken: boolean;
};

const PROVIDER_SORT_PRIORITY: Record<string, number> = {
  "github-relay": 0,
  "gitlab-relay": 0,
};

function resolveProviderConfigKey(input: {
  provider: string;
  providerConfigKey: string | null;
}): string {
  return (
    input.providerConfigKey ??
    (isWorkspaceIntegrationProvider(input.provider)
      ? getProviderConfigKey(input.provider)
      : input.provider)
  );
}

function toGithubInstallationCandidate(
  workspaceId: string,
  connection: GithubInstallationConnection,
): GitCloneTokenCandidate {
  return {
    source: "github_installation_connection",
    workspaceId,
    provider: "github",
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    installationId: connection.installationId,
  };
}

function sortGitIntegrations<T extends {
  provider: string;
  providerConfigKey: string | null;
}>(integrations: T[]): T[] {
  return [...integrations].sort((left, right) => {
    const leftKey = resolveProviderConfigKey(left);
    const rightKey = resolveProviderConfigKey(right);
    const leftScore = PROVIDER_SORT_PRIORITY[leftKey] ?? 1;
    const rightScore = PROVIDER_SORT_PRIORITY[rightKey] ?? 1;
    return leftScore - rightScore;
  });
}

function toUserCandidate(userId: string, integration: UserIntegrationRecord): GitCloneTokenCandidate {
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
): GitCloneTokenCandidate {
  return {
    source: "workspace_integrations",
    workspaceId,
    provider: integration.provider,
    connectionId: integration.connectionId,
    providerConfigKey: integration.providerConfigKey,
    installationId: integration.installationId,
  };
}

async function listGitCandidates(input: {
  userId: string;
  workspaceId: string;
  provider: GitCloneProvider;
}): Promise<GitCloneTokenCandidate[]> {
  const user = sortGitIntegrations(
    (await listUserIntegrations(input.userId))
      .filter((integration) => integration.provider.startsWith(input.provider)),
  ).map((integration) => toUserCandidate(input.userId, integration));
  if (input.provider === "github" && isGithubInstallationCentricEnabled()) {
    const installationConnection = await resolveGithubConnectionForWorkspace(
      input.workspaceId,
    );
    const workspace = installationConnection
      ? [toGithubInstallationCandidate(input.workspaceId, installationConnection)]
      : [];
    return [...workspace, ...user];
  }
  const workspace = sortGitIntegrations(
    await listWorkspaceIntegrationsByProviderAlias(input.workspaceId, input.provider),
  ).map((integration) => toWorkspaceCandidate(input.workspaceId, integration));
  return [...workspace, ...user];
}

function githubRepoEndpoint(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function gitlabProjectEndpoint(projectPath: string): string {
  return `/api/v4/projects/${encodeURIComponent(projectPath)}`;
}

function parseGitRemote(remoteUrl: string): ParsedGitRemote | null {
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  const segments = url.pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);
  if (hostname === "github.com") {
    const [owner, rawRepo, ...rest] = segments;
    if (!owner || !rawRepo || rest.length > 0) {
      return null;
    }
    const repo = rawRepo.replace(/\.git$/u, "");
    return repo
      ? {
          provider: "github",
          repoLabel: `${owner}/${repo}`,
          probeEndpoint: githubRepoEndpoint(owner, repo),
          cloneUsername: "x-access-token",
          refreshGithubAppJwtToken: true,
        }
      : null;
  }
  if (hostname === "gitlab.com") {
    if (segments.length < 2) return null;
    const last = segments[segments.length - 1];
    if (!last) return null;
    const normalized = [
      ...segments.slice(0, -1),
      last.replace(/\.git$/u, ""),
    ];
    const projectPath = normalized.join("/");
    return projectPath
      ? {
          provider: "gitlab",
          repoLabel: projectPath,
          probeEndpoint: gitlabProjectEndpoint(projectPath),
          cloneUsername: "oauth2",
          refreshGithubAppJwtToken: false,
        }
      : null;
  }
  return null;
}

function extractToken(raw: string | { access_token?: unknown; token?: unknown }): string {
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }
  if (raw && typeof raw === "object") {
    if (typeof raw.access_token === "string" && raw.access_token.trim()) {
      return raw.access_token.trim();
    }
    if (typeof raw.token === "string" && raw.token.trim()) {
      return raw.token.trim();
    }
  }
  throw new Error("Nango getToken returned an unexpected GitHub App token shape.");
}

async function candidateCanReadRepo(input: {
  client: NangoTokenClient;
  candidate: GitCloneTokenCandidate;
  remote: ParsedGitRemote;
}): Promise<boolean> {
  const providerConfigKey = resolveProviderConfigKey(input.candidate);
  try {
    const response = await input.client.proxy({
      method: "GET",
      endpoint: input.remote.probeEndpoint,
      connectionId: input.candidate.connectionId,
      providerConfigKey,
    });
    const status = typeof response.status === "number" ? response.status : 200;
    return status >= 200 && status < 300;
  } catch (error) {
    const status = readStatus(error);
    if (status === 403 || status === 404) return false;
    throw error;
  }
}

function readStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  for (const value of [
    record.status,
    record.statusCode,
    (record.response as Record<string, unknown> | undefined)?.status,
  ]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

// Pull a human-readable message out of a Nango/axios error body so failures
// carry the upstream reason rather than a context-free
// "Request failed with status code 400".
function readNangoErrorBody(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const response = (error as { response?: { data?: unknown } }).response;
  const data = response?.data;
  if (typeof data === "string" && data.trim()) return data.trim();
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const nested =
      record.error && typeof record.error === "object"
        ? (record.error as Record<string, unknown>)
        : null;
    for (const value of [
      record.message,
      record.error,
      nested?.message,
      nested?.code,
    ]) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}


// Identify a candidate without leaking secrets: source + resolved provider
// config key + connectionId are safe correlation handles.
function describeCandidate(candidate: GitCloneTokenCandidate): string {
  return `${candidate.source}:${resolveProviderConfigKey(candidate)}/${candidate.connectionId}`;
}

function describeCandidateFailure(
  candidate: GitCloneTokenCandidate,
  error: unknown,
): string {
  const status = readStatus(error);
  const body = readNangoErrorBody(error);
  const base = error instanceof Error ? error.message : String(error);
  return [
    describeCandidate(candidate),
    status !== null ? `status=${status}` : null,
    body ? `nango=${JSON.stringify(body)}` : null,
    base,
  ]
    .filter(Boolean)
    .join(" ");
}

async function mintCandidateToken(input: {
  client: NangoTokenClient;
  candidate: GitCloneTokenCandidate;
  remote: ParsedGitRemote;
}): Promise<string> {
  const providerConfigKey = resolveProviderConfigKey(input.candidate);
  return extractToken(await input.client.getToken(
    providerConfigKey,
    input.candidate.connectionId,
    false,
    input.remote.refreshGithubAppJwtToken,
  ));
}

// Tenant scopes to try when re-resolving a live GitHub connection, ordered
// relay-ws first (matches the production clone worker's tag-scope, which is the
// scope the live connection for these workspaces is tagged with) then the app
// workspace id (covers CLI-connected, app-ws-tagged tenants). De-duped, with a
// raw-workspaceId fallback if the binding lookup fails.
async function resolveTenantScopeIds(workspaceId: string): Promise<string[]> {
  try {
    const identity = await resolveWorkspaceIntegrationIdentity(workspaceId);
    const ordered = [
      identity.relayWorkspaceId,
      identity.appWorkspaceId ?? workspaceId,
      workspaceId,
    ];
    return Array.from(
      new Set(ordered.map((id) => id?.trim()).filter((id): id is string => Boolean(id))),
    );
  } catch {
    return [workspaceId];
  }
}

export async function resolveGitCloneCredentials(input: {
  userId: string;
  workspaceId: string;
  remoteUrl: string;
}): Promise<GitCloneCredentials | null> {
  const remote = parseGitRemote(input.remoteUrl);
  if (!remote) return null;

  if (!getNangoSecretKey()) {
    console.warn(`[cloud-agent-box] NANGO_SECRET_KEY is not configured; ${remote.provider} clone will try without integration auth`);
    return null;
  }

  const candidates = await listGitCandidates({
    userId: input.userId,
    workspaceId: input.workspaceId,
    provider: remote.provider,
  });
  if (candidates.length === 0) return null;

  const client = getNangoClient() as unknown as NangoTokenClient;
  const failures: string[] = [];
  // Capture the provider config key of the stale/missing stored candidate so
  // the live re-resolution stays within the same GitHub integration.
  let missingConnectionConfigKey: string | null = null;
  for (const candidate of candidates) {
    try {
      if (!await candidateCanReadRepo({
        client,
        candidate,
        remote,
      })) {
        continue;
      }
      return {
        provider: remote.provider,
        username: remote.cloneUsername,
        token: await mintCandidateToken({ client, candidate, remote }),
      };
    } catch (error) {
      if (isMissingNangoConnectionError(error)) {
        missingConnectionConfigKey ??= resolveProviderConfigKey(candidate);
      }
      failures.push(describeCandidateFailure(candidate, error));
    }
  }

  // The stored connectionId for this workspace re-stales per fire (something
  // upstream keeps rotating it), so a stored candidate returning Nango's
  // missing/stale 400|404 is not terminal. Re-resolve the LIVE connection on
  // each warm by reusing the production clone worker's auto-heal
  // (selectRepoCapableConnection) instead of trusting the stored id.
  if (remote.provider === "github" && missingConnectionConfigKey) {
    const [owner, repo] = remote.repoLabel.split("/", 2);
    if (owner && repo) {
      // `selectRepoCapableConnection` matches same-tenant Nango connections by
      // their `end_user_id`/`workspaceId` tags. The production clone worker
      // scopes by the RELAY workspace id, and the live connection for these
      // workspaces is relay-ws-tagged — passing the APP workspace id (as the
      // first cut of this auto-heal did) filtered it out. Resolve the binding
      // and try the relay scope first, then the app scope, so we match
      // whichever id the connection was tagged with without regressing
      // app-ws-tagged (CLI-connected) tenants.
      const scopeIds = await resolveTenantScopeIds(input.workspaceId);
      let healed: Awaited<ReturnType<typeof selectRepoCapableConnection>> | null =
        null;
      for (const scopeId of scopeIds) {
        try {
          healed = await selectRepoCapableConnection({
            client: client as unknown as Parameters<
              typeof selectRepoCapableConnection
            >[0]["client"],
            providerConfigKey: missingConnectionConfigKey,
            relayfileWorkspaceId: scopeId,
            owner,
            repo,
          });
          break;
        } catch (healError) {
          failures.push(
            `auto-heal live re-resolution failed (scope ${scopeId}): ${
              healError instanceof Error ? healError.message : String(healError)
            }`,
          );
        }
      }

      if (healed) {
        const healedCandidate: GitCloneTokenCandidate = {
          source: "workspace_integrations",
          workspaceId: input.workspaceId,
          provider: "github",
          connectionId: healed.connectionId,
          providerConfigKey: healed.providerConfigKey,
          installationId: null,
        };
        const token = await mintCandidateToken({
          client,
          candidate: healedCandidate,
          remote,
        });
        console.warn(
          "[cloud-agent-box] git clone connection auto-healed via live re-resolution",
          {
            provider: remote.provider,
            repo: remote.repoLabel,
            healedConnectionId: healed.connectionId,
            healedProviderConfigKey: healed.providerConfigKey,
          },
        );
        return {
          provider: remote.provider,
          username: remote.cloneUsername,
          token,
        };
      }
    }
  }

  if (failures.length > 0) {
    console.warn("[cloud-agent-box] Git clone integration token candidates failed", {
      provider: remote.provider,
      repo: remote.repoLabel,
      failures: failures.slice(0, 3),
    });
    const hint = missingConnectionConfigKey
      ? " The GitHub connection is missing or stale in Nango and live re-resolution found no repo-capable connection; reconnect the GitHub integration for this workspace."
      : "";
    throw new Error(
      `${remote.provider} clone integration auth failed for ${remote.repoLabel}: ${failures[0]}${hint}`,
    );
  }
  return null;
}

export async function resolveGithubCloneToken(input: {
  userId: string;
  workspaceId: string;
  remoteUrl: string;
}): Promise<string | null> {
  const credentials = await resolveGitCloneCredentials(input);
  return credentials?.provider === "github" ? credentials.token : null;
}

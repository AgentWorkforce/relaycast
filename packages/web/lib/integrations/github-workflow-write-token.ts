import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { workspaces } from "@/lib/db/schema";
import {
  getNangoClient,
  getNangoSecretKey,
  getProviderConfigKey,
} from "./nango-runtime-client";
import { isWorkspaceIntegrationProvider } from "./providers";
import {
  listUserIntegrations,
  type UserIntegrationRecord,
} from "./user-integrations";
import {
  resolveGithubAuthShadow,
  type GithubAuthResolution,
} from "./github-auth-resolver";
import { isGithubInstallationCentricEnabled } from "./github-installation-centric-flag";
import { resolveGithubConnectionForWorkspace } from "./github-installation-connection";
import { resolveRepoAllowlistOrRelaxed } from "./workflow-repository-allowlists";
import {
  findWorkspaceGithubIntegrationByInstallation,
  listWorkspaceIntegrationsByProviderAlias,
  type WorkspaceIntegrationRecord,
} from "./workspace-integrations";

export type WorkflowGithubWriteTokenErrorCode =
  | "repo_push_not_allowed"
  | "integration_not_found"
  | "installation_token_failed"
  | "github_api_error";

export class WorkflowGithubWriteTokenError extends Error {
  readonly code: WorkflowGithubWriteTokenErrorCode;
  readonly status: number;
  readonly probeStatus?: number;
  readonly tokenPrefix?: string;
  readonly githubMessage?: string;

  constructor(
    code: WorkflowGithubWriteTokenErrorCode,
    message: string,
    status = 500,
    details: { probeStatus?: number; tokenPrefix?: string; githubMessage?: string } = {},
  ) {
    super(message);
    this.name = "WorkflowGithubWriteTokenError";
    this.code = code;
    this.status = status;
    this.probeStatus = details.probeStatus;
    this.tokenPrefix = details.tokenPrefix;
    this.githubMessage = details.githubMessage;
  }
}

type MintedWorkflowGithubToken = {
  token: string;
  installationId: string;
  /**
   * Nango's GitHub-App token mint path used here does not expose a
   * repository_ids downscope parameter in the current local integration
   * surface. The route still gates by trusted workflow slug, allowlist,
   * exact repo probe, and exact-repo sandbox usage, but the token itself may
   * be installation-scoped.
   */
  repositoryScoped: false;
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GITHUB_AUTH_RESOLVER_WORKFLOW_WRITE_ENABLED_ENV =
  "CLOUD_GITHUB_AUTH_RESOLVER_WORKFLOW_WRITE_ENABLED";

function truthyFlag(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "enabled";
}

export function isGithubAuthResolverWorkflowWriteEnabled(): boolean {
  return isGithubInstallationCentricEnabled() ||
    truthyFlag(process.env[GITHUB_AUTH_RESOLVER_WORKFLOW_WRITE_ENABLED_ENV]);
}

function repoEndpoint(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function readPayloadMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const message = (payload as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return fallback;
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
    const leftKey = resolveProviderConfigKey(left);
    const rightKey = resolveProviderConfigKey(right);
    const leftScore = leftKey === "github-relay" ? 0 : 1;
    const rightScore = rightKey === "github-relay" ? 0 : 1;
    return leftScore - rightScore;
  });
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

function describeCandidate(candidate: GithubIntegrationCandidate): Record<string, string | number | null> {
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

function describeGithubAuthResolution(result: GithubAuthResolution): Record<string, unknown> {
  if (result.ok) {
    return {
      ok: true,
      installationId: result.installationId,
      accountLogin: result.accountLogin,
      accountType: result.accountType,
      matchedBy: result.matchedBy,
      connectionId: result.connectionId,
      providerConfigKey: result.providerConfigKey,
    };
  }
  return {
    ok: false,
    reason: result.reason,
    tokenType: result.tokenType,
    authKind: result.authKind,
    candidates: result.candidates ?? [],
  };
}

function githubAuthResolutionToCandidate(
  workspaceId: string,
  result: GithubAuthResolution,
): GithubIntegrationCandidate | null {
  if (!result.ok || !result.connectionId) return null;
  return {
    source: "workspace_integrations",
    workspaceId,
    provider: "github",
    connectionId: result.connectionId,
    providerConfigKey: result.providerConfigKey,
    installationId: result.installationId,
  };
}

async function resolveGithubAuthResolverCandidateForWorkflowWrite(input: {
  workspaceIds: string[];
  repoOwner: string;
  repoName: string;
}): Promise<GithubIntegrationCandidate | null> {
  if (!isGithubAuthResolverWorkflowWriteEnabled()) return null;

  for (const workspaceId of input.workspaceIds) {
    let result: GithubAuthResolution;
    try {
      result = await resolveGithubAuthShadow({
        workspaceId,
        owner: input.repoOwner,
        repo: input.repoName,
        purpose: "workflow_write",
      });
    } catch (error) {
      console.warn("[workflows/github-write-token] GitHub auth resolver failed; falling back to probe loop", {
        workspaceId,
        repo: `${input.repoOwner}/${input.repoName}`,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const candidate = githubAuthResolutionToCandidate(workspaceId, result);
    if (candidate) {
      console.log("[workflows/github-write-token] GitHub auth resolver selected candidate", {
        workspaceId,
        repo: `${input.repoOwner}/${input.repoName}`,
        ...describeGithubAuthResolution(result),
      });
      return candidate;
    }

    console.warn("[workflows/github-write-token] GitHub auth resolver did not select candidate", {
      workspaceId,
      repo: `${input.repoOwner}/${input.repoName}`,
      ...describeGithubAuthResolution(result),
    });
  }

  return null;
}

function readProxyErrorStatus(error: unknown): number | null {
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

function readProxyErrorPayload(error: unknown): unknown {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  return (
    (record.response as Record<string, unknown> | undefined)?.data ??
    record.payload ??
    record.data ??
    null
  );
}

async function mintIntegrationToken(input: {
  integration: GithubIntegrationCandidate;
}): Promise<string> {
  if (!getNangoSecretKey()) {
    throw new WorkflowGithubWriteTokenError(
      "installation_token_failed",
      "NANGO_SECRET_KEY is not configured.",
      503,
    );
  }

  const providerConfigKey = resolveProviderConfigKey(input.integration);

  let rawToken: string | { access_token?: unknown; token?: unknown };
  try {
    rawToken = (await getNangoClient().getToken(
      providerConfigKey,
      input.integration.connectionId,
      false,
      true,
    )) as string | { access_token?: unknown; token?: unknown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkflowGithubWriteTokenError(
      "installation_token_failed",
      `Nango getToken failed: ${message}`,
      503,
    );
  }

  const token =
    typeof rawToken === "string"
      ? rawToken
      : typeof rawToken?.access_token === "string"
        ? rawToken.access_token
        : typeof rawToken?.token === "string"
          ? rawToken.token
          : null;
  if (!token) {
    throw new WorkflowGithubWriteTokenError(
      "installation_token_failed",
      "Nango getToken returned an unexpected GitHub App token shape.",
      503,
    );
  }

  return token;
}

async function resolveInstallationCandidate(input: {
  workspaceId: string;
  installationId: string;
}): Promise<GithubIntegrationCandidate> {
  if (isGithubInstallationCentricEnabled()) {
    const connection = await resolveGithubConnectionForWorkspace(input.workspaceId);
    if (connection?.installationId === input.installationId) {
      return {
        source: "workspace_integrations",
        workspaceId: input.workspaceId,
        provider: "github",
        connectionId: connection.connectionId,
        providerConfigKey: connection.providerConfigKey,
        installationId: connection.installationId,
      };
    }
    throw new WorkflowGithubWriteTokenError(
      "integration_not_found",
      `No GitHub installation connection in workspace ${input.workspaceId} owns installation ${input.installationId}.`,
      404,
    );
  }

  const integration = await findWorkspaceGithubIntegrationByInstallation(
    input.workspaceId,
    input.installationId,
  );
  if (!integration) {
    throw new WorkflowGithubWriteTokenError(
      "integration_not_found",
      `No GitHub integration in workspace ${input.workspaceId} owns installation ${input.installationId}.`,
      404,
    );
  }

  return toWorkspaceCandidate(input.workspaceId, integration);
}

async function probeRepoAccess(input: {
  integration: GithubIntegrationCandidate;
  repoOwner: string;
  repoName: string;
}): Promise<number> {
  const endpoint = repoEndpoint(input.repoOwner, input.repoName);
  const providerConfigKey = resolveProviderConfigKey(input.integration);
  try {
    const response = await getNangoClient().proxy({
      method: "GET",
      endpoint,
      connectionId: input.integration.connectionId,
      providerConfigKey,
    });
    const status = (response as { status?: unknown })?.status;
    return typeof status === "number" && Number.isFinite(status) ? status : 200;
  } catch (error) {
    const probeStatus = readProxyErrorStatus(error) ?? 503;
    const payload = readProxyErrorPayload(error);
    if (probeStatus === 403 || probeStatus === 404) {
      const githubMessage = readPayloadMessage(
        payload,
        `GitHub installation cannot access ${input.repoOwner}/${input.repoName}.`,
      );
      throw new WorkflowGithubWriteTokenError(
        "repo_push_not_allowed",
        githubMessage,
        403,
        { probeStatus, githubMessage },
      );
    }

    const githubMessage = readPayloadMessage(
      payload,
      `GitHub repo access probe returned status ${probeStatus}.`,
    );
    throw new WorkflowGithubWriteTokenError(
      "github_api_error",
      githubMessage,
      503,
      { probeStatus, githubMessage },
    );
  }
}

async function mintAndProbe(input: {
  workspaceId: string;
  installationId: string;
  repoOwner: string;
  repoName: string;
  fetchImpl: typeof fetch;
}): Promise<MintedWorkflowGithubToken> {
  const integration = await resolveInstallationCandidate({
    workspaceId: input.workspaceId,
    installationId: input.installationId,
  });
  const token = await mintIntegrationToken({ integration });
  await probeRepoAccess({
    integration,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
  });
  return {
    token,
    installationId: input.installationId,
    repositoryScoped: false,
  };
}

async function mintIntegrationAndProbe(input: {
  integration: GithubIntegrationCandidate;
  repoOwner: string;
  repoName: string;
  fetchImpl: typeof fetch;
}): Promise<MintedWorkflowGithubToken & { tokenPrefix: string }> {
  const token = await mintIntegrationToken({ integration: input.integration });
  const tokenPrefix = String(token).slice(0, 4);
  let probeStatus: number;
  try {
    probeStatus = await probeRepoAccess({
      integration: input.integration,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
    });
  } catch (error) {
    if (error instanceof WorkflowGithubWriteTokenError) {
      throw new WorkflowGithubWriteTokenError(
        error.code,
        error.message,
        error.status,
        {
          probeStatus: error.probeStatus,
          tokenPrefix,
          githubMessage: error.githubMessage,
        },
      );
    }
    throw error;
  }
  console.log("[workflows/github-write-token] GitHub write token candidate probe passed", {
    ...describeCandidate(input.integration),
    repo: `${input.repoOwner}/${input.repoName}`,
    probeStatus,
    tokenPrefix,
  });
  return {
    token,
    installationId: input.integration.installationId ?? "",
    repositoryScoped: false,
    tokenPrefix,
  };
}

export async function mintWorkflowGithubWriteToken(input: {
  userId: string;
  workspaceId: string;
  repoOwner: string;
  repoName: string;
  fetchImpl?: typeof fetch;
}): Promise<MintedWorkflowGithubToken> {
  const allow = await resolveRepoAllowlistOrRelaxed(
    input.workspaceId,
    input.repoOwner,
    input.repoName,
    { fetchImpl: input.fetchImpl },
  );
  if (!allow || !allow.pushAllowed) {
    throw new WorkflowGithubWriteTokenError(
      "repo_push_not_allowed",
      `Workflow GitHub write is not allowed for ${input.repoOwner}/${input.repoName}.`,
      403,
    );
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  if (allow.installationId) {
    return mintAndProbe({
      workspaceId: input.workspaceId,
      installationId: allow.installationId,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      fetchImpl,
    });
  }

  const integrationWorkspaceIds = await resolveGithubIntegrationWorkspaceIds(input.workspaceId);
  const resolverCandidate = await resolveGithubAuthResolverCandidateForWorkflowWrite({
    workspaceIds: integrationWorkspaceIds,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
  });
  if (resolverCandidate) {
    try {
      const minted = await mintIntegrationAndProbe({
        integration: resolverCandidate,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        fetchImpl,
      });
      console.log("[workflows/github-write-token] selected GitHub auth resolver candidate", {
        ...describeCandidate(resolverCandidate),
        repo: `${input.repoOwner}/${input.repoName}`,
        tokenPrefix: minted.tokenPrefix,
      });
      return {
        token: minted.token,
        installationId: minted.installationId,
        repositoryScoped: minted.repositoryScoped,
      };
    } catch (error) {
      if (error instanceof WorkflowGithubWriteTokenError) {
        console.warn("[workflows/github-write-token] GitHub auth resolver candidate failed; falling back to probe loop", {
          ...describeCandidate(resolverCandidate),
          repo: `${input.repoOwner}/${input.repoName}`,
          code: error.code,
          probeStatus: error.probeStatus ?? null,
          tokenPrefix: error.tokenPrefix ?? null,
          githubMessage: error.githubMessage ?? null,
          message: error.message,
        });
      } else {
        throw error;
      }
    }
  }

  const candidates = [
    ...await listUserGithubCandidates(input.userId),
    ...await listWorkspaceGithubCandidates(integrationWorkspaceIds),
  ];
  if (candidates.length === 0) {
    throw new WorkflowGithubWriteTokenError(
      "integration_not_found",
      `User ${input.userId} and workspaces ${integrationWorkspaceIds.join(", ")} have no GitHub integration connections.`,
      404,
    );
  }

  const failures: WorkflowGithubWriteTokenError[] = [];
  for (const candidate of candidates) {
    try {
      const minted = await mintIntegrationAndProbe({
        integration: candidate,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        fetchImpl,
      });
      console.log("[workflows/github-write-token] selected GitHub write token candidate", {
        ...describeCandidate(candidate),
        repo: `${input.repoOwner}/${input.repoName}`,
        tokenPrefix: minted.tokenPrefix,
      });
      return {
        token: minted.token,
        installationId: minted.installationId,
        repositoryScoped: minted.repositoryScoped,
      };
    } catch (error) {
      if (error instanceof WorkflowGithubWriteTokenError) {
        console.warn("[workflows/github-write-token] GitHub write token candidate failed", {
          ...describeCandidate(candidate),
          repo: `${input.repoOwner}/${input.repoName}`,
          code: error.code,
          probeStatus: error.probeStatus ?? null,
          tokenPrefix: error.tokenPrefix ?? null,
          githubMessage: error.githubMessage ?? null,
          message: error.message,
        });
        failures.push(error);
        continue;
      }
      throw error;
    }
  }

  const configFailure = failures.find(
    (failure) =>
      failure.code === "installation_token_failed" ||
      failure.code === "integration_not_found" ||
      failure.code === "github_api_error",
  );
  const surfaced = configFailure ?? failures[failures.length - 1];
  throw surfaced ?? new WorkflowGithubWriteTokenError(
    "repo_push_not_allowed",
    `No GitHub installation can access ${input.repoOwner}/${input.repoName}.`,
    403,
  );
}

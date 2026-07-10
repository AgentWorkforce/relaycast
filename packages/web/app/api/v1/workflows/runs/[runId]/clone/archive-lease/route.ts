import { NextRequest, NextResponse } from "next/server";
import {
  canAccessWorkflowRun,
  requireAuthScope,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import { workflowStore } from "@/lib/workflows";
import {
  GithubArchiveLeaseError,
  mintGithubArchiveCodeloadUrl,
  resolveGithubRefToSha,
} from "@/lib/integrations/github-archive-lease";
import {
  getNangoClient,
  getNangoSecretKey,
  getProviderConfigKey,
} from "@/lib/integrations/nango-service";
import { isWorkspaceIntegrationProvider } from "@/lib/integrations/providers";
import {
  listWorkspaceIntegrationsByProviderAlias,
  type WorkspaceIntegrationRecord,
} from "@/lib/integrations/workspace-integrations";
import { isGithubInstallationCentricEnabled } from "@/lib/integrations/github-installation-centric-flag";
import { resolveGithubConnectionForWorkspace } from "@/lib/integrations/github-installation-connection";

type RunContext = { params: Promise<{ runId: string }> | { runId: string } };

function jsonError(
  error: string,
  status: number,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(JSON.stringify({ ok: false, error, ...extra }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function readNonEmpty(body: unknown, key: string): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hasOwnBodyField(body: unknown, key: string): boolean {
  return (
    !!body &&
    typeof body === "object" &&
    Object.prototype.hasOwnProperty.call(body, key)
  );
}

function readOptionalRef(body: unknown): string | null {
  if (!hasOwnBodyField(body, "ref")) return "HEAD";
  return readNonEmpty(body, "ref");
}

class GithubInstallationTokenResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubInstallationTokenResolveError";
  }
}

type NangoGithubTokenClient = {
  getToken(
    providerConfigKey: string,
    connectionId: string,
    forceRefresh?: boolean,
    refreshGithubAppJwtToken?: boolean,
  ): Promise<unknown>;
  proxy(config: Record<string, unknown>): Promise<{ status?: unknown }>;
};

function resolveProviderConfigKey(
  integration: Pick<
    WorkspaceIntegrationRecord,
    "provider" | "providerConfigKey"
  >,
): string {
  return (
    integration.providerConfigKey ??
    (isWorkspaceIntegrationProvider(integration.provider)
      ? getProviderConfigKey(integration.provider)
      : integration.provider)
  );
}

function readNangoToken(rawToken: unknown): string | null {
  if (typeof rawToken === "string") return rawToken || null;
  if (!rawToken || typeof rawToken !== "object") return null;
  const tokenRecord = rawToken as Record<string, unknown>;
  if (typeof tokenRecord.access_token === "string") {
    return tokenRecord.access_token || null;
  }
  if (typeof tokenRecord.token === "string") {
    return tokenRecord.token || null;
  }
  return null;
}

function githubRepoEndpoint(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
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

async function integrationCanReadRepo(input: {
  client: NangoGithubTokenClient;
  integration: Pick<WorkspaceIntegrationRecord, "connectionId">;
  providerConfigKey: string;
  owner: string;
  repo: string;
}): Promise<boolean> {
  try {
    const response = await input.client.proxy({
      method: "GET",
      endpoint: githubRepoEndpoint(input.owner, input.repo),
      connectionId: input.integration.connectionId,
      providerConfigKey: input.providerConfigKey,
    });
    const status = typeof response.status === "number" ? response.status : 200;
    if (status >= 200 && status < 300) return true;
    if (status === 403 || status === 404) return false;
    throw new GithubInstallationTokenResolveError(
      `GitHub repo access probe failed with status ${status}.`,
    );
  } catch (error) {
    const status = readStatus(error);
    if (status === 403 || status === 404) return false;
    throw error;
  }
}

async function resolveInstallationToken(input: {
  workspaceId: string;
  owner: string;
  repo: string;
}): Promise<string> {
  if (!getNangoSecretKey()) {
    throw new GithubInstallationTokenResolveError(
      "NANGO_SECRET_KEY is not configured.",
    );
  }

  if (isGithubInstallationCentricEnabled()) {
    const connection = await resolveGithubConnectionForWorkspace(input.workspaceId);
    if (!connection) {
      throw new GithubInstallationTokenResolveError(
        `No GitHub installation connection resolved for workspace ${input.workspaceId}.`,
      );
    }
    const client = getNangoClient() as unknown as NangoGithubTokenClient;
    const integration = {
      workspaceId: input.workspaceId,
      provider: "github",
      connectionId: connection.connectionId,
      providerConfigKey: connection.providerConfigKey,
    };
    const canReadRepo = await integrationCanReadRepo({
      client,
      integration,
      providerConfigKey: connection.providerConfigKey,
      owner: input.owner,
      repo: input.repo,
    });
    if (!canReadRepo) {
      throw new GithubInstallationTokenResolveError(
        `No GitHub installation connection can read ${input.owner}/${input.repo}.`,
      );
    }
    const rawToken = await client.getToken(
      connection.providerConfigKey,
      connection.connectionId,
      false,
      true,
    );
    const token = readNangoToken(rawToken);
    if (token) return token;
    throw new GithubInstallationTokenResolveError(
      "Nango getToken returned an unexpected GitHub App token shape.",
    );
  }

  const integrations = await listWorkspaceIntegrationsByProviderAlias(
    input.workspaceId,
    "github",
  );
  if (integrations.length === 0) {
    throw new GithubInstallationTokenResolveError(
      `No GitHub integration in workspace ${input.workspaceId}.`,
    );
  }

  const ranked = [...integrations].sort((left, right) => {
    const leftKey = resolveProviderConfigKey(left);
    const rightKey = resolveProviderConfigKey(right);
    const leftScore = leftKey === "github-relay" ? 0 : 1;
    const rightScore = rightKey === "github-relay" ? 0 : 1;
    return leftScore - rightScore;
  });

  let lastError: unknown = null;
  let inaccessibleCandidates = 0;
  const client = getNangoClient() as unknown as NangoGithubTokenClient;
  for (const integration of ranked) {
    const providerConfigKey = resolveProviderConfigKey(integration);
    try {
      const canReadRepo = await integrationCanReadRepo({
        client,
        integration,
        providerConfigKey,
        owner: input.owner,
        repo: input.repo,
      });
      if (!canReadRepo) {
        inaccessibleCandidates += 1;
        continue;
      }

      const rawToken = await client.getToken(
        providerConfigKey,
        integration.connectionId,
        false,
        true,
      );
      const token = readNangoToken(rawToken);
      if (token) return token;
      lastError = new GithubInstallationTokenResolveError(
        "Nango getToken returned an unexpected GitHub App token shape.",
      );
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) {
    throw new GithubInstallationTokenResolveError(
      `Nango getToken failed for ${input.owner}/${input.repo}: ${lastError.message}`,
    );
  }
  if (inaccessibleCandidates > 0) {
    throw new GithubInstallationTokenResolveError(
      `No GitHub workspace integration can read ${input.owner}/${input.repo}.`,
    );
  }
  throw new GithubInstallationTokenResolveError(
    `Nango getToken failed for ${input.owner}/${input.repo}.`,
  );
}

export async function POST(
  request: NextRequest,
  context: RunContext,
): Promise<Response> {
  const auth = await resolveRequestAuth(request);
  if (!auth) return jsonError("unauthorized", 401);
  if (!requireAuthScope(auth, "workflow:runs:read")) {
    return jsonError("forbidden", 403);
  }

  const { runId } = await context.params;
  if (!runId) return jsonError("run_not_found", 404);

  const run = await workflowStore.get(runId);
  if (!run) return jsonError("run_not_found", 404);
  if (!canAccessWorkflowRun(auth, run)) {
    return jsonError("run_not_found", 404);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid_body", 400);
  }
  const owner = readNonEmpty(body, "owner");
  const repo = readNonEmpty(body, "repo");
  const hasHeadSha = hasOwnBodyField(body, "headSha");
  const hasRef = hasOwnBodyField(body, "ref");
  const headSha = readNonEmpty(body, "headSha");
  const ref = headSha ? null : readOptionalRef(body);
  if (
    !owner ||
    !repo ||
    (!headSha && hasHeadSha && !hasRef) ||
    (!headSha && !ref)
  ) {
    return jsonError("invalid_body", 400);
  }

  let installationToken: string;
  try {
    installationToken = await resolveInstallationToken({
      workspaceId: run.workspaceId,
      owner,
      repo,
    });
  } catch (error) {
    console.warn("[clone-archive-lease] install-token resolve failed", {
      runId,
      workspaceId: run.workspaceId,
      owner,
      repo,
      message: error instanceof Error ? error.message : String(error),
    });
    return jsonError("github_token_unavailable", 502, {
      stage: "github_app_token_resolve",
    });
  }
  if (!installationToken) {
    return jsonError("github_token_unavailable", 502, {
      stage: "github_app_token_resolve",
    });
  }

  let resolvedHeadSha = headSha;
  if (!resolvedHeadSha && ref) {
    try {
      resolvedHeadSha = await resolveGithubRefToSha({
        owner,
        repo,
        ref,
        installationToken,
      });
    } catch (error) {
      if (error instanceof GithubArchiveLeaseError) {
        return jsonError("ref_resolve_failed", 502, {
          stage: error.stage,
          ...(typeof error.upstreamStatus === "number"
            ? { status: error.upstreamStatus }
            : {}),
        });
      }
      console.warn("[clone-archive-lease] ref resolve failed", {
        runId,
        workspaceId: run.workspaceId,
        owner,
        repo,
        ref,
        message: error instanceof Error ? error.message : String(error),
      });
      return jsonError("ref_resolve_failed", 502, {
        stage: "ref_resolve_failed",
      });
    }
  }
  if (!resolvedHeadSha) return jsonError("invalid_body", 400);

  try {
    const lease = await mintGithubArchiveCodeloadUrl({
      owner,
      repo,
      headSha: resolvedHeadSha,
      installationToken,
    });
    return NextResponse.json({ ok: true, ...lease }, { status: 200 });
  } catch (error) {
    if (error instanceof GithubArchiveLeaseError) {
      return jsonError("archive_lease_mint_failed", 502, {
        stage: error.stage,
        ...(typeof error.upstreamStatus === "number"
          ? { status: error.upstreamStatus }
          : {}),
      });
    }
    console.error("[clone-archive-lease] mint failed", {
      runId,
      workspaceId: run.workspaceId,
      owner,
      repo,
      headSha: resolvedHeadSha,
      message: error instanceof Error ? error.message : String(error),
    });
    return jsonError("archive_lease_mint_failed", 502, {
      stage: "github_tarball_redirect",
    });
  }
}

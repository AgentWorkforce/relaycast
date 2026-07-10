import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { optionalEnv } from "@/lib/env";
import { createWorkflowStorageS3Client, readWorkflowStorageBucket } from "@/lib/storage";
import type {
  PathSubmission,
  WorkflowPathPushResult,
  WorkflowRecord,
} from "@/lib/workflows";
import {
  findWorkspaceGithubIntegrationByInstallation,
  getWorkspaceIntegrationByProviderAlias,
  listWorkspaceIntegrationsByProviderAlias,
  type WorkspaceIntegrationRecord,
} from "./workspace-integrations";
import {
  listUserIntegrations,
  type UserIntegrationRecord,
} from "./user-integrations";
import { getNangoClient, getNangoSecretKey, getProviderConfigKey } from "./nango-service";
import { isWorkspaceIntegrationProvider } from "./providers";
import type { WorkflowRepositoryAllowlistRecord } from "./workflow-repository-allowlists";
import {
  commitPatch,
  sanitizeText,
  type GitHubCommitPatchOperation,
  type GitHubCommitPatchStrategy,
} from "./relayfile-writeback-bridge";

type PushFailureCode =
  | "base_branch_moved"
  | "patch_too_large"
  | "patch_unapplyable"
  | "integration_not_found"
  | "installation_token_failed"
  | "github_api_error";

type BaseRef = {
  branch: string;
  sha: string;
};

type PatchReadResult = {
  patch: string;
  hasChanges: boolean;
  s3Key: string;
};

type GitHubJsonResult<T = Record<string, unknown>> = {
  status: number;
  data: T | null;
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

type ParsedHunkLine = {
  kind: "context" | "add" | "remove";
  text: string;
  /**
   * Set when the diff parser saw a `\ No newline at end of file` marker
   * immediately after this line — meaning the (added or context) line is
   * the final line of the new file and the file does not end with a
   * trailing newline. `applyHunks` honours this so the pushed PR content
   * matches what the agent produced (otherwise we silently re-add a
   * trailing newline and the GitHub blob diverges from the sandbox).
   */
  noTrailingNewline?: boolean;
};

type ParsedHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ParsedHunkLine[];
};

type ParsedFilePatch = {
  oldPath: string | null;
  newPath: string | null;
  renameFrom?: string;
  renameTo?: string;
  binary: boolean;
  hunks: ParsedHunk[];
};

export class PushBackError extends Error {
  readonly code: PushFailureCode;
  readonly base?: BaseRef;
  readonly observedBaseSha?: string;
  readonly probeStatus?: number;
  readonly tokenPrefix?: string;
  readonly githubMessage?: string;

  constructor(
    code: PushFailureCode,
    message: string,
    details: {
      base?: BaseRef;
      observedBaseSha?: string;
      probeStatus?: number;
      tokenPrefix?: string;
      githubMessage?: string;
    } = {},
  ) {
    super(message);
    this.name = "PushBackError";
    this.code = code;
    this.base = details.base;
    this.observedBaseSha = details.observedBaseSha;
    this.probeStatus = details.probeStatus;
    this.tokenPrefix = details.tokenPrefix;
    this.githubMessage = details.githubMessage;
  }
}

function failedResult(
  code: PushFailureCode,
  message: string,
  details: { base?: BaseRef; observedBaseSha?: string } = {},
): WorkflowPathPushResult {
  return {
    status: "failed",
    code,
    message: sanitizeText(message),
    ...(details.base ? { base: details.base } : {}),
    ...(details.observedBaseSha ? { observedBaseSha: details.observedBaseSha } : {}),
    failedAt: new Date().toISOString(),
  };
}

function failureFromUnknown(error: unknown): WorkflowPathPushResult {
  if (error instanceof PushBackError) {
    return failedResult(error.code, error.message, {
      base: error.base,
      observedBaseSha: error.observedBaseSha,
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/too large|large file|size limit|413/i.test(message)) {
    return failedResult("patch_too_large", message);
  }
  if (/patch|hunk|diff|unapply/i.test(message)) {
    return failedResult("patch_unapplyable", message);
  }
  return failedResult("github_api_error", message);
}

function getGitHubApiBaseUrl(): string {
  return (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
}

function encodePathSegments(value: string): string {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function gitRefEndpoint(owner: string, repo: string, branch: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodePathSegments(branch)}`;
}

function repoEndpoint(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

async function readResponsePayload(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPayloadMessage(payload: unknown, fallback: string): string {
  if (typeof payload === "string" && payload.trim().length > 0) {
    return sanitizeText(payload.trim());
  }
  if (isRecord(payload)) {
    if (typeof payload.message === "string" && payload.message.trim().length > 0) {
      return sanitizeText(payload.message.trim());
    }
    if (typeof payload.error === "string" && payload.error.trim().length > 0) {
      return sanitizeText(payload.error.trim());
    }
  }
  return fallback;
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
  if (isRecord(error.response) && "data" in error.response) return error.response.data;
  if ("payload" in error) return error.payload;
  if ("data" in error) return error.data;
  return null;
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

function resolveGithubIntegrationWorkspaceIds(input: {
  workspaceId: string;
  relayWorkspaceId?: string;
}): string[] {
  const relayWorkspaceId = input.relayWorkspaceId?.trim() ?? "";
  if (relayWorkspaceId && relayWorkspaceId !== input.workspaceId) {
    return [relayWorkspaceId, input.workspaceId];
  }
  return [input.workspaceId];
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

async function githubJson<T = Record<string, unknown>>(input: {
  token: string;
  method: string;
  endpoint: string;
  data?: unknown;
  fetchImpl?: typeof fetch;
}): Promise<GitHubJsonResult<T>> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`${getGitHubApiBaseUrl()}${input.endpoint}`, {
    method: input.method,
    headers: {
      Authorization: `Bearer ${input.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: input.data === undefined ? undefined : JSON.stringify(input.data),
    cache: "no-store",
  });
  const payload = await readResponsePayload(response);
  if (!response.ok) {
    throw new PushBackError(
      "github_api_error",
      readPayloadMessage(payload, `GitHub API ${input.endpoint} failed with status ${response.status}`),
    );
  }
  return { status: response.status, data: payload as T | null };
}

async function mintIntegrationToken(input: {
  integration: GithubIntegrationCandidate;
}): Promise<string> {
  // Fast-fail with a typed PushBackError when the Nango secret isn't
  // configured. `getNangoClient()` would throw a generic Error too,
  // but callers (resolver, push-back loop) discriminate on
  // PushBackError.code to surface the right operator-actionable
  // message in pushedTo and in the boot/access logs.
  if (!getNangoSecretKey()) {
    throw new PushBackError("installation_token_failed", "NANGO_SECRET_KEY is not configured.");
  }

  // Use Nango's `getToken` with `refreshGithubAppJwtToken=true`. For
  // GitHub App connections Nango stores the App credentials and mints
  // the installation token itself; this is the supported way to ask
  // for it. Proxying `POST /app/installations/<id>/access_tokens`
  // through `nango.post(...)` returns 401 because Nango's proxy does
  // not auto-attach the App-level JWT for that path — it only
  // forwards installation-token (or OAuth) auth, which is exactly the
  // thing we're trying to mint. Same pattern as the github-clone
  // worker (packages/core/src/clone/github-clone-production.ts).
  const providerConfigKey = resolveProviderConfigKey(input.integration);

  let rawToken: string | { access_token?: unknown; token?: unknown };
  try {
    rawToken = (await getNangoClient().getToken(
      providerConfigKey,
      input.integration.connectionId,
      false,
      true,
    )) as string | { access_token?: unknown; token?: unknown };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PushBackError("installation_token_failed", `Nango getToken failed: ${message}`);
  }

  const token =
    typeof rawToken === "string"
      ? rawToken
      : typeof rawToken?.access_token === "string"
        ? rawToken.access_token
        : typeof rawToken?.token === "string"
          ? rawToken.token
          : null;
  if (typeof token !== "string" || token.length === 0) {
    throw new PushBackError(
      "installation_token_failed",
      "Nango getToken returned an unexpected GitHub App token shape.",
    );
  }
  return token;
}

async function mintInstallationToken(input: {
  workspaceId: string;
  installationId: string;
}): Promise<string> {
  // Route by `(workspaceId, installationId)` directly so that
  // workspaces with multiple GitHub Apps connected (e.g. both
  // `github` and `github-ricky` provider rows) always use the Nango
  // connection that actually owns the installation token we're about
  // to mint.
  const integration = await findWorkspaceGithubIntegrationByInstallation(
    input.workspaceId,
    input.installationId,
  );
  if (!integration) {
    throw new PushBackError(
      "integration_not_found",
      `No GitHub integration in workspace ${input.workspaceId} owns installation ${input.installationId}`,
    );
  }

  return mintIntegrationToken({
    integration: toWorkspaceCandidate(input.workspaceId, integration),
  });
}

/**
 * Lightweight access probe used by the relaxed allowlist path
 * (`resolveRepoAllowlistOrRelaxed`) to confirm that the workspace's
 * GitHub App installation can actually reach a specific repo. A
 * workspace integration row guarantees the App is installed, but
 * installs scoped to "selected repositories" (instead of "all
 * repositories") may not include the path the workflow is asking for.
 *
 * Failure-mode contract:
 *   - returns `true`  (HTTP 200) — install can read the repo.
 *   - returns `false` (HTTP 404 / 403) — install genuinely cannot
 *     reach this repo. Logged with a status-specific hint.
 *   - throws `PushBackError` for everything else, including:
 *       • token mint failure (NANGO_SECRET_KEY missing, install
 *         revoked, Nango proxy 4xx/5xx). Previously this was caught
 *         silently and returned `false` — an entire production
 *         workspace's push-back loop went dark for >24h because the
 *         lambda was missing the Nango secret binding and the
 *         exception got swallowed. Config errors must surface, not
 *         masquerade as "App can't reach repo".
 *       • transient 5xx / rate-limit / network blip — surface so the
 *         caller can persist `pushedTo.{name}.status='failed'` with
 *         a real reason rather than silently skipping.
 *
 * Callers (resolver, run/route, callback/route) already wrap this in
 * try/catch and persist a `failedPushResult({ code, message })` —
 * any error here lands in the run record's `pushedTo` map with full
 * context.
 */
export async function installationCanAccessRepo(input: {
  workspaceId: string;
  installationId: string;
  repoOwner: string;
  repoName: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  // Intentionally NOT wrapping in try/catch: token mint failures are
  // PushBackError instances with codes like `installation_token_failed`
  // that callers already know how to record. Swallowing here was the
  // class of bug that hid prod misconfiguration for a full day.
  const token = await mintInstallationToken({
    workspaceId: input.workspaceId,
    installationId: input.installationId,
  });

  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${getGitHubApiBaseUrl()}${repoEndpoint(input.repoOwner, input.repoName)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    },
  );
  if (response.status === 200) return true;
  if (response.status === 404 || response.status === 403) {
    console.warn(`[allowlist] access probe ${response.status} — install ${input.installationId} cannot reach ${input.repoOwner}/${input.repoName}`, {
      workspaceId: input.workspaceId,
      installationId: input.installationId,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      status: response.status,
      hint:
        response.status === 404
          ? "GitHub returned 404. The install's repo list does not include this repo (selected-repositories install, or 'all repos' install whose accessible-repos list has not refreshed since this repo was created). Re-save the App's org-level install settings or open the App page on the repo to refresh."
          : "GitHub returned 403. The install reached the repo but lacks permission to read it — check the App's repository permissions (contents:read at minimum).",
    });
    return false;
  }

  throw new PushBackError(
    "github_api_error",
    `GitHub repo access probe ${input.repoOwner}/${input.repoName} returned status ${response.status}`,
  );
}

async function probeIntegrationCanAccessRepo(input: {
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
    const githubMessage = readPayloadMessage(
      payload,
      `GitHub repo access probe ${input.repoOwner}/${input.repoName} returned status ${probeStatus}`,
    );

    throw new PushBackError(
      "github_api_error",
      githubMessage,
      { probeStatus, githubMessage },
    );
  }
}

/**
 * Cache keyed by `${owner}/${repo}` (lowercased) to avoid refetching
 * `/repos/{owner}/{repo}` once per path within a single push-back
 * invocation. Repos with non-`main` defaults (e.g. `master`) only need
 * one round-trip even when several paths target the same repo.
 */
export type DefaultBranchCache = Map<string, string>;

export async function resolveDefaultBranch(input: {
  installToken: string;
  owner: string;
  repo: string;
  cache?: DefaultBranchCache;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const key = `${input.owner.toLowerCase()}/${input.repo.toLowerCase()}`;
  const cached = input.cache?.get(key);
  if (cached) return cached;

  const repoPayload = await githubJson<Record<string, unknown>>({
    token: input.installToken,
    method: "GET",
    endpoint: repoEndpoint(input.owner, input.repo),
    fetchImpl: input.fetchImpl,
  });
  const branch = typeof repoPayload.data?.default_branch === "string" ? repoPayload.data.default_branch : "";
  if (!branch) {
    throw new PushBackError("github_api_error", "GitHub repository response did not include default_branch.");
  }
  input.cache?.set(key, branch);
  return branch;
}

async function resolveBaseRef(input: {
  owner: string;
  repo: string;
  pushBase?: string;
  token: string;
  defaultBranchCache?: DefaultBranchCache;
  fetchImpl?: typeof fetch;
}): Promise<BaseRef> {
  let branch = input.pushBase?.trim();
  if (!branch) {
    branch = await resolveDefaultBranch({
      installToken: input.token,
      owner: input.owner,
      repo: input.repo,
      cache: input.defaultBranchCache,
      fetchImpl: input.fetchImpl,
    });
  }

  const refPayload = await githubJson<Record<string, unknown>>({
    token: input.token,
    method: "GET",
    endpoint: gitRefEndpoint(input.owner, input.repo, branch),
    fetchImpl: input.fetchImpl,
  });
  const object = isRecord(refPayload.data?.object) ? refPayload.data.object : null;
  const sha = typeof object?.sha === "string" ? object.sha : null;
  if (!sha) {
    throw new PushBackError("github_api_error", `GitHub ref heads/${branch} did not return object.sha.`);
  }
  return { branch, sha };
}

async function createBranch(input: {
  owner: string;
  repo: string;
  branch: string;
  baseSha: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  await githubJson({
    token: input.token,
    method: "POST",
    endpoint: `${repoEndpoint(input.owner, input.repo)}/git/refs`,
    data: {
      ref: `refs/heads/${input.branch}`,
      sha: input.baseSha,
    },
    fetchImpl: input.fetchImpl,
  });
}

async function readFileContentAtRef(input: {
  owner: string;
  repo: string;
  path: string;
  ref: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const contents = await githubJson<Record<string, unknown>>({
    token: input.token,
    method: "GET",
    endpoint: `${repoEndpoint(input.owner, input.repo)}/contents/${encodePathSegments(input.path)}?ref=${encodeURIComponent(input.ref)}`,
    fetchImpl: input.fetchImpl,
  });
  const encoding = typeof contents.data?.encoding === "string" ? contents.data.encoding : null;
  const rawContent = typeof contents.data?.content === "string" ? contents.data.content : null;
  if (encoding === "base64" && rawContent) {
    return Buffer.from(rawContent.replace(/\s/g, ""), "base64").toString("utf8");
  }

  const blobSha = typeof contents.data?.sha === "string" ? contents.data.sha : null;
  if (!blobSha) {
    throw new PushBackError("patch_unapplyable", `GitHub contents response for ${input.path} did not include content or sha.`);
  }

  const blob = await githubJson<Record<string, unknown>>({
    token: input.token,
    method: "GET",
    endpoint: `${repoEndpoint(input.owner, input.repo)}/git/blobs/${encodeURIComponent(blobSha)}`,
    fetchImpl: input.fetchImpl,
  });
  if (blob.data?.encoding !== "base64" || typeof blob.data.content !== "string") {
    throw new PushBackError("patch_unapplyable", `GitHub blob response for ${input.path} did not include base64 content.`);
  }
  return Buffer.from(blob.data.content.replace(/\s/g, ""), "base64").toString("utf8");
}

async function openPullRequest(input: {
  owner: string;
  repo: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const pr = await githubJson<Record<string, unknown>>({
    token: input.token,
    method: "POST",
    endpoint: `${repoEndpoint(input.owner, input.repo)}/pulls`,
    data: {
      title: input.title,
      head: input.branch,
      base: input.baseBranch,
      body: input.body,
    },
    fetchImpl: input.fetchImpl,
  });

  const url = typeof pr.data?.html_url === "string" ? pr.data.html_url : null;
  if (!url) {
    throw new PushBackError("github_api_error", "GitHub pull request response did not include html_url.");
  }
  return url;
}

function normalizeDiffPath(rawPath: string): string | null {
  const raw = rawPath.trim();
  if (raw === "/dev/null") return null;
  let value = raw;
  if (value.startsWith("\"") && value.endsWith("\"")) {
    value = value.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  return value.replace(/^[ab]\//, "");
}

function parseDiffHeaderPaths(line: string): { oldPath: string | null; newPath: string | null } {
  const match = line.match(/^diff --git (.+) (.+)$/);
  if (!match) return { oldPath: null, newPath: null };
  return {
    oldPath: normalizeDiffPath(match[1] ?? ""),
    newPath: normalizeDiffPath(match[2] ?? ""),
  };
}

export function parseUnifiedDiff(patch: string): ParsedFilePatch[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const files: ParsedFilePatch[] = [];
  let current: ParsedFilePatch | null = null;

  const flush = () => {
    if (current) {
      files.push(current);
      current = null;
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("diff --git ")) {
      flush();
      const paths = parseDiffHeaderPaths(line);
      current = {
        oldPath: paths.oldPath,
        newPath: paths.newPath,
        binary: false,
        hunks: [],
      };
      continue;
    }
    if (!current) continue;

    if (line.startsWith("rename from ")) {
      current.renameFrom = line.slice("rename from ".length);
      current.oldPath = current.renameFrom;
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.renameTo = line.slice("rename to ".length);
      current.newPath = current.renameTo;
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      current.binary = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      current.oldPath = normalizeDiffPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      current.newPath = normalizeDiffPath(line.slice(4));
      continue;
    }
    if (!line.startsWith("@@ ")) {
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!hunkMatch) {
      throw new PushBackError("patch_unapplyable", `Could not parse hunk header: ${line}`);
    }
    const hunk: ParsedHunk = {
      oldStart: Number.parseInt(hunkMatch[1] ?? "0", 10),
      oldCount: Number.parseInt(hunkMatch[2] ?? "1", 10),
      newStart: Number.parseInt(hunkMatch[3] ?? "0", 10),
      newCount: Number.parseInt(hunkMatch[4] ?? "1", 10),
      lines: [],
    };

    index += 1;
    for (; index < lines.length; index += 1) {
      const hunkLine = lines[index] ?? "";
      if (hunkLine.startsWith("diff --git ") || hunkLine.startsWith("@@ ")) {
        index -= 1;
        break;
      }
      if (hunkLine.startsWith("\\ No newline at end of file")) {
        // Mark the preceding non-remove line as terminating without a
        // trailing newline. `remove` lines are eligible too because in a
        // file deletion case the last existing line had no newline; we only
        // care about output lines (add/context) when emitting, but tagging
        // the marker on whatever the immediately preceding line is keeps
        // the parse loop simple. `applyHunks` only consults the flag on
        // add/context output anyway.
        const last = hunk.lines[hunk.lines.length - 1];
        if (last) {
          last.noTrailingNewline = true;
        }
        continue;
      }
      const marker = hunkLine[0];
      const text = hunkLine.slice(1);
      if (marker === " ") {
        hunk.lines.push({ kind: "context", text });
      } else if (marker === "+") {
        hunk.lines.push({ kind: "add", text });
      } else if (marker === "-") {
        hunk.lines.push({ kind: "remove", text });
      } else if (hunkLine.length > 0) {
        throw new PushBackError("patch_unapplyable", `Could not parse hunk line: ${hunkLine}`);
      }
    }
    current.hunks.push(hunk);
  }
  flush();
  return files;
}

function splitContentLines(content: string): { lines: string[]; trailingNewline: boolean } {
  if (content.length === 0) {
    return { lines: [], trailingNewline: false };
  }
  const trailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (trailingNewline) {
    lines.pop();
  }
  return { lines, trailingNewline };
}

function joinContentLines(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) {
    return trailingNewline ? "\n" : "";
  }
  return `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
}

export function applyHunks(baseContent: string, hunks: ParsedHunk[]): string {
  const parsed = splitContentLines(baseContent);
  const output: string[] = [];
  let cursor = 0;
  let trailingNewline = parsed.trailingNewline;

  for (const hunk of hunks) {
    const oldIndex = Math.max(0, hunk.oldStart - 1);
    if (oldIndex < cursor) {
      throw new PushBackError("patch_unapplyable", `Hunk overlaps a previous hunk at line ${hunk.oldStart}.`);
    }

    output.push(...parsed.lines.slice(cursor, oldIndex));
    cursor = oldIndex;

    for (const line of hunk.lines) {
      if (line.kind === "add") {
        output.push(line.text);
        // The newline flag is only meaningful on the LAST emitted line of
        // the new file. Set based on whether the diff carried a `\ No
        // newline at end of file` marker on this add line; otherwise the
        // line ends with a newline (the default).
        trailingNewline = !line.noTrailingNewline;
        continue;
      }

      const actual = parsed.lines[cursor];
      if (actual !== line.text) {
        throw new PushBackError(
          "patch_unapplyable",
          `Patch hunk did not match at line ${cursor + 1}.`,
        );
      }

      if (line.kind === "context") {
        output.push(actual);
        // A context line preserved at the end inherits the same flag —
        // again, only the final emitted line's flag matters.
        trailingNewline = !line.noTrailingNewline;
      }
      cursor += 1;
    }
  }

  // Tail of unchanged lines after the last hunk: their newline-ness
  // matches the base file's.
  if (cursor < parsed.lines.length) {
    output.push(...parsed.lines.slice(cursor));
    trailingNewline = parsed.trailingNewline;
  }
  return joinContentLines(output, trailingNewline);
}

async function buildCommitOperations(input: {
  owner: string;
  repo: string;
  patch: string;
  baseSha: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<GitHubCommitPatchOperation[]> {
  const parsedFiles = parseUnifiedDiff(input.patch);
  const operations: GitHubCommitPatchOperation[] = [];

  for (const file of parsedFiles) {
    if (file.binary) {
      throw new PushBackError("patch_unapplyable", "Binary patch data is not present in git diff output.");
    }

    const oldPath = file.renameFrom ?? file.oldPath;
    const newPath = file.renameTo ?? file.newPath;
    if (!oldPath && !newPath) {
      continue;
    }

    if (!newPath) {
      if (!oldPath) continue;
      operations.push({ kind: "delete", path: oldPath });
      continue;
    }

    if (oldPath === null) {
      operations.push({
        kind: "upsert",
        path: newPath,
        content: applyHunks("", file.hunks),
      });
      continue;
    }

    const renamed = oldPath !== newPath;
    if (!renamed && file.hunks.length === 0) {
      continue;
    }

    const baseContent = await readFileContentAtRef({
      owner: input.owner,
      repo: input.repo,
      path: oldPath,
      ref: input.baseSha,
      token: input.token,
      fetchImpl: input.fetchImpl,
    });
    operations.push({
      kind: "upsert",
      path: newPath,
      content: file.hunks.length > 0 ? applyHunks(baseContent, file.hunks) : baseContent,
      ...(renamed ? { previousPath: oldPath } : {}),
    });
  }

  if (operations.length === 0) {
    throw new PushBackError("patch_unapplyable", "Patch did not contain file operations.");
  }
  return operations;
}

function defaultBranchName(runId: string): string {
  return `agent-relay/run-${runId}`;
}

function defaultPrBody(input: { runId: string; s3Key: string }): string {
  const base =
    optionalEnv("NEXT_PUBLIC_APP_URL") ??
    optionalEnv("CLOUD_WEB_URL") ??
    optionalEnv("CLOUD_API_URL") ??
    "https://agentrelay.com/cloud";
  const runUrl = `${base.replace(/\/+$/, "")}/runs/${encodeURIComponent(input.runId)}`;
  return [
    "Agent Relay created this pull request from a completed cloud workflow run.",
    "",
    `Run: ${runUrl}`,
    `Patch S3 key: ${input.s3Key}`,
  ].join("\n");
}

export async function readWorkflowPathPatch(input: {
  userId: string;
  runId: string;
  pathName: string;
  s3Client?: S3Client;
}): Promise<PatchReadResult> {
  const s3Key = `${input.userId}/${input.runId}/changes-${input.pathName}.patch`;
  const bucket = readWorkflowStorageBucket();
  if (!bucket) {
    return { patch: "", hasChanges: false, s3Key };
  }

  const s3 = input.s3Client ?? createWorkflowStorageS3Client();

  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
    const body = response.Body;
    if (!body) {
      return { patch: "", hasChanges: false, s3Key };
    }
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    const patch = Buffer.concat(chunks).toString("utf8");
    return { patch, hasChanges: patch.trim().length > 0, s3Key };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "name" in error &&
      (error.name === "NoSuchKey" || error.name === "NotFound")
    ) {
      return { patch: "", hasChanges: false, s3Key };
    }
    throw error;
  }
}

async function pushPatchOrThrow(input: {
  run: WorkflowRecord;
  path: PathSubmission;
  allowlist: WorkflowRepositoryAllowlistRecord;
  patch: string;
  s3Key: string;
  defaultBranchCache?: DefaultBranchCache;
  fetchImpl?: typeof fetch;
}, tokenOverride?: string): Promise<Extract<WorkflowPathPushResult, { status: "pushed" }>> {
  if (!input.path.repoOwner || !input.path.repoName) {
    throw new PushBackError("integration_not_found", `Path ${input.path.name} does not include GitHub repo metadata.`);
  }

  const token = tokenOverride ?? await mintInstallationToken({
    workspaceId: input.run.workspaceId,
    installationId: input.allowlist.installationId,
  });

  const base = await resolveBaseRef({
    owner: input.path.repoOwner,
    repo: input.path.repoName,
    pushBase: input.path.pushBase,
    token,
    defaultBranchCache: input.defaultBranchCache,
    fetchImpl: input.fetchImpl,
  });
  const branch = input.path.pushBranch?.trim() || defaultBranchName(input.run.runId);

  await createBranch({
    owner: input.path.repoOwner,
    repo: input.path.repoName,
    branch,
    baseSha: base.sha,
    token,
    fetchImpl: input.fetchImpl,
  });

  const operations = await buildCommitOperations({
    owner: input.path.repoOwner,
    repo: input.path.repoName,
    patch: input.patch,
    baseSha: base.sha,
    token,
    fetchImpl: input.fetchImpl,
  });

  let commitResult: { sha: string; strategy: GitHubCommitPatchStrategy };
  try {
    commitResult = await commitPatch({
      owner: input.path.repoOwner,
      repo: input.path.repoName,
      branch,
      baseSha: base.sha,
      operations,
      token,
      message: `Apply Agent Relay changes for ${input.path.name}`,
      fetchImpl: input.fetchImpl,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/too large|large file|size limit|413/i.test(message)) {
      throw new PushBackError("patch_too_large", message, { base });
    }
    throw new PushBackError("github_api_error", message, { base });
  }

  const observedBase = await resolveBaseRef({
    owner: input.path.repoOwner,
    repo: input.path.repoName,
    pushBase: base.branch,
    token,
    fetchImpl: input.fetchImpl,
  });
  if (observedBase.sha !== base.sha) {
    throw new PushBackError(
      "base_branch_moved",
      `Base branch ${base.branch} moved from ${base.sha} to ${observedBase.sha} before PR creation.`,
      { base, observedBaseSha: observedBase.sha },
    );
  }

  const prUrl = await openPullRequest({
    owner: input.path.repoOwner,
    repo: input.path.repoName,
    branch,
    baseBranch: base.branch,
    title: `Agent Relay changes for ${input.path.name}`,
    body: input.path.pushPrBody ?? defaultPrBody({ runId: input.run.runId, s3Key: input.s3Key }),
    token,
    fetchImpl: input.fetchImpl,
  });

  return {
    status: "pushed",
    branch,
    prUrl,
    sha: commitResult.sha,
    base,
    strategy: commitResult.strategy,
    pushedAt: new Date().toISOString(),
  };
}

export async function pushWorkflowPathPatch(input: {
  run: WorkflowRecord;
  path: PathSubmission;
  allowlist: WorkflowRepositoryAllowlistRecord;
  patch: string;
  s3Key: string;
  defaultBranchCache?: DefaultBranchCache;
  fetchImpl?: typeof fetch;
}): Promise<WorkflowPathPushResult> {
  // Strict mode (or any allowlist row with a specific install): use it
  // directly. The explicit row is the operator's authoritative routing
  // decision — don't fan out behind their back.
  if (input.allowlist.installationId) {
    try {
      return await pushPatchOrThrow(input);
    } catch (error) {
      return failureFromUnknown(error);
    }
  }

  // Relaxed mode: the resolver returned a synthetic record with no
  // installation hint. Discover the workspace's github-* connections
  // and try each one in order until a probe + push succeeds.
  // First-success wins. Do not pre-filter on the stored
  // installationId column: github-app rows can have a live Nango
  // connection that mints the correct installation token even when
  // that denormalized column is empty.
  const integrationWorkspaceIds = resolveGithubIntegrationWorkspaceIds({
    workspaceId: input.run.workspaceId,
    relayWorkspaceId: input.run.relayWorkspaceId,
  });
  const candidates = [
    ...await listUserGithubCandidates(input.run.userId),
    ...await listWorkspaceGithubCandidates(integrationWorkspaceIds),
  ];
  if (candidates.length === 0) {
    return failedResult(
      "integration_not_found",
      `User ${input.run.userId} and workspaces ${integrationWorkspaceIds.join(", ")} have no github-family integration connections — push-back can't mint a token to push to ${input.path.repoOwner}/${input.path.repoName}.`,
    );
  }

  const attempts: Array<{
    source: "user_integrations" | "workspace_integrations";
    userId?: string;
    workspaceId?: string;
    provider: string;
    connectionId: string;
    installationId: string;
    result: WorkflowPathPushResult;
  }> = [];
  for (const candidate of candidates) {
    let tokenPrefix: string | null = null;
    try {
      const token = await mintIntegrationToken({ integration: candidate });
      tokenPrefix = String(token).slice(0, 4);
      if (!input.path.repoOwner || !input.path.repoName) {
        throw new PushBackError("integration_not_found", `Path ${input.path.name} does not include GitHub repo metadata.`);
      }
      const probeStatus = await probeIntegrationCanAccessRepo({
        integration: candidate,
        repoOwner: input.path.repoOwner,
        repoName: input.path.repoName,
      });
      console.log("[push-back] GitHub token candidate probe passed", {
        ...describeCandidate(candidate),
        repo: `${input.path.repoOwner}/${input.path.repoName}`,
        probeStatus,
        tokenPrefix,
      });
      const pushed = await pushPatchOrThrow(input, token);
      console.log("[push-back] selected GitHub token candidate", {
        ...describeCandidate(candidate),
        repo: `${input.path.repoOwner}/${input.path.repoName}`,
        tokenPrefix,
      });
      return pushed;
    } catch (error) {
      const result = failureFromUnknown(error);
      console.warn("[push-back] GitHub token candidate failed", {
        ...describeCandidate(candidate),
        repo: `${input.path.repoOwner}/${input.path.repoName}`,
        code: result.status === "failed" ? result.code : result.status,
        probeStatus: error instanceof PushBackError ? error.probeStatus ?? null : null,
        tokenPrefix: error instanceof PushBackError
          ? error.tokenPrefix ?? tokenPrefix
          : tokenPrefix,
        githubMessage: error instanceof PushBackError ? error.githubMessage ?? null : null,
        message: error instanceof Error ? error.message : String(error),
      });
      attempts.push({
        source: candidate.source,
        userId: candidate.userId,
        workspaceId: candidate.workspaceId,
        provider: candidate.provider,
        connectionId: candidate.connectionId,
        installationId: candidate.installationId ?? "",
        result,
      });
    }
  }

  // Pick the failure to surface. Config errors first (they're the
  // operator's problem), then anything else.
  const configFailure = attempts.find(
    (a) => a.result.status === "failed" &&
      (a.result.code === "installation_token_failed" || a.result.code === "integration_not_found"),
  );
  const surfaced = configFailure ?? attempts[attempts.length - 1];
  console.warn(`[push-back] all ${candidates.length} github-* installs failed for ${input.path.repoOwner}/${input.path.repoName}`, {
    workspaceId: input.run.workspaceId,
    relayWorkspaceId: input.run.relayWorkspaceId,
    repoOwner: input.path.repoOwner,
    repoName: input.path.repoName,
    attempts: attempts.map((a) => ({
      source: a.source,
      userId: a.userId ?? null,
      workspaceId: a.workspaceId ?? null,
      provider: a.provider,
      connectionId: a.connectionId,
      installationId: a.installationId,
      code: a.result.status === "failed" ? a.result.code : a.result.status,
    })),
  });
  return surfaced.result;
}

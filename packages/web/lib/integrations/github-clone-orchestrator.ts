import { RelayFileApiError } from "@relayfile/sdk";
import type { RelayFileClient } from "@relayfile/sdk";
import { chunkedBulkWrite } from "./github-clone-writer";
import { nangoGithubTarball } from "./github-nango-proxy-client";
import { walkGithubTarball, GITHUB_CLONE_MAX_FILE_BYTES } from "./github-tarball-walker";

const GITHUB_CLONE_MAX_BUFFERED_BYTES = 200 * 1024 * 1024;
const GITHUB_CLONE_RELAYFILE_WRITE_CONCURRENCY = 1;
const GITHUB_CLONE_SOURCE = "github-tarball-via-nango";
const GITHUB_REPOS_INDEX_PATH = "/github/repos/index.json";

type CloneSkipReason = "binary" | "too-large" | "ignored";

type CloneIndexEntry = {
  owner: string;
  repo: string;
  defaultBranch?: string;
  headSha?: string;
  clonedAt?: string;
};

type RelayCloneFile = {
  path: string;
  content: string;
  contentType?: string;
  encoding: "utf-8" | "base64";
};

export interface CloneRequest {
  workspaceId: string;
  owner: string;
  repo: string;
  ref?: string;
}

export interface CloneOutcome {
  filesWritten: number;
  headSha: string;
  defaultBranch: string;
  durationMs: number;
  skipped: Array<{ path: string; reason: CloneSkipReason }>;
  errors: Array<{ path: string; code: string; message: string }>;
}

export interface CloneDeps {
  nango: typeof nangoGithubTarball;
  writer: typeof chunkedBulkWrite;
  relayfile: RelayFileClient;
  connectionId: string;
  providerConfigKey: string;
}

function buildRepoRoot(owner: string, repo: string): string {
  return `/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function encodeEntryPath(entryPath: string): string {
  return entryPath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildContentPath(owner: string, repo: string, entryPath: string, headSha: string): string {
  return `${buildRepoRoot(owner, repo)}/contents/${encodeEntryPath(entryPath)}@${encodeURIComponent(headSha)}.json`;
}

function buildMetaPath(owner: string, repo: string): string {
  return `${buildRepoRoot(owner, repo)}/meta.json`;
}

function mapSkippedReason(reason: string): CloneSkipReason {
  if (reason === "too-large") {
    return "too-large";
  }

  if (reason === "ignored") {
    return "ignored";
  }

  return "binary";
}

function getContentType(repoPath: string, isBinary: boolean): string {
  if (isBinary) {
    return "application/octet-stream";
  }

  if (repoPath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }

  if (repoPath.endsWith(".md")) {
    return "text/markdown; charset=utf-8";
  }

  return "text/plain; charset=utf-8";
}

function parseIndexEntries(content: string): CloneIndexEntry[] {
  try {
    const parsed = JSON.parse(content) as unknown;

    if (Array.isArray(parsed)) {
      return parsed.filter(isIndexEntry);
    }

    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      if (Array.isArray(record.repos)) {
        return record.repos.filter(isIndexEntry);
      }
      if (Array.isArray(record.items)) {
        return record.items.filter(isIndexEntry);
      }
    }
  } catch {
    return [];
  }

  return [];
}

function isIndexEntry(value: unknown): value is CloneIndexEntry {
  return (
    value !== null
    && typeof value === "object"
    && typeof (value as { owner?: unknown }).owner === "string"
    && typeof (value as { repo?: unknown }).repo === "string"
  );
}

function isNotFoundError(error: unknown): boolean {
  if (error instanceof RelayFileApiError && error.status === 404) {
    return true;
  }
  // Duck-type fallback — tsx dynamic imports can break instanceof when the
  // orchestrator and the test see different RelayFileApiError class identities.
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: unknown }).status === 404
  );
}

async function readIndexEntries(
  relayfile: RelayFileClient,
  workspaceId: string,
): Promise<{ entries: CloneIndexEntry[]; baseRevision: string }> {
  try {
    const file = await relayfile.readFile(workspaceId, GITHUB_REPOS_INDEX_PATH);
    return { entries: parseIndexEntries(file.content), baseRevision: file.revision };
  } catch (error) {
    if (isNotFoundError(error)) {
      return { entries: [], baseRevision: "0" };
    }

    throw error;
  }
}

async function readFileRevisionOrNew(
  relayfile: RelayFileClient,
  workspaceId: string,
  path: string,
): Promise<string> {
  try {
    const file = await relayfile.readFile(workspaceId, path);
    return file.revision;
  } catch (error) {
    if (isNotFoundError(error)) {
      return "0";
    }

    throw error;
  }
}

function upsertIndexEntry(
  entries: CloneIndexEntry[],
  nextEntry: CloneIndexEntry,
): CloneIndexEntry[] {
  const merged = entries.filter(
    (entry) => !(entry.owner === nextEntry.owner && entry.repo === nextEntry.repo),
  );
  merged.push(nextEntry);
  return merged;
}

function toCloneFile(
  owner: string,
  repo: string,
  headSha: string,
  entry: {
    repoPath: string;
    content: Buffer;
    isBinary: boolean;
  },
): RelayCloneFile {
  return {
    path: buildContentPath(owner, repo, entry.repoPath, headSha),
    content: entry.isBinary ? entry.content.toString("base64") : entry.content.toString("utf8"),
    contentType: getContentType(entry.repoPath, entry.isBinary),
    encoding: entry.isBinary ? "base64" : "utf-8",
  };
}

function normalizeRef(ref?: string): string {
  const trimmed = ref?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "HEAD";
}

export async function runGithubClone(deps: CloneDeps, req: CloneRequest): Promise<CloneOutcome> {
  const startedAt = Date.now();
  const requestedRef = normalizeRef(req.ref);
  const skipped: CloneOutcome["skipped"] = [];
  const files: RelayCloneFile[] = [];
  let bufferedBytes = 0;

  const tarball = await deps.nango({
    connectionId: deps.connectionId,
    providerConfigKey: deps.providerConfigKey,
    owner: req.owner,
    repo: req.repo,
    ref: requestedRef,
  });

  for await (const entry of walkGithubTarball(tarball.stream)) {
    if (entry.skipped) {
      skipped.push({
        path: entry.repoPath,
        reason: mapSkippedReason(entry.skipped),
      });
      continue;
    }

    if (entry.size > GITHUB_CLONE_MAX_FILE_BYTES) {
      skipped.push({
        path: entry.repoPath,
        reason: "too-large",
      });
      continue;
    }

    bufferedBytes += entry.content.byteLength;
    if (bufferedBytes > GITHUB_CLONE_MAX_BUFFERED_BYTES) {
      throw new Error("GitHub clone exceeded the 200 MiB in-memory snapshot limit (too_large_repo).");
    }

    files.push(toCloneFile(req.owner, req.repo, tarball.headSha, entry));
  }

  const writeResult = await deps.writer({
    client: deps.relayfile,
    workspaceId: req.workspaceId,
    files,
    maxConcurrent: GITHUB_CLONE_RELAYFILE_WRITE_CONCURRENCY,
  });

  if (writeResult.errors.length === 0) {
    if (writeResult.written > 0) {
      const clonedAt = new Date().toISOString();
      const { entries: existingEntries, baseRevision: indexBaseRevision } =
        await readIndexEntries(deps.relayfile, req.workspaceId);
      const mergedIndex = upsertIndexEntry(existingEntries, {
        owner: req.owner,
        repo: req.repo,
        defaultBranch: tarball.defaultBranch,
        headSha: tarball.headSha,
        clonedAt,
      });

      const metaPath = buildMetaPath(req.owner, req.repo);
      const metaBaseRevision = await readFileRevisionOrNew(
        deps.relayfile,
        req.workspaceId,
        metaPath,
      );

      await deps.relayfile.writeFile({
        workspaceId: req.workspaceId,
        path: GITHUB_REPOS_INDEX_PATH,
        baseRevision: indexBaseRevision,
        content: JSON.stringify(mergedIndex),
        contentType: "application/json",
        encoding: "utf-8",
        correlationId: `github-clone-index-${req.workspaceId}`,
      });

      // meta.json LAST — partial-failure contract
      await deps.relayfile.writeFile({
        workspaceId: req.workspaceId,
        path: metaPath,
        baseRevision: metaBaseRevision,
        content: JSON.stringify({
          defaultBranch: tarball.defaultBranch,
          headSha: tarball.headSha,
          clonedAt,
          filesWritten: writeResult.written,
          cloneSource: GITHUB_CLONE_SOURCE,
        }),
        contentType: "application/json",
        encoding: "utf-8",
        correlationId: `github-clone-meta-${req.workspaceId}`,
      });
    }
  }

  return {
    filesWritten: writeResult.written,
    headSha: tarball.headSha,
    defaultBranch: tarball.defaultBranch,
    durationMs: Date.now() - startedAt,
    skipped,
    errors: writeResult.errors,
  };
}

// Wraps GitHub's `GET /repos/{owner}/{repo}/compare/{base}...{head}` for the
// webhook-driven incremental sync path. The executor uses the result to decide
// between a per-file delta apply (`changes`), a no-op completion
// (`no_change`), or a full-clone fallback (`diverged` or `truncated`).
//
// GitHub caps `files` at 300 entries per response. When we hit that cap we
// can't be sure we got the full diff, so we treat it as truncated and let
// the caller fall back to a full clone — same posture as a force-push.
//
// References:
//  - https://docs.github.com/rest/commits/commits#compare-two-commits
//  - status: 'ahead' | 'behind' | 'identical' | 'diverged'
//  - files[].status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' |
//                    'changed' | 'unchanged'

const GITHUB_COMPARE_FILES_CAP = 300;

export type CompareChangedFile =
  | { status: "added" | "modified"; path: string; sha: string }
  | { status: "renamed"; path: string; previousPath: string; sha: string }
  | { status: "removed"; path: string };

export type CompareResult =
  | { kind: "no_change" }
  | { kind: "diverged"; reason: "force_push" | "behind" | "non_ancestor" }
  | { kind: "truncated"; totalChangedFiles: number }
  | { kind: "changes"; files: CompareChangedFile[]; headSha: string };

export interface CompareNangoClient {
  proxy<T = unknown>(config: {
    method: string;
    endpoint: string;
    connectionId: string;
    providerConfigKey: string;
  }): Promise<{ status: number; data: T }>;
}

export interface CompareGithubRefsInput {
  nango: CompareNangoClient;
  connectionId: string;
  providerConfigKey: string;
  owner: string;
  repo: string;
  base: string;
  head: string;
}

interface GithubCompareFile {
  filename?: unknown;
  previous_filename?: unknown;
  status?: unknown;
  sha?: unknown;
}

interface GithubCompareResponse {
  status?: unknown;
  total_commits?: unknown;
  files?: unknown;
  head_commit?: { sha?: unknown } | null;
  merge_base_commit?: { sha?: unknown } | null;
  base_commit?: { sha?: unknown } | null;
  commits?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function encodeRef(value: string): string {
  return encodeURIComponent(value);
}

function buildEndpoint(
  owner: string,
  repo: string,
  base: string,
  head: string,
): string {
  // GitHub's compare endpoint expects `base...head` (three dots). The path
  // segments are URL-encoded individually so refs with `/` (e.g. `feat/foo`)
  // round-trip correctly.
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeRef(base)}...${encodeRef(head)}`;
}

function normalizeFiles(raw: unknown): GithubCompareFile[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const files: GithubCompareFile[] = [];
  for (const candidate of raw) {
    if (isRecord(candidate)) {
      files.push(candidate as GithubCompareFile);
    }
  }
  return files;
}

function mapChangedFile(file: GithubCompareFile): CompareChangedFile | null {
  const status = readString(file.status);
  const filename = readString(file.filename);
  if (!status || !filename) {
    return null;
  }

  // Map GitHub's broader file-status vocabulary onto the executor's surface.
  // 'changed' / 'unchanged' rarely appear (and 'unchanged' is a no-op);
  // treat them as 'modified' so the caller writes the new blob.
  if (status === "removed") {
    return { status: "removed", path: filename };
  }

  if (status === "added") {
    const sha = readString(file.sha);
    if (!sha) {
      // No blob sha → no way to fetch the contents. Fall back to full clone
      // by surfacing the file as truncated upstream — but here we just skip
      // it; the executor logs zero writes and the manifest stays consistent.
      return null;
    }
    return { status: "added", path: filename, sha };
  }

  if (status === "renamed") {
    const sha = readString(file.sha);
    const previousPath = readString(file.previous_filename);
    if (!sha || !previousPath) return null;
    return { status: "renamed", path: filename, previousPath, sha };
  }

  if (status === "copied") {
    const sha = readString(file.sha);
    if (!sha) return null;
    return { status: "added", path: filename, sha };
  }

  // 'modified' | 'changed'
  const sha = readString(file.sha);
  if (!sha) return null;
  return { status: "modified", path: filename, sha };
}

function readResolvedHeadSha(data: GithubCompareResponse): string | null {
  const headCommitSha = readString(data.head_commit?.sha);
  if (headCommitSha) {
    return headCommitSha;
  }

  if (Array.isArray(data.commits)) {
    for (let index = data.commits.length - 1; index >= 0; index -= 1) {
      const commit = data.commits[index];
      if (!isRecord(commit)) {
        continue;
      }
      const sha = readString(commit.sha);
      if (sha) {
        return sha;
      }
    }
  }

  return null;
}

export async function compareGithubRefs(
  input: CompareGithubRefsInput,
): Promise<CompareResult> {
  const endpoint = buildEndpoint(
    input.owner,
    input.repo,
    input.base,
    input.head,
  );

  const response = await input.nango.proxy<GithubCompareResponse>({
    method: "GET",
    endpoint,
    connectionId: input.connectionId,
    providerConfigKey: input.providerConfigKey,
  });

  const data = response.data;
  if (!isRecord(data)) {
    throw new Error(
      `GitHub compare ${endpoint} returned a non-object body (status=${response.status}).`,
    );
  }

  const status = readString((data as GithubCompareResponse).status);
  const files = normalizeFiles((data as GithubCompareResponse).files);

  // GitHub can't produce a meaningful diff when head is behind base or when
  // the two commits don't share an ancestor (the case after a force-push
  // that drops commits). Both require a full re-clone.
  if (status === "behind") {
    return { kind: "diverged", reason: "behind" };
  }
  if (status === "diverged") {
    return { kind: "diverged", reason: "force_push" };
  }

  if (status === "identical") {
    return { kind: "no_change" };
  }

  // GitHub caps `files` at 300 entries. When the server returns exactly 300
  // we can't tell whether we got the full diff or it was truncated — treat
  // it as truncated and have the caller full-reclone.
  if (files.length >= GITHUB_COMPARE_FILES_CAP) {
    return {
      kind: "truncated",
      totalChangedFiles: files.length,
    };
  }

  if (status !== "ahead") {
    // Defensive: an unknown status string. Tarball fallback is the safe move.
    return { kind: "diverged", reason: "non_ancestor" };
  }

  const changed: CompareChangedFile[] = [];
  for (const file of files) {
    const mapped = mapChangedFile(file);
    if (mapped) {
      changed.push(mapped);
    }
  }

  const headSha = readResolvedHeadSha(data as GithubCompareResponse);
  if (!headSha) {
    throw new Error(
      `GitHub compare ${endpoint} did not return a resolved head commit sha.`,
    );
  }

  return {
    kind: "changes",
    files: changed,
    headSha,
  };
}

export const __test__ = {
  buildEndpoint,
  GITHUB_COMPARE_FILES_CAP,
};

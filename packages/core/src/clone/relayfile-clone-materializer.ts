import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type RelayfileTreeEntry = {
  path: string;
  type?: "file" | "dir" | string;
};

export type RelayfileFileRead = {
  content: string;
  encoding?: string | null;
};

export type RelayfileCloneClient = {
  listTree(
    workspaceId: string,
    input: { path: string; depth?: number; cursor?: string | null },
  ): Promise<{ entries?: RelayfileTreeEntry[]; nextCursor?: string | null }>;
  readFile(workspaceId: string, path: string): Promise<RelayfileFileRead>;
};

export type MaterializeRelayfileGithubCloneInput = {
  client: RelayfileCloneClient;
  workspaceId: string;
  owner: string;
  repo: string;
  targetDir: string;
};

export type MaterializeRelayfileGithubCloneResult = {
  headSha: string;
  filesWritten: number;
};

type CloneSentinel = {
  headSha?: unknown;
};

function repoRoot(owner: string, repo: string): string {
  return `/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function contentRoot(owner: string, repo: string): string {
  return `${repoRoot(owner, repo)}/contents`;
}

function cloneSentinelPath(owner: string, repo: string): string {
  return `${repoRoot(owner, repo)}/.relayfile/clone.json`;
}

function parseCloneSentinel(file: RelayfileFileRead): string {
  const content =
    file.encoding === "base64"
      ? Buffer.from(file.content, "base64").toString("utf8")
      : file.content;
  const parsed = JSON.parse(content) as CloneSentinel;
  if (typeof parsed.headSha !== "string" || parsed.headSha.length === 0) {
    throw new Error("Relayfile GitHub clone sentinel is missing headSha.");
  }
  return parsed.headSha;
}

function decodeSegment(segment: string): string {
  return decodeURIComponent(segment);
}

export function repoPathFromCloneCachePath(input: {
  path: string;
  owner: string;
  repo: string;
  headSha: string;
}): string | null {
  const root = `${contentRoot(input.owner, input.repo)}/`;
  if (!input.path.startsWith(root)) return null;

  const suffix = `@${encodeURIComponent(input.headSha)}.json`;
  const encodedRelative = input.path.slice(root.length);
  if (!encodedRelative.endsWith(suffix)) return null;

  const withoutSha = encodedRelative.slice(0, -suffix.length);
  const relative = withoutSha
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(decodeSegment)
    .join("/");

  if (!relative || path.isAbsolute(relative)) return null;
  const normalized = path.posix.normalize(relative);
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    return null;
  }
  return normalized;
}

function decodeFile(file: RelayfileFileRead): Buffer {
  if (file.encoding === "base64") {
    return Buffer.from(file.content, "base64");
  }
  return Buffer.from(file.content, "utf8");
}

async function listAllFiles(
  client: RelayfileCloneClient,
  workspaceId: string,
  root: string,
): Promise<string[]> {
  const files: string[] = [];
  let cursor: string | null = null;

  do {
    const page = await client.listTree(workspaceId, {
      path: root,
      depth: 10,
      cursor,
    });
    for (const entry of page.entries ?? []) {
      if (entry.type === "file") {
        files.push(entry.path);
      }
    }
    cursor = page.nextCursor ?? null;
  } while (cursor);

  return files;
}

export async function materializeRelayfileGithubClone(
  input: MaterializeRelayfileGithubCloneInput,
): Promise<MaterializeRelayfileGithubCloneResult> {
  const headSha = parseCloneSentinel(
    await input.client.readFile(
      input.workspaceId,
      cloneSentinelPath(input.owner, input.repo),
    ),
  );
  const root = contentRoot(input.owner, input.repo);
  const cachePaths = await listAllFiles(input.client, input.workspaceId, root);

  let filesWritten = 0;
  for (const cachePath of cachePaths) {
    const repoPath = repoPathFromCloneCachePath({
      path: cachePath,
      owner: input.owner,
      repo: input.repo,
      headSha,
    });
    if (!repoPath) continue;

    const destination = path.join(input.targetDir, repoPath);
    const relative = path.relative(input.targetDir, destination);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Refusing to materialize unsafe repo path: ${repoPath}`);
    }

    const file = await input.client.readFile(input.workspaceId, cachePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, decodeFile(file));
    filesWritten += 1;
  }

  return { headSha, filesWritten };
}

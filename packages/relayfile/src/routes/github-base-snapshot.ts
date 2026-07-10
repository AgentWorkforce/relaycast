import type { AppEnv } from "../env.js";
import type { ExportManifestEntry } from "../durable-objects/adapter.js";
import {
  baseManifestKey,
  blobKey,
  type BaseManifestEntry,
  type ContentHash,
} from "../overlay-base.js";

export type GithubBaseManifestEntry = BaseManifestEntry;

export type GithubBaseSnapshotRow = {
  workspace_id: string;
  owner: string;
  repo: string;
  head_sha: string;
  content_root: string;
  manifest_ref: string;
  file_count: number;
  bytes: number;
  current: number;
  created_at: string;
  updated_at: string;
};

export type GithubBaseSnapshotInput = {
  workspaceId: string;
  owner: string;
  repo: string;
  headSha: string;
};

export function githubBaseSnapshotsEnabled(
  env: Pick<AppEnv["Bindings"], "RELAYFILE_GITHUB_BASE_SNAPSHOT_WORKSPACES">,
  workspaceId: string,
): boolean {
  const raw = env.RELAYFILE_GITHUB_BASE_SNAPSHOT_WORKSPACES?.trim();
  if (!raw) {
    return false;
  }
  const normalized = raw.toLowerCase();
  if (
    normalized === "*" ||
    normalized === "1" ||
    normalized === "true" ||
    normalized === "on"
  ) {
    return true;
  }
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(workspaceId);
}

export function githubBaseBlobRef(contentHash: string): string {
  return blobKey(contentHash.toLowerCase() as ContentHash);
}

export function githubBaseContentRoot(input: {
  owner: string;
  repo: string;
}): string {
  return `/github/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents`;
}

export function githubBaseManifestRef(input: GithubBaseSnapshotInput): string {
  return baseManifestKey(
    input.workspaceId,
    input.owner,
    input.repo,
    input.headSha,
  );
}

export async function putGithubBaseManifest(
  env: Pick<AppEnv["Bindings"], "CONTENT_BUCKET">,
  manifestRef: string,
  entries: readonly GithubBaseManifestEntry[],
): Promise<void> {
  const body = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  await env.CONTENT_BUCKET.put(manifestRef, body, {
    httpMetadata: { contentType: "application/x-ndjson; charset=utf-8" },
    customMetadata: {
      source: "github-base-snapshot-manifest",
      version: "1",
    },
  });
}

export async function upsertGithubBaseSnapshot(
  env: Pick<AppEnv["Bindings"], "DB">,
  input: GithubBaseSnapshotInput & {
    manifestRef: string;
    fileCount: number;
    bytes: number;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const contentRoot = githubBaseContentRoot(input);
  await env.DB.batch([
    env.DB.prepare(
      `
      UPDATE github_base_snapshots
      SET current = 0,
          updated_at = ?
      WHERE workspace_id = ?
        AND owner = ?
        AND repo = ?
        AND head_sha <> ?
        AND current = 1
    `,
    ).bind(now, input.workspaceId, input.owner, input.repo, input.headSha),
    env.DB.prepare(
      `
      INSERT INTO github_base_snapshots (
        workspace_id, owner, repo, head_sha, content_root, manifest_ref,
        file_count, bytes, current, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(workspace_id, owner, repo, head_sha) DO UPDATE SET
        content_root = excluded.content_root,
        manifest_ref = excluded.manifest_ref,
        file_count = excluded.file_count,
        bytes = excluded.bytes,
        current = 1,
        updated_at = excluded.updated_at
    `,
    ).bind(
      input.workspaceId,
      input.owner,
      input.repo,
      input.headSha,
      contentRoot,
      input.manifestRef,
      input.fileCount,
      input.bytes,
      now,
      now,
    ),
  ]);
}

export async function readGithubBaseSnapshot(
  env: Pick<AppEnv["Bindings"], "DB">,
  input: GithubBaseSnapshotInput,
): Promise<GithubBaseSnapshotRow | null> {
  return env.DB.prepare(
    `
      SELECT *
      FROM github_base_snapshots
      WHERE workspace_id = ?
        AND owner = ?
        AND repo = ?
        AND head_sha = ?
      LIMIT 1
    `,
  )
    .bind(input.workspaceId, input.owner, input.repo, input.headSha)
    .first<GithubBaseSnapshotRow>();
}

export async function loadGithubBaseManifest(
  env: Pick<AppEnv["Bindings"], "CONTENT_BUCKET">,
  manifestRef: string,
): Promise<GithubBaseManifestEntry[]> {
  const object = await env.CONTENT_BUCKET.get(manifestRef);
  if (!object) {
    throw new Error(`github base manifest missing from R2: ${manifestRef}`);
  }
  const text: string = await object.text();
  return text
    .split("\n")
    .map((line: string) => line.trim())
    .filter(Boolean)
    .map((line: string) => JSON.parse(line) as GithubBaseManifestEntry);
}

export function githubBaseEntryToExportManifestEntry(
  entry: GithubBaseManifestEntry,
): ExportManifestEntry {
  return {
    path: entry.path,
    revision: `base_${entry.headSha}`,
    contentType: entry.contentType ?? "application/octet-stream",
    contentRef: entry.blobRef,
    size: entry.size,
    encoding: entry.encoding,
    updatedAt: entry.updatedAt,
    semanticsJson: "{}",
    provider: "github",
    providerObjectId: "",
    contentHash: entry.contentHash,
  };
}

export function parseGithubContentRoot(
  pathPrefix: string,
): { owner: string; repo: string } | null {
  const parts = pathPrefix.split("/");
  if (
    parts.length !== 6 ||
    parts[0] !== "" ||
    parts[1] !== "github" ||
    parts[2] !== "repos" ||
    parts[3] === "" ||
    parts[4] === "" ||
    parts[5] !== "contents"
  ) {
    return null;
  }
  try {
    return {
      owner: decodeURIComponent(parts[3]),
      repo: decodeURIComponent(parts[4]),
    };
  } catch {
    return null;
  }
}

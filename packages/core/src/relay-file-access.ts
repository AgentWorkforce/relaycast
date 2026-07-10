import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { mintRelayfileToken } from "./relayfile/client.js";
import type { ScopedS3Client } from "./storage/client.js";
import { generateWorkspaceId } from "./workspace/id.js";

/**
 * Persistent revocation record for a relayfile access token.
 *
 * `tokenHash` is the SHA-256 hex digest of the bearer token — raw tokens are
 * never written to the store. `expiresAt` is the token's natural JWT expiry;
 * past that instant the revocation row is moot (the token is invalid anyway),
 * so reads filter on it and pruning deletes past-expiry rows.
 */
export interface RelayFileRevocationRecord {
  tokenHash: string;
  scope: string;
  workspace: string | null;
  agentName: string | null;
  revokedAt: Date;
  expiresAt: Date;
}

/**
 * Storage contract for persistent token revocation. Implementations must be
 * shared across replicas (e.g. Postgres via DrizzleRelayFileRevocationStore in
 * ./db/relay-file-revocations.js) so a revocation issued on one replica is
 * honored by every other replica.
 */
export interface RelayFileRevocationStore {
  /** Persist a revocation. Idempotent: re-revoking the same token is a no-op upsert. */
  revoke(record: RelayFileRevocationRecord): Promise<void>;
  /** True when an unexpired revocation row exists for the token hash. */
  isRevoked(tokenHash: string, now?: Date): Promise<boolean>;
  /** Delete rows whose `expiresAt` has passed. Returns the number of rows removed. */
  prune(now?: Date): Promise<number>;
}

/** SHA-256 hex digest used as the revocation key for a bearer token. */
export function hashRelayFileToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export type RelayFileSeedSource =
  | { type: "directory"; rootDir: string }
  | { type: "git"; repoUrl: string; ref?: string; subdir?: string }
  | { type: "s3"; client: ScopedS3Client; key: string; stripComponents?: number };

export interface ProvisionedRelayFileAccess {
  relayfileUrl: string;
  token: string;
  workspace: string;
  wsUrl: string;
  agentName: string;
  scopes: string[];
  dotfileRules: string[];
}

export interface RelayFileAccessManagerOptions {
  relayfileUrl: string;
  relayAuthUrl: string;
  relayAuthApiKey: string;
  workspacePrefix?: string;
  fetchImpl?: typeof fetch;
  /** JWT token TTL in seconds. Defaults to 7200 (2 hours). */
  tokenTtlSeconds?: number;
  /** Max concurrent file uploads during seeding. Defaults to 10. */
  seedConcurrency?: number;
  /**
   * Shared persistent revocation store (e.g. DrizzleRelayFileRevocationStore
   * backed by Postgres). When provided, revocations are written through to the
   * store so they survive process/Lambda restarts and are visible to every
   * replica. Without it the manager falls back to in-memory-only revocation
   * (suitable for tests / single-process dev only).
   */
  revocationStore?: RelayFileRevocationStore;
  /**
   * How long a store lookup result may be served from the in-memory
   * read-through cache before `isRevoked` re-consults the store. Bounds
   * cross-replica staleness: a revocation written on replica A is honored by
   * replica B within this window. Defaults to 30_000 (30s). Set to 0 to query
   * the store on every check.
   */
  revocationCacheTtlMs?: number;
}

type ProvisionRecord = ProvisionedRelayFileAccess & { createdAt: string };

const DEFAULT_SCOPES = ["fs:read", "fs:write", "sync:read"];

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function dedupeScopes(scopes: readonly string[]): string[] {
  const normalized = scopes.map((scope) => scope.trim()).filter(Boolean);
  return [...new Set(normalized.length > 0 ? normalized : DEFAULT_SCOPES)];
}

function isTextBuffer(buffer: Buffer): boolean {
  return !buffer.includes(0);
}

function toWebSocketUrl(relayfileUrl: string, workspaceId: string, token: string): string {
  const url = new URL(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/fs/ws`,
    stripTrailingSlash(relayfileUrl),
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  return url.toString();
}

async function collectTextFiles(rootDir: string): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const buffer = await readFile(fullPath);
      if (!isTextBuffer(buffer)) {
        continue;
      }

      files.push({
        path: path.relative(rootDir, fullPath).replace(/\\/g, "/"),
        content: buffer.toString("utf-8"),
      });
    }
  }

  await walk(rootDir);
  return files;
}

export class RelayFileAccessManager {
  private readonly relayfileUrl: string;
  private readonly relayAuthUrl: string;
  private readonly relayAuthApiKey: string;
  private readonly workspacePrefix: string;
  private readonly fetchImpl: typeof fetch;
  private readonly tokenTtlSeconds: number;
  private readonly seedConcurrency: number;
  private readonly provisions = new Map<string, ProvisionRecord>();
  // Revocation state. The persistent store (when configured) is the source of
  // truth: it survives restarts and is shared across replicas. The structures
  // below are local accelerators only:
  //  - `locallyRevokedHashes` records revocations issued BY THIS instance so
  //    they are honored immediately and even if the store is unreachable.
  //  - `revocationLookupCache` is a short-TTL read-through cache over store
  //    lookups (keyed by token hash) so the hot `isRevoked` path does not hit
  //    the database on every check. Cross-replica staleness is bounded by
  //    `revocationCacheTtlMs` (default 30s).
  // Note: WorkspaceRegistry also mints JWT tokens independently — revocation
  // must cover both paths; the shared store keys on token hash, so any minted
  // token can be revoked regardless of which component minted it.
  private readonly locallyRevokedHashes = new Set<string>();
  private readonly revocationLookupCache = new Map<string, { revoked: boolean; checkedAt: number }>();
  private readonly revocationStore: RelayFileRevocationStore | null;
  private readonly revocationCacheTtlMs: number;

  constructor(options: RelayFileAccessManagerOptions) {
    this.relayfileUrl = stripTrailingSlash(options.relayfileUrl);
    this.relayAuthUrl = options.relayAuthUrl;
    this.relayAuthApiKey = options.relayAuthApiKey;
    this.workspacePrefix = options.workspacePrefix?.trim() ?? "";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tokenTtlSeconds = options.tokenTtlSeconds ?? 7_200;
    this.seedConcurrency = options.seedConcurrency ?? 10;
    this.revocationStore = options.revocationStore ?? null;
    this.revocationCacheTtlMs = options.revocationCacheTtlMs ?? 30_000;
  }

  async provisionAgent(
    name: string,
    scopes: readonly string[],
    dotfileRules: readonly string[],
    options?: { workspaceId?: string },
  ): Promise<ProvisionedRelayFileAccess> {
    const workspace = options?.workspaceId
      ?? (this.workspacePrefix
        ? `${this.workspacePrefix}-${randomUUID()}`
        : generateWorkspaceId());
    const grantedScopes = dedupeScopes(scopes);
    const token = await this.mintToken(workspace, name, grantedScopes);
    const access: ProvisionedRelayFileAccess = {
      relayfileUrl: this.relayfileUrl,
      token,
      workspace,
      wsUrl: toWebSocketUrl(this.relayfileUrl, workspace, token),
      agentName: name,
      scopes: grantedScopes,
      dotfileRules: [...dotfileRules],
    };

    this.provisions.set(token, {
      ...access,
      createdAt: new Date().toISOString(),
    });

    return access;
  }

  async seedFromSource(
    workspaceId: string,
    source: RelayFileSeedSource,
  ): Promise<{ workspaceId: string; fileCount: number; sourceType: RelayFileSeedSource["type"] }> {
    switch (source.type) {
      case "directory":
        return {
          workspaceId,
          fileCount: await this.seedDirectory(workspaceId, source.rootDir),
          sourceType: "directory",
        };
      case "git":
        return {
          workspaceId,
          fileCount: await this.seedGitRepo(workspaceId, source),
          sourceType: "git",
        };
      case "s3":
        return {
          workspaceId,
          fileCount: await this.seedS3Archive(workspaceId, source),
          sourceType: "s3",
        };
    }
  }

  /**
   * Revoke a token. The local revocation takes effect immediately; when a
   * persistent store is configured the revocation is written through so it
   * survives restarts and is visible to other replicas (within their cache
   * TTL). The store write is awaited — if it fails the error propagates so
   * callers know the revocation is NOT durable (it still holds on this
   * instance for its lifetime).
   */
  async revokeAgent(token: string): Promise<boolean> {
    const provision = this.provisions.get(token);
    const existed = this.provisions.delete(token);
    const tokenHash = hashRelayFileToken(token);
    this.locallyRevokedHashes.add(tokenHash);
    this.revocationLookupCache.set(tokenHash, { revoked: true, checkedAt: Date.now() });

    if (this.revocationStore) {
      const now = new Date();
      // Revocation rows only need to outlive the token itself: expiry is the
      // token's natural JWT expiry (mint time + TTL when we minted it here, a
      // conservative now + TTL otherwise).
      const mintedAt = provision ? new Date(provision.createdAt) : now;
      const expiresAt = new Date(mintedAt.getTime() + this.tokenTtlSeconds * 1000);
      await this.revocationStore.revoke({
        tokenHash,
        scope: "relayfile-access",
        workspace: provision?.workspace ?? null,
        agentName: provision?.agentName ?? null,
        revokedAt: now,
        expiresAt: expiresAt > now ? expiresAt : new Date(now.getTime() + this.tokenTtlSeconds * 1000),
      });
      // Opportunistic cleanup of rows past their natural expiry. Best-effort:
      // a prune failure must not fail the revocation that already persisted.
      await this.revocationStore.prune(now).catch(() => undefined);
    }

    return existed;
  }

  /**
   * Check whether a token has been revoked. Locally-issued revocations are
   * answered from memory; otherwise the persistent store is consulted through
   * a read-through cache so the hot path stays cheap. A revocation issued on
   * another replica becomes visible here within `revocationCacheTtlMs`.
   * If the store is unreachable the last cached value (or false) is returned —
   * availability over consistency, matching pre-store behavior.
   */
  async isRevoked(token: string): Promise<boolean> {
    const tokenHash = hashRelayFileToken(token);
    if (this.locallyRevokedHashes.has(tokenHash)) {
      return true;
    }

    if (!this.revocationStore) {
      return false;
    }

    const cached = this.revocationLookupCache.get(tokenHash);
    const now = Date.now();
    if (cached && now - cached.checkedAt < this.revocationCacheTtlMs) {
      return cached.revoked;
    }

    let revoked: boolean;
    try {
      revoked = await this.revocationStore.isRevoked(tokenHash);
    } catch {
      return cached?.revoked ?? false;
    }

    this.cacheRevocationLookup(tokenHash, revoked, now);
    return revoked;
  }

  private cacheRevocationLookup(tokenHash: string, revoked: boolean, checkedAt: number): void {
    // Bound cache growth in long-lived processes: evict stale entries once the
    // cache gets large. Entries older than the TTL are dead weight anyway.
    if (this.revocationLookupCache.size >= 10_000) {
      const cutoff = checkedAt - this.revocationCacheTtlMs;
      for (const [key, entry] of this.revocationLookupCache) {
        if (entry.checkedAt < cutoff) {
          this.revocationLookupCache.delete(key);
        }
      }
    }
    this.revocationLookupCache.set(tokenHash, { revoked, checkedAt });
  }

  getProvision(token: string): ProvisionedRelayFileAccess | null {
    const provision = this.provisions.get(token);
    if (!provision) {
      return null;
    }

    const { createdAt: _createdAt, ...access } = provision;
    return access;
  }

  private mintToken(workspaceId: string, agentName: string, scopes: readonly string[]): Promise<string> {
    return mintRelayfileToken({
      workspaceId,
      agentName,
      relayAuthUrl: this.relayAuthUrl,
      relayAuthApiKey: this.relayAuthApiKey,
      scopes: [...scopes],
      ttlSeconds: this.tokenTtlSeconds,
    });
  }

  private async seedDirectory(workspaceId: string, rootDir: string): Promise<number> {
    const files = await collectTextFiles(rootDir);
    const token = await this.mintToken(workspaceId, "cloud-seeder", ["fs:read", "fs:write", "sync:read"]);

    const limit = this.seedConcurrency;
    for (let i = 0; i < files.length; i += limit) {
      const batch = files.slice(i, i + limit);
      await Promise.all(
        batch.map((file) => this.putWorkspaceFile(workspaceId, token, file.path, file.content)),
      );
    }

    return files.length;
  }

  private async seedGitRepo(
    workspaceId: string,
    source: Extract<RelayFileSeedSource, { type: "git" }>,
  ): Promise<number> {
    const cloneDir = await mkdtemp(path.join(os.tmpdir(), "relayfile-git-"));
    try {
      const args = ["clone", "--depth", "1"];
      if (source.ref) {
        args.push("--branch", source.ref);
      }
      args.push(source.repoUrl, cloneDir);
      execFileSync("git", args, { stdio: "ignore" });

      let seedRoot = cloneDir;
      if (source.subdir) {
        seedRoot = path.resolve(cloneDir, source.subdir);
        if (!seedRoot.startsWith(cloneDir + path.sep) && seedRoot !== cloneDir) {
          throw new Error(
            `Path traversal detected: subdir "${source.subdir}" resolves outside clone directory`,
          );
        }
      }
      return await this.seedDirectory(workspaceId, seedRoot);
    } finally {
      await rm(cloneDir, { recursive: true, force: true });
    }
  }

  private async seedS3Archive(
    workspaceId: string,
    source: Extract<RelayFileSeedSource, { type: "s3" }>,
  ): Promise<number> {
    const extractDir = await mkdtemp(path.join(os.tmpdir(), "relayfile-s3-"));
    const archivePath = path.join(extractDir, "seed.tar.gz");

    try {
      const archive = await source.client.getObject(source.key);
      await writeFile(archivePath, archive);
      await tar.x({
        cwd: extractDir,
        file: archivePath,
        gzip: true,
        strip: source.stripComponents ?? 0,
      });

      return await this.seedDirectory(workspaceId, extractDir);
    } finally {
      await rm(extractDir, { recursive: true, force: true });
    }
  }

  private async putWorkspaceFile(
    workspaceId: string,
    token: string,
    filePath: string,
    content: string,
  ): Promise<void> {
    const url = new URL(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/fs/file`,
      this.relayfileUrl,
    );
    url.searchParams.set("path", filePath);

    const response = await this.fetchImpl(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "If-Match": "*",
        "X-Correlation-Id": randomUUID(),
      },
      body: JSON.stringify({
        content,
        contentType: "text/plain; charset=utf-8",
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Relayfile seed failed for ${filePath} (${response.status} ${response.statusText})${body ? `: ${body.slice(0, 500)}` : ""}`,
      );
    }
  }
}

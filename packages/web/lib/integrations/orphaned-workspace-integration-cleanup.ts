import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "../db";
import { workspaceIntegrations } from "../db/schema";

export const DEFAULT_ORPHANED_GOOGLE_MAIL_PROVIDER = "google-mail";
export const DEFAULT_GOOGLE_MAIL_RELAYFILE_ROOT = "/google-mail";
export const DEFAULT_RELAYFILE_FINGERPRINT_READ_CONCURRENCY = 10;

export type OrphanedWorkspaceIntegrationCandidate = {
  id: string;
  workspaceId: string;
  provider: string;
  name: string | null;
  connectionId: string;
  providerConfigKey: string | null;
  installationId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RelayfileFingerprintFile = {
  path: string;
  revision: string;
  contentType: string;
  encoding: "utf-8" | "base64";
  size: number;
  sha256: string;
};

export type RelayfileSubtreeFingerprint = {
  workspaceId: string;
  root: string;
  fileCount: number;
  totalBytes: number;
  digest: string;
  sampledFiles: RelayfileFingerprintFile[];
};

export type RemoveOrphanedWorkspaceIntegrationOptions = {
  workspaceId?: string;
  provider?: string;
  connectionId?: string;
  dryRun?: boolean;
  verifyRelayfile?: boolean;
  relayfileRoot?: string;
  relayfileSampleLimit?: number;
};

export type RemoveOrphanedWorkspaceIntegrationResult = {
  dryRun: boolean;
  provider: string;
  connectionId: string;
  matched: number;
  deleted: number;
  status:
    | "no_match"
    | "would_delete"
    | "deleted"
    | "blocked_multiple_matches"
    | "delete_race_lost"
    | "relayfile_changed";
  candidate?: OrphanedWorkspaceIntegrationCandidate;
  beforeRelayfile?: RelayfileSubtreeFingerprint;
  afterRelayfile?: RelayfileSubtreeFingerprint;
  error?: string;
};

type RemoveOrphanedWorkspaceIntegrationDeps = {
  listCandidates?: (
    options: RequiredCleanupSelector,
  ) => Promise<OrphanedWorkspaceIntegrationCandidate[]>;
  deleteCandidate?: (
    candidate: OrphanedWorkspaceIntegrationCandidate,
  ) => Promise<boolean>;
  fingerprintRelayfile?: (
    workspaceId: string,
    options: {
      root: string;
      sampleLimit: number;
    },
  ) => Promise<RelayfileSubtreeFingerprint>;
};

type RequiredCleanupSelector = {
  workspaceId?: string;
  provider: string;
  connectionId: string;
};

export type RelayfileFingerprintClient = {
  listTree(
    workspaceId: string,
    options?: {
      path?: string;
      depth?: number;
      cursor?: string | null;
      correlationId?: string;
      signal?: AbortSignal;
    },
  ): Promise<{
    entries: Array<{
      path: string;
      type: "file" | "dir";
      revision: string;
      size?: number;
    }>;
    nextCursor: string | null;
  }>;
  readFile(
    workspaceId: string,
    path: string,
    correlationId?: string,
    signal?: AbortSignal,
  ): Promise<{
    path: string;
    revision: string;
    contentType: string;
    content: string;
    encoding?: "utf-8" | "base64";
  }>;
};

export async function removeOrphanedWorkspaceIntegration(
  options: RemoveOrphanedWorkspaceIntegrationOptions = {},
  deps: RemoveOrphanedWorkspaceIntegrationDeps = {},
): Promise<RemoveOrphanedWorkspaceIntegrationResult> {
  const provider = options.provider ?? DEFAULT_ORPHANED_GOOGLE_MAIL_PROVIDER;
  const connectionId = options.connectionId?.trim();
  if (!connectionId) {
    throw new Error("connectionId is required for orphaned workspace integration cleanup.");
  }
  const dryRun = options.dryRun ?? true;
  const verifyRelayfile = options.verifyRelayfile ?? false;
  const relayfileRoot =
    options.relayfileRoot ?? DEFAULT_GOOGLE_MAIL_RELAYFILE_ROOT;
  const relayfileSampleLimit = normalizeSampleLimit(
    options.relayfileSampleLimit,
  );
  const selector = {
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    provider,
    connectionId,
  };
  const listCandidates = deps.listCandidates ?? listOrphanedCandidates;
  const deleteCandidate = deps.deleteCandidate ?? deleteCandidateByExactRow;
  const fingerprintRelayfile = deps.fingerprintRelayfile;
  if (verifyRelayfile && !fingerprintRelayfile) {
    throw new Error("RelayFile verification requires a fingerprintRelayfile dependency.");
  }
  const candidates = await listCandidates(selector);

  if (candidates.length === 0) {
    return {
      dryRun,
      provider,
      connectionId,
      matched: 0,
      deleted: 0,
      status: "no_match",
    };
  }

  if (candidates.length > 1) {
    return {
      dryRun,
      provider,
      connectionId,
      matched: candidates.length,
      deleted: 0,
      status: "blocked_multiple_matches",
      error: "Refusing to delete because more than one row matched.",
    };
  }

  const [candidate] = candidates;
  const beforeRelayfile =
    verifyRelayfile && fingerprintRelayfile
      ? await fingerprintRelayfile(candidate.workspaceId, {
          root: relayfileRoot,
          sampleLimit: relayfileSampleLimit,
        })
      : undefined;

  if (dryRun) {
    return {
      dryRun,
      provider,
      connectionId,
      matched: 1,
      deleted: 0,
      status: "would_delete",
      candidate,
      ...(beforeRelayfile ? { beforeRelayfile } : {}),
    };
  }

  const deleted = await deleteCandidate(candidate);
  if (!deleted) {
    return {
      dryRun,
      provider,
      connectionId,
      matched: 1,
      deleted: 0,
      status: "delete_race_lost",
      candidate,
      ...(beforeRelayfile ? { beforeRelayfile } : {}),
      error: "The workspace integration row changed before deletion.",
    };
  }

  const afterRelayfile =
    verifyRelayfile && fingerprintRelayfile
      ? await fingerprintRelayfile(candidate.workspaceId, {
          root: relayfileRoot,
          sampleLimit: relayfileSampleLimit,
        })
      : undefined;

  if (
    beforeRelayfile &&
    afterRelayfile &&
    beforeRelayfile.digest !== afterRelayfile.digest
  ) {
    return {
      dryRun,
      provider,
      connectionId,
      matched: 1,
      deleted: 1,
      status: "relayfile_changed",
      candidate,
      beforeRelayfile,
      afterRelayfile,
      error: `${relayfileRoot} fingerprint changed during cleanup.`,
    };
  }

  return {
    dryRun,
    provider,
    connectionId,
    matched: 1,
    deleted: 1,
    status: "deleted",
    candidate,
    ...(beforeRelayfile ? { beforeRelayfile } : {}),
    ...(afterRelayfile ? { afterRelayfile } : {}),
  };
}

export async function createRelayfileSubtreeFingerprint(
  client: RelayfileFingerprintClient,
  workspaceId: string,
  options: {
    root?: string;
    sampleLimit?: number;
    depth?: number;
    readConcurrency?: number;
    correlationId?: string;
    signal?: AbortSignal;
  } = {},
): Promise<RelayfileSubtreeFingerprint> {
  const root = options.root ?? DEFAULT_GOOGLE_MAIL_RELAYFILE_ROOT;
  const sampleLimit = normalizeSampleLimit(options.sampleLimit);
  const readConcurrency = normalizeReadConcurrency(options.readConcurrency);
  const correlationId =
    options.correlationId ?? "cloud-1311-google-mail-cleanup";
  const paths: string[] = [];
  let cursor: string | null = null;

  do {
    const page = await client.listTree(workspaceId, {
      path: root,
      depth: options.depth ?? 20,
      cursor,
      correlationId,
      signal: options.signal,
    });
    for (const entry of page.entries ?? []) {
      if (entry.type === "file") {
        paths.push(entry.path);
      }
    }
    cursor = page.nextCursor ?? null;
  } while (cursor);

  paths.sort();

  const files: RelayfileFingerprintFile[] = [];
  for (let index = 0; index < paths.length; index += readConcurrency) {
    const chunk = paths.slice(index, index + readConcurrency);
    const chunkFiles = await Promise.all(
      chunk.map((path) =>
        fingerprintRelayfilePath(
          client,
          workspaceId,
          path,
          correlationId,
          options.signal,
        ),
      ),
    );
    files.push(...chunkFiles);
  }

  const digest = sha256Hex(
    Buffer.from(files.map((file) => JSON.stringify(file)).join("\n"), "utf8"),
  );

  return {
    workspaceId,
    root,
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
    digest,
    sampledFiles: files.slice(0, sampleLimit),
  };
}

async function listOrphanedCandidates(
  options: RequiredCleanupSelector,
): Promise<OrphanedWorkspaceIntegrationCandidate[]> {
  const conditions = [
    eq(workspaceIntegrations.provider, options.provider),
    eq(workspaceIntegrations.connectionId, options.connectionId),
    isNotNull(workspaceIntegrations.connectionId),
    isNull(workspaceIntegrations.name),
  ];
  if (options.workspaceId) {
    conditions.push(eq(workspaceIntegrations.workspaceId, options.workspaceId));
  }

  const records = await getDb()
    .select({
      id: workspaceIntegrations.id,
      workspaceId: workspaceIntegrations.workspaceId,
      provider: workspaceIntegrations.provider,
      name: workspaceIntegrations.name,
      connectionId: workspaceIntegrations.connectionId,
      providerConfigKey: workspaceIntegrations.providerConfigKey,
      installationId: workspaceIntegrations.installationId,
      createdAt: workspaceIntegrations.createdAt,
      updatedAt: workspaceIntegrations.updatedAt,
    })
    .from(workspaceIntegrations)
    .where(and(...conditions))
    .orderBy(asc(workspaceIntegrations.workspaceId))
    .limit(2);

  return records.map((record) => ({
    ...record,
    connectionId: record.connectionId ?? options.connectionId,
  }));
}

async function deleteCandidateByExactRow(
  candidate: OrphanedWorkspaceIntegrationCandidate,
): Promise<boolean> {
  const [record] = await getDb()
    .delete(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.id, candidate.id),
        eq(workspaceIntegrations.workspaceId, candidate.workspaceId),
        eq(workspaceIntegrations.provider, candidate.provider),
        eq(workspaceIntegrations.connectionId, candidate.connectionId),
        isNull(workspaceIntegrations.name),
      ),
    )
    .returning({ id: workspaceIntegrations.id });

  return Boolean(record);
}

function normalizeSampleLimit(value: number | undefined): number {
  if (value === undefined) {
    return 5;
  }
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 5;
}

function normalizeReadConcurrency(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_RELAYFILE_FINGERPRINT_READ_CONCURRENCY;
  }
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_RELAYFILE_FINGERPRINT_READ_CONCURRENCY;
  }
  return Math.floor(value);
}

async function fingerprintRelayfilePath(
  client: RelayfileFingerprintClient,
  workspaceId: string,
  path: string,
  correlationId: string,
  signal: AbortSignal | undefined,
): Promise<RelayfileFingerprintFile> {
  const file = await client.readFile(workspaceId, path, correlationId, signal);
  const encoding = file.encoding ?? "utf-8";
  const bytes =
    encoding === "base64"
      ? Buffer.from(file.content, "base64")
      : Buffer.from(file.content, "utf8");

  return {
    path: file.path,
    revision: file.revision,
    contentType: file.contentType,
    encoding,
    size: bytes.byteLength,
    sha256: sha256Hex(bytes),
  };
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

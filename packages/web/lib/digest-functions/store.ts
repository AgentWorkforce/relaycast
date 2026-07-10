import { createHmac } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { Resource } from "sst";
import { getDb } from "@/lib/db";
import { workspaceDigestFunctions } from "@/lib/db/schema";
import { createWorkflowStorageS3Client, readWorkflowStorageBucket as readConfiguredWorkflowStorageBucket } from "@/lib/storage";
import { bundleSource } from "./bundle";
import { contentHash } from "./hash";
import type { DigestFunctionSource, DigestRuntime } from "./types";
import { InvalidSourceError, QuotaExceededError } from "./types";

const ARTIFACT_PREFIX = "digest-functions";
const SIGNING_KEY_ID = "digest-function-signing-key-v1";

export class DigestFunctionDeployError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(
    message: string,
    code = "DIGEST_FUNCTION_ERROR",
    status = 500,
    details?: unknown,
  ) {
    super(message);
    this.name = "DigestFunctionDeployError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type DigestFunctionDeployInput = {
  slug: string;
  displayName: string | null;
  source: DigestFunctionSource;
};

export type DigestFunctionSummary = {
  digestFunctionId: string;
  name: string;
  version: number;
  status: string;
  sha256: string;
  bytes: number;
  createdAt: string;
};

export type DigestFunctionDetail = DigestFunctionSummary & {
  workspaceId: string;
  entrypoint: string;
  runtime: string;
  updatedAt: string;
};

export type DigestFunctionDisableResult = {
  digestFunctionId: string;
  status: "disabled";
  disabledAt: string;
  alreadyDisabled: boolean;
};

type DigestFunctionRow = typeof workspaceDigestFunctions.$inferSelect;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function failInput(message: string, details?: unknown): never {
  throw new DigestFunctionDeployError(
    message,
    "DIGEST_INPUT_INVALID",
    400,
    details,
  );
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseSource(value: unknown): DigestFunctionSource {
  if (!isRecord(value)) {
    failInput("Digest function source must be an object");
  }
  const files = value.files;
  if (!Array.isArray(files)) {
    failInput("Digest function source.files must be an array");
  }
  return {
    runtime: readString(value, "runtime") as DigestRuntime,
    entrypoint: readString(value, "entrypoint") ?? "",
    files: files.map((file, index) => {
      if (!isRecord(file)) {
        failInput("Digest function source file must be an object", { index });
      }
      if (typeof file.contents !== "string") {
        failInput("Digest function source file contents must be a string", {
          index,
        });
      }
      return {
        path: readString(file, "path") ?? "",
        contents: file.contents,
      };
    }),
  };
}

export function parseDigestFunctionDeployRequest(
  raw: unknown,
): DigestFunctionDeployInput {
  if (!isRecord(raw)) {
    failInput("Request body must be an object");
  }
  const sourceCandidate = isRecord(raw.source) ? raw.source : raw;
  const slug = readString(raw, "slug") ?? readString(raw, "name");
  if (!slug || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    failInput(
      "Digest function slug must be 1-63 lowercase letters, numbers, or hyphens",
    );
  }
  return {
    slug,
    displayName: readString(raw, "displayName") ?? readString(raw, "name"),
    source: parseSource(sourceCandidate),
  };
}

function readWorkflowStorageBucket(): string {
  const bucket = readConfiguredWorkflowStorageBucket();
  if (!bucket) {
    throw new DigestFunctionDeployError(
      "Digest function artifact storage is not configured",
      "DIGEST_ARTIFACT_STORAGE_MISSING",
      500,
    );
  }
  return bucket;
}

function readSigningKey(): string {
  if (typeof Resource !== "undefined" && Resource !== null) {
    const value = (Resource as unknown as {
      DigestFunctionSigningKey?: { value?: string };
    }).DigestFunctionSigningKey?.value;
    if (value) return value;
  }
  const value = process.env.DIGEST_FUNCTION_SIGNING_KEY;
  if (!value) {
    throw new DigestFunctionDeployError(
      "Digest function signing key is not configured",
      "DIGEST_SIGNING_KEY_MISSING",
      500,
    );
  }
  return value;
}

function s3Client(): S3Client {
  return createWorkflowStorageS3Client();
}

function artifactKey(workspaceId: string, sha256: string): string {
  return `${ARTIFACT_PREFIX}/${workspaceId}/${sha256}.bin`;
}

function signDigestFunction(input: {
  workspaceId: string;
  slug: string;
  sha256: string;
  bytes: number;
}): string {
  return createHmac("sha256", readSigningKey())
    .update(`${input.workspaceId}.${input.slug}.${input.sha256}.${input.bytes}`)
    .digest("base64url");
}

async function storeArtifact(input: {
  workspaceId: string;
  sha256: string;
  bundle: Uint8Array;
}): Promise<string> {
  const bucket = readWorkflowStorageBucket();
  const key = artifactKey(input.workspaceId, input.sha256);
  await s3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: Buffer.from(input.bundle),
      ContentType: "application/octet-stream",
      Metadata: {
        sha256: input.sha256,
        workspaceId: input.workspaceId,
      },
    }),
  );
  return `s3://${bucket}/${key}`;
}

function mapCompileError(error: unknown): never {
  if (error instanceof QuotaExceededError) {
    throw new DigestFunctionDeployError(error.message, error.code, 413, {
      bytes: error.bytes,
      limit: error.limit,
    });
  }
  if (error instanceof InvalidSourceError) {
    throw new DigestFunctionDeployError(error.message, error.code, 400);
  }
  throw error;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    isRecord(error) &&
    (error.code === "23505" ||
      String(error.message ?? "").includes(
        "workspace_digest_functions_workspace_slug_live_unique",
      ))
  );
}

function toSummary(row: DigestFunctionRow): DigestFunctionSummary {
  return {
    digestFunctionId: row.id,
    name: row.displayName ?? row.slug,
    version: 1,
    status: row.status,
    sha256: row.sourceHash,
    bytes: row.sourceSize,
    createdAt: row.createdAt.toISOString(),
  };
}

function toDetail(row: DigestFunctionRow): DigestFunctionDetail {
  return {
    ...toSummary(row),
    workspaceId: row.workspaceId,
    entrypoint: row.entrypoint,
    runtime: row.runtime,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseCursor(value: string | null): { createdAt: Date; id: string } | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const [createdAtRaw, id] = decoded.split("|");
    const createdAt = new Date(createdAtRaw ?? "");
    if (!id || Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString(
    "base64url",
  );
}

function isDeployInput(value: unknown): value is DigestFunctionDeployInput {
  return (
    isRecord(value) &&
    typeof value.slug === "string" &&
    isRecord(value.source) &&
    typeof value.source.entrypoint === "string" &&
    typeof value.source.runtime === "string" &&
    Array.isArray(value.source.files)
  );
}

export async function deployDigestFunction(input: {
  workspaceId: string;
  requesterUserId: string;
  body: unknown;
}): Promise<{
  digestFunctionId: string;
  version: number;
  status: string;
  sha256: string;
}> {
  const parsed = isDeployInput(input.body)
    ? input.body
    : parseDigestFunctionDeployRequest(input.body);
  let bundle: Uint8Array;
  let hash: string;
  try {
    bundle = bundleSource(parsed.source);
    hash = contentHash(bundle);
  } catch (error) {
    mapCompileError(error);
  }

  const artifactRef = await storeArtifact({
    workspaceId: input.workspaceId,
    sha256: hash,
    bundle,
  });
  const now = new Date();
  const signature = signDigestFunction({
    workspaceId: input.workspaceId,
    slug: parsed.slug,
    sha256: hash,
    bytes: bundle.byteLength,
  });

  try {
    const [row] = await getDb()
      .insert(workspaceDigestFunctions)
      .values({
        workspaceId: input.workspaceId,
        slug: parsed.slug,
        displayName: parsed.displayName,
        status: "active",
        runtime: parsed.source.runtime,
        entrypoint: parsed.source.entrypoint,
        sourceHash: hash,
        sourceSize: bundle.byteLength,
        compiledArtifactRef: artifactRef,
        signature,
        signingKeyId: SIGNING_KEY_ID,
        deployedByUserId: input.requesterUserId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return {
      digestFunctionId: row.id,
      version: 1,
      status: row.status,
      sha256: row.sourceHash,
    };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DigestFunctionDeployError(
        "Digest function slug is already active in this workspace",
        "DIGEST_FUNCTION_SLUG_CONFLICT",
        409,
      );
    }
    throw error;
  }
}

export async function listDigestFunctions(input: {
  workspaceId: string;
  cursor: string | null;
  limit: number;
}): Promise<{
  digestFunctions: DigestFunctionSummary[];
  nextCursor: string | null;
}> {
  const limit = Math.max(1, Math.min(input.limit, 100));
  const cursor = parseCursor(input.cursor);
  const predicates = [eq(workspaceDigestFunctions.workspaceId, input.workspaceId)];
  if (cursor) {
    predicates.push(
      or(
        lt(workspaceDigestFunctions.createdAt, cursor.createdAt),
        and(
          eq(workspaceDigestFunctions.createdAt, cursor.createdAt),
          lt(workspaceDigestFunctions.id, cursor.id),
        ),
      )!,
    );
  }

  const rows = await getDb()
    .select()
    .from(workspaceDigestFunctions)
    .where(and(...predicates))
    .orderBy(
      desc(workspaceDigestFunctions.createdAt),
      desc(workspaceDigestFunctions.id),
    )
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    digestFunctions: page.map(toSummary),
    nextCursor:
      rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export async function getDigestFunction(input: {
  workspaceId: string;
  digestFunctionId: string;
}): Promise<DigestFunctionDetail | null> {
  const [row] = await getDb()
    .select()
    .from(workspaceDigestFunctions)
    .where(
      and(
        eq(workspaceDigestFunctions.workspaceId, input.workspaceId),
        eq(workspaceDigestFunctions.id, input.digestFunctionId),
      ),
    )
    .limit(1);
  return row ? toDetail(row) : null;
}

export async function disableDigestFunction(input: {
  workspaceId: string;
  digestFunctionId: string;
  requesterUserId: string;
}): Promise<DigestFunctionDisableResult | null> {
  const [current] = await getDb()
    .select()
    .from(workspaceDigestFunctions)
    .where(
      and(
        eq(workspaceDigestFunctions.workspaceId, input.workspaceId),
        eq(workspaceDigestFunctions.id, input.digestFunctionId),
      ),
    )
    .limit(1);
  if (!current) return null;
  if (current.status === "disabled" && current.disabledAt) {
    return {
      digestFunctionId: current.id,
      status: "disabled",
      disabledAt: current.disabledAt.toISOString(),
      alreadyDisabled: true,
    };
  }

  const disabledAt = new Date();
  const [row] = await getDb()
    .update(workspaceDigestFunctions)
    .set({
      status: "disabled",
      disabledAt,
      disabledByUserId: input.requesterUserId,
      updatedAt: disabledAt,
    })
    .where(
      and(
        eq(workspaceDigestFunctions.workspaceId, input.workspaceId),
        eq(workspaceDigestFunctions.id, input.digestFunctionId),
      ),
    )
    .returning();
  return row
    ? {
        digestFunctionId: row.id,
        status: "disabled",
        disabledAt: (row.disabledAt ?? disabledAt).toISOString(),
        alreadyDisabled: false,
      }
    : null;
}

export async function fetchRecentInvocationLogs(input: {
  workspaceId: string;
  digestFunctionId: string;
  since: Date | null;
  limit: number;
}): Promise<{
  digestFunctionId: string;
  logs: Array<{
    invocationId: string;
    occurredAt: string;
    level: string;
    message: string;
    durationMs?: number;
  }>;
  nextCursor: string | null;
} | null> {
  void input.since;
  void input.limit;
  const row = await getDigestFunction(input);
  if (!row) return null;
  return {
    digestFunctionId: input.digestFunctionId,
    logs: [],
    nextCursor: null,
  };
}

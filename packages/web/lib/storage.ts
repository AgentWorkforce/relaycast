import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import { Resource } from "sst";
import { getCloudflareContext } from "@/lib/cloudflare-context";
import { optionalEnv } from "@/lib/env";
import { isWorkerRuntime } from "@/lib/aws/runtime";
import {
  mintCredentialStoreCredentials,
  mintScopedS3Credentials,
} from "@/lib/aws/sts-credentials";

type WorkerEnv = Record<string, unknown>;
type ResourceValue = { value?: unknown };
type CloudApiS3Credentials = {
  backend: "cloud-api";
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  bucket: string;
  prefix: string;
  cloudApiUrl: string;
  cloudApiAccessToken: string;
  cloudApiRefreshToken?: string;
};
type R2ObjectBody = {
  body: ReadableStream<Uint8Array> | null;
  size?: number;
  httpEtag?: string;
  writeHttpMetadata?: (headers: Headers) => void;
};
type R2Bucket = {
  put: (
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | string | null,
    options?: { httpMetadata?: { contentType?: string } },
  ) => Promise<unknown>;
  get: (
    key: string,
    options?: { range?: { offset: number; length?: number } },
  ) => Promise<R2ObjectBody | null>;
  head: (key: string) => Promise<R2ObjectBody | null>;
  list: (options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }) => Promise<{
    objects: Array<{ key: string; size?: number }>;
    truncated: boolean;
    cursor?: string;
  }>;
  createMultipartUpload?: (
    key: string,
    options?: { httpMetadata?: { contentType?: string } },
  ) => Promise<{
    uploadId: string;
    uploadPart: (partNumber: number, value: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView) => Promise<{ etag: string }>;
    complete: (parts: Array<{ partNumber: number; etag: string }>) => Promise<unknown>;
    abort: () => Promise<void>;
  }>;
  resumeMultipartUpload?: (
    key: string,
    uploadId: string,
  ) => {
    uploadPart: (partNumber: number, value: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView) => Promise<{ etag: string }>;
    complete: (parts: Array<{ partNumber: number; etag: string }>) => Promise<unknown>;
    abort: () => Promise<void>;
  };
};
export type WorkflowStorageBackend = "s3" | "r2";
export type WorkflowStorageObject = {
  body: ReadableStream<Uint8Array> | null;
  size: number;
  headers?: Headers;
};
type CredentialNames = {
  accessKey: string[];
  secretKey: string[];
  sessionToken: string[];
};

const WORKFLOW_STORAGE_CREDENTIAL_NAMES: CredentialNames = {
  accessKey: ["AWS_ACCESS_KEY_ID", "S3_ACCESS_KEY_ID", "WORKFLOW_STORAGE_ACCESS_KEY_ID"],
  secretKey: ["AWS_SECRET_ACCESS_KEY", "S3_SECRET_ACCESS_KEY", "WORKFLOW_STORAGE_SECRET_ACCESS_KEY"],
  sessionToken: ["AWS_SESSION_TOKEN", "S3_SESSION_TOKEN", "WORKFLOW_STORAGE_SESSION_TOKEN"],
};

const WORKFLOW_STORAGE_RESOURCE_CREDENTIAL_NAMES: CredentialNames = {
  accessKey: ["S3AccessKeyId", "WorkflowStorageAccessKeyId", "AwsAccessKeyId"],
  secretKey: ["S3SecretAccessKey", "WorkflowStorageSecretAccessKey", "AwsSecretAccessKey"],
  sessionToken: ["S3SessionToken", "WorkflowStorageSessionToken", "AwsSessionToken"],
};

let cachedS3Client: {
  key: string;
  client: S3Client;
} | undefined;

function readWorkerEnv(): WorkerEnv | undefined {
  try {
    return getCloudflareContext({ async: false }).env as WorkerEnv | undefined;
  } catch {
    return undefined;
  }
}

function readR2Bucket(env: WorkerEnv | undefined = readWorkerEnv()): R2Bucket | undefined {
  const bucket = env?.WORKFLOW_STORAGE_R2;
  if (bucket && typeof bucket === "object") {
    return bucket as R2Bucket;
  }
  return undefined;
}

function requireR2Bucket(): R2Bucket {
  const bucket = readR2Bucket();
  if (!bucket) {
    throw new Error("Workflow storage R2 binding is not configured");
  }
  return bucket;
}

function readString(record: WorkerEnv | undefined, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = record?.[name];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function readResourceValue(...names: string[]): string | undefined {
  const resources = Resource as unknown as Record<string, ResourceValue | undefined>;
  for (const name of names) {
    try {
      const value = resources[name]?.value;
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    } catch {
      // Missing Resource binding; keep looking for local-dev fallbacks.
    }
  }
  return undefined;
}

function readCredentialTuple(
  source: "worker" | "resource" | "process",
  env: WorkerEnv | undefined,
): Pick<Required<S3ClientConfig>, "credentials">["credentials"] | undefined {
  const names =
    source === "resource"
      ? WORKFLOW_STORAGE_RESOURCE_CREDENTIAL_NAMES
      : WORKFLOW_STORAGE_CREDENTIAL_NAMES;
  const read =
    source === "worker"
      ? (...keys: string[]) => readString(env, ...keys)
      : source === "resource"
        ? readResourceValue
        : (...keys: string[]) => keys.map(optionalEnv).find(Boolean);

  const accessKeyId = read(...names.accessKey);
  const secretAccessKey = read(...names.secretKey);
  if (!accessKeyId || !secretAccessKey) {
    return undefined;
  }

  const sessionToken = read(...names.sessionToken);
  return sessionToken ? { accessKeyId, secretAccessKey, sessionToken } : { accessKeyId, secretAccessKey };
}

function readWorkflowStorageCredentials(
  env: WorkerEnv | undefined,
): Pick<Required<S3ClientConfig>, "credentials">["credentials"] | undefined {
  return (
    readCredentialTuple("worker", env) ??
    readCredentialTuple("resource", env) ??
    readCredentialTuple("process", env)
  );
}

function s3ClientCacheKey(
  region: string,
  credentials: Pick<Required<S3ClientConfig>, "credentials">["credentials"] | undefined,
): string {
  if (!credentials || typeof credentials === "function") {
    return `${region}:default`;
  }
  return `${region}:${credentials.accessKeyId}:${credentials.sessionToken ?? ""}`;
}

function workerFetchRequestHandlerConfig(): Pick<S3ClientConfig, "requestHandler"> {
  return { requestHandler: new FetchHttpHandler() };
}

export function readWorkflowStorageBucket(): string | undefined {
  const env = readWorkerEnv();
  const workerBucket = readString(env, "WORKFLOW_STORAGE_BUCKET", "S3_BUCKET");
  if (workerBucket) {
    return workerBucket;
  }

  try {
    const bucket = Resource.WorkflowStorage.bucketName;
    if (bucket) return bucket;
  } catch {
    // Fall through to local process env.
  }

  return optionalEnv("WORKFLOW_STORAGE_BUCKET") ?? optionalEnv("S3_BUCKET");
}

export function getWorkflowStorageBackend(): WorkflowStorageBackend {
  const env = readWorkerEnv();
  const configured = readString(env, "WORKFLOW_STORAGE_BACKEND") ?? optionalEnv("WORKFLOW_STORAGE_BACKEND");
  if (configured === "r2") {
    return "r2";
  }
  return "s3";
}

export function isWorkflowStorageConfigured(): boolean {
  return getWorkflowStorageBackend() === "r2" ? Boolean(readR2Bucket()) : Boolean(readWorkflowStorageBucket());
}

export function buildWorkflowStoragePrefix(input: { userId: string; runId: string }): string {
  return `${input.userId}/${input.runId}`;
}

export function buildCloudApiWorkflowStorageCredentials(input: {
  userId: string;
  runId: string;
  apiUrl: string;
  accessToken: string;
  refreshToken?: string;
}): CloudApiS3Credentials {
  const env = readWorkerEnv();
  const bucket =
    readString(env, "WORKFLOW_STORAGE_R2_BUCKET")
    ?? safeWorkflowStorageResource("r2BucketName")
    ?? "workflow-storage-r2";

  return {
    backend: "cloud-api",
    accessKeyId: "cloud-api",
    secretAccessKey: "cloud-api",
    sessionToken: input.accessToken,
    bucket,
    prefix: buildWorkflowStoragePrefix(input),
    cloudApiUrl: input.apiUrl,
    cloudApiAccessToken: input.accessToken,
    ...(input.refreshToken ? { cloudApiRefreshToken: input.refreshToken } : {}),
  };
}

export function joinWorkflowStorageKey(prefix: string, key: string): string {
  return `${prefix.replace(/\/+$/, "")}/${key.replace(/^\/+/, "")}`;
}

async function streamToBuffer(body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): Promise<Buffer> {
  if (Symbol.asyncIterator in body) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Buffer[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function bodyToS3Body(
  body: ArrayBuffer | ArrayBufferView | string | null,
): string | Uint8Array | undefined {
  if (body == null) {
    return undefined;
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}

function parseRange(rangeHeader: string | null): { offset: number; length?: number } | undefined {
  if (!rangeHeader) return undefined;
  const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return undefined;
  const offset = Number.parseInt(match[1], 10);
  if (!Number.isFinite(offset) || offset < 0) return undefined;
  if (!match[2]) return { offset };
  const end = Number.parseInt(match[2], 10);
  if (!Number.isFinite(end) || end < offset) return { offset };
  return { offset, length: end - offset + 1 };
}

// `body` deliberately excludes ReadableStream: R2 rejects streams of unknown
// length, so callers must buffer (e.g. `await request.arrayBuffer()`) first.
export async function putWorkflowStorageObject(input: {
  key: string;
  body: ArrayBuffer | ArrayBufferView | string | null;
  contentType?: string | null;
}): Promise<void> {
  if (getWorkflowStorageBackend() === "r2") {
    const r2 = requireR2Bucket();
    await r2.put(input.key, input.body, {
      httpMetadata: input.contentType ? { contentType: input.contentType } : undefined,
    });
    return;
  }

  const bucket = readWorkflowStorageBucket();
  if (!bucket) {
    throw new Error("Workflow storage bucket is not configured");
  }
  const s3 = createWorkflowStorageS3Client();
  const body = bodyToS3Body(input.body);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: input.key,
      ...(body ? { Body: body } : {}),
      ...(input.contentType ? { ContentType: input.contentType } : {}),
    }),
  );
}

export async function headWorkflowStorageObject(key: string): Promise<{ size: number; headers?: Headers } | null> {
  if (getWorkflowStorageBackend() === "r2") {
    const r2 = requireR2Bucket();
    const object = await r2.head(key);
    if (!object) return null;
    const headers = new Headers();
    object.writeHttpMetadata?.(headers);
    if (object.httpEtag) headers.set("etag", object.httpEtag);
    return { size: object.size ?? 0, headers };
  }

  const bucket = readWorkflowStorageBucket();
  if (!bucket) return null;
  const s3 = createWorkflowStorageS3Client();
  try {
    const response = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { size: response.ContentLength ?? 0 };
  } catch (err) {
    if (err && typeof err === "object" && "name" in err && (err.name === "NoSuchKey" || err.name === "NotFound")) {
      return null;
    }
    throw err;
  }
}

export async function getWorkflowStorageObject(input: {
  key: string;
  rangeHeader?: string | null;
}): Promise<WorkflowStorageObject | null> {
  const range = parseRange(input.rangeHeader ?? null);
  if (getWorkflowStorageBackend() === "r2") {
    const r2 = requireR2Bucket();
    const object = await r2.get(input.key, range ? { range } : undefined);
    if (!object) return null;
    const headers = new Headers();
    object.writeHttpMetadata?.(headers);
    if (object.httpEtag) headers.set("etag", object.httpEtag);
    return { body: object.body, size: object.size ?? 0, headers };
  }

  const bucket = readWorkflowStorageBucket();
  if (!bucket) return null;
  const s3 = createWorkflowStorageS3Client();
  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: input.key,
        ...(input.rangeHeader ? { Range: input.rangeHeader } : {}),
      }),
    );
    const body = response.Body ? await streamToBuffer(response.Body as AsyncIterable<Uint8Array>) : Buffer.alloc(0);
    return {
      body: new Response(new Uint8Array(body)).body,
      size: response.ContentLength ?? body.length,
    };
  } catch (err) {
    if (err && typeof err === "object" && "name" in err && (err.name === "NoSuchKey" || err.name === "NotFound")) {
      return null;
    }
    throw err;
  }
}

export async function listWorkflowStorageObjects(input: {
  prefix: string;
}): Promise<Array<{ key: string; size?: number }>> {
  if (getWorkflowStorageBackend() === "r2") {
    const r2 = requireR2Bucket();
    const objects: Array<{ key: string; size?: number }> = [];
    let cursor: string | undefined;
    do {
      const page = await r2.list({ prefix: input.prefix, cursor });
      objects.push(...page.objects.map((object) => ({ key: object.key, size: object.size })));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return objects;
  }

  const bucket = readWorkflowStorageBucket();
  if (!bucket) return [];
  const s3 = createWorkflowStorageS3Client();
  const objects: Array<{ key: string; size?: number }> = [];
  let continuationToken: string | undefined;
  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: input.prefix,
        ContinuationToken: continuationToken,
      }),
    );
    objects.push(...(response.Contents ?? []).flatMap((object) => object.Key ? [{ key: object.Key, size: object.Size }] : []));
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

export async function createWorkflowStorageMultipartUpload(input: {
  key: string;
  contentType?: string | null;
}): Promise<string> {
  const r2 = getWorkflowStorageBackend() === "r2" ? requireR2Bucket() : undefined;
  if (!r2?.createMultipartUpload) {
    throw new Error("Workflow storage multipart upload is not configured");
  }
  const upload = await r2.createMultipartUpload(input.key, {
    httpMetadata: input.contentType ? { contentType: input.contentType } : undefined,
  });
  return upload.uploadId;
}

// `body` deliberately excludes ReadableStream — same R2 constraint as
// `putWorkflowStorageObject`.
export async function uploadWorkflowStoragePart(input: {
  key: string;
  uploadId: string;
  partNumber: number;
  body: ArrayBuffer | ArrayBufferView;
}): Promise<string> {
  const r2 = getWorkflowStorageBackend() === "r2" ? requireR2Bucket() : undefined;
  if (!r2?.resumeMultipartUpload) {
    throw new Error("Workflow storage multipart upload is not configured");
  }
  const upload = r2.resumeMultipartUpload(input.key, input.uploadId);
  const part = await upload.uploadPart(input.partNumber, input.body);
  return part.etag;
}

export async function completeWorkflowStorageMultipartUpload(input: {
  key: string;
  uploadId: string;
  parts: Array<{ PartNumber?: number; partNumber?: number; ETag?: string; etag?: string }>;
}): Promise<void> {
  const r2 = getWorkflowStorageBackend() === "r2" ? requireR2Bucket() : undefined;
  if (!r2?.resumeMultipartUpload) {
    throw new Error("Workflow storage multipart upload is not configured");
  }
  const upload = r2.resumeMultipartUpload(input.key, input.uploadId);
  await upload.complete(
    input.parts.map((part) => ({
      partNumber: part.partNumber ?? part.PartNumber ?? 0,
      etag: part.etag ?? part.ETag ?? "",
    })).filter((part) => part.partNumber > 0 && part.etag.length > 0),
  );
}

export async function abortWorkflowStorageMultipartUpload(input: {
  key: string;
  uploadId: string;
}): Promise<void> {
  const r2 = getWorkflowStorageBackend() === "r2" ? requireR2Bucket() : undefined;
  if (!r2?.resumeMultipartUpload) {
    throw new Error("Workflow storage multipart upload is not configured");
  }
  const upload = r2.resumeMultipartUpload(input.key, input.uploadId);
  await upload.abort();
}

function safeWorkflowStorageResource(prop: "bucketName" | "r2BucketName" | "stsRoleArn"): string | undefined {
  try {
    const resource = Resource.WorkflowStorage as unknown as Record<string, unknown>;
    const value = resource[prop];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Worker-aware S3 client factory for run-scoped reads/writes.
 *
 * On the Cloudflare Worker the static workflow-storage credentials we'd
 * otherwise hand to `createWorkflowStorageS3Client` aren't available — the
 * Worker has no IAM and we don't want to bind long-lived AWS keys to the
 * edge. Routes that need to read or write under a known
 * `<userId>/<runId>/` prefix should call this helper, which mints scoped
 * temporary credentials via the STS broker on the Worker path and falls
 * back to the existing static-credentials client on the Lambda path
 * (where the IAM role grants bucket-wide access).
 *
 * On Lambda we ignore the (userId, runId) arguments and return the same
 * shared client `createWorkflowStorageS3Client()` returns; this keeps
 * Lambda behaviour byte-identical to today while letting Worker callers
 * pass their scope through.
 */
export async function createWorkflowStorageS3ClientForRun(input: {
  userId: string;
  runId: string;
}): Promise<S3Client> {
  if (!isWorkerRuntime()) {
    return createWorkflowStorageS3Client();
  }

  // Worker path. mintScopedS3Credentials goes through the broker.
  const credentials = await mintScopedS3Credentials({
    userId: input.userId,
    runId: input.runId,
  });
  const env = readWorkerEnv();
  const region =
    readString(env, "AWS_REGION", "AWS_DEFAULT_REGION") ?? "us-east-1";
  return new S3Client({
    region,
    defaultsMode: "standard",
    ...workerFetchRequestHandlerConfig(),
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  });
}

/**
 * Worker-aware S3 client factory for the credential-store routes.
 *
 * The CredentialStore writes to `credentials/<userId>/...` which sits
 * outside the workflow-run prefix the standard broker scope grants. On
 * the Worker we mint a separate "credential-store" scope token; on
 * Lambda we hand back the shared client (whose IAM role covers the
 * whole bucket).
 *
 * Returns a client suitable for passing into `new CredentialStore({
 * client: ... })` — the constructor optionally accepts a pre-built
 * client so route handlers don't have to bypass CredentialStore for
 * Worker support.
 */
export async function createCredentialStoreS3Client(input: {
  userId: string;
}): Promise<S3Client> {
  if (!isWorkerRuntime()) {
    return createWorkflowStorageS3Client();
  }
  const credentials = await mintCredentialStoreCredentials({
    userId: input.userId,
  });
  const env = readWorkerEnv();
  const region =
    readString(env, "AWS_REGION", "AWS_DEFAULT_REGION") ?? "us-east-1";
  return new S3Client({
    region,
    defaultsMode: "standard",
    ...workerFetchRequestHandlerConfig(),
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  });
}

export function createWorkflowStorageS3Client(): S3Client {
  const env = readWorkerEnv();
  const inWorkerScope = env !== undefined;
  const region =
    readString(env, "AWS_REGION", "AWS_DEFAULT_REGION") ??
    optionalEnv("AWS_REGION") ??
    optionalEnv("AWS_DEFAULT_REGION") ??
    "us-east-1";
  const credentials = readWorkflowStorageCredentials(env);
  if (inWorkerScope && !credentials) {
    throw new Error("[storage] WorkflowStorage S3 credentials are not configured");
  }

  const key = s3ClientCacheKey(region, credentials);
  if (cachedS3Client?.key === key) {
    return cachedS3Client.client;
  }

  const client = new S3Client({
    region,
    defaultsMode: "standard",
    ...(inWorkerScope ? workerFetchRequestHandlerConfig() : {}),
    ...(credentials ? { credentials } : {}),
  });
  cachedS3Client = { key, client };
  return client;
}

/**
 * Persona bundle storage — content-addressed by SHA256 in the
 * `WorkflowStorage` S3 bucket under `persona-bundles/<sha256>.json`.
 *
 * Why content-addressing: the bundle (runner.mjs + agent.bundle.mjs +
 * package.json) has poor entropy across personas — `runner.mjs` is
 * boilerplate shipped from `@agentworkforce/runtime`, `package.json` is
 * mostly the same dep manifest. Two personas with identical bundles
 * dedupe to a single S3 object. A spec-only persona update (changed
 * description, new schedule, etc.) writes zero bundle bytes because
 * the hash is unchanged.
 *
 * The hash is persisted on `persona_versions.bundle_sha256`; the tick
 * handler reads it when provisioning a sandbox on-demand at trigger
 * fire (cloud#604 + tick-handler follow-up).
 *
 * Cleanup is a separate concern — a future GC sweep walks
 * `persona_versions` for live `bundle_sha256` values and deletes S3
 * objects whose hashes don't appear in that set. Out of scope here.
 */

import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  createWorkflowStorageS3Client,
  getWorkflowStorageObject,
  putWorkflowStorageObject,
  readWorkflowStorageBucket as readConfiguredWorkflowStorageBucket,
} from "@/lib/storage";
import type { PersonaBundle } from "./persona-deploy";

const BUNDLE_PREFIX = "persona-bundles";

function readWorkflowStorageBucket(): string {
  const bucket = readConfiguredWorkflowStorageBucket();
  if (!bucket) {
    throw new Error(
      "Persona bundle storage requires WorkflowStorage bucket — set Resource.WorkflowStorage or WORKFLOW_STORAGE_BUCKET.",
    );
  }
  return bucket;
}

function s3Client(): S3Client {
  return createWorkflowStorageS3Client();
}

function bundleKey(sha256: string): string {
  return `${BUNDLE_PREFIX}/${sha256}.json`;
}

/**
 * Compute a stable SHA256 hex over `{ runner, agent, packageJson }`.
 *
 * The hash is part of the persisted state (FK from
 * `persona_versions.bundle_sha256`), so it must be deterministic across
 * deploys. `packageJson` is JSON-canonicalized by key-sort before
 * hashing — otherwise insertion-order differences between Next.js
 * builds produce different hashes for byte-equivalent JSON.
 */
export function bundleContentHash(bundle: PersonaBundle): string {
  const canonical = JSON.stringify({
    runner: bundle.runner,
    agent: bundle.agent,
    packageJson: canonicalizeJson(bundle.packageJson),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalizeJson(record[key]);
        return acc;
      }, {});
  }
  return value;
}

export interface StoredBundle {
  sha256: string;
  bytesWritten: number;
  /** `true` when the object already existed; `false` after a fresh put. */
  reused: boolean;
}

/**
 * Upload the persona bundle to S3, keyed by its content hash.
 *
 * Idempotent: re-uploading a byte-equivalent bundle hits the same key
 * and is a no-op (well, an S3 PutObject overwrite — same bytes, same
 * hash). Returns the hash so callers can persist it on
 * `persona_versions.bundle_sha256`.
 */
export async function storeBundle(
  bundle: PersonaBundle,
  opts: { client?: S3Client; bucket?: string } = {},
): Promise<StoredBundle> {
  const sha256 = bundleContentHash(bundle);
  const body = JSON.stringify({
    runner: bundle.runner,
    agent: bundle.agent,
    packageJson: bundle.packageJson,
  });

  if (!opts.client && !opts.bucket) {
    await putWorkflowStorageObject({
      key: bundleKey(sha256),
      body,
      contentType: "application/json",
    });
    return {
      sha256,
      bytesWritten: Buffer.byteLength(body, "utf8"),
      reused: false,
    };
  }

  const client = opts.client ?? s3Client();
  const bucket = opts.bucket ?? readWorkflowStorageBucket();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: bundleKey(sha256),
      Body: body,
      ContentType: "application/json",
    }),
  );
  return {
    sha256,
    bytesWritten: Buffer.byteLength(body, "utf8"),
    // Without a HeadObject pre-check we can't tell new vs. overwrite,
    // and the cost of HeadObject ≈ cost of PutObject for these sizes —
    // not worth it. Reported as `false` (assume new); callers that
    // need accurate stats should sample upstream.
    reused: false,
  };
}

/**
 * Fetch a previously-stored bundle by hash. Throws if missing — callers
 * (the tick handler) should surface a clear error to the trigger source
 * because the agent cannot run without its bundle.
 */
export async function loadBundle(
  sha256: string,
  opts: { client?: S3Client; bucket?: string } = {},
): Promise<PersonaBundle> {
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`loadBundle: invalid sha256 ${JSON.stringify(sha256)}`);
  }

  if (!opts.client && !opts.bucket) {
    const object = await getWorkflowStorageObject({ key: bundleKey(sha256) });
    if (!object?.body) {
      throw new Error(`Persona bundle ${sha256} not found in WorkflowStorage`);
    }
    const text = await new Response(object.body).text();
    return JSON.parse(text) as PersonaBundle;
  }

  const client = opts.client ?? s3Client();
  const bucket = opts.bucket ?? readWorkflowStorageBucket();
  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: bundleKey(sha256),
    }),
  );
  if (!response.Body) {
    throw new Error(`loadBundle: empty body for ${sha256}`);
  }
  const text = await response.Body.transformToString("utf-8");
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`loadBundle: malformed body for ${sha256}`);
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.runner !== "string" ||
    typeof record.agent !== "string" ||
    !record.packageJson ||
    typeof record.packageJson !== "object" ||
    Array.isArray(record.packageJson)
  ) {
    throw new Error(`loadBundle: bundle shape invalid for ${sha256}`);
  }
  return {
    runner: record.runner,
    agent: record.agent,
    packageJson: record.packageJson as Record<string, unknown>,
  };
}

/** Test seam — module-level S3 client can be substituted in tests. */
export function __setS3ClientForTesting(_client: S3Client): void {
  // Reserved for future injection-style tests; current call sites accept
  // an injected `client` via the `opts.client` option, which is the
  // recommended pattern. Kept exported for symmetry with sibling stores.
  void _client;
}

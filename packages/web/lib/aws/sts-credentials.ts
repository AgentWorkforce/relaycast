/**
 * Runtime-agnostic façade for minting scoped S3 credentials.
 *
 * On Lambda the existing `mintS3Credentials` from `@cloud/core` runs, using
 * the lambda's own IAM identity to call `STSClient.AssumeRole`. On the
 * Cloudflare Worker (which has no IAM) the request is forwarded to the
 * Lambda STS broker via HMAC-signed HTTPS.
 *
 * Route handlers should call this façade rather than `mintS3Credentials`
 * directly so the same handler code can run unmodified under both
 * runtimes — Phase 3 cutover requires that.
 */

import type { S3Credentials } from "@cloud/core/auth/s3-credentials.js";
import { getStsCredentials, type BrokerScope } from "./broker-client";
import { isWorkerRuntime, readBrokerConfig } from "./runtime";

export type MintS3CredentialsInput = {
  userId: string;
  runId: string;
  /** Required on Lambda (passed straight to STS). Ignored on Worker (broker reads from SST link). */
  roleArn?: string;
  /** Required on Lambda. Ignored on Worker (broker reads from SST link). */
  bucket?: string;
  durationSeconds?: number;
};

export type MintCredentialStoreInput = {
  userId: string;
  /** Required on Lambda. Ignored on Worker (broker reads from SST link). */
  bucket?: string;
  durationSeconds?: number;
};

/**
 * Returns scoped S3 credentials with read+write access to
 * `s3://<bucket>/<userId>/<runId>/*`.
 *
 * Errors propagate from the underlying runtime path:
 *   - Lambda: STSClient errors (network, throttling, AccessDenied)
 *   - Worker: BrokerClientError (4xx terminal, 5xx after retries)
 *
 * Caller is responsible for translating these to HTTP responses.
 */
export async function mintScopedS3Credentials(
  input: MintS3CredentialsInput,
): Promise<S3Credentials & { expiresAt?: string }> {
  if (isWorkerRuntime()) {
    return mintViaBroker({
      scope: "workflow-run",
      userId: input.userId,
      runId: input.runId,
      durationSeconds: input.durationSeconds,
    });
  }

  // Lambda path. Defer the import so the Worker bundle never pulls in
  // `@aws-sdk/client-sts` (the Worker has no IAM and the SDK has Node-only
  // transports that fail to resolve under workerd).
  const { mintS3Credentials } = await import("@cloud/core/auth/s3-credentials.js");
  if (!input.roleArn || !input.bucket) {
    throw new Error(
      "[aws/sts-credentials] roleArn and bucket are required on the Lambda path",
    );
  }
  return mintS3Credentials({
    userId: input.userId,
    runId: input.runId,
    roleArn: input.roleArn,
    bucket: input.bucket,
    durationSeconds: input.durationSeconds,
  });
}

async function mintViaBroker(input: {
  scope: BrokerScope;
  userId: string;
  runId?: string;
  durationSeconds?: number;
}): Promise<S3Credentials & { expiresAt?: string }> {
  const config = readBrokerConfig();
  if (!config) {
    throw new Error(
      "[aws/sts-credentials] expected Worker runtime to expose broker config",
    );
  }
  const credentials = await getStsCredentials(
    {
      scope: input.scope,
      userId: input.userId,
      runId: input.runId,
      durationSeconds: input.durationSeconds,
    },
    config,
  );
  return {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    bucket: credentials.bucket,
    prefix: credentials.prefix,
    expiresAt: credentials.expiresAt,
  };
}

/**
 * Worker-only path for the credential-store routes (BYOK, credential
 * refresh, cli/auth/complete). Returns scoped temp creds for
 * `s3://<bucket>/credentials/<userId>/*`.
 *
 * Lambda callers should NOT call this — they don't need scoped creds,
 * the lambda's IAM role already grants bucket-wide access. Throws on
 * Lambda to surface accidental call-site drift.
 */
export async function mintCredentialStoreCredentials(
  input: MintCredentialStoreInput,
): Promise<S3Credentials & { expiresAt?: string }> {
  if (!isWorkerRuntime()) {
    throw new Error(
      "[aws/sts-credentials] mintCredentialStoreCredentials is Worker-only — Lambda code should use the default credential chain",
    );
  }
  return mintViaBroker({
    scope: "credential-store",
    userId: input.userId,
    durationSeconds: input.durationSeconds,
  });
}

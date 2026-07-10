import { NextRequest, NextResponse } from "next/server";
import { Resource } from "sst";
import { mintScopedS3Credentials } from "@/lib/aws/sts-credentials";
import { BrokerClientError } from "@/lib/aws/broker-client";
import { isWorkerRuntime } from "@/lib/aws/runtime";
import { requireAuthScope, requireSessionAuth, resolveRequestAuth } from "@/lib/auth/request-auth";
import { createApiTokenSession } from "@/lib/auth/api-token-store";
import { getConfiguredAppOrigin } from "@/lib/app-origin";
import { toAbsoluteAppUrl } from "@/lib/app-path";
import {
  buildCloudApiWorkflowStorageCredentials,
  getWorkflowStorageBackend,
} from "@/lib/storage";

export async function POST(request: NextRequest) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireSessionAuth(auth) && !requireAuthScope(auth, "cli:auth")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const runId = crypto.randomUUID();
  const storageBackend = getWorkflowStorageBackend();
  if (storageBackend === "r2") {
    const issuedToken = auth.bearerToken
      ? null
      : await createApiTokenSession({
          subjectType: "cli",
          userId: auth.userId,
          workspaceId: auth.workspaceId,
          organizationId: auth.organizationId,
          runId,
          scopes: ["workflow:invoke:write"],
          accessTokenTtlSeconds: 60 * 30,
          refreshTokenTtlSeconds: 60 * 60 * 24,
        });
    const accessToken = auth.bearerToken ?? issuedToken?.accessToken ?? "";
    return NextResponse.json({
      runId,
      s3Credentials: buildCloudApiWorkflowStorageCredentials({
        userId: auth.userId,
        runId,
        apiUrl: toAbsoluteAppUrl(getConfiguredAppOrigin(), "/").toString(),
        accessToken,
        refreshToken: issuedToken?.refreshToken,
      }),
      s3CodeKey: "code.tar.gz",
      workflowStorage: { backend: "cloud-api" },
    });
  }

  // On Lambda these come from the SST link; the Worker S3 fallback path goes
  // through the broker which reads them server-side, so they're optional under
  // `mintScopedS3Credentials`. Read them eagerly anyway so the Lambda path
  // keeps its existing 500-on-misconfig behaviour.
  const roleArn = safeResource("stsRoleArn");
  const bucket = safeResource("bucketName");
  // Lambda must have these from the SST link; missing → server misconfig
  // (this preserves the pre-broker 500-on-misconfig contract). Worker reads
  // them server-side via the broker, so we don't gate the request on them.
  if (!isWorkerRuntime() && (!roleArn || !bucket)) {
    return NextResponse.json(
      { error: "Server misconfigured: STS role or workflow storage bucket missing" },
      { status: 500 },
    );
  }

  try {
    const s3Credentials = await mintScopedS3Credentials({
      userId: auth.userId,
      runId,
      roleArn,
      bucket,
    });

    return NextResponse.json({
      runId,
      s3Credentials,
      // Phase B multi-path clients upload each declared path under this same
      // scoped prefix using code-{name}.tar.gz; legacy clients keep code.tar.gz.
      s3CodeKey: "code.tar.gz",
    });
  } catch (err) {
    if (err instanceof BrokerClientError) {
      // Map broker terminal failures (4xx) to opaque 503 — the caller
      // can't fix it. Transient failures (5xx after retries) also
      // surface as BrokerClientError; same response shape either way.
      console.error("[workflows/prepare] STS broker rejected request", {
        status: err.status,
        message: err.message,
      });
      return NextResponse.json(
        { error: "Workflow storage temporarily unavailable" },
        { status: 503 },
      );
    }
    throw err;
  }
}

function safeResource(prop: "stsRoleArn" | "bucketName"): string | undefined {
  try {
    const value =
      prop === "stsRoleArn"
        ? Resource.WorkflowStorage.stsRoleArn
        : Resource.WorkflowStorage.bucketName;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

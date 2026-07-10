import { NextRequest, NextResponse } from "next/server";
import {
  abortWorkflowStorageMultipartUpload,
  buildWorkflowStoragePrefix,
  completeWorkflowStorageMultipartUpload,
  createWorkflowStorageMultipartUpload,
  getWorkflowStorageObject,
  headWorkflowStorageObject,
  joinWorkflowStorageKey,
  putWorkflowStorageObject,
  uploadWorkflowStoragePart,
} from "@/lib/storage";
import { canAccessWorkflowRun, requireAuthRunAccess, requireAuthScope, resolveRequestAuth } from "@/lib/auth/request-auth";
import { workflowStore } from "@/lib/workflows";

type RouteParams = {
  params: Promise<{ runId: string; objectKey: string[] }>;
};

function normalizeObjectKey(parts: string[]): string | null {
  const key = parts.join("/");
  if (!key || key.length > 1024 || key.startsWith("/") || key.includes("\\") || key.includes("\0")) {
    return null;
  }
  const segments = key.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  return key;
}

async function authorizeStorageRequest(
  request: NextRequest,
  runId: string,
  mode: "read" | "write",
) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (!requireAuthRunAccess(auth, runId)) {
    return { error: NextResponse.json({ error: "Run not found" }, { status: 404 }) };
  }

  const run = await workflowStore.get(runId);
  if (run && !canAccessWorkflowRun(auth, run)) {
    return { error: NextResponse.json({ error: "Run not found" }, { status: 404 }) };
  }

  const sandboxForRun = auth.source === "token" && auth.subjectType === "sandbox" && auth.runId === runId;
  const cliPreparingOwnRun =
    mode === "write"
    && auth.source === "token"
    && auth.subjectType === "cli"
    && (!run || run.userId === auth.userId)
    && (
      requireAuthScope(auth, "cli:auth")
      || (auth.runId === runId && requireAuthScope(auth, "workflow:invoke:write"))
    );
  const allowed = mode === "write"
    ? (sandboxForRun && requireAuthScope(auth, "workflow:invoke:write")) || cliPreparingOwnRun
    : sandboxForRun && requireAuthScope(auth, "workflow:invoke:read");
  if (!allowed) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  return {
    auth,
    prefix: buildWorkflowStoragePrefix({ userId: run?.userId ?? auth.userId, runId }),
  };
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const { runId, objectKey } = await params;
  const key = normalizeObjectKey(objectKey);
  if (!key) {
    return jsonError("Invalid object key", 400);
  }

  const authorized = await authorizeStorageRequest(request, runId, "write");
  if ("error" in authorized) return authorized.error;

  const search = request.nextUrl.searchParams;
  const uploadId = search.get("uploadId");
  const partNumber = Number.parseInt(search.get("partNumber") ?? "", 10);
  const storageKey = joinWorkflowStorageKey(authorized.prefix, key);
  const contentType = request.headers.get("content-type");

  if (uploadId) {
    if (!Number.isFinite(partNumber) || partNumber < 1) {
      return jsonError("Invalid multipart partNumber", 400);
    }
    const body = await request.arrayBuffer();
    const etag = await uploadWorkflowStoragePart({
      key: storageKey,
      uploadId,
      partNumber,
      body,
    });
    return NextResponse.json({ etag });
  }

  const body = await request.arrayBuffer();
  await putWorkflowStorageObject({
    key: storageKey,
    body,
    contentType,
  });
  return NextResponse.json({ ok: true });
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { runId, objectKey } = await params;
  const key = normalizeObjectKey(objectKey);
  if (!key) {
    return jsonError("Invalid object key", 400);
  }

  const authorized = await authorizeStorageRequest(request, runId, "write");
  if ("error" in authorized) return authorized.error;

  const search = request.nextUrl.searchParams;
  const storageKey = joinWorkflowStorageKey(authorized.prefix, key);
  const contentType = request.headers.get("content-type");

  if (search.has("uploads")) {
    const uploadId = await createWorkflowStorageMultipartUpload({ key: storageKey, contentType });
    return NextResponse.json({ uploadId });
  }

  const uploadId = search.get("uploadId");
  if (!uploadId) {
    return jsonError("Missing uploadId", 400);
  }

  const body = await request.json().catch(() => null) as { parts?: unknown } | null;
  if (!body || !Array.isArray(body.parts)) {
    return jsonError("Invalid multipart completion body", 400);
  }
  await completeWorkflowStorageMultipartUpload({
    key: storageKey,
    uploadId,
    parts: body.parts as Array<{ PartNumber?: number; partNumber?: number; ETag?: string; etag?: string }>,
  });
  return NextResponse.json({ ok: true });
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { runId, objectKey } = await params;
  const key = normalizeObjectKey(objectKey);
  if (!key) {
    return jsonError("Invalid object key", 400);
  }

  const authorized = await authorizeStorageRequest(request, runId, "read");
  if ("error" in authorized) return authorized.error;

  const object = await getWorkflowStorageObject({
    key: joinWorkflowStorageKey(authorized.prefix, key),
    rangeHeader: request.headers.get("range"),
  });
  if (!object) {
    return jsonError("Object not found", 404);
  }

  const headers = object.headers ?? new Headers();
  if (!headers.has("content-length")) {
    headers.set("content-length", String(object.size));
  }
  return new Response(object.body ?? null, {
    status: request.headers.has("range") ? 206 : 200,
    headers,
  });
}

export async function HEAD(request: NextRequest, { params }: RouteParams) {
  const { runId, objectKey } = await params;
  const key = normalizeObjectKey(objectKey);
  if (!key) {
    return new Response(null, { status: 400 });
  }

  const authorized = await authorizeStorageRequest(request, runId, "read");
  if ("error" in authorized) return new Response(null, { status: authorized.error?.status ?? 500 });

  const object = await headWorkflowStorageObject(joinWorkflowStorageKey(authorized.prefix, key));
  if (!object) {
    return new Response(null, { status: 404 });
  }

  const headers = object.headers ?? new Headers();
  if (!headers.has("content-length")) {
    headers.set("content-length", String(object.size));
  }
  return new Response(null, { status: 200, headers });
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { runId, objectKey } = await params;
  const key = normalizeObjectKey(objectKey);
  if (!key) {
    return jsonError("Invalid object key", 400);
  }

  const authorized = await authorizeStorageRequest(request, runId, "write");
  if ("error" in authorized) return authorized.error;

  const uploadId = request.nextUrl.searchParams.get("uploadId");
  if (!uploadId) {
    return jsonError("Missing uploadId", 400);
  }

  await abortWorkflowStorageMultipartUpload({
    key: joinWorkflowStorageKey(authorized.prefix, key),
    uploadId,
  });
  return NextResponse.json({ ok: true });
}

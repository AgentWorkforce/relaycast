import { NextRequest, NextResponse } from "next/server";
import {
  buildWorkflowStoragePrefix,
  getWorkflowStorageObject,
  headWorkflowStorageObject,
  joinWorkflowStorageKey,
} from "@/lib/storage";
import { requireWorkerAuth, WorkerAuthError } from "@/lib/workers/auth";
import {
  getWorkerStorageAssignment,
  type WorkerStorageAssignment,
} from "@/lib/workers/storage-assignment";
import type { WorkerWorkflowPayload } from "@/lib/workers/types";
import { workflowStore } from "@/lib/workflows";

type RouteParams = {
  params: Promise<{ workerId: string; runId: string; objectKey: string[] }>;
};

const READABLE_ASSIGNMENT_STATUSES = new Set(["assigned", "running"]);

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

function readWorkerPayload(assignment: WorkerStorageAssignment): WorkerWorkflowPayload | null {
  if (assignment.workflowRef.type !== "inline") {
    return null;
  }
  try {
    const payload = JSON.parse(assignment.workflowRef.value) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    return payload as WorkerWorkflowPayload;
  } catch {
    return null;
  }
}

function allowedStorageKeys(payload: WorkerWorkflowPayload): Set<string> {
  const keys = new Set<string>();
  if (typeof payload.s3CodeKey === "string" && payload.s3CodeKey.length > 0) {
    keys.add(payload.s3CodeKey);
  }
  for (const pathEntry of payload.paths ?? []) {
    if (typeof pathEntry?.s3CodeKey === "string" && pathEntry.s3CodeKey.length > 0) {
      keys.add(pathEntry.s3CodeKey);
    }
  }
  return keys;
}

function resolveAllowedStorageKey(payload: WorkerWorkflowPayload, prefix: string, requestedKey: string): string | null {
  for (const rawKey of allowedStorageKeys(payload)) {
    const storageKey = rawKey.startsWith(`${prefix}/`)
      ? rawKey
      : joinWorkflowStorageKey(prefix, rawKey);
    const relativeKey = storageKey.slice(prefix.length + 1);
    if (requestedKey === relativeKey || requestedKey === storageKey) {
      return storageKey;
    }
  }
  return null;
}

async function authorizeWorkerStorageRead(request: NextRequest, params: Awaited<RouteParams["params"]>) {
  const { workerId, runId, objectKey } = params;
  const key = normalizeObjectKey(objectKey);
  if (!key) {
    return { error: NextResponse.json({ error: "Invalid object key" }, { status: 400 }) };
  }

  try {
    await requireWorkerAuth(request, workerId);
  } catch (error) {
    if (error instanceof WorkerAuthError) {
      return { error: NextResponse.json({ error: error.message }, { status: error.status }) };
    }
    throw error;
  }

  const assignment = await getWorkerStorageAssignment(workerId, runId);
  if (!assignment || !READABLE_ASSIGNMENT_STATUSES.has(assignment.status)) {
    return { error: NextResponse.json({ error: "Assignment not found" }, { status: 404 }) };
  }

  const payload = readWorkerPayload(assignment);
  if (!payload || payload.runId !== runId) {
    return { error: NextResponse.json({ error: "Assignment storage unavailable" }, { status: 409 }) };
  }

  const run = await workflowStore.get(runId);
  if (!run) {
    return { error: NextResponse.json({ error: "Run not found" }, { status: 404 }) };
  }
  const prefix = buildWorkflowStoragePrefix({ userId: run.userId, runId });
  const storageKey = resolveAllowedStorageKey(payload, prefix, key);
  if (!storageKey) {
    return { error: NextResponse.json({ error: "Object not found" }, { status: 404 }) };
  }

  return {
    key,
    storageKey,
  };
}

function headersForObject(size: number, headers?: Headers): Headers {
  const out = new Headers(headers);
  if (!out.has("content-length")) {
    out.set("content-length", String(size));
  }
  return out;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const authorized = await authorizeWorkerStorageRead(request, await params);
  if ("error" in authorized) return authorized.error;

  const object = await getWorkflowStorageObject({
    key: authorized.storageKey,
    rangeHeader: request.headers.get("range"),
  });
  if (!object) {
    return NextResponse.json({ error: "Object not found" }, { status: 404 });
  }

  return new Response(object.body ?? null, {
    status: request.headers.has("range") ? 206 : 200,
    headers: headersForObject(object.size, object.headers),
  });
}

export async function HEAD(request: NextRequest, { params }: RouteParams) {
  const authorized = await authorizeWorkerStorageRead(request, await params);
  if ("error" in authorized) {
    const status = authorized.error?.status ?? 500;
    return new Response(null, { status });
  }

  const object = await headWorkflowStorageObject(authorized.storageKey);
  if (!object) {
    return new Response(null, { status: 404 });
  }

  return new Response(null, {
    status: 200,
    headers: headersForObject(object.size, object.headers),
  });
}

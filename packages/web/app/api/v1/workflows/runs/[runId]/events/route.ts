import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  canAccessWorkflowRun,
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import { createDbEventClient } from "@cloud/core/session/events.js";

function parsePositiveInt(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return undefined;
  return n;
}

type RouteParams = { params: Promise<{ runId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireAuthScope(auth, "workflow:runs:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { runId } = await params;
  if (!runId) {
    return NextResponse.json({ error: "Missing runId" }, { status: 400 });
  }

  const url = new URL(request.url);
  const afterParam = parsePositiveInt(url.searchParams.get("after"));
  const limitParam = parsePositiveInt(url.searchParams.get("limit"));
  const sort = url.searchParams.get("sort");

  const db = getDb();
  const { eq } = await import("drizzle-orm");
  const runs = await db
    .select({ id: schema.workflowRuns.id, userId: schema.workflowRuns.userId, workspaceId: schema.workflowRuns.workspaceId })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId))
    .limit(1);

  if (runs.length === 0 || !canAccessWorkflowRun(auth, { runId, userId: runs[0].userId, workspaceId: runs[0].workspaceId })) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const client = createDbEventClient({ db, schema });

  // Clamp the limit into a sensible range. `parsePositiveInt` permits 0
  // (since `after=0` is a legitimate caller request meaning "from the
  // start"), but `limit=0` makes no sense at this API — treat it as the
  // default to avoid a "return 0 events" foot-gun. Upper bound is 1000.
  const effectiveLimit = Math.max(1, Math.min(limitParam ?? 100, 1000));

  const events = await client.getEvents(runId, {
    ...(afterParam !== undefined ? { after: afterParam } : {}),
    limit: effectiveLimit,
    ...(sort === "asc" || sort === "desc" ? { sort } : {}),
  });

  return NextResponse.json({ events });
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Writes require session auth or the narrow, run-bound events write scope
  // (carried by sandbox tokens minted in run/route.ts). The run-binding via
  // requireAuthRunAccess below ensures tokens can only write for their own run.
  if (!requireSessionAuth(auth) && !requireAuthScope(auth, "workflow:runs:events:write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { runId } = await params;
  if (!runId) {
    return NextResponse.json({ error: "Missing runId" }, { status: 400 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  if (!body.eventType || typeof body.eventType !== "string") {
    return NextResponse.json({ error: "eventType is required" }, { status: 400 });
  }

  const db = getDb();

  // Verify run exists
  const { eq } = await import("drizzle-orm");
  const runs = await db
    .select({ id: schema.workflowRuns.id, userId: schema.workflowRuns.userId, workspaceId: schema.workflowRuns.workspaceId })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId))
    .limit(1);

  if (runs.length === 0 || !canAccessWorkflowRun(auth, { runId, userId: runs[0].userId, workspaceId: runs[0].workspaceId })) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const client = createDbEventClient({ db, schema });
  // emit() returns the sequence assigned to THIS insert — use it
  // directly to avoid the prior race where a concurrent POST for the
  // same runId could slip in between emit and a follow-up
  // getLatestSequence and return the wrong number.
  const { sequence } = await client.emit({
    runId,
    eventType: body.eventType,
    stepName: body.stepName,
    sandboxId: body.sandboxId,
    payload: body.payload ?? {},
  });

  return NextResponse.json({ runId, sequence }, { status: 201 });
}

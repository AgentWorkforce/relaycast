import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import {
  POST as launchWorkflowRun,
  WORKSPACE_WORKFLOW_INVOCATION_DELEGATION_HEADER,
  WORKSPACE_WORKFLOW_INVOCATION_DELEGATION_TOKEN,
} from "@/app/api/v1/workflows/run/route";
import { resolveRequestAuth, requireAuthScope } from "@/lib/auth/request-auth";
import { getDb } from "@/lib/db";
import { workspaces } from "@/lib/db/schema";
import { hasWorkspaceAccess } from "@/lib/integrations/integration-route-handler";
import {
  type WorkflowInvocationEntry,
  listRegisteredSlugs,
  resolveWorkflowSlug,
} from "@/lib/workflows/invocation-registry";
import { recordWorkflowInvocation } from "../workflow-invocation-audit";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

type InvocationRequestBody = {
  name: string;
  args: Record<string, unknown>;
};

type RuntimeDescriptor = {
  id?: string;
  kind?: string;
  config?: unknown;
};

/**
 * Lightweight workspace-scoped workflow invocation endpoint. The MCP server
 * (`@agentworkforce/mcp-workforce`, `workflow.run` tool) POSTs here with just
 * a slug + arg-bag and gets back a runId + initial status — no S3 code key,
 * no workflow file path, no sandbox creds required from the caller.
 */
function parseBody(value: unknown): InvocationRequestBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.trim().length === 0) {
    return null;
  }
  const args = record.args;
  if (args === undefined || args === null) {
    return { name: record.name.trim(), args: {} };
  }
  if (typeof args !== "object" || Array.isArray(args)) {
    return null;
  }
  return { name: record.name.trim(), args: args as Record<string, unknown> };
}

function isRuntimeDescriptor(value: unknown): value is RuntimeDescriptor {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    ("id" in value || "kind" in value)
  );
}

async function resolveWorkspaceRuntime(workspaceId: string): Promise<RuntimeDescriptor> {
  const [row] = await getDb()
    .select({ defaultRuntime: workspaces.defaultRuntime })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  const runtime = row?.defaultRuntime;
  return isRuntimeDescriptor(runtime) ? runtime : { id: "daytona" };
}

function buildRunBody(input: {
  entry: WorkflowInvocationEntry;
  runtime: RuntimeDescriptor;
  args: Record<string, unknown>;
}) {
  return {
    workflow: input.entry.workflow,
    fileType: input.entry.fileType,
    sourceFileType: input.entry.sourceFileType ?? "workflow",
    s3CodeKey: input.entry.s3CodeKey,
    workflowPath: input.entry.workflowPath,
    runtime: input.runtime,
    metadata: {
      invocationSlug: input.entry.slug,
      invocationArgs: JSON.stringify(input.args),
    },
  };
}

async function delegateToWorkflowRun(request: NextRequest, body: unknown) {
  const headers = new Headers({ "content-type": "application/json" });
  const authorization = request.headers.get("authorization");
  const cookie = request.headers.get("cookie");
  if (authorization) headers.set("authorization", authorization);
  if (cookie) headers.set("cookie", cookie);
  headers.set(
    WORKSPACE_WORKFLOW_INVOCATION_DELEGATION_HEADER,
    WORKSPACE_WORKFLOW_INVOCATION_DELEGATION_TOKEN,
  );

  const delegated = new NextRequest(new URL("/api/v1/workflows/run", request.url), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  return launchWorkflowRun(delegated);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json(
      { error: "Unauthorized", code: "unauthorized" },
      { status: 401 },
    );
  }

  const { workspaceId } = await context.params;
  if (!workspaceId) {
    return NextResponse.json(
      { error: "Workspace not found", code: "workspace_not_found" },
      { status: 404 },
    );
  }

  if (!hasWorkspaceAccess(auth, workspaceId)) {
    return NextResponse.json(
      { error: "Forbidden", code: "forbidden" },
      { status: 403 },
    );
  }

  if (!requireAuthScope(auth, "workflow:invoke:write")) {
    return NextResponse.json(
      {
        error: "Missing required scope: workflow:invoke:write",
        code: "insufficient_scope",
      },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body", code: "invalid_request" },
      { status: 400 },
    );
  }

  const parsed = parseBody(body);
  if (!parsed) {
    return NextResponse.json(
      { error: "Invalid request body", code: "invalid_request" },
      { status: 400 },
    );
  }

  const entry = resolveWorkflowSlug(parsed.name);
  if (!entry) {
    recordWorkflowInvocation({
      workspaceId,
      slug: parsed.name,
      runId: "",
      requester: auth.userId,
      organizationId: auth.organizationId || null,
      outcome: "rejected_unknown_slug",
    });
    return NextResponse.json(
      {
        error: `Unknown workflow slug: ${parsed.name}`,
        code: "workflow_slug_not_found",
        knownSlugs: listRegisteredSlugs(),
      },
      { status: 404 },
    );
  }

  const runtime = await resolveWorkspaceRuntime(workspaceId);
  const delegatedResponse = await delegateToWorkflowRun(
    request,
    buildRunBody({ entry, runtime, args: parsed.args }),
  );
  const delegatedPayload = await delegatedResponse.json().catch(() => null);

  if (!delegatedResponse.ok) {
    recordWorkflowInvocation({
      workspaceId,
      slug: parsed.name,
      runId: "",
      requester: auth.userId,
      organizationId: auth.organizationId || null,
      outcome: "rejected_launch_failed",
    });
    return NextResponse.json(
      delegatedPayload ?? {
        error: "Workflow launch failed",
        code: "workflow_launch_failed",
      },
      { status: delegatedResponse.status },
    );
  }

  const runId =
    delegatedPayload &&
    typeof delegatedPayload === "object" &&
    "runId" in delegatedPayload &&
    typeof delegatedPayload.runId === "string"
      ? delegatedPayload.runId
      : "";
  recordWorkflowInvocation({
    workspaceId,
    slug: parsed.name,
    runId,
    requester: auth.userId,
    organizationId: auth.organizationId || null,
    outcome: "accepted",
  });
  return NextResponse.json(delegatedPayload, { status: delegatedResponse.status });
}

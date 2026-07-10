import { NextRequest, NextResponse } from "next/server";
import {
  canAccessWorkflowRun,
  requireAuthScope,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import { hasWorkspaceAccess } from "@/lib/integrations/integration-route-handler";
import { workflowStore } from "@/lib/workflows";

type RouteContext = {
  params: Promise<{ workspaceId: string; runId: string }>;
};

type StatusResponse = {
  runId: string;
  status: "pending" | "running" | "success" | "failure";
  output?: unknown;
  error?: string;
};

/**
 * Map the internal workflow-runs status vocabulary onto the four-state shape
 * the MCP `workflow.status` tool expects. Anything we don't recognise falls
 * through to `pending` rather than leaking an internal label to MCP callers.
 */
function mapStatus(status: string): StatusResponse["status"] {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "success":
    case "succeeded":
    case "completed":
      return "success";
    case "failure":
    case "failed":
    case "errored":
      return "failure";
    default:
      return "pending";
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json(
      { error: "Unauthorized", code: "unauthorized" },
      { status: 401 },
    );
  }

  const { workspaceId, runId } = await context.params;
  if (!workspaceId || !runId) {
    return NextResponse.json(
      { error: "Run not found", code: "run_not_found" },
      { status: 404 },
    );
  }

  if (!hasWorkspaceAccess(auth, workspaceId)) {
    return NextResponse.json(
      { error: "Forbidden", code: "forbidden" },
      { status: 403 },
    );
  }

  if (!requireAuthScope(auth, "workflow:invoke:read")) {
    return NextResponse.json(
      {
        error: "Missing required scope: workflow:invoke:read",
        code: "insufficient_scope",
      },
      { status: 403 },
    );
  }

  const run = await workflowStore.get(runId);
  if (!run) {
    return NextResponse.json(
      { error: "Run not found", code: "run_not_found" },
      { status: 404 },
    );
  }

  // Enforce workspace scoping in addition to the standard run-access check so
  // a runId from a different workspace can't be probed even with a valid
  // workspace-scoped token. The path workspaceId is the authority here.
  if (run.workspaceId !== workspaceId) {
    return NextResponse.json(
      { error: "Run not found", code: "run_not_found" },
      { status: 404 },
    );
  }

  if (!canAccessWorkflowRun(auth, run)) {
    return NextResponse.json(
      { error: "Run not found", code: "run_not_found" },
      { status: 404 },
    );
  }

  const status = mapStatus(run.status);
  const response: StatusResponse = {
    runId: run.runId,
    status,
  };
  if (run.result !== undefined) {
    response.output = run.result;
  }
  if (run.error) {
    response.error = run.error;
  }
  return NextResponse.json(response);
}

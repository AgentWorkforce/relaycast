import { NextRequest } from "next/server";
import { POST as launchWorkflowRun } from "@/app/api/v1/workflows/run/route";
import { POST as cancelWorkflowRun } from "@/app/api/v1/workflows/runs/[runId]/cancel/route";
import type { CreateRickyRunRequest } from "./types";

type WorkflowLaunchResponse = {
  runId: string;
  sandboxId?: string;
  assignmentId?: string;
  dispatchedTo?: string;
  status: string;
};

function copyAuthHeaders(request: NextRequest): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  const authorization = request.headers.get("authorization");
  const cookie = request.headers.get("cookie");
  if (authorization) headers.set("authorization", authorization);
  if (cookie) headers.set("cookie", cookie);
  return headers;
}

export async function launchViaWorkflowRunRoute(input: {
  request: NextRequest;
  body: CreateRickyRunRequest & {
    runId?: string;
    previousRunId?: string;
    startFrom?: string;
    resume?: string;
    metadata?: Record<string, string>;
  };
}): Promise<WorkflowLaunchResponse> {
  const url = new URL("/api/v1/workflows/run", input.request.url);
  const delegated = new NextRequest(url, {
    method: "POST",
    headers: copyAuthHeaders(input.request),
    body: JSON.stringify(input.body),
  });

  const response = await launchWorkflowRun(delegated);
  const payload = (await response.json()) as WorkflowLaunchResponse | { error?: string };
  if (!response.ok || !("runId" in payload)) {
    throw new Error(("error" in payload && payload.error) || `Workflow launch failed with ${response.status}`);
  }
  return payload;
}

export async function cancelViaWorkflowRunRoute(input: {
  request: NextRequest;
  runId: string;
}): Promise<{ runId: string; status: string } | null> {
  const delegated = new NextRequest(new URL(`/api/v1/workflows/runs/${input.runId}/cancel`, input.request.url), {
    method: "POST",
    headers: copyAuthHeaders(input.request),
  });

  const response = await cancelWorkflowRun(delegated, {
    params: Promise.resolve({ runId: input.runId }),
  });
  if (!response.ok && response.status !== 409 && response.status !== 404) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || `Workflow cancel failed with ${response.status}`);
  }
  return (await response.json().catch(() => null)) as { runId: string; status: string } | null;
}

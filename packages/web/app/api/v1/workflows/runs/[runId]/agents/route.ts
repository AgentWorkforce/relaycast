import { NextRequest, NextResponse } from "next/server";
import { workflowStore } from "@/lib/workflows";
import { isWorkflowStorageConfigured, listWorkflowStorageObjects } from "@/lib/storage";
import { canAccessWorkflowRun, requireAuthScope, resolveRequestAuth } from "@/lib/auth/request-auth";

type AgentEntry = {
  name: string;
  hasLogs: boolean;
};

function parseWorkflowAgentNames(workflow: string): string[] {
  try {
    const parsed = JSON.parse(workflow) as { agents?: unknown };
    if (!Array.isArray(parsed.agents)) {
      return [];
    }

    return parsed.agents
      .map((agent) => {
        if (!agent || typeof agent !== "object") {
          return null;
        }

        const name = "name" in agent ? agent.name : null;
        return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
      })
      .filter((name): name is string => name !== null);
  } catch {
    return [];
  }
}

async function listSandboxIdsWithLogs(userId: string, runId: string): Promise<Set<string>> {
  if (!isWorkflowStorageConfigured()) {
    return new Set();
  }

  const sandboxIds = new Set<string>();
  const objects = await listWorkflowStorageObjects({ prefix: `${userId}/${runId}/` });
  for (const object of objects) {
    const key = object.key;
    const escUserId = userId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escRunId = runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = key.match(new RegExp(`^${escUserId}/${escRunId}/([^/]+)/agent\\.log$`));
    if (match?.[1]) {
      sandboxIds.add(match[1]);
    }
  }

  return sandboxIds;
}

function mergeAgents(configAgents: string[], stepAgents: string[], logAgents: string[]): AgentEntry[] {
  const orderedNames: string[] = [];
  const seen = new Set<string>();

  for (const name of [...configAgents, ...stepAgents, ...logAgents]) {
    if (seen.has(name)) {
      continue;
    }

    seen.add(name);
    orderedNames.push(name);
  }

  const logAgentSet = new Set(logAgents);
  return orderedNames.map((name) => ({
    name,
    hasLogs: logAgentSet.has(name),
  }));
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireAuthScope(auth, "workflow:runs:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { runId } = await params;
  if (auth.source === "token" && auth.subjectType === "sandbox" && auth.runId !== runId) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const run = await workflowStore.get(runId);
  if (!run || !canAccessWorkflowRun(auth, run)) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const steps = await workflowStore.listSteps(runId);
  const configAgents = parseWorkflowAgentNames(run.workflow);
  const stepAgents = steps
    .map((step) => step.agent.trim())
    .filter((name) => name.length > 0);

  let logAgentNames = new Set<string>();
  try {
    logAgentNames = await listSandboxIdsWithLogs(run.userId, runId);
  } catch (error) {
    console.error("Failed to list agent logs:", error);
  }

  // S3 keys use agent names (not sandbox IDs), so match against agent names directly.
  const logAgents = steps
    .filter((step) => logAgentNames.has(step.agent.trim()))
    .map((step) => step.agent.trim())
    .filter((name) => name.length > 0);

  const agents = isWorkflowStorageConfigured()
    ? mergeAgents(configAgents, stepAgents, logAgents)
    : mergeAgents(configAgents, stepAgents, stepAgents);

  return NextResponse.json({ agents });
}

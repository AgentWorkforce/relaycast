import { NextRequest, NextResponse } from "next/server";
import { canAccessWorkflowRun, requireAuthScope, resolveRequestAuth } from "@/lib/auth/request-auth";
import { workflowStore, type WorkflowPathPushResult } from "@/lib/workflows";
import { rickyRunStore } from "@/lib/ricky/run-store";

type RunContext = {
  params: Promise<{ runId: string }>;
};

export async function GET(request: NextRequest, { params }: RunContext) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!requireAuthScope(auth, "workflow:runs:read")) {
    return NextResponse.json({ error: "Missing required scope: workflow:runs:read" }, { status: 403 });
  }

  const { runId } = await params;
  if (!runId) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const run = await workflowStore.get(runId);
  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  if (!canAccessWorkflowRun(auth, run)) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const safeRun = { ...run };
  delete (safeRun as { callbackToken?: string }).callbackToken;
  if (run.paths && run.paths.length > 0) {
    (safeRun as typeof safeRun & {
      patches: Record<string, {
        s3Key: string;
        hasChanges?: boolean;
        pushedTo?: {
          branch: string;
          prUrl: string;
          sha: string;
          base: { branch: string; sha: string };
          strategy: "contents_api" | "git_db";
        };
        pushError?: {
          code: string;
          message: string;
          observedBaseSha?: string;
          base?: { branch: string; sha: string };
        };
      }>;
    }).patches = Object.fromEntries(
      run.paths.map((entry) => {
        const pushResult = run.pushedTo?.[entry.name] as WorkflowPathPushResult | undefined;
        const patchEntry: {
          s3Key: string;
          hasChanges?: boolean;
          pushedTo?: {
            branch: string;
            prUrl: string;
            sha: string;
            base: { branch: string; sha: string };
            strategy: "contents_api" | "git_db";
          };
          pushError?: {
            code: string;
            message: string;
            observedBaseSha?: string;
            base?: { branch: string; sha: string };
          };
        } = {
          s3Key: `${run.userId}/${run.runId}/changes-${entry.name}.patch`,
        };

        if (pushResult?.status === "pushed") {
          patchEntry.pushedTo = {
            branch: pushResult.branch,
            prUrl: pushResult.prUrl,
            sha: pushResult.sha,
            base: pushResult.base,
            strategy: pushResult.strategy,
          };
        } else if (pushResult?.status === "failed") {
          patchEntry.pushError = {
            code: pushResult.code,
            message: pushResult.message,
            ...(pushResult.observedBaseSha ? { observedBaseSha: pushResult.observedBaseSha } : {}),
            ...(pushResult.base ? { base: pushResult.base } : {}),
          };
        }

        return [entry.name, patchEntry] as const;
      }),
    );
  }

  // Ricky enrichment is best-effort: if the supervisor lookups fail, return
  // the base workflow run payload rather than 500'ing the detail page.
  try {
    const rickyRun = await rickyRunStore.getByRootWorkflowRunId(run.runId);
    if (rickyRun) {
      const [attempts, gates] = await Promise.all([
        rickyRunStore.listAttempts(rickyRun.id),
        rickyRunStore.listGates(rickyRun.id),
      ]);
      const openGates = gates.filter((g) => g.status === "open");
      (safeRun as typeof safeRun & {
        rickyRun: {
          id: string;
          status: string;
          currentAttempt: number;
          maxAttempts: number;
          latestDiagnosis?: Record<string, unknown>;
          attempts: Array<{
            attempt: number;
            workflowRunId: string;
            role: string;
            repairMode: string;
            status: string;
            repairSummary?: string;
            repairAgent?: Record<string, unknown>;
          }>;
          gates: Array<{
            id: string;
            gateType: string;
            reason: string;
            prompt: string;
            status: string;
            createdAt: string;
          }>;
        };
      }).rickyRun = {
        id: rickyRun.id,
        status: rickyRun.status,
        currentAttempt: rickyRun.currentAttempt,
        maxAttempts: rickyRun.maxAttempts,
        latestDiagnosis: rickyRun.latestDiagnosis as Record<string, unknown> | undefined,
        attempts: attempts.map((a) => ({
          attempt: a.attempt,
          workflowRunId: a.workflowRunId,
          role: a.role,
          repairMode: a.repairMode,
          status: a.status,
          repairSummary: a.repairSummary,
          repairAgent: a.repairAgent as Record<string, unknown> | undefined,
        })),
        gates: openGates.map((g) => ({
          id: g.id,
          gateType: g.gateType,
          reason: g.reason,
          prompt: g.prompt,
          status: g.status,
          createdAt: g.createdAt,
        })),
      };
    }
  } catch (error) {
    console.error("[ricky] failed to enrich workflow run with supervisor context", {
      runId: run.runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return NextResponse.json(safeRun);
}

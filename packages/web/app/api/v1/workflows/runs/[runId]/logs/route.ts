import { NextRequest, NextResponse } from "next/server";
import { workflowStore, type WorkflowRecord } from "@/lib/workflows";
import { getWorkflowStorageObject, headWorkflowStorageObject, isWorkflowStorageConfigured } from "@/lib/storage";
import { canAccessWorkflowRun, requireAuthScope, resolveRequestAuth } from "@/lib/auth/request-auth";

function isRunDone(run: WorkflowRecord): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "cancelled";
}

function parseOffset(rawOffset: string | null): number {
  if (!rawOffset) {
    return 0;
  }

  const parsed = Number.parseInt(rawOffset, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

async function buildMockLogText(run: WorkflowRecord, sandboxId: string | null): Promise<string> {
  if (sandboxId) {
    const steps = await workflowStore.listSteps(run.runId);
    const step = steps.find((candidate) => candidate.sandboxId === sandboxId);

    if (step) {
      const lines = [
        `[${step.agent}] Starting ${step.stepName}`,
        `preset=${step.preset} cli=${step.cli} sandbox=${step.sandboxId}`,
        step.outputSummary,
        step.exitCode === 0 ? "exit_code=0" : `exit_code=${step.exitCode}`,
      ];

      if (step.error) {
        lines.push(`ERROR: ${step.error}`);
      } else if (run.status === "running") {
        lines.push("Streaming step output...");
      } else {
        lines.push("Step completed successfully.");
      }

      return `${lines.filter(Boolean).join("\n")}\n`;
    }
  }

  const lines = [
    `run_id=${run.runId}`,
    `workflow_status=${run.status}`,
    `orchestrator_sandbox=${run.sandboxId}`,
    run.error ?? "Orchestrator log stream is not available in mock mode.",
  ];

  return `${lines.join("\n")}\n`;
}

async function createMockLogPayload(
  run: WorkflowRecord,
  sandboxId: string | null,
  offset: number
): Promise<{
  content: string;
  offset: number;
  totalSize: number;
  done: boolean;
}> {
  const content = await buildMockLogText(run, sandboxId);
  const totalSize = Buffer.byteLength(content, "utf-8");

  if (offset >= totalSize) {
    return {
      content: "",
      offset,
      totalSize,
      done: isRunDone(run),
    };
  }

  return {
    content: content.slice(offset),
    offset: totalSize,
    totalSize,
    done: isRunDone(run),
  };
}

async function readStreamBody(body: ReadableStream<Uint8Array> | null): Promise<Buffer> {
  if (!body) {
    return Buffer.alloc(0);
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/**
 * GET /api/v1/workflows/runs/[runId]/logs
 *
 * Stream workflow run logs from S3. The bootstrap script in the orchestrator
 * sandbox periodically flushes runner.log to {userId}/{runId}/runner.log, and
 * step sandboxes flush agent.log to {userId}/{runId}/{sandboxId}/agent.log.
 *
 * Query params:
 *   offset - byte offset to start reading from (default: 0)
 *   sandboxId - when set, read the step log for that sandbox instead of runner.log
 *
 * Returns:
 *   { content: string, offset: number, totalSize: number, done: boolean }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireAuthScope(auth, "workflow:logs:read")) {
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

  const sandboxId = request.nextUrl.searchParams.get("sandboxId")?.trim() ?? null;
  const offset = parseOffset(request.nextUrl.searchParams.get("offset"));
  if (!isWorkflowStorageConfigured()) {
    return NextResponse.json(await createMockLogPayload(run, sandboxId, offset));
  }

  const logKey = sandboxId
    ? `${run.userId}/${runId}/${sandboxId}/agent.log`
    : `${run.userId}/${runId}/runner.log`;

  try {
    const head = await headWorkflowStorageObject(logKey);
    if (!head) {
      if (process.env.NODE_ENV === "development") {
        return NextResponse.json(await createMockLogPayload(run, sandboxId, offset));
      }
      return NextResponse.json({ content: "", offset: 0, totalSize: 0, done: isRunDone(run) });
    }
    const totalSize = head.size;

    if (offset >= totalSize) {
      const done = isRunDone(run);
      return NextResponse.json({ content: "", offset, totalSize, done });
    }

    const object = await getWorkflowStorageObject({
      key: logKey,
      rangeHeader: `bytes=${offset}-`,
    });
    if (!object?.body) {
      return NextResponse.json({ content: "", offset, totalSize, done: isRunDone(run) && offset >= totalSize });
    }

    const rawBuffer = await readStreamBody(object.body);
    const content = rawBuffer.toString("utf-8");
    const newOffset = offset + rawBuffer.length;
    const done = isRunDone(run) && newOffset >= totalSize;

    return NextResponse.json({ content, offset: newOffset, totalSize, done });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "name" in err && (err.name === "NoSuchKey" || err.name === "NotFound")) {
      if (process.env.NODE_ENV === "development") {
        return NextResponse.json(await createMockLogPayload(run, sandboxId, offset));
      }

      return NextResponse.json({ content: "", offset: 0, totalSize: 0, done: isRunDone(run) });
    }
    console.error("Log streaming error:", err);
    return NextResponse.json({ error: "Failed to read logs" }, { status: 500 });
  }
}

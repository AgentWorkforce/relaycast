import type { SQSHandler, SQSRecord } from "aws-lambda";
import {
  getWorkflowLaunchJob,
  markWorkflowLaunchJobFailed,
} from "@cloud/core/workflow-launch/job-store.js";
import type { EnqueueWorkflowLaunchJobPayload } from "@cloud/core/workflow-launch/job.js";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { workflowRuns } from "../db/schema";

type QueueRecord = {
  body: string;
};

export const dlqHandler: SQSHandler = async (event) => {
  await processWorkflowLaunchDlqEvent(event.Records);
};

export async function processWorkflowLaunchDlqEvent(
  records: SQSRecord[],
): Promise<void> {
  for (const record of records) {
    await processWorkflowLaunchDlqRecord(record);
  }
}

export async function processWorkflowLaunchDlqRecord(
  record: QueueRecord,
): Promise<void> {
  const payload = parsePayload(record.body);
  const db = getDb();
  const current = await getWorkflowLaunchJob(db, payload.jobId);
  if (!current || ["launched", "failed"].includes(current.status)) {
    return;
  }
  const message = current.lastError
    ? `Workflow launch exhausted retries: ${current.lastError}`
    : "Workflow launch exhausted retries before sandbox launch completed";
  await markWorkflowLaunchJobFailed(db, payload.jobId, message);
  const [run] = await db
    .update(workflowRuns)
    .set({ status: "failed", error: message, updatedAt: new Date() })
    .where(eq(workflowRuns.id, payload.runId))
    .returning({ id: workflowRuns.id });
  if (!run) {
    throw new Error(`Run ${payload.runId} not found`);
  }
  console.error("[workflow-launch] DLQ marked launch job failed", {
    runId: payload.runId,
    jobId: payload.jobId,
    attempts: current.attempts,
    message,
  });
}

function parsePayload(body: string): EnqueueWorkflowLaunchJobPayload {
  const payload = JSON.parse(body) as Partial<EnqueueWorkflowLaunchJobPayload>;
  if (!payload.jobId || !payload.runId) {
    throw new Error("Invalid workflow launch queue payload");
  }
  return payload as EnqueueWorkflowLaunchJobPayload;
}

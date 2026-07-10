import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/index";
import { workAssignments } from "@/lib/db/schema";
import type { WorkerWorkflowRef } from "./types";

export type WorkerStorageAssignment = {
  runId: string;
  status: string;
  workflowRef: WorkerWorkflowRef;
};

function readWorkflowRef(value: unknown): WorkerWorkflowRef | null {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ((value as { type?: unknown }).type === "inline" ||
      (value as { type?: unknown }).type === "url") &&
    typeof (value as { value?: unknown }).value === "string"
  ) {
    return value as WorkerWorkflowRef;
  }
  return null;
}

export async function getWorkerStorageAssignment(
  workerId: string,
  runId: string,
): Promise<WorkerStorageAssignment | null> {
  const [row] = await getDb()
    .select({
      runId: workAssignments.runId,
      status: workAssignments.status,
      workflowRef: workAssignments.workflowRef,
    })
    .from(workAssignments)
    .where(and(eq(workAssignments.workerId, workerId), eq(workAssignments.runId, runId)))
    .limit(1);

  if (!row) {
    return null;
  }

  const workflowRef = readWorkflowRef(row.workflowRef);
  return workflowRef ? { ...row, workflowRef } : null;
}

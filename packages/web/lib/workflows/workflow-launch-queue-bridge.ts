import type { EnqueueWorkflowLaunchJobPayload } from "@cloud/core/workflow-launch/job.js";
import {
  enqueueViaSignedQueueBridge,
  type SignedQueueBridgeConfig,
} from "@/lib/queue-bridge/signed-queue-bridge";

const WORKFLOW_LAUNCH_QUEUE_BRIDGE_PATH = "/internal/queues/workflow-launch/send";
const ERROR_PREFIX = "[workflow-launch-queue]";

export class WorkflowLaunchQueueBridgeError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "WorkflowLaunchQueueBridgeError";
    this.status = status;
  }
}

export async function enqueueWorkflowLaunchJobViaBridge(
  job: EnqueueWorkflowLaunchJobPayload,
  config: SignedQueueBridgeConfig,
): Promise<void> {
  const body = JSON.stringify({ job });
  await enqueueViaSignedQueueBridge({
    path: WORKFLOW_LAUNCH_QUEUE_BRIDGE_PATH,
    body,
    config,
    errorPrefix: ERROR_PREFIX,
    createError: (message, status) => new WorkflowLaunchQueueBridgeError(message, status),
  });
}

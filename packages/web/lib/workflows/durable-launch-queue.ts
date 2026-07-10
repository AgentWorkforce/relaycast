import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { Resource } from "sst";
import type { EnqueueWorkflowLaunchJobPayload } from "@cloud/core/workflow-launch/job.js";
import { readWorkerEnv } from "@/lib/aws/runtime";
import { getSqsClientForQueueUrl } from "@/lib/aws/sqs-client";
import { enqueueWorkflowLaunchJobViaBridge } from "./workflow-launch-queue-bridge";

const resources = Resource as unknown as {
  WorkflowLaunchQueue: { url: string };
};

export async function enqueueWorkflowLaunchJob(
  payload: EnqueueWorkflowLaunchJobPayload,
  options: { delaySeconds?: number } = {},
): Promise<void> {
  const workerEnv = readWorkerEnv();
  if (workerEnv) {
    if (options.delaySeconds) {
      // DelaySeconds is only used by provisioning retries from the Lambda
      // launch worker, where direct SQS is still available. If that retry path
      // ever moves to Worker, fail loudly rather than silently dropping delay.
      throw new Error("[workflow-launch-queue] delayed bridge enqueue is not supported");
    }
    await enqueueWorkflowLaunchJobViaBridge(payload, {
      bridgeUrl: readString(workerEnv, "QUEUE_BRIDGE_URL"),
      hmacSecret: readString(workerEnv, "QUEUE_BRIDGE_HMAC_SECRET"),
    });
    return;
  }

  const queueUrl = resources.WorkflowLaunchQueue.url;
  const sqs = getSqsClientForQueueUrl(queueUrl);
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(payload),
      ...(options.delaySeconds ? { DelaySeconds: options.delaySeconds } : {}),
    }),
  );
}

function readString(env: Record<string, unknown>, name: string): string {
  const value = env[name];
  return typeof value === "string" ? value : "";
}

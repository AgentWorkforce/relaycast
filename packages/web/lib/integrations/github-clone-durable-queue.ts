import "server-only";

import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { Resource } from "sst";
import type { EnqueueGithubCloneJobPayload } from "@cloud/core/clone/github-clone-job.js";
import { getSqsClientForQueueUrl } from "@/lib/aws/sqs-client";

const resources = Resource as unknown as {
  GithubCloneQueue: { url: string };
};

export async function enqueueGithubCloneJob(
  payload: EnqueueGithubCloneJobPayload,
): Promise<void> {
  const queueUrl = resources.GithubCloneQueue.url;
  const sqs = getSqsClientForQueueUrl(queueUrl);
  await sqs.send(
    new SendMessageCommand({
      // Workflow invariant: Resource.GithubCloneQueue.url.
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(payload),
    }),
  );
}

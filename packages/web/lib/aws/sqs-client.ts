import { SQSClient } from "@aws-sdk/client-sqs";

const clientsByQueueUrl = new Map<string, SQSClient>();

export function resolveSqsRegionFromQueueUrl(queueUrl: string): string | null {
  try {
    const host = new URL(queueUrl).hostname;
    const match = host.match(/^sqs[.-]([a-z0-9-]+)\./i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function createSqsClientForQueueUrl(queueUrl: string): SQSClient {
  const region = resolveSqsRegionFromQueueUrl(queueUrl);
  if (!region) {
    throw new Error(`Could not resolve AWS region from SQS queue URL: ${queueUrl}`);
  }
  return new SQSClient({ region });
}

export function getSqsClientForQueueUrl(queueUrl: string): SQSClient {
  const existing = clientsByQueueUrl.get(queueUrl);
  if (existing) return existing;
  const client = createSqsClientForQueueUrl(queueUrl);
  clientsByQueueUrl.set(queueUrl, client);
  return client;
}

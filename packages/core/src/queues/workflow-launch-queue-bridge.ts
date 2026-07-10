import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { verifyRequest } from "@cloud/sts-broker/hmac-node.js";
import type { EnqueueWorkflowLaunchJobPayload } from "../workflow-launch/job.js";

export const WORKFLOW_LAUNCH_QUEUE_BRIDGE_PATH = "/internal/queues/workflow-launch/send";

type EnvSnapshot = {
  hmacSecret: string;
  queueUrl: string;
};

interface SqsSender {
  send(command: SendMessageCommand): Promise<unknown>;
}

let sqsClientOverride: SqsSender | null = null;
let cachedSqsClient: SQSClient | null = null;

export function setSqsClientForTesting(client: SqsSender | null): void {
  sqsClientOverride = client;
}

export function resetSqsClientForTesting(): void {
  cachedSqsClient = null;
  sqsClientOverride = null;
}

function getSqsClient(): SqsSender {
  if (sqsClientOverride) {
    return sqsClientOverride;
  }
  if (!cachedSqsClient) {
    cachedSqsClient = new SQSClient({});
  }
  return cachedSqsClient;
}

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function readEnv(): EnvSnapshot | { error: string } {
  const hmacSecret =
    process.env.QUEUE_BRIDGE_HMAC_SECRET ?? process.env.BROKER_HMAC_SECRET;

  if (!hmacSecret) {
    return { error: "QUEUE_BRIDGE_HMAC_SECRET is not configured" };
  }
  if (!process.env.WORKFLOW_LAUNCH_QUEUE_URL) {
    return { error: "WORKFLOW_LAUNCH_QUEUE_URL is not configured" };
  }
  return {
    hmacSecret,
    queueUrl: process.env.WORKFLOW_LAUNCH_QUEUE_URL,
  };
}

function requestPath(event: APIGatewayProxyEventV2): string {
  return event.rawPath || "/";
}

function parseWorkflowLaunchJob(
  value: unknown,
): EnqueueWorkflowLaunchJobPayload | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "Workflow launch job must be an object" };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.jobId !== "string" || record.jobId.trim().length === 0) {
    return { error: "Workflow launch job requires jobId" };
  }
  if (typeof record.runId !== "string" || record.runId.trim().length === 0) {
    return { error: "Workflow launch job requires runId" };
  }
  return {
    jobId: record.jobId,
    runId: record.runId,
  };
}

function parseRequestBody(
  rawBody: string | undefined,
): EnqueueWorkflowLaunchJobPayload | { error: string } {
  if (!rawBody) {
    return { error: "Request body is required" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { error: "Request body is not valid JSON" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "Request body must be a JSON object" };
  }

  const body = parsed as { job?: unknown };
  return parseWorkflowLaunchJob(body.job);
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const path = requestPath(event);
  if (
    event.requestContext.http.method !== "POST" ||
    path !== WORKFLOW_LAUNCH_QUEUE_BRIDGE_PATH
  ) {
    return jsonResponse(404, { error: "not_found" });
  }

  const env = readEnv();
  if ("error" in env) {
    console.error("Queue bridge misconfigured", {
      area: "queue-bridge",
      queue: "workflow-launch",
      error: env.error,
    });
    return jsonResponse(500, { error: "bridge_misconfigured" });
  }

  const rawBody = event.isBase64Encoded && event.body
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body ?? "";
  const verification = verifyRequest({
    method: "POST",
    path,
    body: rawBody,
    headers: event.headers ?? {},
    secret: env.hmacSecret,
  });
  if (!verification.ok) {
    console.warn("Queue bridge rejected request", {
      area: "queue-bridge",
      queue: "workflow-launch",
      reason: verification.reason,
    });
    return jsonResponse(403, { error: "forbidden" });
  }

  const job = parseRequestBody(rawBody);
  if ("error" in job) {
    return jsonResponse(400, { error: job.error });
  }

  try {
    await getSqsClient().send(
      new SendMessageCommand({
        QueueUrl: env.queueUrl,
        MessageBody: JSON.stringify(job),
      }),
    );
  } catch (error) {
    console.error("Queue bridge failed to enqueue job", {
      area: "queue-bridge",
      queue: "workflow-launch",
      ...logFieldsForJob(job),
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse(503, { error: "queue_send_failed" });
  }

  console.info("Queue bridge enqueued job", {
    area: "queue-bridge",
    queue: "workflow-launch",
    ...logFieldsForJob(job),
  });

  return jsonResponse(202, { accepted: true });
}

function logFieldsForJob(job: EnqueueWorkflowLaunchJobPayload): Record<string, string | null> {
  return {
    jobId: job.jobId,
    runId: job.runId,
  };
}

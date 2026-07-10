import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { signRequest } from "@cloud/sts-broker/hmac-node.js";
import {
  handler,
  resetSqsClientForTesting,
  setSqsClientForTesting,
  WORKFLOW_LAUNCH_QUEUE_BRIDGE_PATH,
} from "../src/queues/workflow-launch-queue-bridge.js";

const SECRET = "queue-bridge-test-secret";
const WORKFLOW_LAUNCH_QUEUE_URL =
  "https://sqs.us-east-1.amazonaws.com/123/WorkflowLaunchQueue";

const job = { jobId: "launch-job-1", runId: "run-1" };

function event(input: {
  body?: string;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
}): APIGatewayProxyEventV2 {
  const path = input.path ?? WORKFLOW_LAUNCH_QUEUE_BRIDGE_PATH;
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    headers: input.headers ?? {},
    requestContext: {
      accountId: "123",
      apiId: "function-url",
      domainName: "queue-bridge.test",
      domainPrefix: "queue-bridge",
      http: {
        method: input.method ?? "POST",
        path,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "node-test",
      },
      requestId: "req-1",
      routeKey: "$default",
      stage: "$default",
      time: "18/May/2026:20:00:00 +0000",
      timeEpoch: 1779134400000,
    },
    body: input.body,
    isBase64Encoded: false,
  };
}

function signedHeaders(
  body: string,
  path = WORKFLOW_LAUNCH_QUEUE_BRIDGE_PATH,
): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    "x-request-timestamp": timestamp,
    "x-request-signature": signRequest({
      method: "POST",
      path,
      body,
      timestamp,
      secret: SECRET,
    }),
  };
}

beforeEach(() => {
  process.env.QUEUE_BRIDGE_HMAC_SECRET = SECRET;
  process.env.WORKFLOW_LAUNCH_QUEUE_URL = WORKFLOW_LAUNCH_QUEUE_URL;
  resetSqsClientForTesting();
});

afterEach(() => {
  delete process.env.QUEUE_BRIDGE_HMAC_SECRET;
  delete process.env.WORKFLOW_LAUNCH_QUEUE_URL;
  resetSqsClientForTesting();
});

describe("workflow launch queue bridge", () => {
  it("accepts a signed workflow launch job and sends one SQS message", async () => {
    const sent: unknown[] = [];
    setSqsClientForTesting({
      async send(command) {
        sent.push(command);
        return {};
      },
    });
    const body = JSON.stringify({ job });

    const response = await handler(event({
      body,
      headers: signedHeaders(body),
    }));

    assert.equal(response.statusCode, 202);
    assert.equal(sent.length, 1);
    assert.deepEqual((sent[0] as { input: unknown }).input, {
      QueueUrl: WORKFLOW_LAUNCH_QUEUE_URL,
      MessageBody: JSON.stringify(job),
    });
  });

  it("decodes base64 Function URL bodies before verifying and parsing", async () => {
    const sent: unknown[] = [];
    setSqsClientForTesting({
      async send(command) {
        sent.push(command);
        return {};
      },
    });
    const body = JSON.stringify({ job });

    const response = await handler({
      ...event({
        body: Buffer.from(body, "utf8").toString("base64"),
        headers: signedHeaders(body),
      }),
      isBase64Encoded: true,
    });

    assert.equal(response.statusCode, 202);
    assert.equal(sent.length, 1);
  });

  it("rejects the removed Nango sync bridge route", async () => {
    const body = JSON.stringify({ job: { type: "nango_sync" } });
    const path = "/internal/queues/nango-sync/send";

    const response = await handler(event({
      path,
      body,
      headers: signedHeaders(body, path),
    }));

    assert.equal(response.statusCode, 404);
  });

  it("rejects bad signatures", async () => {
    const body = JSON.stringify({ job });
    const response = await handler(event({
      body,
      headers: {
        "x-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-request-signature": "bad",
      },
    }));

    assert.equal(response.statusCode, 403);
  });

  it("rejects invalid workflow launch jobs", async () => {
    const body = JSON.stringify({ job: { ...job, runId: "" } });
    const response = await handler(event({
      body,
      headers: signedHeaders(body),
    }));

    assert.equal(response.statusCode, 400);
  });

  it("maps SQS send failures to 503", async () => {
    setSqsClientForTesting({
      async send() {
        throw new Error("sqs unavailable");
      },
    });
    const body = JSON.stringify({ job });

    const response = await handler(event({
      body,
      headers: signedHeaders(body),
    }));

    assert.equal(response.statusCode, 503);
  });

  it("reports missing workflow launch queue configuration as bridge misconfiguration", async () => {
    delete process.env.WORKFLOW_LAUNCH_QUEUE_URL;
    const body = JSON.stringify({ job });

    const response = await handler(event({
      body,
      headers: signedHeaders(body),
    }));

    assert.equal(response.statusCode, 500);
  });
});

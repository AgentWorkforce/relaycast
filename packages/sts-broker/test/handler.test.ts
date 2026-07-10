/**
 * Handler tests for the STS broker. Mocks STSClient so the test is
 * hermetic — no AWS network calls. Asserts the routing, auth, scope,
 * and error-mapping behaviour against the broker contract.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  handler,
  resetStsClientForTesting,
  setStsClientForTesting,
} from "../src/handler.js";
import { signRequest } from "../src/hmac-node.js";
import {
  REQUEST_SIGNATURE_HEADER,
  REQUEST_TIMESTAMP_HEADER,
} from "../src/hmac.js";

const SECRET = "test-broker-hmac-secret";
const ROLE_ARN = "arn:aws:iam::131935618863:role/sandbox-sts-role-test";
const BUCKET = "test-workflow-bucket";

function setEnv() {
  process.env.BROKER_HMAC_SECRET = SECRET;
  process.env.WORKFLOW_STORAGE_STS_ROLE_ARN = ROLE_ARN;
  process.env.WORKFLOW_STORAGE_BUCKET = BUCKET;
  process.env.AWS_REGION = "us-east-1";
}

function clearEnv() {
  delete process.env.BROKER_HMAC_SECRET;
  delete process.env.WORKFLOW_STORAGE_STS_ROLE_ARN;
  delete process.env.WORKFLOW_STORAGE_BUCKET;
}

type FakeAssumeRoleSend = (cmd: { input: Record<string, unknown> }) => Promise<unknown>;

function makeFakeStsClient(send: FakeAssumeRoleSend) {
  // Cast through `unknown` because we're only stubbing the `send` surface
  // the broker actually calls — the rest of STSClient's API is irrelevant.
  return { send } as unknown as Parameters<typeof setStsClientForTesting>[0];
}

function makeEvent(opts: {
  method?: string;
  path?: string;
  body: string;
  headers: Record<string, string>;
}): APIGatewayProxyEventV2 {
  // Build a minimal v2 shape matching what Lambda Function URL delivers.
  // The broker only reads requestContext.http.method/path, headers, and body.
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: opts.path ?? "/broker/sts/assume-role",
    rawQueryString: "",
    headers: opts.headers,
    requestContext: {
      accountId: "131935618863",
      apiId: "test",
      domainName: "example.com",
      domainPrefix: "x",
      http: {
        method: opts.method ?? "POST",
        path: opts.path ?? "/broker/sts/assume-role",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "test",
      },
      requestId: "req",
      routeKey: "$default",
      stage: "$default",
      time: "now",
      timeEpoch: 0,
    },
    body: opts.body,
    isBase64Encoded: false,
  } as APIGatewayProxyEventV2;
}

function signedHeaders(body: string, secret = SECRET) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = signRequest({
    method: "POST",
    path: "/broker/sts/assume-role",
    body,
    timestamp: ts,
    secret,
  });
  return {
    [REQUEST_SIGNATURE_HEADER]: sig,
    [REQUEST_TIMESTAMP_HEADER]: ts,
    "content-type": "application/json",
  };
}

describe("handler — routing", () => {
  beforeEach(setEnv);
  afterEach(() => {
    clearEnv();
    resetStsClientForTesting();
    setStsClientForTesting(null);
  });

  it("404s on unknown path", async () => {
    const body = "{}";
    const event = makeEvent({
      path: "/unknown",
      body,
      headers: signedHeaders(body),
    });
    const result = await handler(event);
    assert.equal((result as { statusCode: number }).statusCode, 404);
  });

  it("404s on GET method", async () => {
    const body = "{}";
    const event = makeEvent({
      method: "GET",
      body,
      headers: signedHeaders(body),
    });
    const result = await handler(event);
    assert.equal((result as { statusCode: number }).statusCode, 404);
  });
});

describe("handler — auth", () => {
  beforeEach(setEnv);
  afterEach(() => {
    clearEnv();
    resetStsClientForTesting();
    setStsClientForTesting(null);
  });

  it("returns 403 when signature is missing", async () => {
    const event = makeEvent({
      body: '{"userId":"u","runId":"r"}',
      headers: { "content-type": "application/json" },
    });
    const result = await handler(event);
    assert.equal((result as { statusCode: number }).statusCode, 403);
  });

  it("returns 403 when signature is wrong", async () => {
    const body = '{"userId":"u","runId":"r"}';
    const event = makeEvent({
      body,
      headers: signedHeaders(body, "wrong-secret"),
    });
    const result = await handler(event);
    assert.equal((result as { statusCode: number }).statusCode, 403);
  });

  it("returns 500 when broker secret is not configured", async () => {
    delete process.env.BROKER_HMAC_SECRET;
    const body = '{"userId":"u","runId":"r"}';
    const event = makeEvent({
      body,
      headers: signedHeaders(body),
    });
    const result = await handler(event);
    assert.equal((result as { statusCode: number }).statusCode, 500);
  });
});

describe("handler — request validation", () => {
  beforeEach(setEnv);
  afterEach(() => {
    clearEnv();
    resetStsClientForTesting();
    setStsClientForTesting(null);
  });

  it("returns 400 when userId is missing", async () => {
    const body = '{"runId":"r"}';
    const event = makeEvent({
      body,
      headers: signedHeaders(body),
    });
    const result = await handler(event);
    assert.equal((result as { statusCode: number }).statusCode, 400);
  });

  it("returns 400 when scope=workflow-run and runId is missing", async () => {
    const body = '{"scope":"workflow-run","userId":"u"}';
    const event = makeEvent({
      body,
      headers: signedHeaders(body),
    });
    const result = await handler(event);
    assert.equal((result as { statusCode: number }).statusCode, 400);
  });

  it("returns 400 on unknown scope", async () => {
    const body = '{"scope":"frobnicate","userId":"u"}';
    const event = makeEvent({
      body,
      headers: signedHeaders(body),
    });
    const result = await handler(event);
    assert.equal((result as { statusCode: number }).statusCode, 400);
  });
});

describe("handler — STS happy path", () => {
  beforeEach(setEnv);
  afterEach(() => {
    clearEnv();
    resetStsClientForTesting();
    setStsClientForTesting(null);
  });

  it("returns scoped credentials for workflow-run", async () => {
    const expirationDate = new Date("2026-05-15T12:00:00.000Z");
    setStsClientForTesting(
      makeFakeStsClient(async (cmd) => {
        // Assert the command shape the broker built.
        const input = cmd.input as {
          RoleArn: string;
          Policy: string;
          DurationSeconds: number;
        };
        assert.equal(input.RoleArn, ROLE_ARN);
        // Session policy must reference the user/run prefix.
        assert.match(input.Policy, /alice\/run-1/);
        return {
          Credentials: {
            AccessKeyId: "AKIAFAKE",
            SecretAccessKey: "secret",
            SessionToken: "token",
            Expiration: expirationDate,
          },
        };
      }),
    );

    const body = '{"scope":"workflow-run","userId":"alice","runId":"run-1"}';
    const event = makeEvent({
      body,
      headers: signedHeaders(body),
    });
    const result = await handler(event);
    const parsed = JSON.parse((result as { body: string }).body);
    assert.equal((result as { statusCode: number }).statusCode, 200);
    assert.equal(parsed.accessKeyId, "AKIAFAKE");
    assert.equal(parsed.bucket, BUCKET);
    assert.equal(parsed.prefix, "alice/run-1");
    assert.equal(parsed.expiresAt, expirationDate.toISOString());
  });

  it("returns scoped credentials for credential-store", async () => {
    setStsClientForTesting(
      makeFakeStsClient(async (cmd) => {
        const input = cmd.input as { Policy: string };
        assert.match(input.Policy, /credentials\/alice/);
        return {
          Credentials: {
            AccessKeyId: "AKIAFAKE2",
            SecretAccessKey: "secret",
            SessionToken: "token",
            Expiration: new Date(),
          },
        };
      }),
    );

    const body = '{"scope":"credential-store","userId":"alice"}';
    const event = makeEvent({
      body,
      headers: signedHeaders(body),
    });
    const result = await handler(event);
    const parsed = JSON.parse((result as { body: string }).body);
    assert.equal((result as { statusCode: number }).statusCode, 200);
    assert.equal(parsed.prefix, "credentials/alice");
  });

  it("maps STS failures to 503", async () => {
    setStsClientForTesting(
      makeFakeStsClient(async () => {
        throw Object.assign(new Error("Throttling"), { name: "Throttling" });
      }),
    );

    const body = '{"scope":"workflow-run","userId":"u","runId":"r"}';
    const event = makeEvent({
      body,
      headers: signedHeaders(body),
    });
    const result = await handler(event);
    assert.equal((result as { statusCode: number }).statusCode, 503);
  });
});

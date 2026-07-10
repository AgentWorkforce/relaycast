import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Reporter } from "../../packages/core/src/reporter/reporter.js";

function startMockServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => handler(req, res, body));
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("Bad address");
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({
        url,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe("Reporter", () => {
  let closeServer: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (closeServer) {
      await closeServer();
      closeServer = null;
    }
  });

  it("sends completion callback with correct payload", async () => {
    let receivedBody: any = null;
    let receivedHeaders: any = null;

    const { url, close } = await startMockServer((req, res, body) => {
      receivedBody = JSON.parse(body);
      receivedHeaders = req.headers;
      res.writeHead(200);
      res.end("OK");
    });
    closeServer = close;

    const reporter = new Reporter({ callbackUrl: url, callbackToken: "token-123" });
    await reporter.reportCompletion("run-abc", { summary: "done" });

    assert.equal(receivedBody.runId, "run-abc");
    assert.equal(receivedBody.status, "completed");
    assert.deepEqual(receivedBody.result, { summary: "done" });
    assert.equal("callbackToken" in receivedBody, false);
    assert.equal(receivedHeaders["content-type"], "application/json");
    assert.equal(receivedHeaders["x-callback-token"], "token-123");
  });

  it("sends error callback with error message", async () => {
    let receivedBody: any = null;

    const { url, close } = await startMockServer((_req, res, body) => {
      receivedBody = JSON.parse(body);
      res.writeHead(200);
      res.end("OK");
    });
    closeServer = close;

    const reporter = new Reporter({ callbackUrl: url, callbackToken: "token-456" });
    await reporter.reportError("run-def", new Error("Sandbox crashed"));

    assert.equal(receivedBody.runId, "run-def");
    assert.equal(receivedBody.status, "failed");
    assert.equal(receivedBody.error, "Sandbox crashed");
  });

  it("sends error callback with string error", async () => {
    let receivedBody: any = null;

    const { url, close } = await startMockServer((_req, res, body) => {
      receivedBody = JSON.parse(body);
      res.writeHead(200);
      res.end("OK");
    });
    closeServer = close;

    const reporter = new Reporter({ callbackUrl: url, callbackToken: "tk" });
    await reporter.reportError("run-xyz", "string error message");

    assert.equal(receivedBody.error, "string error message");
  });

  it("retries on server error and eventually succeeds", async () => {
    let attempts = 0;

    const { url, close } = await startMockServer((_req, res, _body) => {
      attempts++;
      if (attempts < 3) {
        res.writeHead(500);
        res.end("Server Error");
      } else {
        res.writeHead(200);
        res.end("OK");
      }
    });
    closeServer = close;

    const reporter = new Reporter({ callbackUrl: url, callbackToken: "retry-tok" });
    await reporter.reportCompletion("run-retry", { ok: true });

    assert.equal(attempts, 3);
  });

  it("throws after exhausting all retry attempts", async () => {
    const { url, close } = await startMockServer((_req, res, _body) => {
      res.writeHead(500);
      res.end("Always fails");
    });
    closeServer = close;

    const reporter = new Reporter({ callbackUrl: url, callbackToken: "fail-tok" });

    await assert.rejects(
      () => reporter.reportCompletion("run-fail", {}),
      { message: /failed after 3 attempts/i }
    );
  });

  it("does not retry on 4xx and surfaces the status code", async () => {
    let attempts = 0;

    const { url, close } = await startMockServer((_req, res, _body) => {
      attempts++;
      res.writeHead(409);
      res.end("Conflict");
    });
    closeServer = close;

    const reporter = new Reporter({ callbackUrl: url, callbackToken: "tok-409" });

    await assert.rejects(
      () => reporter.reportStatus("run-409", "running"),
      (err: Error) => /failed after 1 attempt/i.test(err.message) && /409/.test(err.message)
    );
    assert.equal(attempts, 1, "4xx should not be retried");
  });
});

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";

import {
  assertDormantTarget,
  buildGateRequest,
  parseArgs,
  runGate,
} from "../../scripts/nango-webhook-dormant-burst-gate.js";

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => handler(req, res, body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected local TCP address");
  }

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

describe("nango dormant burst gate", () => {
  it("parses safe defaults and scenario lists", () => {
    const opts = parseArgs(
      [
        "--target",
        "https://cloud-production-webhookworkerscript.example.workers.dev",
        "--scenarios",
        "nango-sync,forged-signature",
      ],
      { NANGO_WEBHOOK_SECRET: "secret" },
    );

    expect(opts.requests).toBe(100);
    expect(opts.concurrency).toBe(25);
    expect(opts.scenarios).toEqual(["nango-sync", "forged-signature"]);
  });

  it("refuses non-worker non-localhost targets by default", () => {
    expect(() =>
      assertDormantTarget("https://agentrelay.com/cloud/api/v1/webhooks/nango", false),
    ).toThrow(/Refusing to run/);

    expect(() =>
      assertDormantTarget("https://agentrelay.com/cloud/api/v1/webhooks/nango", true),
    ).not.toThrow();
  });

  it("signs valid scenarios and marks forged signatures as 401", () => {
    const valid = buildGateRequest("nango-sync", 1, {
      target: "https://example.workers.dev",
      path: "/api/v1/webhooks/nango",
      secret: "secret",
      seed: "seed",
    });
    const forged = buildGateRequest("forged-signature", 2, {
      target: "https://example.workers.dev",
      path: "/api/v1/webhooks/nango",
      secret: "secret",
      seed: "seed",
    });

    expect(valid.headers["x-nango-hmac-sha256"]).toMatch(/^[a-f0-9]{64}$/);
    expect(valid.expectedStatuses).toEqual([202]);
    expect(forged.headers["x-nango-hmac-sha256"]).toBe("00");
    expect(forged.expectedStatuses).toEqual([401]);
  });

  it("passes when every response matches the scenario contract", async () => {
    await withServer((req, res) => {
      const signature = req.headers["x-nango-hmac-sha256"];
      const status = signature === "00" ? 401 : 202;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ status }));
    }, async (target) => {
      const report = await runGate({
        target,
        path: "/api/v1/webhooks/nango",
        secret: "secret",
        scenarios: ["nango-sync", "forged-signature"],
        requests: 6,
        concurrency: 3,
        timeoutMs: 1_000,
        reportPath: "unused.json",
        allowNonWorkerTarget: false,
        seed: "test",
      });

      expect(report.totals).toMatchObject({
        total: 6,
        passed: 6,
        failed: 0,
        fiveXx: 0,
      });
      expect(report.byScenario["nango-sync"].statuses).toEqual({ "202": 3 });
      expect(report.byScenario["forged-signature"].statuses).toEqual({ "401": 3 });
    });
  });

  it("fails the gate on unexpected 5xx responses", async () => {
    await withServer((_req, res) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad_gateway" }));
    }, async (target) => {
      const report = await runGate({
        target,
        path: "/api/v1/webhooks/nango",
        secret: "secret",
        scenarios: ["nango-sync"],
        requests: 4,
        concurrency: 2,
        timeoutMs: 1_000,
        reportPath: "unused.json",
        allowNonWorkerTarget: false,
        seed: "test",
      });

      expect(report.totals).toMatchObject({
        total: 4,
        passed: 0,
        failed: 4,
        fiveXx: 4,
      });
      expect(report.byScenario["nango-sync"].statuses).toEqual({ "502": 4 });
    });
  });
});

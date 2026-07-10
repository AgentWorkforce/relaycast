import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import {
  buildEvidenceFromHop,
  emitCloudEvidence,
  type CloudEvidenceSummary,
} from "../src/observability/evidence-emitter.js";
import {
  newRequestId,
  resolveTelemetryMeta,
} from "../src/observability/telemetry-meta.js";

function createSummary(overrides: Partial<CloudEvidenceSummary> = {}): CloudEvidenceSummary {
  return {
    schemaVersion: "cloud-runtime-evidence/1",
    service: "webhook-worker",
    environment: "test",
    version: "abc1234",
    path: "webhook.queue",
    kind: "queue_processing_error",
    outcome: "retry",
    severity: 6,
    occurredAt: "2026-06-03T12:00:00.000Z",
    requestId: "req_1",
    summary: "queue failed",
    inspect: {
      logQuery: "area:\"nango-webhook-path\" AND requestId:\"req_1\"",
    },
    ...overrides,
  };
}

function createCtx() {
  const waits: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        waits.push(promise);
      },
    },
    waits,
  };
}

describe("observability/telemetry-meta", () => {
  it("resolves metadata with documented precedence", () => {
    assert.deepEqual(
      resolveTelemetryMeta({
        ENVIRONMENT: " production ",
        SST_STAGE: "staging",
        NEXT_PUBLIC_SST_STAGE: "preview",
        DEPLOY_VERSION: " abc1234 ",
        DEPLOY_ID: " deploy-1 ",
        CF_VERSION_METADATA: {
          id: "cf-version",
          tag: "cf-tag",
        },
      }, "webhook-worker"),
      {
        service: "webhook-worker",
        environment: "production",
        version: "abc1234",
        deployId: "deploy-1",
      },
    );

    assert.deepEqual(
      resolveTelemetryMeta({
        SST_STAGE: "staging",
        CF_VERSION_METADATA: {
          id: "cf-version",
          tag: "cf-tag",
        },
      }, "webhook-worker"),
      {
        service: "webhook-worker",
        environment: "staging",
        version: "cf-version",
        deployId: "cf-tag",
      },
    );

    assert.deepEqual(resolveTelemetryMeta({}, "webhook-worker"), {
      service: "webhook-worker",
      environment: "dev",
      version: "unknown",
    });
  });

  it("creates req-prefixed request ids", () => {
    assert.match(newRequestId(), /^req_[0-9a-f-]+$/);
  });
});

describe("observability/evidence-emitter", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("does nothing when NIGHTCTO_EVIDENCE_URL is unset", () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => new Response(null));

    emitCloudEvidence({}, undefined, createSummary());

    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("posts the shared evidence contract with auth headers when configured", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 202 });
    });
    const { ctx, waits } = createCtx();

    emitCloudEvidence(
      {
        NIGHTCTO_EVIDENCE_URL: "https://nightcto.example/webhooks/cloud-runtime",
        NIGHTCTO_EVIDENCE_TOKEN: "secret-token",
      },
      ctx,
      createSummary(),
    );
    await Promise.all(waits);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://nightcto.example/webhooks/cloud-runtime");
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(calls[0].init.headers, {
      "content-type": "application/json",
      authorization: "Bearer secret-token",
      "x-nightcto-evidence-token": "secret-token",
    });
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), createSummary());
  });

  it("never throws when fetch rejects", async () => {
    const warn = mock.method(console, "warn", () => undefined);
    mock.method(globalThis, "fetch", async () => {
      throw new Error("network down");
    });
    const { ctx, waits } = createCtx();

    assert.doesNotThrow(() => {
      emitCloudEvidence(
        { NIGHTCTO_EVIDENCE_URL: "https://nightcto.example/webhooks/cloud-runtime" },
        ctx,
        createSummary(),
      );
    });
    await Promise.all(waits);

    assert.equal(warn.mock.callCount(), 1);
    const payload = warn.mock.calls[0].arguments[1] as Record<string, unknown>;
    assert.equal(payload.area, "cloud-evidence-emit");
    assert.equal(payload.errorMessage, "network down");
  });

  it("truncates summary and errorMessage to 300 characters", async () => {
    const calls: RequestInit[] = [];
    mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(null, { status: 202 });
    });
    const { ctx, waits } = createCtx();

    emitCloudEvidence(
      { NIGHTCTO_EVIDENCE_URL: "https://nightcto.example/webhooks/cloud-runtime" },
      ctx,
      createSummary({
        summary: "s".repeat(400),
        errorMessage: "e".repeat(400),
      }),
    );
    await Promise.all(waits);

    const body = JSON.parse(String(calls[0].body)) as CloudEvidenceSummary;
    assert.equal(body.summary.length, 300);
    assert.equal(body.errorMessage?.length, 300);
  });

  it("builds evidence from telemetry metadata", () => {
    assert.deepEqual(
      buildEvidenceFromHop(
        {
          service: "webhook-worker",
          environment: "production",
          version: "abc1234",
          deployId: "deploy-1",
        },
        {
          path: "webhook.queue.dlq",
          kind: "dlq_dead_letter",
          outcome: "dlq",
          severity: 8,
          occurredAt: "2026-06-03T12:00:00.000Z",
          summary: "1 webhook message(s) dead-lettered",
        },
      ),
      {
        schemaVersion: "cloud-runtime-evidence/1",
        service: "webhook-worker",
        environment: "production",
        version: "abc1234",
        deployId: "deploy-1",
        path: "webhook.queue.dlq",
        kind: "dlq_dead_letter",
        outcome: "dlq",
        severity: 8,
        occurredAt: "2026-06-03T12:00:00.000Z",
        summary: "1 webhook message(s) dead-lettered",
      },
    );
  });
});

import assert from "node:assert/strict";
import { test } from "vitest";

import { createCronTickEvent } from "@agent-relay/events";

import { buildDlqPath, writeGatewayDlqRecord } from "../src/dlq.js";

test("buildDlqPath uses the canonical per-workspace DLQ filename", () => {
  assert.equal(
    buildDlqPath("support", "evt_123"),
    "/_dlq/support/evt_123.json",
  );
});

test("buildDlqPath rejects blank path segments", () => {
  assert.throws(() => buildDlqPath(" ", "evt_123"), /workspace must be a non-empty string/);
  assert.throws(() => buildDlqPath("support", " "), /eventId must be a non-empty string/);
});

test("writeGatewayDlqRecord writes the canonical DLQ file through relayfile", async () => {
  const writes: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    writes.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
      body: init?.body ? String(init.body) : "",
    });
    return Response.json({
      opId: "op_dlq_1",
      status: "queued",
    });
  };

  try {
    const event = createCronTickEvent({
      id: "evt_dlq_1",
      workspace: "support",
      schedule: "*/5 * * * *",
      scheduledFor: "2026-05-12T00:00:00.000Z",
    });

    const record = await writeGatewayDlqRecord({
      workspace: "support",
      agentId: "support-agent",
      event,
      errorMessage: "fatal",
      relayfileAccessToken: "relayfile-token",
      relayfileUrl: "https://relayfile.test",
    });

    assert.equal(record.path, "/_dlq/support/evt_dlq_1.json");
    assert.equal(writes.length, 1);
    assert.equal(
      writes[0]?.url,
      "https://relayfile.test/v1/workspaces/support/fs/file?path=%2F_dlq%2Fsupport%2Fevt_dlq_1.json",
    );
    assert.equal(writes[0]?.method, "PUT");
    assert.equal(writes[0]?.authorization, "Bearer relayfile-token");
    const writePayload = JSON.parse(String(writes[0]?.body ?? "")) as {
      content: string;
    };
    const storedRecord = JSON.parse(writePayload.content) as { path: string };
    assert.equal(storedRecord.path, "/_dlq/support/evt_dlq_1.json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

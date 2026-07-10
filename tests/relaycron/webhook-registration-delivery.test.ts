import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createApp } from "@relaycron/server";
import { executeWebhook } from "../../packages/relaycron/src/engine/executor.ts";

const TOKEN_HEADERS = {
  "x-cloud-agent-deployment-token": "deployment-webhook-secret",
  "x-agentrelay-deployment-token": "deployment-webhook-secret",
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createInMemoryDb(apiKey: string) {
  const apiKeys = [
    {
      id: "api-key-1",
      key_hash: createHash("sha256").update(apiKey).digest("hex"),
      key_prefix: apiKey.slice(0, 10),
    },
  ];
  const schedules: Array<Record<string, unknown>> = [];

  return {
    schedules,
    db: {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  limit: async () => apiKeys,
                };
              },
            };
          },
        };
      },
      insert() {
        return {
          values: async (record: Record<string, unknown>) => {
            schedules.push(record);
          },
        };
      },
      update() {
        return {
          set() {
            return {
              where: async () => undefined,
            };
          },
        };
      },
    },
  };
}

describe("relaycron webhook registration and delivery", () => {
  it("round-trips canonical delivery headers and payload through schedule registration", async () => {
    const apiKey = "ac_issue831";
    const { db, schedules } = createInMemoryDb(apiKey);
    const alarms: Array<{ scheduleId: string; runAt: string }> = [];
    const app = createApp(db as any, {
      setAlarm(scheduleId: string, runAt: string) {
        alarms.push({ scheduleId, runAt });
      },
      cancelAlarm() {},
    });

    const scheduleResponse = await app.fetch(
      new Request("https://relaycron.test/v1/schedules", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "cloud-persona:workspace-1:agent-1:sched",
          description: "Cloud persona cron trigger for agent-1",
          schedule: { cron: "* * * * *", tz: "UTC" },
          payload: {
            workspace: "workspace-1",
            agentId: "agent-1",
            scheduleId: "gateway-schedule-1",
            gatewayScheduleId: "gateway-schedule-1",
          },
          delivery: {
            type: "webhook",
            url: "https://cloud.test/api/v1/workspaces/workspace-1/deployments/agent-1/ticks",
            headers: TOKEN_HEADERS,
            timeout_ms: 10_000,
          },
          metadata: { source: "cloud" },
        }),
      }),
    );

    assert.equal(scheduleResponse.status, 201);
    const schedulePayload = (await scheduleResponse.json()) as {
      data: {
        id: string;
        payload: Record<string, unknown>;
        transport_type: string;
        transport_config: {
          url: string;
          headers?: Record<string, string>;
        };
      };
    };

    assert.equal(schedulePayload.data.transport_type, "webhook");
    assert.deepEqual(schedulePayload.data.payload, {
      workspace: "workspace-1",
      agentId: "agent-1",
      scheduleId: "gateway-schedule-1",
      gatewayScheduleId: "gateway-schedule-1",
    });
    assert.equal(
      schedulePayload.data.transport_config.url,
      "https://cloud.test/api/v1/workspaces/workspace-1/deployments/agent-1/ticks",
    );
    assert.deepEqual(schedulePayload.data.transport_config.headers, TOKEN_HEADERS);
    assert.deepEqual(alarms.map((alarm) => alarm.scheduleId), [
      schedulePayload.data.id,
    ]);
    assert.equal(schedules.length, 1);
    assert.deepEqual(JSON.parse(String(schedules[0].payload)), schedulePayload.data.payload);
    assert.deepEqual(
      JSON.parse(String(schedules[0].transport_config)).headers,
      TOKEN_HEADERS,
    );
  });

  it("sends webhook delivery headers and the registered payload body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response("accepted", { status: 202 });
    }) as typeof fetch;

    const result = await executeWebhook(
      "https://cloud.test/api/v1/workspaces/workspace-1/deployments/agent-1/ticks",
      {
        workspace: "workspace-1",
        agentId: "agent-1",
        scheduleId: "gateway-schedule-1",
      },
      TOKEN_HEADERS,
      10_000,
    );

    assert.equal(result.status, "success");
    assert.equal(result.http_status, 202);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://cloud.test/api/v1/workspaces/workspace-1/deployments/agent-1/ticks",
    );
    assert.deepEqual(
      JSON.parse(String(calls[0].init.body)),
      {
        workspace: "workspace-1",
        agentId: "agent-1",
        scheduleId: "gateway-schedule-1",
      },
    );
    assert.equal(
      (calls[0].init.headers as Record<string, string>)["x-cloud-agent-deployment-token"],
      "deployment-webhook-secret",
    );
    assert.equal(
      (calls[0].init.headers as Record<string, string>)["x-agentrelay-deployment-token"],
      "deployment-webhook-secret",
    );
  });

  it("adds stable occurrence identity to the webhook body and executor-owned headers", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response("accepted", { status: 202 });
    }) as typeof fetch;

    const scheduledRunAt = Date.parse("2026-06-07T09:00:00.000Z");
    const gatewayScheduleId = "gateway-schedule-1";
    const expectedOccurrenceId = createHash("sha256")
      .update(`${gatewayScheduleId}:${scheduledRunAt}`)
      .digest("hex");

    const result = await executeWebhook(
      "https://cloud.test/api/v1/workspaces/workspace-1/deployments/agent-1/ticks",
      {
        workspace: "workspace-1",
        agentId: "agent-1",
        scheduleId: gatewayScheduleId,
        gatewayScheduleId,
      },
      TOKEN_HEADERS,
      10_000,
      { scheduleId: gatewayScheduleId, scheduledRunAt },
    );

    assert.equal(result.status, "success");
    assert.equal(calls.length, 1);
    assert.deepEqual(
      JSON.parse(String(calls[0].init.body)),
      {
        workspace: "workspace-1",
        agentId: "agent-1",
        scheduleId: gatewayScheduleId,
        gatewayScheduleId,
        occurrenceEpoch: scheduledRunAt,
        occurrenceId: expectedOccurrenceId,
      },
    );
    const requestHeaders = calls[0].init.headers as Record<string, string>;
    assert.equal(
      requestHeaders["X-AgentCron-Occurrence-Epoch"],
      String(scheduledRunAt),
    );
    assert.equal(
      requestHeaders["X-AgentCron-Occurrence-Id"],
      expectedOccurrenceId,
    );
  });
});

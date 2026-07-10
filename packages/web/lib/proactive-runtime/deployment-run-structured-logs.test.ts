import { describe, expect, it } from "vitest";

import {
  deploymentRunLogEntriesForApi,
  deploymentRunnerStructuredLogEntries,
} from "./deployment-run-structured-logs";

const base = {
  output: "",
  relayWorkspaceId: "workspace-1",
  agentId: "agent-1",
  deploymentId: "deployment-1",
  eventSource: "cron:daily",
  sandboxId: "sandbox-1",
};

describe("deployment run structured log parsing", () => {
  it("skips malformed partial NDJSON lines and interleaved non-JSON noise", () => {
    const entries = deploymentRunnerStructuredLogEntries({
      ...base,
      output: [
        "installing dependencies...",
        JSON.stringify({
          t: "2026-06-03T22:21:09.773Z",
          level: "info",
          message: "runner.started",
          source: "system",
        }),
        "{\"t\":\"2026-06-03T22:21:10.000Z\",\"level\":\"error\",\"message\":",
        "{not-json}",
        JSON.stringify({
          ts: "2026-06-03T22:21:11.000Z",
          level: "warn",
          msg: "runner.cleanup.warning",
          source: "runner",
        }),
        "stdout tail truncated at a random byte {\"t\":\"2026-06",
      ].join("\n"),
    });

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.msg)).toEqual([
      "runner.started",
      "runner.cleanup.warning",
    ]);
  });

  it("maps structured runner lines into API entries with payload and duration", () => {
    const entries = deploymentRunLogEntriesForApi({
      ...base,
      runId: "run-1",
      output: JSON.stringify({
        t: "2026-06-03T22:21:09.782Z",
        level: "error",
        message: "POST /api/v1/workspaces/ws/deployments/agent/ticks failed",
        source: "handler",
        durationMs: 904,
        status: "failed",
        nested: { providerToken: "ghp_123456789012345678901234" },
      }),
    });

    expect(entries).toEqual([{
      id: "run-1:0",
      timestamp: "2026-06-03T22:21:09.782Z",
      level: "error",
      source: "handler",
      message: "POST /api/v1/workspaces/ws/deployments/agent/ticks failed",
      durationMs: 904,
      stream: "runner",
      payload: expect.objectContaining({
        workspace: "workspace-1",
        agentId: "agent-1",
        deploymentId: "deployment-1",
        eventSource: "cron:daily",
        sandboxId: "sandbox-1",
        source: "handler",
        durationMs: 904,
        status: "failed",
        nested: { providerToken: "[REDACTED]" },
      }),
    }]);
  });
});

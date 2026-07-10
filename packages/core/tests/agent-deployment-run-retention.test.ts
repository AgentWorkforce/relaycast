import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAgentDeploymentRunSummary,
  compactAgentDeploymentRuns,
} from "../src/sync/agent-deployment-run-retention.js";

type QueryCall = {
  sql: string;
  params?: unknown[];
};

function makeClient(rows: unknown[] = []) {
  const calls: QueryCall[] = [];

  return {
    calls,
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql.includes("SELECT") && sql.includes("agent_deployment_runs")) {
        return { rows };
      }
      return { rows: [] };
    },
  };
}

describe("agent deployment run retention", () => {
  it("builds one-line summaries with outcome, duration, and first-line error", () => {
    const summary = buildAgentDeploymentRunSummary({
      status: "failed",
      exit_code: 1,
      duration_ms: 2450,
      error: "runtime failed\nstack trace line",
    });

    assert.equal(summary, "failed (exit 1) in 2.5 s - error: runtime failed");
    assert.equal(summary.includes("\n"), false);
  });

  it("compresses eligible rows and nulls captured output fields", async () => {
    const now = new Date("2026-05-23T00:00:00.000Z");
    const client = makeClient([
      {
        id: "run-1",
        status: "succeeded",
        exit_code: 0,
        duration_ms: 42,
        error: null,
      },
      {
        id: "run-2",
        status: "failed",
        exit_code: 2,
        duration_ms: 12_000,
        error: "deploy failed\nfull log follows",
      },
    ]);

    const result = await compactAgentDeploymentRuns(client, {
      now,
      retentionDays: 14,
      batchLimit: 100,
    });

    assert.deepEqual(result, {
      compressed: 2,
      retentionDays: 14,
      batchLimit: 100,
    });

    assert.equal(client.calls[0]?.sql, "BEGIN");
    assert.deepEqual(client.calls[1]?.params, [now.toISOString(), 14, 100]);
    assert.match(client.calls[1]?.sql ?? "", /FOR UPDATE SKIP LOCKED/);

    const updateCalls = client.calls.filter((call) => call.sql.includes("UPDATE agent_deployment_runs"));
    assert.equal(updateCalls.length, 2);
    assert.match(updateCalls[0]?.sql ?? "", /stdout = NULL/);
    assert.match(updateCalls[0]?.sql ?? "", /stderr = NULL/);
    assert.match(updateCalls[0]?.sql ?? "", /mount_log_tail = NULL/);
    assert.deepEqual(updateCalls[0]?.params, [
      "succeeded (exit 0) in 42 ms",
      now.toISOString(),
      "run-1",
    ]);
    assert.deepEqual(updateCalls[1]?.params, [
      "failed (exit 2) in 12 s - error: deploy failed",
      now.toISOString(),
      "run-2",
    ]);
    assert.equal(client.calls.at(-1)?.sql, "COMMIT");
  });

  it("rolls back when a row update fails", async () => {
    const calls: QueryCall[] = [];
    const client = {
      calls,
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        if (sql.includes("SELECT") && sql.includes("agent_deployment_runs")) {
          return {
            rows: [{
              id: "run-1",
              status: "failed",
              exit_code: 1,
              duration_ms: 1_000,
              error: "boom",
            }],
          };
        }
        if (sql.includes("UPDATE agent_deployment_runs")) {
          throw new Error("db unavailable");
        }
        return { rows: [] };
      },
    };

    await assert.rejects(
      compactAgentDeploymentRuns(client, {
        now: new Date("2026-05-23T00:00:00.000Z"),
      }),
      /db unavailable/,
    );

    assert.equal(calls.at(-1)?.sql, "ROLLBACK");
  });
});

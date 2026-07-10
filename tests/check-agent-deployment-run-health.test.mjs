import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_PR_REVIEWER_AGENT_ID,
  buildAgentDeploymentRunHealthQuery,
  classifyAgentDeploymentRunHealth,
  parseArgs,
} from "../scripts/check-agent-deployment-run-health.mjs";

test("agent deployment run health defaults to pr-reviewer", () => {
  const options = parseArgs(["node", "script"], {
    NEON_APP_DATABASE_URL: "postgres://example",
  });

  assert.equal(options.agentId, DEFAULT_PR_REVIEWER_AGENT_ID);
  assert.equal(options.agentName, "pr-reviewer");
  assert.equal(options.windowMinutes, 30);
  assert.equal(options.minRuns, 3);
  assert.equal(options.maxFailureRate, 0);
});

test("agent deployment run health query treats boxless and incomplete runs as unhealthy", () => {
  const query = buildAgentDeploymentRunHealthQuery({
    agentId: DEFAULT_PR_REVIEWER_AGENT_ID,
    windowMinutes: 30,
  });

  assert.match(query.text, /FROM agent_deployment_runs/);
  assert.match(query.text, /sandbox_id IS NULL/);
  assert.match(query.text, /cleanup_status->>'scriptCompleted'/);
  assert.deepEqual(query.values, [DEFAULT_PR_REVIEWER_AGENT_ID, 30]);
});

test("agent deployment run health skips below sample floor", () => {
  const result = classifyAgentDeploymentRunHealth(
    { total_runs: 2, unhealthy_runs: 2, healthy_runs: 0, succeeded_runs: 0 },
    { agentName: "pr-reviewer", windowMinutes: 30, minRuns: 3, maxFailureRate: 0 },
  );

  assert.equal(result.status, "skip");
});

test("agent deployment run health fails when unhealthy rate exceeds threshold", () => {
  const result = classifyAgentDeploymentRunHealth(
    { total_runs: 4, unhealthy_runs: 1, healthy_runs: 3, succeeded_runs: 3 },
    { agentName: "pr-reviewer", windowMinutes: 30, minRuns: 3, maxFailureRate: 0 },
  );

  assert.equal(result.status, "fail");
  assert.equal(result.health.failureRate, 0.25);
});

test("agent deployment run health passes when all sampled runs completed with boxes", () => {
  const result = classifyAgentDeploymentRunHealth(
    { total_runs: "3", unhealthy_runs: "0", healthy_runs: "3", succeeded_runs: "3" },
    { agentName: "pr-reviewer", windowMinutes: 30, minRuns: 3, maxFailureRate: 0 },
  );

  assert.equal(result.status, "pass");
  assert.equal(result.health.healthyRuns, 3);
});

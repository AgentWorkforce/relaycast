import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({ execute: mocks.execute }),
}));

import { listAuthorizedDeploymentRuns } from "./deployment-run-observability-core";

const baseRunRow = {
  id: "run-1",
  deployment_id: "deployment-1",
  agent_id: "agent-1",
  trigger_kind: "clock",
  event_source: "cron:manual:scan",
  sandbox_id: "sandbox-1",
  sandbox_name: "sandbox-name",
  stdout_truncated: false,
  stderr_truncated: false,
  exit_code: 1,
  cleanup_status: {
    mountConfigured: true,
    scriptCompleted: true,
    flushExitCode: 1,
    killExitCode: 0,
    pendingWriteback: 0,
    hasPendingWriteback: false,
    outboxNeedsAttention: false,
    commandDraftWrittenThisRun: false,
    commandDraftsUndeliverable: 0,
  },
  started_at: "2026-06-28T13:40:48.147Z",
  ended_at: "2026-06-28T13:43:13.719Z",
  duration_ms: 145572,
  status: "failed",
  error: null,
  summary: null,
  compressed_at: null,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  total_tokens: 0,
  agent_total_tokens: 0,
};

describe("deployment run observability serialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not serialize cleanup-backed failed compact rows with an empty error", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [baseRunRow] });

    const response = await listAuthorizedDeploymentRuns(
      new Request("https://cloud.test/runs?format=compact"),
      { workspaceId: "workspace-1", agentId: "agent-1" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      runs: [
        {
          runId: "run-1",
          status: "failed",
          error: "relayfile mount cleanup failed (flushExitCode=1)",
          failureClass: "mount_failure",
          terminalCause: {
            code: "mount_failure",
            headline: "mount_failure",
          },
        },
      ],
    });
  });
});

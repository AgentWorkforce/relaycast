import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as evidenceModule from "../../packages/web/lib/ricky/evidence-builder-rows.ts";
import * as diagnoseEvidenceModule from "../../packages/web/lib/ricky/evidence-builder.ts";
import type { WorkflowRunEvidence } from "../../packages/web/lib/ricky/types.ts";

const { buildWorkflowRunEvidenceFromRows: buildWorkflowRunEvidence } = evidenceModule as {
  buildWorkflowRunEvidenceFromRows: typeof import("../../packages/web/lib/ricky/evidence-builder-rows.ts").buildWorkflowRunEvidenceFromRows;
};

const { diagnoseEvidence } = diagnoseEvidenceModule as {
  diagnoseEvidence: typeof import("../../packages/web/lib/ricky/evidence-builder.ts").diagnoseEvidence;
};

function makeEvidence(overrides: {
  status?: string;
  error?: string;
  runner?: string;
  steps?: WorkflowRunEvidence["steps"];
}): WorkflowRunEvidence {
  return {
    schemaVersion: 1,
    capturedAt: "2026-05-05T19:25:00.000Z",
    rickyRunId: "ricky-run-x",
    attempt: 1,
    workflowRun: {
      runId: "workflow-run-x",
      status: overrides.status ?? "failed",
      error: overrides.error,
      fileType: "ts",
      workflow: "// workflow source",
      sandboxId: "sandbox-x",
    },
    retry: { attempt: 1 },
    steps: overrides.steps ?? [],
    events: [],
    logs: {
      runner: overrides.runner ?? "",
      stepLogs: [],
    },
    runtime: { sandboxId: "sandbox-x", id: "daytona" },
  };
}

describe("Ricky evidence builder", () => {
  it("builds Ricky-compatible evidence from cloud rows and persists a snapshot reference", async () => {
    const storedSnapshots: Array<{
      rickyRunId: string;
      attempt: number;
      workflowRunId: string;
      content: string;
      digest: string;
    }> = [];

    const result = await buildWorkflowRunEvidence({
      rickyRunId: "ricky-run-1",
      attempt: 2,
      capturedAt: "2026-05-03T12:02:00.000Z",
      run: {
        runId: "workflow-run-2",
        status: "failed",
        result: { ok: false },
        error: "step build failed",
        fileType: "yaml",
        workflow: "name: broken\n",
        sandboxId: "sandbox-1",
        relayWorkspaceId: "rw_123",
      },
      previousRunId: "workflow-run-1",
      startFrom: "build",
      steps: [
        {
          stepName: "build",
          agent: "builder",
          preset: "worker",
          cli: "codex",
          sandboxId: "sandbox-1",
          startTime: "2026-05-03T12:01:00.000Z",
          endTime: "2026-05-03T12:01:30.000Z",
          durationMs: 30000,
          exitCode: 1,
          outputSummary: "",
          status: "failed",
          error: "missing artifact",
        },
        {
          stepName: "setup",
          agent: "setup",
          preset: "worker",
          cli: "codex",
          sandboxId: "sandbox-1",
          startTime: "2026-05-03T12:00:00.000Z",
          endTime: "2026-05-03T12:00:05.000Z",
          durationMs: 5000,
          exitCode: 0,
          outputSummary: "cached",
          status: "succeeded",
        },
      ],
      events: [
        {
          sequence: 2,
          eventType: "step.failed",
          createdAt: "2026-05-03T12:01:30.000Z",
          payload: { stepId: "build" },
        },
        {
          sequence: 1,
          eventType: "step.started",
          createdAt: "2026-05-03T12:00:00.000Z",
          payload: { stepId: "setup" },
        },
      ],
      logs: {
        runner: "setup ok\nbuild failed\n",
        stepLogs: [{ sandboxId: "sandbox-1", content: "agent log" }],
      },
      patch: { patch: "diff --git a/workflow.yaml b/workflow.yaml\n", hasChanges: true },
      runtime: {
        id: "daytona",
        sandboxId: "sandbox-1",
        workerAssignmentId: "assignment-1",
        relayWorkspaceId: "rw_123",
      },
      snapshotStore: {
        async put(input) {
          storedSnapshots.push(input);
          return {
            objectKey: `ricky/${input.rickyRunId}/attempt-${input.attempt}/evidence.json`,
          };
        },
      },
    });

    assert.equal(result.evidence.schemaVersion, 1);
    assert.equal(result.evidence.workflowRun.runId, "workflow-run-2");
    assert.deepEqual(
      result.evidence.steps.map((step) => step.stepName),
      ["setup", "build"],
    );
    assert.deepEqual(
      result.evidence.events.map((event) => event.sequence),
      [1, 2],
    );
    assert.deepEqual(result.evidence.retry, {
      attempt: 2,
      previousRunId: "workflow-run-1",
      startFrom: "build",
    });
    assert.equal(result.evidence.logs.runner, "setup ok\nbuild failed\n");
    assert.equal(result.snapshotRef?.objectKey, "ricky/ricky-run-1/attempt-2/evidence.json");
    assert.match(result.snapshotRef?.digest ?? "", /^[a-f0-9]{64}$/);
    assert.equal(storedSnapshots.length, 1);
    assert.equal(storedSnapshots[0]?.workflowRunId, "workflow-run-2");
    assert.equal(storedSnapshots[0]?.digest, result.snapshotRef?.digest);
    assert.match(storedSnapshots[0]?.content ?? "", /"workflow-run-2"/);
  });
});

describe("diagnoseEvidence", () => {
  it("does not classify Daytona bootstrap credential lines as missing_credentials", () => {
    const runner = [
      "[bootstrap] Mounted credentials for opencode at /home/daytona/.local/share/opencode/auth.json",
      "[bootstrap] Mounted credentials for anthropic at /home/daytona/.claude/.credentials.json",
      "[bootstrap] Mounted credentials for openai at /home/daytona/.codex/auth.json",
      "[workflow 00:00] Starting workflow",
      "  ● verify-output — started",
      "[workflow 00:31] [verify-output] Command failed (exit code 1)",
      '  ✗ verify-output — FAILED: Command failed with exit code 1',
      '[workflow] FAILED: Step "verify-output" failed: Command failed with exit code 1',
    ].join("\n");

    const diagnosis = diagnoseEvidence(
      makeEvidence({
        error: 'Standalone TS workflow execution failed for "/home/daytona/workflow.ts"',
        runner,
        steps: [
          {
            stepName: "verify-output",
            agent: "deterministic",
            preset: "worker",
            cli: "shell",
            sandboxId: "sandbox-x",
            startTime: "2026-05-05T19:22:10Z",
            endTime: "2026-05-05T19:22:42Z",
            durationMs: 32000,
            exitCode: 1,
            outputSummary: "",
            error: "Command failed with exit code 1",
          },
        ],
      }),
    );

    assert.notEqual(diagnosis.classification, "missing_credentials");
    assert.equal(diagnosis.classification, "workflow_artifact");
    assert.equal(diagnosis.repairable, true);
    assert.equal(diagnosis.failedStep, "verify-output");
  });

  it("still classifies real credential failures as missing_credentials", () => {
    const diagnosis = diagnoseEvidence(
      makeEvidence({
        error: "Authentication failed: 401 Unauthorized",
        runner: "[workflow] HTTP 401 Unauthorized — token rejected",
      }),
    );

    assert.equal(diagnosis.classification, "missing_credentials");
    assert.equal(diagnosis.repairable, false);
  });

  it("classifies completed runs as success regardless of log content", () => {
    const diagnosis = diagnoseEvidence(
      makeEvidence({
        status: "completed",
        runner: "[bootstrap] Mounted credentials for openai at /home/daytona/.codex/auth.json",
      }),
    );

    assert.equal(diagnosis.classification, "success");
    assert.equal(diagnosis.repairable, false);
  });
});

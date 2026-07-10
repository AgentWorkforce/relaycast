import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimWorkflowLaunchJob: vi.fn(),
  getWorkflowLaunchJob: vi.fn(),
  isWorkflowLaunchJobTerminal: vi.fn(),
  markWorkflowLaunchJobFailed: vi.fn(),
  markWorkflowLaunchJobLaunched: vi.fn(),
  markWorkflowLaunchJobRelayWorkspace: vi.fn(),
  markWorkflowLaunchJobSandboxCreated: vi.fn(),
  recordWorkflowLaunchJobRetryableFailure: vi.fn(),
  releaseWorkflowLaunchJobForRetry: vi.fn(),
  getDb: vi.fn(),
  workflowGet: vi.fn(),
  workflowUpdate: vi.fn(),
  enqueueWorkflowLaunchJob: vi.fn(),
  createGithubProxyIssueComment: vi.fn(),
  decryptWorkflowLaunchEnvelope: vi.fn(),
  runWorkflowLaunch: vi.fn(),
  dbUpdateReturning: vi.fn(),
}));

vi.mock("sst", () => ({
  Resource: {
    CredentialEncryptionKey: { value: "0".repeat(64) },
  },
}));

vi.mock("@cloud/core/workflow-launch/job-store.js", () => ({
  claimWorkflowLaunchJob: mocks.claimWorkflowLaunchJob,
  getWorkflowLaunchJob: mocks.getWorkflowLaunchJob,
  isWorkflowLaunchJobTerminal: mocks.isWorkflowLaunchJobTerminal,
  markWorkflowLaunchJobFailed: mocks.markWorkflowLaunchJobFailed,
  markWorkflowLaunchJobLaunched: mocks.markWorkflowLaunchJobLaunched,
  markWorkflowLaunchJobRelayWorkspace: mocks.markWorkflowLaunchJobRelayWorkspace,
  markWorkflowLaunchJobSandboxCreated: mocks.markWorkflowLaunchJobSandboxCreated,
  recordWorkflowLaunchJobRetryableFailure: mocks.recordWorkflowLaunchJobRetryableFailure,
  releaseWorkflowLaunchJobForRetry: mocks.releaseWorkflowLaunchJobForRetry,
}));

vi.mock("@cloud/core/workflow-launch/job.js", () => ({
  WORKFLOW_LAUNCH_JOB_MAX_ATTEMPTS: 3,
}));

vi.mock("../db", () => ({ getDb: mocks.getDb }));

vi.mock("../workflows", () => ({
  workflowStore: {
    get: mocks.workflowGet,
    update: mocks.workflowUpdate,
  },
}));

vi.mock("../integrations/github-proxy-pull-request", () => ({
  createGithubProxyIssueComment: mocks.createGithubProxyIssueComment,
}));

vi.mock("./launch-job-envelope", () => ({
  decryptWorkflowLaunchEnvelope: mocks.decryptWorkflowLaunchEnvelope,
}));

vi.mock("@cloud/core/bootstrap/launcher.js", () => ({
  WorkflowSandboxProvisioningPendingError: class WorkflowSandboxProvisioningPendingError extends Error {
    sandboxId: string;
    state?: string;
    constructor(sandboxId: string, state?: string) {
      super(`Workflow sandbox ${sandboxId} is still provisioning`);
      this.name = "WorkflowSandboxProvisioningPendingError";
      this.sandboxId = sandboxId;
      this.state = state;
    }
  },
}));

vi.mock("./durable-launch-queue", () => ({
  enqueueWorkflowLaunchJob: mocks.enqueueWorkflowLaunchJob,
}));

vi.mock("./launch-runner", () => ({
  runWorkflowLaunch: mocks.runWorkflowLaunch,
  WorkflowLaunchError: class WorkflowLaunchError extends Error {
    kind: "terminal" | "retryable";
    constructor(kind: "terminal" | "retryable", message: string) {
      super(message);
      this.kind = kind;
    }
  },
}));

import {
  processWorkflowLaunchQueueRecord,
} from "./launch-worker";
import { processWorkflowLaunchDlqRecord } from "./launch-dlq-worker";

const dbUpdateMocks = {
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
};
const db = {
  id: "db",
  update: dbUpdateMocks.update,
};
const requestEnvelope = { v: 1, iv: "iv", tag: "tag", ciphertext: "ciphertext" };
const envelope = {
  runId: "run-1",
  workspaceId: "workspace-1",
  workflowOwnerUserId: "user-1",
};
const envelopeWithIssue = {
  ...envelope,
  failureNotification: {
    githubIssue: {
      owner: "AgentWorkforce",
      repo: "cloud",
      issueNumber: 1091,
    },
  },
};

function record() {
  return { body: JSON.stringify({ jobId: "job-1", runId: "run-1" }) };
}

function claimedJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    runId: "run-1",
    attempts: 1,
    sandboxId: null,
    requestEnvelope,
    ...overrides,
  };
}

describe("workflow launch worker", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getDb.mockReturnValue(db);
    mocks.workflowGet.mockResolvedValue({ runId: "run-1", sandboxId: null, status: "pending" });
    mocks.workflowUpdate.mockResolvedValue({});
    mocks.createGithubProxyIssueComment.mockResolvedValue({ commentUrl: "https://github.com/AgentWorkforce/cloud/issues/1091#issuecomment-1" });
    mocks.decryptWorkflowLaunchEnvelope.mockReturnValue(envelope);
    dbUpdateMocks.update.mockReturnValue({ set: dbUpdateMocks.set });
    dbUpdateMocks.set.mockReturnValue({ where: dbUpdateMocks.where });
    dbUpdateMocks.where.mockReturnValue({ returning: mocks.dbUpdateReturning });
    mocks.dbUpdateReturning.mockResolvedValue([{ id: "run-1" }]);
  });

  it("records sandbox id before completing the launch job", async () => {
    mocks.claimWorkflowLaunchJob.mockResolvedValue(claimedJob());
    mocks.runWorkflowLaunch.mockImplementation(async (input: { onSandboxCreated?: (sandboxId: string) => Promise<void> }) => {
      await input.onSandboxCreated?.("sandbox-1");
      return { sandboxId: "sandbox-1", relayWorkspaceId: "rw-1" };
    });

    await processWorkflowLaunchQueueRecord(record());

    expect(mocks.markWorkflowLaunchJobSandboxCreated).toHaveBeenCalledWith(db, "job-1", "sandbox-1");
    expect(mocks.workflowUpdate).toHaveBeenCalledWith("run-1", { sandboxId: "sandbox-1" });
    expect(mocks.markWorkflowLaunchJobLaunched).toHaveBeenCalledWith(db, "job-1", {
      sandboxId: "sandbox-1",
      relayWorkspaceId: "rw-1",
    });
  });

  it("fails visibly instead of retrying after a sandbox has been created", async () => {
    mocks.claimWorkflowLaunchJob.mockResolvedValue(claimedJob());
    mocks.runWorkflowLaunch.mockImplementation(async (input: { onSandboxCreated?: (sandboxId: string) => Promise<void> }) => {
      await input.onSandboxCreated?.("sandbox-1");
      throw new Error("after create crash");
    });

    await processWorkflowLaunchQueueRecord(record());

    expect(mocks.markWorkflowLaunchJobFailed).toHaveBeenCalledWith(db, "job-1", "after create crash");
    expect(mocks.workflowUpdate).toHaveBeenLastCalledWith("run-1", {
      status: "failed",
      error: "after create crash",
    });
    expect(mocks.recordWorkflowLaunchJobRetryableFailure).not.toHaveBeenCalled();
  });

  it("re-enqueues a persisted provisioning sandbox instead of terminal-failing it", async () => {
    const { WorkflowSandboxProvisioningPendingError } = await import("@cloud/core/bootstrap/launcher.js");
    mocks.claimWorkflowLaunchJob.mockResolvedValue(claimedJob({
      attempts: 2,
      sandboxId: "sandbox-1",
      createdAt: new Date(Date.now() - 10_000),
    }));
    mocks.runWorkflowLaunch.mockRejectedValue(
      new WorkflowSandboxProvisioningPendingError("sandbox-1", "STARTING"),
    );

    await processWorkflowLaunchQueueRecord(record());

    expect(mocks.runWorkflowLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        provisioningSandboxId: "sandbox-1",
      }),
    );
    expect(mocks.releaseWorkflowLaunchJobForRetry).toHaveBeenCalledWith(
      db,
      "job-1",
      "Workflow sandbox sandbox-1 is still provisioning",
    );
    expect(mocks.enqueueWorkflowLaunchJob).toHaveBeenCalledWith(
      { jobId: "job-1", runId: "run-1" },
      { delaySeconds: 60 },
    );
    expect(mocks.markWorkflowLaunchJobFailed).not.toHaveBeenCalled();
  });

  it("fails visibly when the retry budget is exhausted", async () => {
    mocks.claimWorkflowLaunchJob.mockResolvedValue(claimedJob({ attempts: 3 }));
    mocks.runWorkflowLaunch.mockRejectedValue(new Error("launch timed out"));

    await processWorkflowLaunchQueueRecord(record());

    expect(mocks.markWorkflowLaunchJobFailed).toHaveBeenCalledWith(db, "job-1", "launch timed out");
    expect(mocks.workflowUpdate).toHaveBeenCalledWith("run-1", {
      status: "failed",
      error: "launch timed out",
    });
  });

  it("comments the first retryable launch failure without changing retry behavior", async () => {
    mocks.claimWorkflowLaunchJob.mockResolvedValue(claimedJob());
    mocks.decryptWorkflowLaunchEnvelope.mockReturnValue(envelopeWithIssue);
    mocks.runWorkflowLaunch.mockRejectedValue(new Error("relayfile ACL GET /.relayfile.acl timed out after 15000ms"));

    await expect(processWorkflowLaunchQueueRecord(record())).rejects.toThrow(
      "relayfile ACL GET /.relayfile.acl timed out after 15000ms",
    );

    expect(mocks.recordWorkflowLaunchJobRetryableFailure).toHaveBeenCalledWith(
      db,
      "job-1",
      "relayfile ACL GET /.relayfile.acl timed out after 15000ms",
    );
    expect(mocks.createGithubProxyIssueComment).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "workspace-1",
      owner: "AgentWorkforce",
      repo: "cloud",
      issueNumber: 1091,
      body: expect.stringContaining("relayfile ACL GET /.relayfile.acl timed out after 15000ms"),
    });
  });

  it("does not let a launch-failure comment error mask the launch failure", async () => {
    mocks.claimWorkflowLaunchJob.mockResolvedValue(claimedJob());
    mocks.decryptWorkflowLaunchEnvelope.mockReturnValue(envelopeWithIssue);
    mocks.createGithubProxyIssueComment.mockRejectedValue(new Error("nango unavailable"));
    mocks.runWorkflowLaunch.mockRejectedValue(new Error("daytona create timed out"));

    await expect(processWorkflowLaunchQueueRecord(record())).rejects.toThrow(
      "daytona create timed out",
    );

    expect(mocks.createGithubProxyIssueComment).toHaveBeenCalledTimes(1);
    expect(mocks.recordWorkflowLaunchJobRetryableFailure).toHaveBeenCalledWith(
      db,
      "job-1",
      "daytona create timed out",
    );
  });

  it("marks DLQ jobs failed so runs do not stay pending", async () => {
    mocks.getWorkflowLaunchJob.mockResolvedValue({
      id: "job-1",
      runId: "run-1",
      status: "launching",
      attempts: 3,
      lastError: "daytona unavailable",
    });

    await processWorkflowLaunchDlqRecord(record());

    expect(mocks.markWorkflowLaunchJobFailed).toHaveBeenCalledWith(
      db,
      "job-1",
      "Workflow launch exhausted retries: daytona unavailable",
    );
    expect(dbUpdateMocks.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        error: "Workflow launch exhausted retries: daytona unavailable",
      }),
    );
    expect(mocks.workflowUpdate).not.toHaveBeenCalled();
  });
});

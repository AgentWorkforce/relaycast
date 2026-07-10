import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as loopModule from "../../packages/web/lib/ricky/run-loop-harness.ts";
import * as supervisorModule from "../../packages/web/lib/ricky/run-supervisor.ts";
import type {
  AgentAvailability,
  CloudWorkflowRunRow,
  RickyAutoFixPolicy,
  RickyDiagnosis,
  WorkflowRunEvidence,
} from "../../packages/web/lib/ricky/types.ts";
import type { RequestAuth } from "../../packages/web/lib/auth/request-auth.ts";

const { runRickyAutoFixHarness } = loopModule as {
  runRickyAutoFixHarness: typeof import("../../packages/web/lib/ricky/run-loop-harness.ts").runRickyAutoFixHarness;
};
const { canAccessRickyRun, normalizeAutoFixPolicy } = supervisorModule as {
  canAccessRickyRun: typeof import("../../packages/web/lib/ricky/run-supervisor.ts").canAccessRickyRun;
  normalizeAutoFixPolicy: typeof import("../../packages/web/lib/ricky/run-supervisor.ts").normalizeAutoFixPolicy;
};
const { canResolveRickyGate, isCreateRickyRunRequest } = supervisorModule as {
  canResolveRickyGate: typeof import("../../packages/web/lib/ricky/run-supervisor.ts").canResolveRickyGate;
  isCreateRickyRunRequest: typeof import("../../packages/web/lib/ricky/run-supervisor.ts").isCreateRickyRunRequest;
};
const { runRickyAutoFix } = supervisorModule as {
  runRickyAutoFix: typeof import("../../packages/web/lib/ricky/run-supervisor.ts").runRickyAutoFix;
};

const policy: RickyAutoFixPolicy = {
  enabled: true,
  maxAttempts: 2,
  preferWorkforcePersona: true,
  allowOpenRouterFallback: true,
  requireHumanApprovalFor: [],
};

const openRouterAvailability: AgentAvailability = {
  checkedAt: "2026-05-03T12:00:00.000Z",
  workspaceId: "workspace-1",
  userId: "user-1",
  requestedClis: ["claude"],
  subscriptionAgents: [
    {
      cli: "claude",
      provider: "anthropic",
      source: "cloud_agents",
      status: "missing",
    },
  ],
  workforcePersona: { status: "missing" },
  openRouterFallback: {
    status: "usable",
    provider: "openrouter",
    model: "openrouter/auto",
  },
};

const diagnosis: RickyDiagnosis = {
  classification: "workflow_artifact",
  repairable: true,
  failedStep: "verify",
  summary: "verify contract failed",
  evidenceRefs: ["steps"],
};

function evidence(runId: string): WorkflowRunEvidence {
  return {
    schemaVersion: 1,
    capturedAt: "2026-05-03T12:00:00.000Z",
    rickyRunId: "ricky-test",
    attempt: 1,
    workflowRun: {
      runId,
      status: "failed",
      fileType: "yaml",
      workflow: "name: broken\n",
      sandboxId: null,
    },
    retry: {},
    steps: [],
    events: [],
    logs: { stepLogs: [] },
    runtime: { sandboxId: null },
  };
}

function workflowRow(id: string, status: string): CloudWorkflowRunRow {
  return {
    id,
    runId: id,
    status,
    fileType: "yaml",
    workflow: "name: broken\n",
  };
}

describe("Ricky policy normalization", () => {
  it("falls back to safe defaults for malformed auto-fix policy values", () => {
    const normalized = normalizeAutoFixPolicy({
      enabled: "false",
      maxAttempts: "not-a-number",
      preferWorkforcePersona: "no",
      allowOpenRouterFallback: "yes",
      requireHumanApprovalFor: "credential_change",
    } as never);

    assert.deepEqual(normalized, {
      enabled: true,
      maxAttempts: 3,
      preferWorkforcePersona: true,
      allowOpenRouterFallback: true,
      requireHumanApprovalFor: [],
    });
  });

  it("clamps maxAttempts to the supported integer range and filters approval reasons", () => {
    const normalized = normalizeAutoFixPolicy({
      maxAttempts: 8.9,
      requireHumanApprovalFor: ["credential_change", "unknown_reason", "cost_over_budget"],
    } as never);

    assert.equal(normalized.maxAttempts, 5);
    assert.deepEqual(normalized.requireHumanApprovalFor, ["credential_change", "cost_over_budget"]);
  });
});

describe("Ricky create request validation", () => {
  it("matches workflow launcher validation for workflow paths and env secrets", () => {
    const valid = {
      workflow: "name: ok\n",
      fileType: "yaml",
      workflowPath: "workflows/demo.ts",
      envSecrets: { SAFE_TOKEN: "secret-ref" },
      runtime: { id: "daytona" },
    };

    assert.equal(isCreateRickyRunRequest(valid), true);
    assert.equal(isCreateRickyRunRequest({ ...valid, workflowPath: "../escape.ts" }), false);
    assert.equal(isCreateRickyRunRequest({ ...valid, workflowPath: "/absolute.ts" }), false);
    assert.equal(isCreateRickyRunRequest({ ...valid, workflowPath: "workflows\\escape.ts" }), false);
    assert.equal(isCreateRickyRunRequest({ ...valid, envSecrets: { SAFE_TOKEN: 123 } }), false);
    assert.equal(isCreateRickyRunRequest({ ...valid, envSecrets: { "not-env": "value" } }), false);
    assert.equal(isCreateRickyRunRequest({ ...valid, envSecrets: { START_FROM: "verify" } }), false);
  });
});

describe("Ricky human gate resolution", () => {
  it("only allows resolving open gates while the run is awaiting a human gate", () => {
    const gate = { rickyRunId: "ricky-1", status: "open" };

    assert.equal(canResolveRickyGate({ status: "awaiting_human_gate" }, gate, "ricky-1"), true);
    assert.equal(canResolveRickyGate({ status: "succeeded" }, gate, "ricky-1"), false);
    assert.equal(canResolveRickyGate({ status: "monitoring" }, gate, "ricky-1"), false);
    assert.equal(canResolveRickyGate({ status: "awaiting_human_gate" }, { ...gate, status: "approved" }, "ricky-1"), false);
    assert.equal(canResolveRickyGate({ status: "awaiting_human_gate" }, gate, "ricky-other"), false);
  });
});

describe("Ricky auto-fix run loop integration harness", () => {
  it("requires explicit session workspace membership for Ricky run reads", () => {
    const run = {
      userId: "user-1",
      organizationId: "org-1",
      workspaceId: "workspace-allowed",
      rootWorkflowRunId: "run-root",
      activeWorkflowRunId: "run-active",
    };
    const auth: RequestAuth = {
      source: "session",
      userId: "user-1",
      organizationId: "org-1",
      workspaceId: "workspace-other",
      context: {
        user: {
          id: "user-1",
          email: null,
          name: null,
          avatarUrl: null,
        },
        organizations: [
          {
            id: "org-1",
            slug: "org",
            name: "Org",
            role: "member",
            status: "active",
          },
        ],
        currentOrganization: {
          id: "org-1",
          slug: "org",
          name: "Org",
          role: "member",
          status: "active",
        },
        workspaces: [
          {
            id: "workspace-other",
            organization_id: "org-1",
            slug: "other",
            name: "Other",
          },
        ],
        currentWorkspace: {
          id: "workspace-other",
          organization_id: "org-1",
          slug: "other",
          name: "Other",
        },
      },
    };

    assert.equal(canAccessRickyRun(auth, run), false);
    auth.context!.workspaces.push({
      id: "workspace-allowed",
      organization_id: "org-1",
      slug: "allowed",
      name: "Allowed",
    });
    assert.equal(canAccessRickyRun(auth, run), true);
  });

  it("limits run-scoped tokens to the Ricky root or active workflow run", () => {
    const run = {
      userId: "user-1",
      organizationId: "org-1",
      workspaceId: "workspace-1",
      rootWorkflowRunId: "run-root",
      activeWorkflowRunId: "run-active",
    };
    const auth: RequestAuth = {
      source: "token",
      userId: "user-1",
      organizationId: "org-1",
      workspaceId: "workspace-1",
      runId: "run-other",
    };

    assert.equal(canAccessRickyRun(auth, run), false);
    auth.runId = "run-active";
    assert.equal(canAccessRickyRun(auth, run), true);
  });

  it("repairs a failed root run and launches a successful rerun with previousRunId and startFrom", async () => {
    const result = await runRickyAutoFixHarness({
      rickyRunId: "ricky-1",
      workflow: "name: broken\n",
      policy,
      async launchWorkflow(input) {
        return { runId: input.previousRunId ? "run-repaired" : "run-root" };
      },
      async waitForTerminal(runId) {
        return { runId, status: runId === "run-root" ? "failed" : "completed" };
      },
      async evidenceFor(run) {
        return evidence(run.runId);
      },
      async diagnose() {
        return diagnosis;
      },
      async resolveAvailability() {
        return openRouterAvailability;
      },
    });

    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.repairs, ["ricky_openrouter"]);
    assert.deepEqual(
      result.attempts.map((attempt) => ({
        workflowRunId: attempt.workflowRunId,
        status: attempt.status,
        repairMode: attempt.repairMode,
      })),
      [
        { workflowRunId: "run-root", status: "failed", repairMode: "ricky_openrouter" },
        { workflowRunId: "run-repaired", status: "completed", repairMode: "none" },
      ],
    );
    assert.equal(result.launches[1]?.previousRunId, "run-root");
    assert.equal(result.launches[1]?.startFrom, "verify");
    assert.equal(result.launches[1]?.metadata?.RICKY_REPAIR_MODE, "ricky_openrouter");
  });

  it("uses the Workforce repair path when the persona is usable", async () => {
    const result = await runRickyAutoFixHarness({
      rickyRunId: "ricky-workforce",
      workflow: "name: broken\n",
      policy,
      async launchWorkflow(input) {
        return { runId: input.previousRunId ? "run-workforce-rerun" : "run-workforce-root" };
      },
      async waitForTerminal(runId) {
        return { runId, status: runId === "run-workforce-root" ? "failed" : "completed" };
      },
      async evidenceFor(run) {
        return evidence(run.runId);
      },
      async diagnose() {
        return diagnosis;
      },
      async resolveAvailability() {
        return {
          ...openRouterAvailability,
          workforcePersona: {
            status: "usable",
            personaId: "persona-ricky-repair",
            selectedIntent: "workflow_repair",
          },
        };
      },
    });

    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.repairs, ["workforce_persona"]);
  });

  it("uses OpenRouter fallback when subscription-backed and Workforce paths are unavailable", async () => {
    const result = await runRickyAutoFixHarness({
      rickyRunId: "ricky-openrouter",
      workflow: "name: broken\n",
      policy,
      async launchWorkflow(input) {
        return { runId: input.previousRunId ? "run-openrouter-rerun" : "run-openrouter-root" };
      },
      async waitForTerminal(runId) {
        return { runId, status: runId === "run-openrouter-root" ? "failed" : "completed" };
      },
      async evidenceFor(run) {
        return evidence(run.runId);
      },
      async diagnose() {
        return diagnosis;
      },
      async resolveAvailability() {
        return openRouterAvailability;
      },
    });

    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.repairs, ["ricky_openrouter"]);
  });

  it("opens a human gate and does not launch a rerun when repair approval is required", async () => {
    const result = await runRickyAutoFixHarness({
      rickyRunId: "ricky-human-gate",
      workflow: "name: unsafe\n",
      policy,
      async launchWorkflow(input) {
        return { runId: input.previousRunId ? "run-should-not-launch" : "run-human-gate-root" };
      },
      async waitForTerminal(runId) {
        return { runId, status: "failed" };
      },
      async evidenceFor(run) {
        return evidence(run.runId);
      },
      async diagnose() {
        return {
          ...diagnosis,
          classification: "unsafe_side_effect",
          safety: "credential_change",
          summary: "repair would update a cloud credential",
        };
      },
      async resolveAvailability() {
        return openRouterAvailability;
      },
    });

    assert.equal(result.status, "awaiting_human_gate");
    assert.equal(result.activeWorkflowRunId, "run-human-gate-root");
    assert.deepEqual(result.repairs, []);
    assert.deepEqual(result.launches.map((launch) => launch.previousRunId), [undefined]);
    assert.equal(result.gates[0]?.gateType, "approval_required");
    assert.match(result.gates[0]?.prompt ?? "", /repair would update a cloud credential/);
  });

  it("runs the exported loop from failed root run to repaired rerun success", async () => {
    const launches: Array<{
      workflow: string;
      workflowPath?: string;
      previousRunId?: string;
      startFrom?: string;
      metadata?: Record<string, string>;
    }> = [];

    const result = await runRickyAutoFix(
      {
        rickyRunId: "ricky-loop-success",
        workflow: "name: broken\n",
        workflowPath: "workflows/fix.yaml",
        fileType: "yaml",
        policy,
      },
      {
        async launchWorkflow(input) {
          launches.push(input);
          return { runId: input.previousRunId ? "loop-rerun" : "loop-root" };
        },
        async waitForTerminal(runId) {
          return workflowRow(runId, runId === "loop-root" ? "failed" : "completed");
        },
        async buildEvidence({ run }) {
          return evidence(run.id ?? run.runId ?? "missing-run-id");
        },
        async diagnose() {
          return diagnosis;
        },
        async resolveAvailability() {
          return openRouterAvailability;
        },
        async repair({ mode, selectedAgent }) {
          return {
            workflow: `# repaired via ${mode}\nname: fixed\n`,
            workflowPath: "workflows/fix.yaml",
            summary: `repair via ${String(selectedAgent?.provider ?? mode)}`,
            digest: "digest-loop-success",
          };
        },
      },
    );

    assert.equal(result.status, "succeeded");
    assert.equal(result.rootRunId, "loop-root");
    assert.equal(result.activeWorkflowRunId, "loop-rerun");
    assert.deepEqual(
      result.attempts.map((attempt) => ({
        workflowRunId: attempt.workflowRunId,
        status: attempt.status,
        role: attempt.role,
        repairMode: attempt.repairMode,
      })),
      [
        {
          workflowRunId: "loop-root",
          status: "failed",
          role: "original",
          repairMode: "ricky_openrouter",
        },
        {
          workflowRunId: "loop-rerun",
          status: "completed",
          role: "repaired_rerun",
          repairMode: "none",
        },
      ],
    );
    assert.deepEqual(result.selectedRepairs.map((repair) => repair.mode), ["ricky_openrouter"]);
    assert.equal(launches[1]?.previousRunId, "loop-root");
    assert.equal(launches[1]?.startFrom, "verify");
    assert.deepEqual(launches[1]?.metadata, {
      RICKY_RUN_ID: "ricky-loop-success",
      RICKY_ATTEMPT: "2",
      RICKY_REPAIR_MODE: "ricky_openrouter",
    });
  });

  it("preserves rerun IDs when terminal rows use the workflowStore runId shape", async () => {
    const launches: Array<{
      previousRunId?: string;
      startFrom?: string;
      metadata?: Record<string, string>;
    }> = [];

    const result = await runRickyAutoFix(
      {
        rickyRunId: "ricky-loop-runid-shape",
        workflow: "name: broken\n",
        workflowPath: "workflows/fix.yaml",
        fileType: "yaml",
        policy,
      },
      {
        async launchWorkflow(input) {
          launches.push(input);
          return {
            runId: input.previousRunId ? "loop-runid-rerun" : "loop-runid-root",
          };
        },
        async waitForTerminal(runId) {
          return {
            runId,
            status: runId === "loop-runid-root" ? "failed" : "completed",
            fileType: "yaml",
            workflow: "name: broken\n",
          };
        },
        async buildEvidence({ run }) {
          return evidence(run.runId ?? "missing-run-id");
        },
        async diagnose() {
          return diagnosis;
        },
        async resolveAvailability() {
          return openRouterAvailability;
        },
        async repair({ mode }) {
          return {
            workflow: `# repaired via ${mode}\nname: fixed\n`,
            workflowPath: "workflows/fix.yaml",
            summary: "repair via runId shape",
            digest: "digest-loop-runid-shape",
          };
        },
      },
    );

    assert.equal(result.status, "succeeded");
    assert.equal(result.activeWorkflowRunId, "loop-runid-rerun");
    assert.equal(result.finalResult.workflowRunId, "loop-runid-rerun");
    assert.equal(launches[1]?.previousRunId, "loop-runid-root");
    assert.equal(launches[1]?.startFrom, "verify");
    assert.deepEqual(launches[1]?.metadata, {
      RICKY_RUN_ID: "ricky-loop-runid-shape",
      RICKY_ATTEMPT: "2",
      RICKY_REPAIR_MODE: "ricky_openrouter",
    });
  });

  it("runs the exported loop through the Workforce repair path", async () => {
    const launches: Array<{
      previousRunId?: string;
      startFrom?: string;
      metadata?: Record<string, string>;
    }> = [];

    const result = await runRickyAutoFix(
      {
        rickyRunId: "ricky-loop-workforce",
        workflow: "name: broken\n",
        workflowPath: "workflows/fix.yaml",
        fileType: "yaml",
        policy,
      },
      {
        async launchWorkflow(input) {
          launches.push(input);
          return {
            runId: input.previousRunId ? "loop-workforce-rerun" : "loop-workforce-root",
          };
        },
        async waitForTerminal(runId) {
          return workflowRow(runId, runId === "loop-workforce-root" ? "failed" : "completed");
        },
        async buildEvidence({ run }) {
          return evidence(run.id ?? run.runId ?? "missing-run-id");
        },
        async diagnose() {
          return diagnosis;
        },
        async resolveAvailability() {
          return {
            ...openRouterAvailability,
            workforcePersona: {
              status: "usable",
              personaId: "persona-ricky-repair",
              selectedIntent: "workflow_repair",
            },
          };
        },
        async repair({ mode, selectedAgent }) {
          return {
            workflow: `# repaired via ${mode}\nname: fixed\n`,
            workflowPath: "workflows/fix.yaml",
            summary: `repair via ${String(selectedAgent?.personaId ?? mode)}`,
            digest: "digest-loop-workforce",
          };
        },
      },
    );

    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.selectedRepairs.map((repair) => repair.mode), ["workforce_persona"]);
    assert.equal(result.selectedRepairs[0]?.selectedAgent?.personaId, "persona-ricky-repair");
    assert.equal(launches[1]?.previousRunId, "loop-workforce-root");
    assert.equal(launches[1]?.startFrom, "verify");
    assert.deepEqual(launches[1]?.metadata, {
      RICKY_RUN_ID: "ricky-loop-workforce",
      RICKY_ATTEMPT: "2",
      RICKY_REPAIR_MODE: "workforce_persona",
    });
  });

  it("runs the exported loop through the OpenRouter fallback path when subscription repair is unavailable", async () => {
    const launches: Array<{
      previousRunId?: string;
      startFrom?: string;
      metadata?: Record<string, string>;
    }> = [];

    const result = await runRickyAutoFix(
      {
        rickyRunId: "ricky-loop-openrouter",
        workflow: "name: broken\n",
        workflowPath: "workflows/fix.yaml",
        fileType: "yaml",
        policy,
      },
      {
        async launchWorkflow(input) {
          launches.push(input);
          return {
            runId: input.previousRunId ? "loop-openrouter-rerun" : "loop-openrouter-root",
          };
        },
        async waitForTerminal(runId) {
          return workflowRow(runId, runId === "loop-openrouter-root" ? "failed" : "completed");
        },
        async buildEvidence({ run }) {
          return evidence(run.id ?? run.runId ?? "missing-run-id");
        },
        async diagnose() {
          return diagnosis;
        },
        async resolveAvailability() {
          return openRouterAvailability;
        },
        async repair({ mode, selectedAgent }) {
          return {
            workflow: `# repaired via ${mode}\nname: fixed\n`,
            workflowPath: "workflows/fix.yaml",
            summary: `repair via ${String(selectedAgent?.provider ?? mode)}`,
            digest: "digest-loop-openrouter",
          };
        },
      },
    );

    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.selectedRepairs.map((repair) => repair.mode), ["ricky_openrouter"]);
    assert.deepEqual(result.selectedRepairs[0]?.selectedAgent, {
      status: "usable",
      provider: "openrouter",
      model: "openrouter/auto",
    });
    assert.equal(launches[1]?.previousRunId, "loop-openrouter-root");
    assert.equal(launches[1]?.startFrom, "verify");
    assert.deepEqual(launches[1]?.metadata, {
      RICKY_RUN_ID: "ricky-loop-openrouter",
      RICKY_ATTEMPT: "2",
      RICKY_REPAIR_MODE: "ricky_openrouter",
    });
  });

  it("reports exhausted from the exported loop without masking failed terminal attempts", async () => {
    const result = await runRickyAutoFix(
      {
        rickyRunId: "ricky-loop-exhausted",
        workflow: "name: still broken\n",
        fileType: "yaml",
        policy,
      },
      {
        async launchWorkflow(input) {
          return { runId: input.previousRunId ? "loop-exhausted-rerun" : "loop-exhausted-root" };
        },
        async waitForTerminal(runId) {
          return workflowRow(runId, "failed");
        },
        async buildEvidence({ run }) {
          return evidence(run.id ?? run.runId ?? "missing-run-id");
        },
        async diagnose() {
          return diagnosis;
        },
        async resolveAvailability() {
          return openRouterAvailability;
        },
        async repair({ mode }) {
          return {
            workflow: `# repaired via ${mode}\nname: still broken\n`,
            summary: "repair attempted",
            digest: "digest-loop-exhausted",
          };
        },
      },
    );

    assert.equal(result.status, "exhausted");
    assert.equal(result.activeWorkflowRunId, "loop-exhausted-rerun");
    assert.deepEqual(
      result.attempts.map((attempt) => ({
        workflowRunId: attempt.workflowRunId,
        status: attempt.status,
        role: attempt.role,
        repairMode: attempt.repairMode,
      })),
      [
        {
          workflowRunId: "loop-exhausted-root",
          status: "failed",
          role: "original",
          repairMode: "ricky_openrouter",
        },
        {
          workflowRunId: "loop-exhausted-rerun",
          status: "failed",
          role: "repaired_rerun",
          repairMode: "none",
        },
      ],
    );
    assert.deepEqual(result.finalResult, {
      status: "exhausted",
      maxAttempts: 2,
    });
  });

  it("reports exhausted without rewriting canceled terminal attempts", async () => {
    const result = await runRickyAutoFix(
      {
        rickyRunId: "ricky-loop-canceled-exhausted",
        workflow: "name: canceled\n",
        fileType: "yaml",
        policy: { ...policy, maxAttempts: 1 },
      },
      {
        async launchWorkflow() {
          return { runId: "loop-canceled-root" };
        },
        async waitForTerminal(runId) {
          return workflowRow(runId, "canceled");
        },
        async buildEvidence({ run }) {
          return evidence(run.id ?? run.runId ?? "missing-run-id");
        },
        async diagnose() {
          return diagnosis;
        },
        async resolveAvailability() {
          return openRouterAvailability;
        },
        async repair() {
          throw new Error("repair should not run after max-attempt exhaustion");
        },
      },
    );

    assert.equal(result.status, "exhausted");
    assert.equal(result.activeWorkflowRunId, "loop-canceled-root");
    assert.deepEqual(result.attempts, [
      {
        attempt: 1,
        workflowRunId: "loop-canceled-root",
        status: "canceled",
        role: "original",
        repairMode: "none",
      },
    ]);
    assert.deepEqual(result.finalResult, {
      status: "exhausted",
      maxAttempts: 1,
    });
  });

  it("stops with exhausted after max attempts and reports the truthful terminal status", async () => {
    const result = await runRickyAutoFixHarness({
      rickyRunId: "ricky-exhausted",
      workflow: "name: still broken\n",
      policy,
      async launchWorkflow(input) {
        return { runId: input.previousRunId ? "run-exhausted-rerun" : "run-exhausted-root" };
      },
      async waitForTerminal(runId) {
        return { runId, status: "failed" };
      },
      async evidenceFor(run) {
        return evidence(run.runId);
      },
      async diagnose() {
        return diagnosis;
      },
      async resolveAvailability() {
        return openRouterAvailability;
      },
    });

    assert.equal(result.status, "exhausted");
    assert.equal(result.activeWorkflowRunId, "run-exhausted-rerun");
    assert.deepEqual(
      result.attempts.map((attempt) => ({
        workflowRunId: attempt.workflowRunId,
        status: attempt.status,
        repairMode: attempt.repairMode,
      })),
      [
        { workflowRunId: "run-exhausted-root", status: "failed", repairMode: "ricky_openrouter" },
        { workflowRunId: "run-exhausted-rerun", status: "failed", repairMode: "none" },
      ],
    );
    assert.equal(result.gates[0]?.gateType, "max_attempts_reached");
  });
});

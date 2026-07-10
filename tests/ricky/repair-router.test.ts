import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as routerModule from "../../packages/web/lib/ricky/repair-router.ts";
import type { AgentAvailability, RickyAutoFixPolicy, RickyDiagnosis } from "../../packages/web/lib/ricky/types.ts";

const { routeRepair, buildRepairResult } = routerModule as {
  routeRepair: typeof import("../../packages/web/lib/ricky/repair-router.ts").routeRepair;
  buildRepairResult: typeof import("../../packages/web/lib/ricky/repair-router.ts").buildRepairResult;
};

const policy: RickyAutoFixPolicy = {
  enabled: true,
  maxAttempts: 3,
  preferWorkforcePersona: true,
  allowOpenRouterFallback: true,
  requireHumanApprovalFor: [],
};

const diagnosis: RickyDiagnosis = {
  classification: "workflow_artifact",
  summary: "Broken step dependency",
  repairable: true,
  failedStep: "verify",
  evidenceRefs: ["steps"],
};

function availability(overrides: Partial<AgentAvailability> = {}): AgentAvailability {
  return {
    checkedAt: "2026-05-03T00:00:00.000Z",
    workspaceId: "workspace",
    userId: "user",
    requestedClis: ["codex"],
    subscriptionAgents: [],
    workforcePersona: { status: "missing" },
    openRouterFallback: {
      status: "missing",
      provider: "openrouter",
      model: "openrouter/auto",
    },
    ...overrides,
  };
}

describe("Ricky repair router", () => {
  it("prefers Workforce persona when usable", () => {
    const decision = routeRepair({
      diagnosis,
      availability: availability({
        workforcePersona: {
          status: "usable",
          personaId: "ricky-workflow-repair",
          selectedIntent: "workflow_repair",
        },
        openRouterFallback: {
          status: "usable",
          provider: "openrouter",
          model: "openrouter/auto",
        },
      }),
      policy,
      attempt: 1,
      maxAttempts: 3,
    });

    assert.equal(decision.mode, "workforce_persona");
  });

  it("falls back to OpenRouter when no subscription agent is usable", () => {
    const decision = routeRepair({
      diagnosis,
      availability: availability({
        subscriptionAgents: [
          {
            cli: "codex",
            provider: "openai",
            source: "cli_credentials",
            status: "missing",
          },
          {
            cli: "claude",
            provider: "anthropic",
            source: "cloud_agents",
            status: "expired",
          },
          {
            cli: "opencode",
            provider: "opencode",
            source: "cloud_agents",
            status: "unhealthy",
            reason: "worker heartbeat stale",
          },
        ],
        openRouterFallback: {
          status: "usable",
          provider: "openrouter",
          model: "openrouter/auto",
        },
      }),
      policy,
      attempt: 1,
      maxAttempts: 3,
    });

    assert.equal(decision.mode, "ricky_openrouter");
  });

  it("uses a subscription-backed agent before OpenRouter when Workforce is unavailable", () => {
    const decision = routeRepair({
      diagnosis,
      availability: availability({
        subscriptionAgents: [
          {
            cli: "codex",
            provider: "openai",
            source: "cli_credentials",
            status: "usable",
          },
        ],
        openRouterFallback: {
          status: "usable",
          provider: "openrouter",
          model: "openrouter/auto",
        },
      }),
      policy,
      attempt: 1,
      maxAttempts: 3,
    });

    assert.equal(decision.mode, "subscription_agent");
    assert.equal(decision.selectedAgent?.provider, "openai");
  });

  it("does not use OpenRouter when the auto-fix policy disables fallback", () => {
    const decision = routeRepair({
      diagnosis,
      availability: availability({
        openRouterFallback: {
          status: "usable",
          provider: "openrouter",
          model: "openrouter/auto",
        },
      }),
      policy: { ...policy, allowOpenRouterFallback: false },
      attempt: 1,
      maxAttempts: 3,
    });

    assert.equal(decision.mode, "deterministic");
  });

  it("allows source-sync artifacts only when an isolated workflow target can be derived", () => {
    const safeDecision = routeRepair({
      diagnosis,
      availability: availability({
        openRouterFallback: {
          status: "usable",
          provider: "openrouter",
          model: "openrouter/auto",
        },
      }),
      policy,
      attempt: 1,
      maxAttempts: 3,
      sourceWorkflowPath: "workflows/fix.ts",
      s3CodeKey: "code.tar.gz",
    });
    const unsafeDecision = routeRepair({
      diagnosis,
      availability: availability(),
      policy,
      attempt: 1,
      maxAttempts: 3,
      s3CodeKey: "user/run/code.tar.gz",
    });

    assert.equal(safeDecision.mode, "ricky_openrouter");
    assert.equal(unsafeDecision.mode, "human_gate");
    assert.equal(unsafeDecision.gate?.gateType, "unsafe_patch");
  });

  it("opens human gates for ambiguous, credential, secret, cost, and max-attempt cases", () => {
    const cases: Array<{
      diagnosis: RickyDiagnosis;
      policy?: RickyAutoFixPolicy;
      attempt?: number;
      gateType: string;
    }> = [
      {
        diagnosis: {
          ...diagnosis,
          classification: "ambiguous",
          summary: "Multiple repairs fit the evidence",
        },
        gateType: "ambiguous_repair",
      },
      {
        diagnosis: {
          ...diagnosis,
          classification: "unsafe_side_effect",
          summary: "Repair may rotate a production secret",
        },
        gateType: "approval_required",
      },
      {
        diagnosis: {
          ...diagnosis,
          classification: "missing_credentials",
          summary: "No usable credential",
          repairable: false,
        },
        gateType: "missing_credentials",
      },
      {
        diagnosis: {
          ...diagnosis,
          classification: "missing_secret",
          summary: "DEPLOY_TOKEN is missing",
          repairable: false,
        },
        gateType: "missing_secret",
      },
      {
        diagnosis,
        policy: { ...policy, requireHumanApprovalFor: ["cost_over_budget"] },
        gateType: "cost_over_budget",
      },
      {
        diagnosis: {
          ...diagnosis,
          safety: "cost_over_budget",
          summary: "Estimated fallback repair cost exceeds policy",
          proposedAction: {
            summary: "Rerun through metered fallback capacity",
          },
        },
        gateType: "cost_over_budget",
      },
      {
        diagnosis: {
          ...diagnosis,
          safety: "unsafe_patch",
          proposedAction: {
            file: "workflow.yaml",
            apiKey: "sk-should-not-appear",
          },
        },
        gateType: "unsafe_patch",
      },
      {
        diagnosis: {
          ...diagnosis,
          safety: "credential_change",
          summary: "Repair would rotate a credential",
        },
        gateType: "approval_required",
      },
      {
        diagnosis,
        attempt: 3,
        gateType: "max_attempts_reached",
      },
    ];

    for (const item of cases) {
      const decision = routeRepair({
        diagnosis: item.diagnosis,
        availability: availability({
          openRouterFallback: {
            status: "usable",
            provider: "openrouter",
            model: "openrouter/auto",
          },
        }),
        policy: item.policy ?? policy,
        attempt: item.attempt ?? 1,
        maxAttempts: 3,
      });

      assert.equal(decision.mode, "human_gate");
      assert.equal(decision.gate?.gateType, item.gateType);
      assert.match(decision.gate?.prompt ?? "", /What failed:/);
      assert.match(decision.gate?.prompt ?? "", /What Ricky tried:/);
      assert.match(decision.gate?.prompt ?? "", /What Ricky wants to do next:/);
      assert.match(decision.gate?.prompt ?? "", /Exact file or action affected:/);
      assert.match(decision.gate?.prompt ?? "", /approve, deny, or edit/i);
      assert.doesNotMatch(decision.gate?.prompt ?? "", /sk-should-not-appear/);
    }
  });

  it("honors approved human gates exactly as routing input instead of reopening the same gate", () => {
    const unsafe = routeRepair({
      diagnosis: {
        ...diagnosis,
        safety: "unsafe_patch",
        proposedAction: {
          file: "workflow.yaml",
          apiKey: "sk-should-not-appear",
        },
      },
      availability: availability({
        openRouterFallback: {
          status: "usable",
          provider: "openrouter",
          model: "openrouter/auto",
        },
      }),
      policy,
      attempt: 1,
      maxAttempts: 3,
      approvedGateTypes: ["unsafe_patch"],
    });
    const missingSecret = routeRepair({
      diagnosis: {
        ...diagnosis,
        classification: "missing_secret",
        repairable: false,
        summary: "DEPLOY_TOKEN is missing",
      },
      availability: availability(),
      policy: { ...policy, allowOpenRouterFallback: false },
      attempt: 1,
      maxAttempts: 3,
      approvedGateTypes: ["missing_secret"],
      humanInstruction: "retry after adding DEPLOY_TOKEN=secret-value",
    });

    assert.equal(unsafe.mode, "ricky_openrouter");
    assert.equal(missingSecret.mode, "deterministic");
    assert.match(missingSecret.reason, /edit instruction/i);
  });

  it("redacts human edit instructions in repair summaries and workflow stamps", async () => {
    const result = await buildRepairResult({
      mode: "deterministic",
      decision: {
        mode: "deterministic",
        reason: "approved",
      },
      diagnosis,
      humanInstruction: "retry with OPENAI_API_KEY=sk-should-not-appear",
      evidence: {
        schemaVersion: 1,
        capturedAt: "2026-05-03T00:00:00.000Z",
        rickyRunId: "ricky",
        attempt: 1,
        workflowRun: {
          runId: "workflow-run",
          status: "failed",
          fileType: "ts",
          workflow: "export default {};\n",
          sandboxId: null,
        },
        retry: { attempt: 1 },
        steps: [],
        events: [],
        logs: { stepLogs: [] },
        runtime: { sandboxId: null },
      },
    });

    assert.doesNotMatch(result.summary, /sk-should-not-appear/);
    assert.doesNotMatch(result.repairedWorkflow, /sk-should-not-appear/);
    assert.match(result.summary, /OPENAI_API_KEY=\[REDACTED\]/);
  });

  it("redacts credential-shaped diagnosis summaries in repair outputs", async () => {
    const result = await buildRepairResult({
      mode: "ricky_openrouter",
      decision: {
        mode: "ricky_openrouter",
        reason: "fallback",
        selectedAgent: { provider: "openrouter" },
      },
      diagnosis: {
        ...diagnosis,
        summary:
          'provider failed with OPENROUTER_API_KEY=sk-should-not-appear and "credential_json":{"private_key":"raw-key","client_email":"bot@example.com"}',
      },
      evidence: {
        schemaVersion: 1,
        capturedAt: "2026-05-03T00:00:00.000Z",
        rickyRunId: "ricky",
        attempt: 1,
        workflowRun: {
          runId: "workflow-run",
          status: "failed",
          fileType: "yaml",
          workflow: "{}",
          sandboxId: null,
        },
        retry: { attempt: 1 },
        steps: [],
        events: [],
        logs: { stepLogs: [] },
        runtime: { sandboxId: null },
      },
    });

    assert.doesNotMatch(result.summary, /sk-should-not-appear|raw-key|bot@example.com/);
    assert.doesNotMatch(result.repairedWorkflow, /sk-should-not-appear|raw-key|bot@example.com/);
    assert.match(result.summary, /OPENROUTER_API_KEY=\[REDACTED\]/);

    const repairedWorkflow = JSON.parse(result.repairedWorkflow) as {
      metadata?: { rickyRepair?: { summary?: string } };
    };
    assert.equal(repairedWorkflow.metadata?.rickyRepair?.summary?.includes("sk-should-not-appear"), false);
    assert.equal(repairedWorkflow.metadata?.rickyRepair?.summary?.includes("raw-key"), false);
    assert.match(repairedWorkflow.metadata?.rickyRepair?.summary ?? "", /"credential_json":\[REDACTED\]/);
  });

  it("uses firstFailedStepId for rerun startFrom when failedStep is absent", async () => {
    const result = await buildRepairResult({
      mode: "ricky_openrouter",
      decision: {
        mode: "ricky_openrouter",
        reason: "fallback",
        selectedAgent: { provider: "openrouter" },
      },
      diagnosis: {
        ...diagnosis,
        failedStep: undefined,
        firstFailedStepId: "contract",
      },
      evidence: {
        schemaVersion: 1,
        capturedAt: "2026-05-03T00:00:00.000Z",
        rickyRunId: "ricky",
        attempt: 1,
        workflowRun: {
          runId: "workflow-run",
          status: "failed",
          fileType: "yaml",
          workflow: "name: broken\n",
          sandboxId: null,
        },
        retry: { attempt: 1 },
        steps: [],
        events: [],
        logs: { stepLogs: [] },
        runtime: { sandboxId: null },
      },
    });

    assert.equal(result.resumePlan.previousRunId, "workflow-run");
    assert.equal(result.resumePlan.startFrom, "contract");
  });
});

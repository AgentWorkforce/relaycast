import { buildRepairResult, routeRepair } from "./repair-router";
import type {
  AgentAvailability,
  RickyAutoFixPolicy,
  RickyDiagnosis,
  RickyRepairMode,
  WorkflowRunEvidence,
} from "./types";

export type HarnessWorkflowRun = {
  runId: string;
  status: "pending" | "running" | "completed" | "failed" | "canceled";
  error?: string;
};

export type HarnessLaunchInput = {
  workflow: string;
  previousRunId?: string;
  startFrom?: string;
  metadata?: Record<string, string>;
};

export async function runRickyAutoFixHarness(input: {
  rickyRunId: string;
  workflow: string;
  policy: RickyAutoFixPolicy;
  launchWorkflow(input: HarnessLaunchInput): Promise<{ runId: string }>;
  waitForTerminal(runId: string): Promise<HarnessWorkflowRun>;
  evidenceFor(run: HarnessWorkflowRun, attempt: number): Promise<WorkflowRunEvidence>;
  diagnose(evidence: WorkflowRunEvidence): Promise<RickyDiagnosis>;
  resolveAvailability(run: HarnessWorkflowRun, attempt: number): Promise<AgentAvailability>;
}) {
  const attempts: Array<{
    attempt: number;
    workflowRunId: string;
    status: string;
    repairMode: RickyRepairMode;
    previousWorkflowRunId?: string;
    startFromStep?: string;
  }> = [];
  const repairs: RickyRepairMode[] = [];
  const gates: Array<{ gateType: string; prompt: string }> = [];
  const launches: HarnessLaunchInput[] = [];

  async function launch(body: HarnessLaunchInput) {
    launches.push(body);
    return input.launchWorkflow(body);
  }

  let active = await launch({
    workflow: input.workflow,
    metadata: {
      RICKY_RUN_ID: input.rickyRunId,
      RICKY_ATTEMPT: "1",
      RICKY_REPAIR_MODE: "none",
    },
  });

  for (let attemptNumber = 1; attemptNumber <= input.policy.maxAttempts; attemptNumber += 1) {
    const terminal = await input.waitForTerminal(active.runId);
    attempts.push({
      attempt: attemptNumber,
      workflowRunId: terminal.runId,
      status: terminal.status,
      repairMode: "none",
    });

    if (terminal.status === "completed") {
      return {
        status: "succeeded" as const,
        attempts,
        repairs,
        gates,
        launches,
        activeWorkflowRunId: terminal.runId,
      };
    }

    const evidence = await input.evidenceFor(terminal, attemptNumber);
    const diagnosis = await input.diagnose(evidence);
    const availability = await input.resolveAvailability(terminal, attemptNumber);
    const decision = routeRepair({
      diagnosis,
      availability,
      policy: input.policy,
      attempt: attemptNumber,
      maxAttempts: input.policy.maxAttempts,
    });

    if (decision.mode === "human_gate") {
      gates.push({
        gateType: decision.gate?.gateType ?? "approval_required",
        prompt: decision.gate?.prompt ?? "",
      });

      if (decision.gate?.gateType === "max_attempts_reached") {
        return {
          status: "exhausted" as const,
          attempts,
          repairs,
          gates,
          launches,
          activeWorkflowRunId: terminal.runId,
        };
      }

      return {
        status: "awaiting_human_gate" as const,
        attempts,
        repairs,
        gates,
        launches,
        activeWorkflowRunId: terminal.runId,
      };
    }

    const repair = await buildRepairResult({
      mode: decision.mode as Exclude<RickyRepairMode, "human_gate" | "none">,
      decision,
      evidence,
      diagnosis,
    });
    repairs.push(repair.mode);
    attempts[attempts.length - 1]!.repairMode = repair.mode;
    attempts[attempts.length - 1]!.previousWorkflowRunId = repair.resumePlan.previousRunId;
    attempts[attempts.length - 1]!.startFromStep = repair.resumePlan.startFrom;
    active = await launch({
      workflow: repair.repairedWorkflow,
      previousRunId: repair.resumePlan.previousRunId,
      startFrom: repair.resumePlan.startFrom,
      metadata: {
        RICKY_RUN_ID: input.rickyRunId,
        RICKY_ATTEMPT: String(attemptNumber + 1),
        RICKY_REPAIR_MODE: repair.mode,
      },
    });
  }

  return {
    status: "failed" as const,
    attempts,
    repairs,
    gates,
    launches,
    activeWorkflowRunId: active.runId,
  };
}

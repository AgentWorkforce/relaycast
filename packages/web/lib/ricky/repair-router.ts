import { createHash } from "node:crypto";
import { redactForRicky, redactText } from "./redaction";
import type {
  AgentAvailability,
  HumanGateType,
  RepairDecision,
  RepairResult,
  RickyAutoFixPolicy,
  RickyDiagnosis,
  RickyRepairMode,
  WorkflowRunEvidence,
} from "./types";

function workflowHasSafeRepairTarget(input: {
  sourceWorkflowPath?: string;
  s3CodeKey?: string;
}): boolean {
  if (!input.s3CodeKey && !input.sourceWorkflowPath) {
    return true;
  }
  return Boolean(input.s3CodeKey && input.sourceWorkflowPath);
}

export function routeRepair(input: {
  diagnosis: RickyDiagnosis;
  availability: AgentAvailability;
  policy: RickyAutoFixPolicy;
  attempt: number;
  maxAttempts: number;
  sourceWorkflowPath?: string;
  s3CodeKey?: string;
  approvedGateTypes?: HumanGateType[];
  humanInstruction?: string;
}): RepairDecision {
  const approvedGateTypes = new Set(input.approvedGateTypes ?? []);
  const hasApprovedGate = approvedGateTypes.size > 0;
  const gateApproved = (gateType: HumanGateType) => approvedGateTypes.has(gateType);

  if (input.attempt >= input.maxAttempts) {
    return gateDecision(
      "max_attempts_reached",
      "Ricky reached the configured maximum number of attempts.",
      "The workflow is still failing after the configured attempts. Review the evidence and choose whether to continue manually.",
    );
  }

  if (input.diagnosis.classification === "missing_credentials" && !gateApproved("missing_credentials")) {
    return gateDecision(
      "missing_credentials",
      input.diagnosis.summary,
      "Connect Claude, Codex, OpenCode, or enable the OpenRouter fallback before Ricky can continue.",
    );
  }

  if ((
    input.diagnosis.classification === "missing_secret" ||
    input.diagnosis.classification === "missing_required_secret" ||
    input.diagnosis.safety === "missing_secret"
  ) && !gateApproved("missing_secret")
  ) {
    return gateDecision(
      "missing_secret",
      input.diagnosis.summary,
      input.diagnosis.proposedAction?.summary ??
        "Add the missing cloud secret or edit the workflow instructions, then approve Ricky to retry.",
    );
  }

  if (input.diagnosis.safety === "unsafe_patch" && !gateApproved("unsafe_patch")) {
    return gateDecision(
      "unsafe_patch",
      input.diagnosis.summary,
      "Ricky found a repair that could change files outside the isolated workflow artifact. Approve, deny, or edit the next action.",
      input.diagnosis.proposedAction,
    );
  }

  if ((
    input.diagnosis.classification === "unsafe_side_effect" ||
    input.diagnosis.safety === "external_side_effect" ||
    input.diagnosis.safety === "credential_change"
  ) && !gateApproved("approval_required")
  ) {
    return gateDecision(
      "approval_required",
      input.diagnosis.summary,
      "Ricky found a repair path that may perform an external side effect. Approve, deny, or edit the next action.",
    );
  }

  if (!workflowHasSafeRepairTarget(input) && !gateApproved("unsafe_patch")) {
    return gateDecision(
      "unsafe_patch",
      "The failed workflow does not have a safe workflow artifact target.",
      "Ricky needs both the workflow path and source archive key to create an isolated repaired copy before rerunning.",
      {
        workflowPath: input.sourceWorkflowPath,
        s3CodeKey: input.s3CodeKey,
      },
    );
  }

  if ((
    input.diagnosis.classification === "ambiguous" ||
    input.diagnosis.safety === "ambiguous_repair"
  ) && !gateApproved("ambiguous_repair")
  ) {
    return gateDecision(
      "ambiguous_repair",
      input.diagnosis.summary,
      "Multiple repair paths are plausible. Provide an edit instruction or approve Ricky's safest workflow-only repair.",
      input.diagnosis.proposedAction,
    );
  }

  if ((
    input.diagnosis.safety === "cost_over_budget" ||
    input.policy.requireHumanApprovalFor.includes("cost_over_budget")
  ) && !gateApproved("cost_over_budget")
  ) {
    return gateDecision(
      "cost_over_budget",
      input.diagnosis.safety === "cost_over_budget"
        ? input.diagnosis.summary
        : "The next Ricky repair or rerun would exceed the configured auto-fix budget.",
      "Review the estimated cost, then approve, deny, or edit the repair plan.",
      input.diagnosis.proposedAction,
    );
  }

  if (!input.diagnosis.repairable && !hasApprovedGate) {
    return gateDecision(
      "approval_required",
      input.diagnosis.summary,
      "Ricky did not find a safe automatic workflow-artifact repair. Approve a manual retry plan, deny, or provide edit instructions.",
      input.diagnosis.proposedAction,
    );
  }

  if (input.availability.workforcePersona?.status === "usable" && input.policy.preferWorkforcePersona) {
    return {
      mode: "workforce_persona",
      reason: "Workforce persona is available and preferred for semantic workflow artifact repairs.",
      selectedAgent: input.availability.workforcePersona,
    };
  }

  const subscriptionAgent = input.availability.subscriptionAgents.find((agent) => agent.status === "usable");
  if (subscriptionAgent) {
    return {
      mode: "subscription_agent",
      reason: `Using subscription-backed ${subscriptionAgent.cli} repair capacity.`,
      selectedAgent: subscriptionAgent,
    };
  }

  if (input.policy.allowOpenRouterFallback && input.availability.openRouterFallback.status === "usable") {
    return {
      mode: "ricky_openrouter",
      reason: "No subscription-backed repair agent is usable; OpenRouter fallback is enabled.",
      selectedAgent: input.availability.openRouterFallback,
    };
  }

  if (input.diagnosis.classification === "workflow_artifact") {
    return {
      mode: "deterministic",
      reason: "No agent capacity is available, but the failure is bounded to the workflow artifact.",
    };
  }

  if (hasApprovedGate) {
    return {
      mode: "deterministic",
      reason: input.humanInstruction
        ? "Human gate was resolved with an edit instruction; preparing an isolated workflow-only rerun."
        : "Human gate was approved; preparing an isolated workflow-only rerun.",
    };
  }

  return gateDecision(
    "missing_agent_capacity",
    "No usable Workforce, subscription-backed, OpenRouter, or deterministic repair path is available.",
    "Connect an agent subscription, enable OpenRouter fallback, or edit the workflow manually.",
  );
}

function gateDecision(
  gateType: HumanGateType,
  reason: string,
  prompt: string,
  proposedAction?: unknown,
): RepairDecision {
  const safeReason = redactText(reason);
  const safePrompt = redactText(prompt);
  const safeProposedAction = redactForRicky(proposedAction);
  const actionTarget =
    safeProposedAction && typeof safeProposedAction === "object"
      ? redactText(JSON.stringify(safeProposedAction))
      : "workflow artifact or cloud run action";
  return {
    mode: "human_gate",
    reason: safeReason,
    gate: {
      gateType,
      prompt: [
        `What failed: ${safeReason}`,
        "What Ricky tried: collected cloud run evidence and selected the next repair route.",
        `What Ricky wants to do next: ${safePrompt}`,
        `Exact file or action affected: ${actionTarget}`,
        "Options: approve, deny, or edit.",
      ].join(" "),
      proposedAction: safeProposedAction,
    },
  };
}

export async function buildRepairResult(input: {
  mode: Exclude<RickyRepairMode, "human_gate" | "none">;
  decision: RepairDecision;
  evidence: WorkflowRunEvidence;
  diagnosis: RickyDiagnosis;
  humanInstruction?: string;
}): Promise<RepairResult> {
  const repairedWorkflow = applyWorkflowOnlyRepairHint({
    workflow: input.evidence.workflowRun.workflow,
    fileType: input.evidence.workflowRun.fileType,
    mode: input.mode,
    diagnosis: input.diagnosis,
    humanInstruction: input.humanInstruction,
  });
  const digest = createHash("sha256").update(repairedWorkflow).digest("hex");

  return {
    mode: input.mode,
    summary: buildRepairSummary(input.mode, input.diagnosis, input.humanInstruction),
    repairedWorkflow,
    digest,
    selectedAgent: input.decision.selectedAgent,
    safety: {
      isolated: true,
      externalSideEffects: false,
    },
    resumePlan: {
      previousRunId: input.evidence.workflowRun.runId,
      startFrom: input.diagnosis.failedStep ?? input.diagnosis.firstFailedStepId,
    },
  };
}

function buildRepairSummary(
  mode: RickyRepairMode,
  diagnosis: RickyDiagnosis,
  humanInstruction?: string,
): string {
  const safeSummary = redactText(diagnosis.summary);
  const humanContext = humanInstruction ? ` Human edit instruction: ${redactText(humanInstruction)}` : "";
  switch (mode) {
    case "workforce_persona":
      return `Prepared an isolated workflow artifact repair through the configured Workforce persona. Diagnosis: ${safeSummary}.${humanContext}`;
    case "subscription_agent":
      return `Prepared an isolated workflow artifact repair through subscription-backed agent capacity. Diagnosis: ${safeSummary}.${humanContext}`;
    case "ricky_openrouter":
      return `Prepared an isolated Ricky workflow artifact repair through the OpenRouter fallback using redacted evidence only. Diagnosis: ${safeSummary}.${humanContext}`;
    case "deterministic":
      return `Prepared a deterministic isolated workflow artifact repair. Diagnosis: ${safeSummary}.${humanContext}`;
    default:
      return `${safeSummary}.${humanContext}`;
  }
}

function applyWorkflowOnlyRepairHint(input: {
  workflow: string;
  fileType: string;
  mode: RickyRepairMode;
  diagnosis: RickyDiagnosis;
  humanInstruction?: string;
}): string {
  const safeSummary = redactText(input.diagnosis.summary);
  const instruction = input.humanInstruction ? ` Human edit: ${redactText(input.humanInstruction)}` : "";
  const stamp = `Ricky repair (${input.mode}): ${safeSummary}.${instruction}`;
  if (input.fileType === "yaml") {
    if (input.workflow.trimStart().startsWith("{")) {
      try {
        const parsed = JSON.parse(input.workflow) as Record<string, unknown>;
        const metadata = {
          ...(typeof parsed.metadata === "object" && parsed.metadata ? parsed.metadata : {}),
          rickyRepair: {
            mode: input.mode,
            summary: safeSummary,
          },
        };
        return JSON.stringify({ ...parsed, metadata }, null, 2);
      } catch {
        return `# ${stamp}\n${input.workflow}`;
      }
    }
    return `# ${stamp}\n${input.workflow}`;
  }

  const comment = input.fileType === "py" ? `# ${stamp}` : `// ${stamp}`;
  if (input.workflow.includes("Ricky repair (")) {
    return input.workflow;
  }
  return `${comment}\n${input.workflow}`;
}

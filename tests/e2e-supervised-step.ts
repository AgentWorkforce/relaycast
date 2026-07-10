/**
 * Runnable supervised-step workflow validation.
 *
 * Expected workflow YAML shape:
 *
 * ```yaml
 * version: "1.0"
 * name: supervised-step-e2e
 * swarm:
 *   pattern: supervisor
 *   maxConcurrency: 2
 * agents:
 *   - name: lead
 *     cli: claude
 *     role: lead
 *   - name: worker
 *     cli: claude
 *     role: specialist
 *     interactive: true
 * workflows:
 *   - name: supervised-flow
 *     steps:
 *       - name: implement-feature
 *         agent: worker
 *         task: "Write a hello world function"
 *         interactive: true
 * ```
 *
 * Note: the SDK uses agent interactivity, not step interactivity, to decide
 * whether dedicated owner supervision is enabled. This script keeps the
 * requested `interactive: true` step marker in the config example and also
 * validates the worker agent is interactive so owner assignment matches the
 * actual runtime behavior.
 */

import assert from "node:assert/strict";
import {
  WorkflowRunner,
  type AgentDefinition,
  type RelayYamlConfig,
} from "@relayflows/core";

type StepWithInteractiveFlag = {
  name: string;
  agent: string;
  task: string;
  interactive: boolean;
};

const workflowConfig = {
  version: "1.0",
  name: "supervised-step-e2e",
  description: "Validates dedicated ownership for an interactive worker step.",
  swarm: {
    pattern: "supervisor",
    maxConcurrency: 2,
    timeoutMs: 120_000,
  },
  agents: [
    {
      name: "lead",
      cli: "claude",
      role: "lead",
    },
    {
      name: "worker",
      cli: "claude",
      role: "specialist",
      interactive: true,
    },
  ],
  workflows: [
    {
      name: "supervised-flow",
      steps: [
        {
          name: "implement-feature",
          agent: "worker",
          task: "Write a hello world function",
          interactive: true,
        },
      ],
    },
  ],
} as unknown as RelayYamlConfig;

function main(): void {
  const runner: WorkflowRunner = new WorkflowRunner();
  runner.validateConfig(workflowConfig, "tests/e2e-supervised-step.ts");

  const config = workflowConfig;
  const step = workflowConfig.workflows![0].steps[0] as StepWithInteractiveFlag;
  const lead = workflowConfig.agents.find((agent) => agent.name === "lead");
  const worker = workflowConfig.agents.find((agent) => agent.name === "worker");

  assert.ok(lead, 'expected agent "lead" to be defined');
  assert.ok(worker, 'expected agent "worker" to be defined');
  assert.equal(lead.role, "lead");
  assert.equal(worker.role, "specialist");
  assert.equal(step.name, "implement-feature");
  assert.equal(step.agent, "worker");
  assert.equal(step.task, "Write a hello world function");
  assert.equal(step.interactive, true);
  assert.equal(worker.interactive, true);

  const agentMap = new Map(config.agents.map((agent) => [agent.name, agent]));
  const resolveAgentDef = (WorkflowRunner as unknown as {
    resolveAgentDef: (def: AgentDefinition) => AgentDefinition;
  }).resolveAgentDef;

  const specialistDef = resolveAgentDef(agentMap.get("worker")!);
  const ownerDef = (runner as unknown as {
    resolveAutoStepOwner: (
      specialist: AgentDefinition,
      allAgents: Map<string, AgentDefinition>,
    ) => AgentDefinition;
  }).resolveAutoStepOwner(specialistDef, agentMap);

  assert.equal(specialistDef.interactive, true);
  assert.equal(ownerDef.name, "lead");
  assert.notEqual(ownerDef.name, specialistDef.name);

  console.log("Supervised-step config validated.");
  console.log(`Step: ${step.name}`);
  console.log(`Specialist: ${specialistDef.name}`);
  console.log(`Dedicated owner: ${ownerDef.name}`);
}

try {
  main();
} catch (error) {
  console.error("Supervised-step config validation failed.");
  console.error(error);
  process.exitCode = 1;
}

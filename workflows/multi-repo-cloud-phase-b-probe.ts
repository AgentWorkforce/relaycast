import { InMemoryWorkflowDb, WorkflowRunner } from "@relayflows/core";
import type { RelayYamlConfig } from "@relayflows/core";

export const config: RelayYamlConfig = {
  version: "1.0",
  name: "multi-repo-cloud-phase-b-probe",
  description: "Phase B probe: two paths mount under /workspace/{name}/.",
  paths: [
    { name: "cloud", path: "." },
    { name: "relay", path: "../relay" },
  ],
  swarm: {
    pattern: "pipeline",
    maxConcurrency: 1,
  },
  agents: [],
  workflows: [
    {
      name: "multi-repo-cloud-phase-b-probe-workflow",
      steps: [
        {
          name: "assert-mounts",
          type: "deterministic",
          command: [
            "set -e",
            "test -d /workspace/cloud/packages/web",
            "test -d /workspace/relay/packages/cloud/src",
            "cat /workspace/.relay/paths.json",
          ].join(" && "),
          captureOutput: true,
          failOnError: true,
        },
        {
          name: "touch-each-repo",
          type: "deterministic",
          dependsOn: ["assert-mounts"],
          command: [
            "set -e",
            "echo \"phase-b-probe\" >> /workspace/cloud/PHASE_B_PROBE.txt",
            "echo \"phase-b-probe\" >> /workspace/relay/PHASE_B_PROBE.txt",
          ].join(" && "),
          failOnError: true,
        },
      ],
    },
  ],
  errorHandling: {
    strategy: "fail-fast",
  },
};

if (!process.env.RUN_ID && process.argv[1]?.endsWith("multi-repo-cloud-phase-b-probe.ts")) {
  const db = new InMemoryWorkflowDb();
  const runner = new WorkflowRunner({ db, cwd: process.cwd() });
  const result = await runner.execute(config);
  console.log(`Workflow ${result.status} (${result.id})`);
  if (result.status === "failed") {
    console.error(result.error);
    process.exitCode = 1;
  }
}

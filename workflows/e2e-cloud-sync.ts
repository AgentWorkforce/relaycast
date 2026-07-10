import { workflow } from "@relayflows/core";

const result = await workflow("e2e-cloud-sync")
  .description("Probe that cloud sync captures files written during a relayfile-enabled cloud run.")
  .pattern("pipeline")
  .channel("e2e-cloud-sync")
  .maxConcurrency(1)
  .timeout(120_000)
  .step("write-sync-probe", {
    type: "deterministic",
    command: [
      "set -e",
      "PROBE_FILE=\"sync-probe-$(date +%s).txt\"",
      "date +%s > \"$PROBE_FILE\"",
      "echo \"SYNC_PROBE_FILE=$PROBE_FILE\"",
      "test -s \"$PROBE_FILE\"",
    ].join("\n"),
    captureOutput: true,
    failOnError: true,
  })
  .run({ cwd: process.cwd() });

if ("status" in result && result.status === "failed") {
  process.exitCode = 1;
}

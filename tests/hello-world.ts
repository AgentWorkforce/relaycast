/**
 * Test runner — executes the hello-world workflow inside a Daytona sandbox.
 *
 * Imports the workflow config and extracts the deterministic command
 * to run inside the sandbox. Requires DAYTONA_API_KEY in environment.
 */

import { Daytona } from "@daytonaio/sdk";
import { config } from "../workflows/hello-world.js";

const step = config.workflows![0].steps[0];
const script = step.command!;

const daytona = new Daytona();
const sandbox = await daytona.create();
console.log(`Sandbox created: ${sandbox.id}`);

try {
  const response = await sandbox.process.executeCommand(script);
  console.log(response.result);

  if (response.exitCode !== 0) {
    console.error("Workflow failed with exit code:", response.exitCode);
    process.exit(1);
  }

  // Extract workspace details from output
  const lastLine = response.result.trim().split("\n").pop()!;
  const { data } = JSON.parse(lastLine);
  console.log(`\nRelaycast workspace_id: ${data.workspace_id}`);
  console.log(`Relaycast api_key: ${data.api_key}`);
} finally {
  await sandbox.delete();
  console.log("Sandbox cleaned up");
}

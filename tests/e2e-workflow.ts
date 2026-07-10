/**
 * End-to-end smoke test — launches a deterministic workflow via the API,
 * polls for status, and checks the sandbox logs for the expected output.
 *
 * Requires: DAYTONA_API_KEY, AWS credentials (AWS_ACCESS_KEY_ID, etc.),
 * STS_ROLE_ARN, S3_BUCKET, and E2E_SESSION_COOKIE in the environment.
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { Daytona } from "@daytonaio/sdk";

const API_PORT = 3099;
const API_BASE = `http://localhost:${API_PORT}`;
const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 120_000;
const SESSION_COOKIE_NAME = "agent_relay_session";

const workflowConfig = JSON.stringify({
  version: "1.0",
  name: "e2e-smoke-test",
  description: "Minimal deterministic workflow for e2e testing",
  swarm: { pattern: "pipeline", maxConcurrency: 1, timeoutMs: 120000 },
  agents: [],
  workflows: [
    {
      name: "smoke",
      steps: [
        {
          name: "hello",
          type: "deterministic",
          command: "echo 'Hello from Daytona sandbox!' && date",
        },
      ],
    },
  ],
});

const sessionCookie = process.env.E2E_SESSION_COOKIE?.trim();

// --- Dev server management ---

let devServer: ChildProcess | null = null;

function startDevServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Dev server start timed out")), 60_000);

    devServer = spawn("npx", ["next", "dev", "-p", String(API_PORT)], {
      cwd: new URL("../packages/web", import.meta.url).pathname,
      env: { ...process.env, PORT: String(API_PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      process.stderr.write(text);
      if (text.includes("Ready") || text.includes("ready") || text.includes(`localhost:${API_PORT}`)) {
        clearTimeout(timeout);
        resolve();
      }
    };

    devServer.stdout?.on("data", onData);
    devServer.stderr?.on("data", onData);

    devServer.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    devServer.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Dev server exited with code ${code}`));
      }
    });
  });
}

function stopDevServer() {
  if (devServer) {
    devServer.kill("SIGTERM");
    devServer = null;
  }
}

// --- API helpers ---

async function postWorkflow(): Promise<{ runId: string; sandboxId: string }> {
  const res = await fetch(`${API_BASE}/api/v1/workflows/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
    },
    body: JSON.stringify({ workflow: workflowConfig, fileType: "yaml" }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /workflows/run failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<{ runId: string; sandboxId: string }>;
}

async function pollStatus(runId: string): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    const res = await fetch(`${API_BASE}/api/v1/workflows/runs/${runId}`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
    });

    if (res.ok) {
      const data = (await res.json()) as { status: string };
      console.log(`  status: ${data.status}`);
      if (data.status === "completed" || data.status === "failed") {
        return data.status;
      }
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  return "timeout";
}

// --- Sandbox log checker ---

async function checkSandboxLogs(sandboxId: string): Promise<boolean> {
  try {
    const daytona = new Daytona();
    const sandbox = await daytona.get(sandboxId);
    const home = (await sandbox.getUserHomeDir()) ?? "/home/daytona";

    const logResult = await sandbox.process.executeCommand(`cat ${home}/runner.log`);
    console.log("\n--- Sandbox runner.log ---");
    console.log(logResult.result);
    console.log("--- End runner.log ---\n");

    return logResult.result.includes("Hello from Daytona sandbox!");
  } catch (err) {
    console.error("Failed to read sandbox logs:", err);
    return false;
  }
}

async function cleanupSandbox(sandboxId: string) {
  try {
    const daytona = new Daytona();
    const sandbox = await daytona.get(sandboxId);
    await sandbox.delete();
    console.log(`Sandbox ${sandboxId} cleaned up`);
  } catch (err) {
    console.error(`Failed to cleanup sandbox ${sandboxId}:`, err);
  }
}

// --- Main ---

async function main() {
  console.log("=== E2E Workflow Smoke Test ===\n");

  // Check required env vars
  const required = ["STS_ROLE_ARN", "S3_BUCKET", "DAYTONA_API_KEY", "E2E_SESSION_COOKIE"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  console.log("Starting Next.js dev server...");
  await startDevServer();
  console.log("Dev server ready.\n");

  let sandboxId: string | undefined;
  try {
    console.log("Posting workflow...");
    const result = await postWorkflow();
    sandboxId = result.sandboxId;
    console.log(`  runId:     ${result.runId}`);
    console.log(`  sandboxId: ${result.sandboxId}\n`);

    console.log("Polling for status...");
    const status = await pollStatus(result.runId);
    console.log(`\nFinal status: ${status}`);

    // Check sandbox logs regardless of callback status
    // (callback won't work from sandbox → localhost)
    console.log("\nChecking sandbox logs...");
    const logsOk = await checkSandboxLogs(result.sandboxId);

    if (logsOk) {
      console.log("\n✅ PASS — Workflow launched and executed successfully in sandbox");
    } else if (status === "timeout") {
      // Callback can't reach localhost, but if sandbox ran the command, that's a pass
      console.log("\n⚠️  Status polling timed out (expected — callback can't reach localhost)");
      console.log("   Check sandbox logs above for workflow output.");
      console.log("\n❌ FAIL — Could not verify sandbox execution from logs");
    } else {
      console.log("\n❌ FAIL");
    }

    process.exitCode = logsOk ? 0 : 1;
  } catch (err) {
    console.error("\n❌ FAIL —", err);
    process.exitCode = 1;
  } finally {
    if (sandboxId) {
      await cleanupSandbox(sandboxId);
    }
    stopDevServer();
  }
}

main();

/**
 * E2E integration test for the relayfile cloud flow.
 *
 * Verifies the full lifecycle:
 *   1. Start a local relayfile server (in-memory backend)
 *   2. Launch a workflow via the cloud API with RELAYFILE_URL set
 *   3. Confirm the sandbox was created WITHOUT a Daytona volume
 *   4. Confirm project files were seeded into the relayfile workspace wf-{runId}
 *   5. Confirm the relayfile-mount daemon was started inside the sandbox
 *   6. Confirm the workflow completed successfully
 *   7. Confirm files are accessible via the relayfile API
 *   8. Confirm a patch was generated from relayfile export
 *   9. Cleanup: stop relayfile server and delete sandbox
 *
 * Required env vars:
 *   DAYTONA_API_KEY, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, STS_ROLE_ARN,
 *   S3_BUCKET, E2E_SESSION_COOKIE, RELAYAUTH_API_KEY
 *
 * Optional:
 *   RELAYFILE_BIN — path to the relayfile binary (defaults to "go run ../relayfile/cmd/relayfile")
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { Daytona } from "@daytonaio/sdk";
import { mintRelayfileToken } from "../packages/core/src/relayfile/client.js";

// ── Config ──────────────────────────────────────────────────────────

const RELAYFILE_PORT = 9090;
const RELAYFILE_URL = `http://localhost:${RELAYFILE_PORT}`;
const RELAYAUTH_URL = process.env.RELAYAUTH_URL ?? "https://api.relayauth.dev";
const RELAYAUTH_API_KEY = process.env.RELAYAUTH_API_KEY ?? "";

const API_PORT = 3099;
const API_BASE = `http://localhost:${API_PORT}`;
const SESSION_COOKIE_NAME = "agent_relay_session";

const POLL_INTERVAL_MS = 5_000;
const WORKFLOW_TIMEOUT_MS = 180_000;

const sessionCookie = process.env.E2E_SESSION_COOKIE?.trim();

// A minimal deterministic workflow that writes a file so we can verify the patch
const workflowConfig = JSON.stringify({
  version: "1.0",
  name: "e2e-relayfile-test",
  description: "Verifies relayfile integration end-to-end",
  swarm: { pattern: "pipeline", maxConcurrency: 1, timeoutMs: 120000 },
  agents: [],
  workflows: [
    {
      name: "relayfile-smoke",
      steps: [
        {
          name: "write-file",
          type: "deterministic",
          command:
            "echo 'Hello from relayfile e2e test' > /project/e2e-output.txt && echo 'relayfile-test-marker'",
        },
      ],
    },
  ],
});

// ── Process Management ──────────────────────────────────────────────

let relayfileServer: ChildProcess | null = null;
let devServer: ChildProcess | null = null;

function startRelayfileServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Relayfile server start timed out")),
      30_000,
    );

    const relayfileBin = process.env.RELAYFILE_BIN;
    const projectRoot = path.resolve(
      new URL(".", import.meta.url).pathname,
      "..",
    );

    if (relayfileBin) {
      relayfileServer = spawn(relayfileBin, ["serve"], {
        env: {
          ...process.env,
          RELAYFILE_LISTEN_ADDR: `:${RELAYFILE_PORT}`,
          RELAYFILE_BACKEND_PROFILE: "memory",
          RELAYAUTH_URL,
          RELAYAUTH_API_KEY,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else {
      const relayfileDir = path.resolve(projectRoot, "..", "relayfile");
      relayfileServer = spawn("go", ["run", "./cmd/relayfile", "serve"], {
        cwd: relayfileDir,
        env: {
          ...process.env,
          RELAYFILE_LISTEN_ADDR: `:${RELAYFILE_PORT}`,
          RELAYFILE_BACKEND_PROFILE: "memory",
          RELAYAUTH_URL,
          RELAYAUTH_API_KEY,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    }

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      process.stderr.write(`[relayfile] ${text}`);
      if (
        text.includes("listening") ||
        text.includes("started") ||
        text.includes(`:${RELAYFILE_PORT}`)
      ) {
        clearTimeout(timeout);
        resolve();
      }
    };

    relayfileServer.stdout?.on("data", onData);
    relayfileServer.stderr?.on("data", onData);

    relayfileServer.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Relayfile server failed to start: ${err.message}`));
    });

    relayfileServer.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Relayfile server exited with code ${code}`));
      }
    });

    // Fallback: if no "listening" output, poll the health endpoint
    const pollReady = setInterval(async () => {
      try {
        const res = await fetch(`${RELAYFILE_URL}/health`);
        if (res.ok) {
          clearInterval(pollReady);
          clearTimeout(timeout);
          resolve();
        }
      } catch {
        // not ready yet
      }
    }, 500);

    // Cleanup poll on timeout/resolve
    const origReject = reject;
    reject = (err) => {
      clearInterval(pollReady);
      origReject(err);
    };
  });
}

function stopRelayfileServer() {
  if (relayfileServer) {
    relayfileServer.kill("SIGTERM");
    relayfileServer = null;
    console.log("Relayfile server stopped.");
  }
}

function startDevServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Dev server start timed out")),
      60_000,
    );

    devServer = spawn("npx", ["next", "dev", "-p", String(API_PORT)], {
      cwd: new URL("../packages/web", import.meta.url).pathname,
      env: {
        ...process.env,
        PORT: String(API_PORT),
        RELAYFILE_URL,
        RELAYAUTH_URL,
        RELAYAUTH_API_KEY,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      process.stderr.write(text);
      if (
        text.includes("Ready") ||
        text.includes("ready") ||
        text.includes(`localhost:${API_PORT}`)
      ) {
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

// ── Relayfile API helpers ───────────────────────────────────────────

async function relayfileHeaders(workspaceId: string): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${await mintRelayfileToken({
      workspaceId,
      relayAuthUrl: RELAYAUTH_URL,
      relayAuthApiKey: RELAYAUTH_API_KEY,
    })}`,
  };
}

async function relayfileListFiles(
  workspaceId: string,
): Promise<{ path: string }[]> {
  const res = await fetch(
    `${RELAYFILE_URL}/v1/workspaces/${encodeURIComponent(workspaceId)}/fs/list`,
    { headers: await relayfileHeaders(workspaceId) },
  );
  if (!res.ok) {
    throw new Error(
      `relayfile list failed (${res.status}): ${await res.text()}`,
    );
  }
  return (await res.json()) as { path: string }[];
}

async function relayfileReadFile(
  workspaceId: string,
  filePath: string,
): Promise<string> {
  const res = await fetch(
    `${RELAYFILE_URL}/v1/workspaces/${encodeURIComponent(workspaceId)}/fs/file?path=${encodeURIComponent(filePath)}`,
    { headers: await relayfileHeaders(workspaceId) },
  );
  if (!res.ok) {
    throw new Error(
      `relayfile read failed (${res.status}): ${await res.text()}`,
    );
  }
  return res.text();
}

async function relayfileExportPatch(workspaceId: string): Promise<string> {
  const res = await fetch(
    `${RELAYFILE_URL}/v1/workspaces/${encodeURIComponent(workspaceId)}/fs/export?format=patch`,
    { headers: await relayfileHeaders(workspaceId) },
  );
  if (!res.ok) {
    throw new Error(
      `relayfile export failed (${res.status}): ${await res.text()}`,
    );
  }
  return res.text();
}

// ── Cloud API helpers ───────────────────────────────────────────────

async function postWorkflow(): Promise<{
  runId: string;
  sandboxId: string;
}> {
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

async function pollStatus(
  runId: string,
): Promise<"completed" | "failed" | "timeout"> {
  const deadline = Date.now() + WORKFLOW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${API_BASE}/api/v1/workflows/runs/${runId}`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
    });
    if (res.ok) {
      const data = (await res.json()) as { status: string };
      console.log(`  status: ${data.status}`);
      if (data.status === "completed" || data.status === "failed") {
        return data.status as "completed" | "failed";
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return "timeout";
}

// ── Sandbox inspection ──────────────────────────────────────────────

async function inspectSandbox(sandboxId: string): Promise<{
  hasVolume: boolean;
  hasRelayfileMount: boolean;
  runnerLog: string;
}> {
  const daytona = new Daytona();
  const sandbox = await daytona.get(sandboxId);
  const home = (await sandbox.getUserHomeDir()) ?? "/home/daytona";

  // Check runner.log for relayfile-related messages
  const logResult = await sandbox.process.executeCommand(
    `cat ${home}/runner.log 2>/dev/null || echo ""`,
  );
  const runnerLog = logResult.result ?? "";

  // Check if relayfile-mount daemon was started
  const hasRelayfileMount = runnerLog.includes(
    "Started relayfile-mount daemon",
  );

  // Check if a Daytona volume was mounted (legacy path). If relayfile is used,
  // the bootstrap should NOT report a CODE_VOLUME_ID in the env file.
  const envResult = await sandbox.process.executeCommand(
    `grep CODE_VOLUME_ID ${home}/.bootstrap-env 2>/dev/null || echo "NO_VOLUME"`,
  );
  const hasVolume = !envResult.result.includes("NO_VOLUME");

  return { hasVolume, hasRelayfileMount, runnerLog };
}

async function cleanupSandbox(sandboxId: string) {
  try {
    const daytona = new Daytona();
    const sandbox = await daytona.get(sandboxId);
    await sandbox.delete();
    console.log(`Sandbox ${sandboxId} cleaned up.`);
  } catch (err) {
    console.error(`Failed to cleanup sandbox ${sandboxId}:`, err);
  }
}

// ── Assertions ──────────────────────────────────────────────────────

type TestResult = { name: string; pass: boolean; detail?: string };

function assert(
  name: string,
  pass: boolean,
  detail?: string,
): TestResult {
  const icon = pass ? "PASS" : "FAIL";
  console.log(`  [${icon}] ${name}${detail ? ` — ${detail}` : ""}`);
  return { name, pass, detail };
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("=== E2E Relayfile Integration Test ===\n");

  const required = [
    "STS_ROLE_ARN",
    "S3_BUCKET",
    "DAYTONA_API_KEY",
    "E2E_SESSION_COOKIE",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  const results: TestResult[] = [];
  let sandboxId: string | undefined;

  try {
    // Step 1: Start relayfile server
    console.log("1. Starting relayfile server (memory backend)...");
    await startRelayfileServer();
    console.log("   Relayfile server ready.\n");

    // Step 2: Start dev server with RELAYFILE_URL
    console.log("2. Starting Next.js dev server...");
    await startDevServer();
    console.log("   Dev server ready.\n");

    // Step 3: Launch workflow
    console.log("3. Launching workflow...");
    const { runId, sandboxId: sid } = await postWorkflow();
    sandboxId = sid;
    console.log(`   runId:     ${runId}`);
    console.log(`   sandboxId: ${sandboxId}\n`);

    const relayfileWorkspaceId = `wf-${runId}`;

    // Step 4: Poll for completion
    console.log("4. Polling for workflow status...");
    const status = await pollStatus(runId);
    console.log(`   Final status: ${status}\n`);

    // Step 5: Run assertions
    console.log("5. Running assertions...\n");

    // 5a. Sandbox was created WITHOUT a Daytona volume
    const inspection = await inspectSandbox(sandboxId);
    results.push(
      assert(
        "No Daytona volume mounted",
        !inspection.hasVolume,
        inspection.hasVolume
          ? "CODE_VOLUME_ID found in .bootstrap-env"
          : "No CODE_VOLUME_ID in env",
      ),
    );

    // 5b. relayfile-mount daemon started in sandbox
    results.push(
      assert(
        "relayfile-mount daemon started",
        inspection.hasRelayfileMount,
        inspection.hasRelayfileMount
          ? "Daemon start message found in runner.log"
          : "No daemon start message in runner.log",
      ),
    );

    // 5c. relayfile workspace was seeded with files
    const seeded = inspection.runnerLog.includes("Seeded");
    results.push(
      assert(
        "Relayfile workspace seeded",
        seeded,
        seeded
          ? "Seed message found in runner.log"
          : "No seed message in runner.log",
      ),
    );

    // 5d. Workflow completed successfully
    results.push(
      assert("Workflow completed", status === "completed", `status=${status}`),
    );

    // 5e. Files are accessible via relayfile API
    let filesAccessible = false;
    let fileList: { path: string }[] = [];
    try {
      fileList = await relayfileListFiles(relayfileWorkspaceId);
      filesAccessible = fileList.length > 0;
    } catch (err) {
      // The workspace might not exist if seeding failed
    }
    results.push(
      assert(
        "Files accessible via relayfile API",
        filesAccessible,
        `${fileList.length} files in workspace`,
      ),
    );

    // 5f. The file written by the workflow is present
    let outputFileContent = "";
    try {
      outputFileContent = await relayfileReadFile(
        relayfileWorkspaceId,
        "e2e-output.txt",
      );
    } catch {
      // file may not have been synced yet
    }
    const hasOutputFile = outputFileContent.includes(
      "Hello from relayfile e2e test",
    );
    results.push(
      assert(
        "Workflow output file in relayfile",
        hasOutputFile,
        hasOutputFile
          ? "e2e-output.txt found with expected content"
          : "e2e-output.txt not found or wrong content",
      ),
    );

    // 5g. Patch was generated from relayfile export
    let patchContent = "";
    try {
      patchContent = await relayfileExportPatch(relayfileWorkspaceId);
    } catch {
      // export may fail if workspace has no changes
    }
    const hasPatch =
      patchContent.length > 0 && patchContent.includes("e2e-output.txt");
    results.push(
      assert(
        "Patch generated from relayfile export",
        hasPatch,
        hasPatch
          ? `patch size: ${patchContent.length} bytes`
          : "No patch or missing e2e-output.txt in patch",
      ),
    );

    // 5h. Runner.log shows expected marker
    const hasMarker = inspection.runnerLog.includes("relayfile-test-marker");
    results.push(
      assert(
        "Workflow command output in runner.log",
        hasMarker,
        hasMarker
          ? "relayfile-test-marker found"
          : "marker not found in runner.log",
      ),
    );

    // Summary
    console.log("\n=== Results ===");
    const passed = results.filter((r) => r.pass).length;
    const failed = results.filter((r) => !r.pass).length;
    console.log(
      `${passed}/${results.length} passed, ${failed} failed\n`,
    );

    if (failed > 0) {
      console.log("--- Sandbox runner.log ---");
      console.log(inspection.runnerLog);
      console.log("--- End runner.log ---\n");
    }

    process.exitCode = failed > 0 ? 1 : 0;
  } catch (err) {
    console.error("\nFATAL:", err);
    process.exitCode = 1;
  } finally {
    if (sandboxId) {
      console.log("\n6. Cleaning up...");
      await cleanupSandbox(sandboxId);
    }
    stopDevServer();
    stopRelayfileServer();
  }
}

main();

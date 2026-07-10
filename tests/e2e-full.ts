/**
 * Full end-to-end test — no cloud server required.
 *
 * Tests the complete flow:
 *   1. Create a Daytona sandbox for interactive CLI auth (SSH)
 *   2. User completes CLI auth via PTY (ssh2)
 *   3. Credentials are encrypted and stored in S3
 *   4. Verify credentials exist in S3
 *   5. Launch tic-tac-toe workflow via Orchestrator
 *   6. Verify credentials are retrieved from S3 and mounted in agent sandboxes
 *   7. Poll run status via S3 manifest
 *
 * Usage:
 *   npx tsx --env-file=.env tests/e2e-full.ts
 *   npx tsx --env-file=.env tests/e2e-full.ts --skip-auth   # skip OAuth, creds must already exist
 *   npx tsx --env-file=.env tests/e2e-full.ts --auth-only   # only do OAuth + S3 storage, skip workflow
 *
 * Required env vars:
 *   DAYTONA_API_KEY          — Daytona sandbox API key
 *   S3_BUCKET                — S3 bucket for credentials + run artifacts
 *   STS_ROLE_ARN             — IAM role for minting scoped S3 credentials
 *   AWS_ACCESS_KEY_ID        — IAM access key (for STS AssumeRole)
 *   AWS_SECRET_ACCESS_KEY    — IAM secret key
 *   CREDENTIAL_ENCRYPTION_KEY — 64-char hex (AES-256-GCM key for credential encryption)
 *
 * Optional:
 *   AWS_REGION               — defaults to us-east-1
 *   USER_ID                  — defaults to "e2e-test"
 */

// @ts-expect-error no @types/ssh2 installed
import { Client } from "ssh2";
import { Daytona } from "@daytonaio/sdk";
import {
  CLI_AUTH_CONFIG,
  stripAnsiCodes,
} from "@agent-relay/config/cli-auth-config";
import { CredentialStore } from "../packages/core/src/auth/credential-store.js";
import { createAuthSandbox, completeAuthSession } from "../packages/core/src/auth/sandbox-auth.js";
import { config as ticTacToeConfig } from "../workflows/tic-tac-toe.js";
import { Orchestrator } from "../packages/core/src/orchestrator.js";
import { getRunStatus } from "../packages/core/src/cli/status.js";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = new Set(process.argv.slice(2));
const skipAuth = args.has("--skip-auth");
const authOnly = args.has("--auth-only");
const provider = "anthropic";

// ── Env validation ────────────────────────────────────────────────────────────

const DAYTONA_API_KEY = process.env.DAYTONA_API_KEY?.trim();
const S3_BUCKET = process.env.S3_BUCKET?.trim();
const STS_ROLE_ARN = process.env.STS_ROLE_ARN?.trim();
const CREDENTIAL_ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();
const USER_ID = process.env.USER_ID?.trim() ?? "e2e-test";

const required: Record<string, string | undefined> = {
  DAYTONA_API_KEY,
  S3_BUCKET,
  STS_ROLE_ARN,
  CREDENTIAL_ENCRYPTION_KEY,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID?.trim(),
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY?.trim(),
};

const missing = Object.entries(required)
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length > 0) {
  console.error("Missing required env vars:");
  for (const name of missing) {
    console.error(`  - ${name}`);
  }
  process.exit(1);
}

const bucket = S3_BUCKET!;
const daytonaApiKey = DAYTONA_API_KEY!;

// ── Helpers ───────────────────────────────────────────────────────────────────

interface CheckResult {
  step: string;
  status: "PASS" | "FAIL" | "SKIP";
  details: string;
}

const results: CheckResult[] = [];

function record(step: string, status: "PASS" | "FAIL" | "SKIP", details = ""): void {
  results.push({ step, status, details });
  const icon = status === "PASS" ? "\x1b[32m✓\x1b[0m" : status === "FAIL" ? "\x1b[31m✗\x1b[0m" : "\x1b[33m–\x1b[0m";
  console.log(`  ${icon} ${step}${details ? ` — ${details}` : ""}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── SSH+PTY interactive session (adapted from relay ssh-interactive.ts) ───────

interface SshSessionOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  remoteCommand: string;
  timeoutMs: number;
}

interface SshSessionResult {
  exitCode: number | null;
  authDetected: boolean;
}

const providerConfig = (CLI_AUTH_CONFIG as Record<string, any>)[provider];
const successPatterns: RegExp[] = providerConfig?.successPatterns ?? [];

/**
 * Run an interactive SSH session using ssh2 with a PTY.
 *
 * Connects via ssh2, opens a shell with a real PTY, sends the remote command,
 * and pipes stdin/stdout so the user can interact with the CLI auth flow.
 * Monitors output for success patterns to detect when auth completes.
 */
function runSshSession(options: SshSessionOptions): Promise<SshSessionResult> {
  const { host, port, user, password, remoteCommand, timeoutMs } = options;

  return new Promise((resolve, reject) => {
    const sshClient = new Client();

    sshClient.on("ready", () => {
      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;
      const term = process.env.TERM || "xterm-256color";

      // Use shell() for a full login shell with proper TTY — required for CLIs like claude
      sshClient.shell({ term, cols, rows }, (err: any, stream: any) => {
        if (err) {
          sshClient.end();
          return reject(err);
        }

        // Send the command through the shell, then exit with its status
        stream.write(`${remoteCommand}; exit $?\n`);

        let exitCode: number | null = null;
        let authDetected = false;
        let outputBuffer = "";

        const stdin = process.stdin;
        const stdout = process.stdout;

        const wasRaw = (stdin as any).isRaw ?? false;
        try { stdin.setRawMode?.(true); } catch { /* ignore */ }
        stdin.resume();

        // Pipe local stdin → remote
        const onStdinData = (data: Buffer) => {
          // If auth already detected and user presses Escape/Ctrl+C, close
          if (authDetected && (data[0] === 0x1b || data[0] === 0x03)) {
            cleanup();
            clearTimeout(timer);
            try { stream.close(); } catch { /* ignore */ }
            return;
          }
          stream.write(data);
        };
        stdin.on("data", onStdinData);

        const cleanup = () => {
          stdin.off("data", onStdinData);
          stdout.off("resize", onResize);
          try { stdin.setRawMode?.(wasRaw); } catch { /* ignore */ }
          stdin.pause();
        };

        // Pipe remote stdout → local
        stream.on("data", (data: Buffer) => {
          stdout.write(data);

          outputBuffer += data.toString();
          if (outputBuffer.length > 8192) {
            outputBuffer = outputBuffer.slice(-8192);
          }

          // Check for auth success
          if (!authDetected && successPatterns.length > 0) {
            const clean = stripAnsiCodes(outputBuffer);
            for (const pattern of successPatterns) {
              if (pattern.test(clean)) {
                authDetected = true;
                stdout.write("\n");
                stdout.write("\x1b[32m  ✓ Authentication successful!\x1b[0m\n");
                stdout.write("\x1b[2m  Press Escape or Ctrl+C to exit.\x1b[0m\n\n");
                break;
              }
            }
          }
        });

        // Handle terminal resize
        const onResize = () => {
          try { stream.setWindow(stdout.rows || 24, stdout.columns || 80, 0, 0); } catch { /* ignore */ }
        };
        stdout.on("resize", onResize);

        // Timeout
        const timer = setTimeout(() => {
          cleanup();
          try { stream.close(); } catch { /* ignore */ }
          reject(new Error(`SSH session timed out after ${Math.floor(timeoutMs / 1000)}s`));
        }, timeoutMs);

        stream.on("exit", (code: unknown) => {
          if (typeof code === "number") exitCode = code;
        });

        stream.on("close", () => {
          clearTimeout(timer);
          cleanup();
          sshClient.end();
          resolve({ exitCode, authDetected });
        });

        stream.on("error", (streamErr: unknown) => {
          clearTimeout(timer);
          cleanup();
          sshClient.end();
          reject(streamErr instanceof Error ? streamErr : new Error(String(streamErr)));
        });
      });
    });

    sshClient.on("error", (err: any) => {
      reject(new Error(`SSH connection error: ${err.message}`));
    });

    sshClient.on("close", () => {
      // If we never got ready, reject
    });

    sshClient.connect({
      host,
      port,
      username: user,
      password,
      readyTimeout: 15000,
      hostVerifier: () => true,
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════");
  console.log("  E2E FULL PIPELINE TEST");
  console.log("══════════════════════════════════════════════════");
  console.log(`  User ID:  ${USER_ID}`);
  console.log(`  Provider: ${provider}`);
  console.log(`  Bucket:   ${bucket}`);
  console.log(`  Flags:    ${skipAuth ? "--skip-auth" : ""}${authOnly ? "--auth-only" : ""}${!skipAuth && !authOnly ? "(full run)" : ""}`);
  console.log("");

  const store = new CredentialStore({
    bucket,
    region: process.env.AWS_REGION ?? "us-east-1",
    encryptionKey: process.env.CREDENTIAL_ENCRYPTION_KEY ?? "",
  });

  // ── Step 1: Interactive CLI auth via Daytona sandbox ──────────────────

  if (skipAuth) {
    record("1. Create auth sandbox (SSH)", "SKIP", "--skip-auth");
    record("2. Interactive CLI auth", "SKIP", "--skip-auth");
    record("3. Store credentials to S3", "SKIP", "--skip-auth");
  } else {
    console.log("\n── Step 1: Create Daytona sandbox for auth ──\n");

    let sessionId: string | undefined;

    try {
      const authResult = await createAuthSandbox({
        provider,
        userId: USER_ID,
        daytonaApiKey,
        sessionStore: store as any,
      });

      sessionId = authResult.sessionId;
      record("1. Create auth sandbox (SSH)", "PASS", `session=${sessionId}, host=${authResult.ssh.host}:${authResult.ssh.port}`);

      // ── Step 2: Interactive SSH+PTY session ────────────────────────────

      console.log("\n── Step 2: Interactive CLI auth session (ssh2 + PTY) ──\n");
      console.log("  Connecting via ssh2 with PTY...");
      console.log("  Follow the prompts to complete the Claude auth flow.");
      console.log("  The session will detect auth success automatically.\n");

      const sshResult = await runSshSession({
        host: authResult.ssh.host,
        port: authResult.ssh.port,
        user: authResult.ssh.user,
        password: authResult.ssh.password,
        remoteCommand: authResult.remoteCommand,
        timeoutMs: 300_000,
      });

      const authSuccess = sshResult.authDetected || sshResult.exitCode === 0;
      record("2. Interactive CLI auth", authSuccess ? "PASS" : "FAIL",
        authSuccess
          ? `session completed${sshResult.authDetected ? " (auth detected)" : ""}`
          : `exitCode=${sshResult.exitCode}`);

      if (!authSuccess) {
        console.log("\n  SSH exited non-zero, but attempting credential storage anyway...\n");
      }

      // ── Step 3: Complete session → encrypt + store to S3 ────────────

      console.log("\n── Step 3: Store credentials to S3 (encrypted) ──\n");

      try {
        await completeAuthSession({
          sessionId,
          success: authSuccess,
          credentialEncryptionKey: process.env.CREDENTIAL_ENCRYPTION_KEY ?? "",
          sessionStore: store as any,
        });
        record("3. Store credentials to S3", "PASS", `s3://${bucket}/credentials/${USER_ID}/${provider}/credentials.json.enc`);
      } catch (err) {
        record("3. Store credentials to S3", "FAIL", (err as Error).message);
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (!results.some((r) => r.step.startsWith("1."))) {
        record("1. Create auth sandbox (SSH)", "FAIL", msg);
      }
      record("2. Interactive CLI auth", "FAIL", msg);
      record("3. Store credentials to S3", "FAIL", "skipped due to prior failure");
    }
  }

  // ── Step 4: Verify credentials exist in S3 ────────────────────────────

  console.log("\n── Step 4: Verify credentials in S3 ──\n");

  let credsExist = false;
  try {
    credsExist = await store.exists(USER_ID, provider);
    record("4. Credentials exist in S3", credsExist ? "PASS" : "FAIL",
      credsExist ? "encrypted credential found" : "not found — run without --skip-auth");
  } catch (err) {
    record("4. Credentials exist in S3", "FAIL", (err as Error).message);
  }

  if (!credsExist) {
    record("5. Retrieve + decrypt credentials", "FAIL", "no credentials to retrieve");
    if (!authOnly) {
      record("6. Launch tic-tac-toe", "SKIP", "no credentials");
      record("7. S3 artifacts", "SKIP", "no credentials");
    }
    printSummary();
    return;
  }

  // ── Step 5: Retrieve and decrypt credentials from S3 ──────────────────

  try {
    const retrieved = await store.retrieve(USER_ID, provider);
    if (retrieved) {
      // Validate it's real JSON
      JSON.parse(retrieved);
      record("5. Retrieve + decrypt credentials", "PASS", `${retrieved.length} chars, valid JSON`);
    } else {
      record("5. Retrieve + decrypt credentials", "FAIL", "retrieve returned null");
    }
  } catch (err) {
    record("5. Retrieve + decrypt credentials", "FAIL", (err as Error).message);
  }

  if (authOnly) {
    record("6. Launch tic-tac-toe", "SKIP", "--auth-only");
    record("7. S3 artifacts", "SKIP", "--auth-only");
    printSummary();
    return;
  }

  // ── Step 6: Launch tic-tac-toe via Orchestrator ───────────────────────

  console.log("\n── Step 6: Launch tic-tac-toe workflow ──\n");

  let sandboxId: string | undefined;
  let runId: string | undefined;

  try {
    const orchestrator = new Orchestrator(ticTacToeConfig);
    const result = await orchestrator.run({ userId: USER_ID, credentialEncryptionKey: process.env.CREDENTIAL_ENCRYPTION_KEY ?? "" });
    runId = result.runId;
    sandboxId = result.sandboxId;
    record("6. Launch tic-tac-toe", "PASS", `runId=${runId}, sandbox=${sandboxId}`);
    console.log(`\n  S3 artifacts: s3://${bucket}/${USER_ID}/${runId}/`);
    console.log(`  Check status: npx tsx --env-file=.env tests/check-status.ts --user-id ${USER_ID} --run-id ${runId} --poll\n`);
  } catch (err) {
    record("6. Launch tic-tac-toe", "FAIL", (err as Error).message);
    printSummary();
    return;
  }

  // ── Step 7: Poll S3 for run status + artifacts ────────────────────────

  console.log("── Step 7: Poll run status ──\n");

  const maxPolls = 40; // 40 × 15s = 10 min
  const pollDelayMs = 15_000;
  let finalStatus: Awaited<ReturnType<typeof getRunStatus>> | undefined;

  for (let attempt = 1; attempt <= maxPolls; attempt++) {
    finalStatus = await getRunStatus({ bucket, userId: USER_ID, runId: runId! });
    const stepCount = finalStatus.steps.length;
    const logCount = finalStatus.logKeys.length;

    console.log(`  Poll ${attempt}/${maxPolls}: status=${finalStatus.status}, steps=${stepCount}, logs=${logCount}`);

    if (finalStatus.status === "completed" || finalStatus.status === "failed") {
      break;
    }

    if (attempt === maxPolls) {
      record("7. S3 artifacts", "FAIL", "timeout waiting for completion");
      break;
    }

    await sleep(pollDelayMs);
  }

  if (finalStatus && (finalStatus.status === "completed" || finalStatus.status === "failed")) {
    const checks: string[] = [];
    const pass = finalStatus.status === "completed";

    checks.push(`status=${finalStatus.status}`);
    checks.push(`steps=${finalStatus.steps.length}`);
    checks.push(`logs=${finalStatus.logKeys.length}`);

    if (finalStatus.steps.length >= 2) {
      checks.push("2+ step metadata");
    }
    if (finalStatus.logKeys.length >= 2) {
      checks.push("2+ agent logs");
    }

    record("7. S3 artifacts", pass ? "PASS" : "FAIL", checks.join(", "));

    if (finalStatus.steps.length > 0) {
      console.log("\n  Step results:");
      for (const step of finalStatus.steps) {
        const status = step.exitCode === 0 && !step.error ? "ok" : "failed";
        console.log(`    ${step.stepName} (${step.agent}): ${status}, ${step.durationMs}ms`);
      }
    }

    if (finalStatus.logKeys.length > 0) {
      console.log("\n  Agent logs:");
      for (const key of finalStatus.logKeys) {
        console.log(`    s3://${bucket}/${key}`);
      }
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────────────

  if (sandboxId) {
    try {
      const daytona = new Daytona({ apiKey: daytonaApiKey });
      const sandbox = await daytona.get(sandboxId);
      await daytona.delete(sandbox);
      console.log(`\n  Sandbox ${sandboxId} cleaned up.`);
    } catch {
      console.log(`\n  Warning: failed to clean up sandbox ${sandboxId}`);
    }
  }

  printSummary();
}

function printSummary(): void {
  console.log("\n══════════════════════════════════════════════════");
  console.log("  RESULTS");
  console.log("══════════════════════════════════════════════════\n");

  for (const r of results) {
    const icon = r.status === "PASS" ? "\x1b[32mPASS\x1b[0m"
      : r.status === "FAIL" ? "\x1b[31mFAIL\x1b[0m"
      : "\x1b[33mSKIP\x1b[0m";
    console.log(`  ${icon}  ${r.step}`);
    if (r.details) {
      console.log(`        ${r.details}`);
    }
  }

  const failed = results.filter((r) => r.status === "FAIL");
  console.log("");

  if (failed.length > 0) {
    console.log(`  \x1b[31m${failed.length} check(s) failed.\x1b[0m`);
    process.exitCode = 1;
  } else {
    console.log(`  \x1b[32mAll checks passed.\x1b[0m`);
  }

  console.log("");
}

void main();

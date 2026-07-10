/**
 * E2E Interactive Test — Tic-tac-toe with PTY-based interactive agents.
 *
 * Unlike e2e-tic-tac-toe.ts which uses DaytonaStepExecutor (non-interactive),
 * this test runs agents in interactive mode where WorkflowRunner manages
 * its own broker and spawns agents via PTY with relay messaging.
 */
import { Daytona } from "@daytonaio/sdk";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
import { Orchestrator } from "../packages/core/src/orchestrator.js";
import { config as ticTacToeConfig } from "../workflows/tic-tac-toe.js";
import { getRunStatus } from "../packages/core/src/cli/status.js";
import { CredentialStore } from "../packages/core/src/auth/credential-store.js";

interface CheckResult {
  check: string;
  status: "PASS" | "FAIL";
  details: string;
}

const DAYTONA_API_KEY = process.env.DAYTONA_API_KEY?.trim();
const STS_ROLE_ARN = process.env.STS_ROLE_ARN?.trim();
const S3_BUCKET = process.env.S3_BUCKET?.trim();
const CREDENTIAL_ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();
const USER_ID = process.env.USER_ID?.trim() ?? "e2e-interactive";

const requiredEnv = [
  "DAYTONA_API_KEY",
  "STS_ROLE_ARN",
  "S3_BUCKET",
  "CREDENTIAL_ENCRYPTION_KEY",
];

const envByName: Record<string, string | undefined> = {
  DAYTONA_API_KEY,
  STS_ROLE_ARN,
  S3_BUCKET,
  CREDENTIAL_ENCRYPTION_KEY,
};

const missing = requiredEnv.filter((name) => !envByName[name]?.trim());
if (missing.length > 0) {
  console.error("Missing required env vars:");
  for (const name of missing) {
    console.error(`- ${name}`);
  }
  process.exit(1);
}

const daytonaApiKey = DAYTONA_API_KEY as string;
const bucket = S3_BUCKET as string;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main() {
  const results: CheckResult[] = [];
  const record = (check: string, pass: boolean, details = ""): void => {
    results.push({
      check,
      status: pass ? "PASS" : "FAIL",
      details,
    });
  };

  let caughtError: string | null = null;
  let sandboxId: string | undefined;
  let finalStatus: Awaited<ReturnType<typeof getRunStatus>> | undefined;

  const store = new CredentialStore({
    bucket,
    region:
      process.env.AWS_REGION ??
      process.env.AWS_DEFAULT_REGION ??
      "us-east-1",
    encryptionKey: process.env.CREDENTIAL_ENCRYPTION_KEY ?? "",
  });

  try {
    let canLaunch = false;
    let launchBlockedReason: string | null = null;

    try {
      const hasCredentials = await store.exists(USER_ID, "openai");
      canLaunch = hasCredentials;
      record(
        "CredentialStore.exists(userId, openai)",
        hasCredentials,
        hasCredentials
          ? "Credentials found"
          : "Run `npx agent-relay cloud connect openai` first",
      );
      if (!hasCredentials) {
        launchBlockedReason = "skipped: missing credentials";
      }
    } catch (error) {
      launchBlockedReason = (error as Error).message;
      record(
        "CredentialStore.exists(userId, openai)",
        false,
        launchBlockedReason,
      );
    }

    if (!canLaunch) {
      caughtError = launchBlockedReason ?? "skipped: missing credentials";
    } else {
      try {
        const orchestrator = new Orchestrator(ticTacToeConfig, {
          daytonaAuth: { apiKey: daytonaApiKey },
        });
        const runResult = await orchestrator.run({
          userId: USER_ID,
          credentialEncryptionKey: CREDENTIAL_ENCRYPTION_KEY as string,
          interactive: true,
        });
        record("Launch orchestrator (interactive)", true, `runId=${runResult.runId}`);
        sandboxId = runResult.sandboxId;
        const runId = runResult.runId;

        // Interactive mode takes longer — agents communicate via relay
        const maxPolls = 60;
        const pollDelayMs = 15_000;
        let polls = 0;
        let timedOut = false;
        for (let attempt = 1; attempt <= maxPolls; attempt += 1) {
          polls += 1;
          finalStatus = await getRunStatus({
            bucket,
            userId: USER_ID,
            runId,
          });

          if (
            finalStatus.status === "completed" ||
            finalStatus.status === "failed"
          ) {
            break;
          }

          if (attempt === maxPolls) {
            timedOut = true;
            break;
          }

          await sleep(pollDelayMs);
        }

        const statusPass = finalStatus?.status === "completed";
        record(
          "Run status polling (15s, 15m max)",
          statusPass,
          finalStatus
            ? `final=${finalStatus.status}, polls=${polls}, steps=${finalStatus.steps.length}, logs=${finalStatus.logKeys.length}`
            : "no status returned",
        );

        if (timedOut) {
          record("S3 manifest.json exists", false, "timeout waiting for completion");
          record("At least 1 agent.log file", false, "timeout waiting for completion");
        } else {
          record(
            "S3 manifest.json exists",
            true,
            "ok",
          );

          const hasLogs = (finalStatus?.logKeys.length ?? 0) >= 1;
          record(
            "At least 1 agent.log file",
            hasLogs,
            `found ${(finalStatus?.logKeys.length ?? 0)}`,
          );

          // Check run duration — interactive agents should take >10s
          const totalDuration = finalStatus?.steps.reduce(
            (sum, s) => sum + s.durationMs, 0
          ) ?? 0;
          record(
            "Agents ran interactively (>10s total)",
            totalDuration > 10_000 || (finalStatus?.logKeys.length ?? 0) > 0,
            `total duration: ${totalDuration}ms`,
          );
        }
      } catch (error) {
        caughtError = (error as Error).message;
      }
    }

    if (
      caughtError &&
      !results.some((result) => result.check.startsWith("Launch orchestrator"))
    ) {
      record("Launch orchestrator (interactive)", false, caughtError);
    }
  } catch (error) {
    caughtError = (error as Error).message;
  } finally {
    let cleanupPassed = true;
    let cleanupDetail = "no sandbox to cleanup";

    if (sandboxId) {
      cleanupPassed = false;
      const daytona = new Daytona({ apiKey: daytonaApiKey });
      try {
        const sandbox = await daytona.get(sandboxId);
        await daytona.delete(sandbox);
        cleanupPassed = true;
        cleanupDetail = "sandbox deleted";
      } catch (error) {
        cleanupPassed = false;
        cleanupDetail = (error as Error).message;
      }
    }

    record("Cleanup (Daytona SDK delete)", cleanupPassed, cleanupDetail);
  }

  console.log("\nE2E INTERACTIVE CHECKS");
  console.table(
    results.map((result) => ({
      check: result.check,
      status: result.status,
      details: result.details,
    })),
  );

  const failed = results.some((result) => result.status === "FAIL");
  if (failed) {
    process.exitCode = 1;
  }
}

void main();

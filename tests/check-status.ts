/**
 * Check the status of a workflow run.
 *
 * Usage:
 *   npx tsx --env-file=.env tests/check-status.ts --user-id USER --run-id RUN_ID
 *   npx tsx --env-file=.env tests/check-status.ts --user-id USER --run-id RUN_ID --poll
 *   npx tsx --env-file=.env tests/check-status.ts --user-id USER --run-id RUN_ID --logs
 */

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getRunStatus } from "../packages/core/src/cli/status.js";
import { type GetObjectCommandOutput } from "@aws-sdk/client-s3";

interface CliArgs {
  userId?: string;
  runId?: string;
  poll: boolean;
  logs: boolean;
  region?: string;
  timeoutSeconds: number;
}

export const DEFAULT_POLL_TIMEOUT_SECONDS = 30 * 60;
export const MAX_CONSECUTIVE_NOT_FOUND = 5;

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    poll: false,
    logs: false,
    timeoutSeconds: DEFAULT_POLL_TIMEOUT_SECONDS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--poll") {
      args.poll = true;
      continue;
    }
    if (arg === "--logs") {
      args.logs = true;
      continue;
    }
    if (arg === "--user-id" || arg.startsWith("--user-id=")) {
      const value = arg.includes("=")
        ? arg.slice("--user-id=".length)
        : argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --user-id");
      }
      args.userId = value;
      if (arg === "--user-id") {
        i += 1;
      }
      continue;
    }
    if (arg === "--run-id" || arg.startsWith("--run-id=")) {
      const value = arg.includes("=")
        ? arg.slice("--run-id=".length)
        : argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --run-id");
      }
      args.runId = value;
      if (arg === "--run-id") {
        i += 1;
      }
      continue;
    }
    if (arg === "--region" || arg.startsWith("--region=")) {
      const value = arg.includes("=")
        ? arg.slice("--region=".length)
        : argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --region");
      }
      args.region = value;
      if (arg === "--region") {
        i += 1;
      }
      continue;
    }
    if (arg === "--timeout" || arg.startsWith("--timeout=")) {
      const value = arg.includes("=")
        ? arg.slice("--timeout=".length)
        : argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --timeout");
      }
      const timeoutSeconds = Number(value);
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        throw new Error("Invalid value for --timeout; expected a positive number of seconds");
      }
      args.timeoutSeconds = timeoutSeconds;
      if (arg === "--timeout") {
        i += 1;
      }
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  return args;
}

function printUsage(): void {
  console.log(`Usage:
  npx tsx --env-file=.env tests/check-status.ts --user-id USER --run-id RUN_ID
  npx tsx --env-file=.env tests/check-status.ts --user-id USER --run-id RUN_ID --poll [--timeout SECONDS]
  npx tsx --env-file=.env tests/check-status.ts --user-id USER --run-id RUN_ID --logs`);
}

async function readObjectText(
  body: NonNullable<GetObjectCommandOutput["Body"]>
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function printLogs(
  bucket: string,
  logKeys: string[],
  region?: string,
): Promise<void> {
  if (logKeys.length === 0) {
    console.log("\nNo logs found.");
    return;
  }

  const s3 = new S3Client({
    region: region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
  });

  console.log("\nAgent logs:");
  for (const key of logKeys) {
    try {
      const response = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );
      const body = response.Body;
      const text = body ? await readObjectText(body) : "<empty>";
      console.log(`\n=== ${key} ===`);
      console.log(text.trimEnd());
    } catch (error) {
      console.log(`\n=== ${key} ===`);
      console.log(`[failed to load log: ${(error as Error).message}]`);
    }
  }
}

function stepStatus(step: {
  exitCode: number;
  error?: string;
}): string {
  if (step.error) {
    return "failed";
  }
  if (step.exitCode === 0) {
    return "completed";
  }
  return "failed";
}

function printResult(
  runStatus: ReturnType<typeof getRunStatus> extends Promise<infer T>
    ? Awaited<T>
    : never,
  logPrefix: string,
): void {
  console.log(`\nRun ID: ${runStatus.runId}`);
  console.log(`Status: ${runStatus.status}`);
  if (runStatus.workflowName) {
    console.log(`Workflow: ${runStatus.workflowName}`);
  }
  if (runStatus.startTime) {
    console.log(`Started: ${runStatus.startTime}`);
  }
  console.log(`S3 logs:`);
  for (const key of runStatus.logKeys) {
    console.log(`  - ${logPrefix}/${key}`);
  }

  if (runStatus.steps.length === 0) {
    console.log("No step metadata found yet.");
    return;
  }

  const rows = runStatus.steps.map((step) => ({
    "step name": step.stepName,
    agent: step.agent,
    status: stepStatus(step),
    duration: `${step.durationMs}ms`,
    "exit code": step.exitCode,
  }));

  console.log("\nSteps:");
  console.table(rows);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function advanceNotFoundRetries(
  status: Awaited<ReturnType<typeof getRunStatus>>["status"],
  consecutiveNotFound: number,
): { consecutiveNotFound: number; exhausted: boolean } {
  if (status !== "not_found") {
    return { consecutiveNotFound: 0, exhausted: false };
  }

  const nextCount = consecutiveNotFound + 1;
  return {
    consecutiveNotFound: nextCount,
    exhausted: nextCount >= MAX_CONSECUTIVE_NOT_FOUND,
  };
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String((err as Error).message));
    printUsage();
    process.exit(1);
  }

  const bucket = process.env.S3_BUCKET;
  const userId = args.userId;
  const runId = args.runId;

  if (!bucket || !userId || !runId) {
    if (!bucket) {
      console.error("Missing required env var: S3_BUCKET");
    }
    if (!userId) {
      console.error("Missing required arg: --user-id");
    }
    if (!runId) {
      console.error("Missing required arg: --run-id");
    }
    printUsage();
    process.exit(1);
  }

  const statusOptions = {
    bucket,
    userId,
    runId,
    region: args.region,
  };

  const logPrefix = `s3://${bucket}/${userId}/${runId}`;
  const pollIntervalMs = 15_000;
  const pollDeadline = Date.now() + args.timeoutSeconds * 1000;
  let status = await getRunStatus(statusOptions);
  let consecutiveNotFound = 0;

  if (!args.poll) {
    printResult(status, `s3://${bucket}/${userId}/${runId}`);
    if (args.logs && status.logKeys.length > 0) {
      await printLogs(bucket, status.logKeys, args.region);
    }
    if (status.status === "not_found") {
      process.exitCode = 1;
    }
    return;
  }

  while (true) {
    printResult(status, logPrefix);

    if (status.status === "completed" || status.status === "failed") {
      if (args.logs) {
        await printLogs(bucket, status.logKeys, args.region);
      }
      return;
    }

    const retryState = advanceNotFoundRetries(status.status, consecutiveNotFound);
    consecutiveNotFound = retryState.consecutiveNotFound;
    if (retryState.exhausted) {
      console.error(
        `Run manifest was not found after ${MAX_CONSECUTIVE_NOT_FOUND} consecutive checks. Giving up.`,
      );
      process.exitCode = 1;
      return;
    }

    const remainingMs = pollDeadline - Date.now();
    if (remainingMs <= 0) {
      console.error(`Polling timed out after ${args.timeoutSeconds}s.`);
      process.exitCode = 1;
      return;
    }

    if (status.status === "not_found") {
      console.log(
        `\nManifest not found yet (${consecutiveNotFound}/${MAX_CONSECUTIVE_NOT_FOUND}). Retrying...`,
      );
    }

    const sleepMs = Math.min(pollIntervalMs, remainingMs);
    console.log(`\nPolling again in ${sleepMs / 1000}s...`);
    await sleep(sleepMs);
    status = await getRunStatus(statusOptions);
  }
}

const isMain = process.argv[1]?.endsWith("check-status.ts") ||
  process.argv[1]?.endsWith("check-status.js");

if (isMain) {
  void main();
}

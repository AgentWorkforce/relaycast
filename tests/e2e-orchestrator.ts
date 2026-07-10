/**
 * End-to-end orchestrator test.
 *
 * Tests the full flow:
 *  1. Mint STS credentials (using IAM user, not root)
 *  2. Build credential bundle
 *  3. Upload code to S3
 *  4. Launch orchestrator sandbox (creates Daytona sandbox, installs deps,
 *     uploads lib + bootstrap, runs bootstrap in background)
 *  5. Monitor sandbox for completion
 *  6. Check S3 for artifacts
 *  7. Clean up sandbox
 */

import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { Daytona } from "@daytonaio/sdk";
import { buildCredentialBundle } from "../packages/core/src/auth/credentials.js";
import { launchOrchestratorSandbox } from "../packages/core/src/bootstrap/launcher.js";

// --- Configuration ---
interface OrchestratorConfig {
  daytonaApiKey: string;
  awsRegion: string;
  iamUserAccessKeyId: string;
  iamUserSecretAccessKey: string;
  iamUserSessionToken?: string;
  roleArn: string;
  bucket: string;
  relayfileUrl: string;
  relayAuthUrl: string;
  relayAuthApiKey: string;
}

const CONFIG: OrchestratorConfig = (() => {
  const missing: string[] = [];

  const daytonaApiKey = process.env.DAYTONA_API_KEY?.trim();
  if (!daytonaApiKey) {
    missing.push("DAYTONA_API_KEY");
  }

  const roleArn = process.env.E2E_STS_ROLE_ARN?.trim();
  if (!roleArn) {
    missing.push("E2E_STS_ROLE_ARN");
  }

  const bucket = process.env.E2E_S3_BUCKET?.trim();
  if (!bucket) {
    missing.push("E2E_S3_BUCKET");
  }

  const relayfileUrl = process.env.RELAYFILE_URL?.trim();
  if (!relayfileUrl) {
    missing.push("RELAYFILE_URL");
  }

  const relayAuthApiKey = process.env.RELAYAUTH_API_KEY?.trim();
  if (!relayAuthApiKey) {
    missing.push("RELAYAUTH_API_KEY");
  }
  const relayAuthUrl = process.env.RELAYAUTH_URL?.trim() || "https://api.relayauth.dev";

  const iamUserAccessKeyId =
    process.env.E2E_AWS_ACCESS_KEY_ID?.trim() ?? process.env.AWS_ACCESS_KEY_ID?.trim();
  if (!iamUserAccessKeyId) {
    missing.push("E2E_AWS_ACCESS_KEY_ID (or AWS_ACCESS_KEY_ID)");
  }

  const iamUserSecretAccessKey =
    process.env.E2E_AWS_SECRET_ACCESS_KEY?.trim() ??
    process.env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!iamUserSecretAccessKey) {
    missing.push("E2E_AWS_SECRET_ACCESS_KEY (or AWS_SECRET_ACCESS_KEY)");
  }

  const iamUserSessionToken =
    process.env.E2E_AWS_SESSION_TOKEN?.trim() ?? process.env.AWS_SESSION_TOKEN?.trim();

  const awsRegion =
    process.env.E2E_AWS_REGION?.trim() ??
    process.env.AWS_REGION?.trim() ??
    "us-east-1";

  if (missing.length) {
    console.error("Missing required E2E configuration:");
    for (const item of missing) {
      console.error(`  - ${item}`);
    }
    process.exit(1);
  }

  return {
    daytonaApiKey: daytonaApiKey!,
    awsRegion,
    iamUserAccessKeyId: iamUserAccessKeyId!,
    iamUserSecretAccessKey: iamUserSecretAccessKey!,
    iamUserSessionToken,
    roleArn: roleArn!,
    bucket: bucket!,
    relayfileUrl: relayfileUrl!,
    relayAuthUrl,
    relayAuthApiKey: relayAuthApiKey!,
  };
})();

const IAM_USER_CREDS = {
  accessKeyId: CONFIG.iamUserAccessKeyId,
  secretAccessKey: CONFIG.iamUserSecretAccessKey,
  ...(CONFIG.iamUserSessionToken
    ? { sessionToken: CONFIG.iamUserSessionToken }
    : {}),
};

const userId = "e2e-test-user";
const runId = crypto.randomUUID();
const prefix = `${userId}/${runId}`;

async function mintCredentials() {
  console.log("\n=== Step 1: Mint STS Credentials ===");
  const sts = new STSClient({ region: CONFIG.awsRegion, credentials: IAM_USER_CREDS });

  const sessionPolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "s3:PutObject",
          "s3:GetObject",
          "s3:CreateMultipartUpload",
          "s3:UploadPart",
          "s3:CompleteMultipartUpload",
          "s3:AbortMultipartUpload",
        ],
        Resource: `arn:aws:s3:::${CONFIG.bucket}/${prefix}/*`,
      },
    ],
  });

  const response = await sts.send(
    new AssumeRoleCommand({
      RoleArn: CONFIG.roleArn,
      RoleSessionName: `workflow-${runId}`,
      DurationSeconds: 900,
      Policy: sessionPolicy,
    })
  );

  const creds = response.Credentials!;
  console.log("  STS AssumeRole: OK");
  return {
    accessKeyId: creds.AccessKeyId!,
    secretAccessKey: creds.SecretAccessKey!,
    sessionToken: creds.SessionToken!,
    bucket: CONFIG.bucket,
    prefix,
  };
}

async function uploadCodeToS3(s3Creds: {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}) {
  console.log("\n=== Step 2: Upload Code to S3 ===");
  const s3 = new S3Client({
      region: CONFIG.awsRegion,
    credentials: {
      accessKeyId: s3Creds.accessKeyId,
      secretAccessKey: s3Creds.secretAccessKey,
      sessionToken: s3Creds.sessionToken,
    },
  });

  // Create a minimal workflow config matching the SDK's expected format
  const workflowYaml = JSON.stringify({
    name: "e2e-test-workflow",
    swarm: {
      pattern: "sequential",
    },
    agents: {
      "echo-agent": {
        cli: "claude",
        role: "worker",
      },
    },
    workflows: [
      {
        name: "echo-test",
        steps: [
          {
            name: "echo-step",
            agent: "echo-agent",
            task: "Create a file called /tmp/e2e-success.txt with the content 'E2E test passed'",
          },
        ],
      },
    ],
  });

  // Upload a simple code tarball (empty project)
  const { execSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const os = await import("node:os");

  const tmpDir = mkdtempSync(join(os.tmpdir(), "e2e-code-"));
  writeFileSync(join(tmpDir, "README.md"), "# E2E Test Project\n");
  writeFileSync(join(tmpDir, "package.json"), '{"name":"e2e-test","version":"1.0.0"}\n');

  execSync(`tar czf /tmp/e2e-code.tar.gz -C ${tmpDir} .`, {
    encoding: "utf-8",
  });

  const tarBuf = readFileSync("/tmp/e2e-code.tar.gz");
  await s3.send(
    new PutObjectCommand({
      Bucket: CONFIG.bucket,
      Key: `${prefix}/code.tar.gz`,
      Body: tarBuf,
    })
  );
  console.log("  Code tarball uploaded to S3:", `${prefix}/code.tar.gz`);
  console.log("  Tarball size:", tarBuf.length, "bytes");

  return workflowYaml;
}

async function launchSandbox(
  s3Creds: ReturnType<typeof buildCredentialBundle> extends { s3Credentials: infer T } ? T : never,
  workflowConfig: string
) {
  console.log("\n=== Step 3: Launch Orchestrator Sandbox ===");

  const credBundle = buildCredentialBundle({
    s3Credentials: s3Creds,
    cliCredentials: "",
    workspaceId: "e2e-workspace",
    relayApiKey: process.env.RELAY_API_KEY ?? "",
    runId,
    userId,
    daytonaApiKey: CONFIG.daytonaApiKey,
    s3CodeKey: "code.tar.gz",
    workflowConfig,
  });

  console.log("  Credential bundle built");
  console.log("  Launching sandbox...");

  const result = await launchOrchestratorSandbox({
    credentialBundle: credBundle,
    runId,
    relayfileUrl: CONFIG.relayfileUrl,
    relayAuthUrl: CONFIG.relayAuthUrl,
    relayAuthApiKey: CONFIG.relayAuthApiKey,
    fileType: "yaml",
    workflowConfig,
  });

  console.log("  Sandbox launched:", result.sandboxId);
  return result;
}

async function monitorSandbox(sandboxId: string) {
  console.log("\n=== Step 4: Monitor Sandbox ===");
  const daytona = new Daytona({ apiKey: CONFIG.daytonaApiKey });

  // Wait for bootstrap to run (check runner.log)
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    console.log(`  Checking sandbox (attempt ${i + 1}/12)...`);

    try {
      const sandbox = await daytona.get(sandboxId);
      const home = await sandbox.getUserHomeDir();
      const logResult = await sandbox.process.executeCommand(
        `cat ${home}/runner.log 2>/dev/null || echo 'No log yet'`,
        home
      );
      const log = logResult.result ?? "";

      if (log.includes("No log yet") || log.trim().length === 0) {
        // Check if bootstrap.mjs and env exist
        const check = await sandbox.process.executeCommand(
          `ls -la ${home}/bootstrap.mjs ${home}/.bootstrap-env ${home}/lib/ 2>&1; echo "---"; ps aux 2>/dev/null | grep -E 'node|bootstrap' | head -5`,
          home
        );
        console.log("    Bootstrap not started yet. Debug:");
        for (const line of (check.result ?? "").split("\n").slice(0, 10)) {
          console.log("      |", line);
        }
        continue;
      }

      console.log("    Runner log (last 10 lines):");
      const lines = log.split("\n");
      const last10 = lines.slice(-10);
      for (const line of last10) {
        console.log("      |", line);
      }

      if (
        log.includes("completed") ||
        log.includes("fatal error") ||
        log.includes("process.exit")
      ) {
        console.log(
          "  Bootstrap finished with status:",
          log.includes("fatal error") ? "FAILED" : "COMPLETED"
        );
        return log;
      }
    } catch (e) {
      console.log("    Error checking sandbox:", (e as Error).message);
    }
  }

  console.log("  Timeout waiting for bootstrap to complete");
  return null;
}

async function checkS3Artifacts() {
  console.log("\n=== Step 5: Check S3 Artifacts ===");
  const s3 = new S3Client({ region: CONFIG.awsRegion });

  const result = await s3.send(
    new ListObjectsV2Command({
      Bucket: CONFIG.bucket,
      Prefix: prefix,
    })
  );

  const objects = result.Contents ?? [];
  console.log(`  Found ${objects.length} objects in S3:`);
  for (const obj of objects) {
    console.log(`    - ${obj.Key} (${obj.Size} bytes)`);
  }
  return objects;
}

async function cleanup(sandboxId: string) {
  console.log("\n=== Step 6: Cleanup ===");
  try {
    const daytona = new Daytona({ apiKey: CONFIG.daytonaApiKey });
    const sandbox = await daytona.get(sandboxId);
    await daytona.delete(sandbox);
    console.log("  Sandbox deleted:", sandboxId);
  } catch (e) {
    console.log("  Cleanup error:", (e as Error).message);
  }
}

async function main() {
  console.log("========================================");
  console.log("  ORCHESTRATOR END-TO-END TEST");
  console.log("========================================");
  console.log(`  Run ID:  ${runId}`);
  console.log(`  User ID: ${userId}`);
  console.log(`  Bucket:  ${CONFIG.bucket}`);
  console.log(`  Region:  ${CONFIG.awsRegion}`);

  let sandboxId: string | undefined;
  try {
    // Step 1: Mint STS credentials
    const s3Creds = await mintCredentials();

    // Step 2: Upload code to S3
    const workflowConfig = await uploadCodeToS3(s3Creds);

    // Step 3: Launch orchestrator sandbox
    const result = await launchSandbox(s3Creds, workflowConfig);
    sandboxId = result.sandboxId;

    // Step 3.5: Try running bootstrap directly to see errors
    console.log("\n=== Step 3.5: Run Bootstrap Directly (debug) ===");
    const daytona = new Daytona({ apiKey: CONFIG.daytonaApiKey });
    const sandbox = await daytona.get(sandboxId);
    const home = await sandbox.getUserHomeDir();

    // Run bootstrap directly with error capture
    const directRun = await sandbox.process.executeCommand(
      `. ${home}/.bootstrap-env && node ${home}/bootstrap.mjs 2>&1 || true`,
      home,
    );
    console.log("  Direct run exit code:", directRun.exitCode);
    const directOutput = directRun.result ?? "";
    const outputLines = directOutput.split("\n");
    console.log(`  Output (${outputLines.length} lines):`);
    for (const line of outputLines.slice(0, 30)) {
      console.log("    |", line);
    }

    // Step 4: Monitor (skip since we ran directly)
    const log = directOutput;

    // Step 5: Check S3 artifacts
    await checkS3Artifacts();

    // Step 6: Print summary
    console.log("\n========================================");
    console.log("  TEST SUMMARY");
    console.log("========================================");
    console.log("  STS Credential Minting:  PASS");
    console.log("  S3 Code Upload:          PASS");
    console.log("  Sandbox Launch:          PASS");
    console.log(
      "  Bootstrap Execution:    ",
      log ? (log.includes("fatal error") ? "FAIL" : "PASS") : "TIMEOUT"
    );
  } catch (e) {
    console.error("\n  FATAL ERROR:", (e as Error).message);
    console.error((e as Error).stack);
  } finally {
    if (sandboxId) {
      await cleanup(sandboxId);
    }
  }
}

main();

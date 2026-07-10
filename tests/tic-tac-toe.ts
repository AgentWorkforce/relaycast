import { config } from "../workflows/tic-tac-toe.js";
import { Orchestrator } from "../packages/core/src/orchestrator.js";

const daytonaApiKey = process.env.DAYTONA_API_KEY?.trim();
const stsRoleArn = process.env.STS_ROLE_ARN?.trim();
const s3Bucket = process.env.S3_BUCKET?.trim();
const credentialEncryptionKey = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();
const userId = process.env.USER_ID?.trim();
const required = [
  ["DAYTONA_API_KEY", daytonaApiKey],
  ["STS_ROLE_ARN", stsRoleArn],
  ["S3_BUCKET", s3Bucket],
  ["CREDENTIAL_ENCRYPTION_KEY", credentialEncryptionKey],
  ["USER_ID", userId],
] as const;
const missing = required
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missing.length > 0) {
  console.error("Missing required env vars:");
  for (const item of missing) {
    console.error(`- ${item}`);
  }
  process.exit(1);
}

const resolvedS3Bucket = s3Bucket!;
const resolvedUserId = userId!;

try {
  const orchestrator = new Orchestrator(config, {
    daytonaAuth: { apiKey: daytonaApiKey! },
  });
  const { runId, sandboxId } = await orchestrator.run({
    userId: resolvedUserId,
    credentialEncryptionKey: credentialEncryptionKey!,
  });
  const s3Path = `s3://${resolvedS3Bucket}/${resolvedUserId}/${runId}`;
  const checkStatusCommand = `npx tsx --env-file=.env tests/check-status.ts --user-id ${resolvedUserId} --run-id ${runId}`;

  console.log(`Run launched: ${runId}`);
  console.log(`Sandbox: ${sandboxId}`);
  console.log(`S3 path: ${s3Path}`);
  console.log(`Status check: ${checkStatusCommand}`);
} catch (err) {
  console.error("Workflow launch failed:", err);
  process.exit(1);
}

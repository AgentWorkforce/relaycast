/**
 * Seed credentials for e2e-interactive user by copying from e2e-test user.
 */
import { CredentialStore } from "../packages/core/src/auth/credential-store.js";

const bucket = process.env.S3_BUCKET?.trim();
const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";

if (!bucket) {
  console.error("Missing S3_BUCKET");
  process.exit(1);
}

const store = new CredentialStore({ bucket, region, encryptionKey: process.env.CREDENTIAL_ENCRYPTION_KEY ?? "" });

async function main() {
  const sourceUser = "e2e-test";
  const targetUser = "e2e-interactive";
  const provider = "openai";

  // Check if target already has credentials
  const exists = await store.exists(targetUser, provider);
  if (exists) {
    console.log(`Credentials already exist for ${targetUser}/${provider}`);
    return;
  }

  // Check source
  const sourceExists = await store.exists(sourceUser, provider);
  if (!sourceExists) {
    console.error(`No credentials found for ${sourceUser}/${provider}`);
    process.exit(1);
  }

  // Retrieve from source and store for target
  const creds = await store.retrieve(sourceUser, provider);
  if (!creds) {
    console.error("Failed to retrieve credentials");
    process.exit(1);
  }

  await store.store(targetUser, provider, creds);
  console.log(`Seeded ${provider} credentials for ${targetUser}`);
}

void main();

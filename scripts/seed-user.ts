/**
 * Seed a user and issue CLI tokens for testing.
 *
 * Usage:
 *   SEED_USER_EMAIL=dev@example.com SEED_USER_NAME="Dev User" npx sst shell --stage dev -- npx tsx scripts/seed-user.ts
 *
 * Requires the SST tunnel to be running for DB access.
 */

import { upsertGoogleUser } from "../packages/web/lib/auth/store.js";
import { getAuthContext } from "../packages/web/lib/auth/store.js";
import { createApiTokenSession } from "../packages/web/lib/auth/api-token-store.js";

const EMAIL = process.env.SEED_USER_EMAIL?.trim() || "dev@example.com";
const NAME = process.env.SEED_USER_NAME?.trim() || "Dev User";
const API_URL = process.env.CLOUD_API_URL?.trim() || "https://agentrelay.com/cloud";

async function main() {
  console.log(`Seeding user: ${EMAIL}`);

  // Create or update user (reuses existing if already seeded)
  const userId = await upsertGoogleUser({
    providerUserId: `dev-${EMAIL}`,
    email: EMAIL,
    emailVerified: true,
    name: NAME,
    avatarUrl: null,
  });

  console.log(`User ID: ${userId}`);

  // Get auth context to find workspace/org IDs
  const context = await getAuthContext(userId);
  console.log(`Organization: ${context.currentOrganization.name} (${context.currentOrganization.id})`);
  console.log(`Workspace: ${context.currentWorkspace.name} (${context.currentWorkspace.id})`);

  // Issue long-lived CLI tokens
  const tokens = await createApiTokenSession({
    subjectType: "cli",
    userId,
    workspaceId: context.currentWorkspace.id,
    organizationId: context.currentOrganization.id,
    scopes: ["cli:auth"],
    accessTokenTtlSeconds: 60 * 60 * 24 * 30, // 30 days
    refreshTokenTtlSeconds: 60 * 60 * 24 * 365, // 1 year
  });

  console.log("\n--- CLI Credentials ---");
  console.log(`Access Token:  ${tokens.accessToken}`);
  console.log(`Refresh Token: ${tokens.refreshToken}`);
  console.log(`Expires At:    ${tokens.accessTokenExpiresAt}`);

  // Output the credentials JSON to paste into ~/.cloud/credentials.json
  const credentials = {
    version: 1,
    apiUrl: API_URL,
    updatedAt: new Date().toISOString(),
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
  };

  console.log("\n--- Save to ~/.cloud/credentials.json ---");
  console.log(JSON.stringify(credentials, null, 2));

  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});

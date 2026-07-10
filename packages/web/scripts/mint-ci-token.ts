/**
 * Mint a long-lived, least-privilege token for unattended CI deploys.
 *
 * The token carries only CI-specific deploy/list scopes (subjectType "ci"), so
 * a leak can deploy/list agents but cannot use broader `deployments:write`
 * routes such as destroy/manual-trigger/provider-credential writes. It is bound
 * to a single workspace at mint time and does NOT rotate — the CLI's env-var
 * auth path (WORKFORCE_WORKSPACE_TOKEN) presents the access token directly, so
 * the access-token TTL is its real lifetime (default 365 days).
 *
 * Usage (requires the SST tunnel for DB access):
 *   CI_TOKEN_USER_EMAIL=will@tailwindapp.com \
 *   CI_TOKEN_WORKSPACE_ID=50587328-441d-4acb-b8f3-dbe1b3c5de99 \
 *   node --env-file-if-exists=.env scripts/run-with-env.mjs \
 *     npx tsx packages/web/scripts/mint-ci-token.ts
 *
 * Optional:
 *   CI_TOKEN_TTL_DAYS=365   override the access-token lifetime
 *
 * Revoke later via revokeApiTokenSessionByAccessToken(token, reason) or by
 * revoking the api_token_sessions row.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../lib/db/index.js";
import { users } from "../lib/db/schema.js";
import { getAuthContext } from "../lib/auth/store.js";
import {
  createApiTokenSession,
  CI_DEPLOY_API_ACCESS_TOKEN_TTL_SECONDS,
  CI_DEPLOY_API_REFRESH_TOKEN_TTL_SECONDS,
} from "../lib/auth/api-token-store.js";
import { CI_DEPLOYMENT_SCOPES } from "../lib/auth/api-token-types.js";

const EMAIL = process.env.CI_TOKEN_USER_EMAIL?.trim();
const WORKSPACE_ID = process.env.CI_TOKEN_WORKSPACE_ID?.trim() || null;
const API_URL = process.env.CLOUD_API_URL?.trim() || "https://agentrelay.com/cloud";
const TTL_DAYS = process.env.CI_TOKEN_TTL_DAYS?.trim();
const accessTtlSeconds = TTL_DAYS
  ? Math.round(Number(TTL_DAYS) * 60 * 60 * 24)
  : CI_DEPLOY_API_ACCESS_TOKEN_TTL_SECONDS;

async function main() {
  if (!EMAIL) {
    throw new Error("CI_TOKEN_USER_EMAIL is required");
  }
  if (!Number.isFinite(accessTtlSeconds) || accessTtlSeconds <= 0) {
    throw new Error(`invalid CI_TOKEN_TTL_DAYS: ${TTL_DAYS}`);
  }

  const db = getDb();
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.primaryEmail, EMAIL))
    .limit(1);
  if (!user) {
    throw new Error(`no user found for email ${EMAIL}`);
  }

  // preferredWorkspaceId pins the token to the requested workspace (the
  // deployed agents land here). Throws if the user can't access it.
  const context = await getAuthContext(user.id, WORKSPACE_ID);
  const workspaceId = context.currentWorkspace.id;
  const organizationId = context.currentOrganization.id;

  if (WORKSPACE_ID && workspaceId !== WORKSPACE_ID) {
    throw new Error(
      `resolved workspace ${workspaceId} does not match requested CI_TOKEN_WORKSPACE_ID ${WORKSPACE_ID} ` +
        `(does ${EMAIL} have access to it?)`,
    );
  }

  const token = await createApiTokenSession({
    subjectType: "ci",
    userId: user.id,
    workspaceId,
    organizationId,
    scopes: [...CI_DEPLOYMENT_SCOPES],
    accessTokenTtlSeconds: accessTtlSeconds,
    refreshTokenTtlSeconds: CI_DEPLOY_API_REFRESH_TOKEN_TTL_SECONDS,
  });

  console.log(`\nMinted CI deploy token for ${EMAIL}`);
  console.log(`  workspace:    ${context.currentWorkspace.name} (${workspaceId})`);
  console.log(`  organization: ${context.currentOrganization.name} (${organizationId})`);
  console.log(`  scopes:       ${token.scopes.join(", ")}`);
  console.log(`  expires:      ${token.accessTokenExpiresAt}`);

  console.log("\n--- Set these in CI (GitHub Actions secrets/variables) ---");
  console.log(`WORKFORCE_WORKSPACE_ID=${workspaceId}`);
  console.log(`WORKFORCE_WORKSPACE_TOKEN=${token.accessToken}`);
  console.log(`CLOUD_API_URL=${API_URL}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Mint failed:", err);
  process.exit(1);
});

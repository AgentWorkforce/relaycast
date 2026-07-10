import { inArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { githubInstallations } from "@/lib/db/schema";
import { getNangoClient, getNangoConnectionDetails } from "@/lib/integrations/nango-service";
import { readIntegrationConnectionScopeFromRecord } from "@/lib/integrations/integration-scope";
import { getUserIntegration } from "@/lib/integrations/user-integrations";

/**
 * `github-oauth-relay` is a user-identity Nango integration: a plain GitHub
 * OAuth app (NOT the AgentWorkforce GitHub App) used only to learn which
 * GitHub orgs the signed-in cloud user belongs to, so launch flows can
 * reconcile those orgs against existing App installations and present the
 * guided-authorize path ("✓ org already has the App installed") instead of
 * a fresh-install ask.
 *
 * It is deliberately NOT a `WORKSPACE_INTEGRATION_PROVIDER_DEFINITIONS`
 * entry: it never syncs records, never mounts in relayfile, never appears in
 * digests (documented exception to the integration-digest rule), and must not
 * surface in the dashboard integrations catalog. Connections are always
 * user-scoped (`deployer_user`) rows in `user_integrations` under the
 * `github-oauth` provider id — never `workspace_integrations`, and never the
 * `github` provider id (which the deploy/token-mint path owns).
 *
 * Scope dependency: the Nango `github-oauth-relay` app must request
 * `read:org`; without it, concealed (private) org memberships are invisible
 * to GET /user/orgs and those orgs silently fail to reconcile.
 */
export const GITHUB_OAUTH_IDENTITY_PROVIDER = "github-oauth";
export const GITHUB_OAUTH_IDENTITY_CONFIG_KEY = "github-oauth-relay";

export function isGithubOauthIdentityConfigKey(value: string | null | undefined): boolean {
  return value?.trim().toLowerCase() === GITHUB_OAUTH_IDENTITY_CONFIG_KEY;
}

export type GithubIdentityOrgs = {
  userLogin: string;
  /** Lowercased: [userLogin, ...orgLogins], deduped. */
  candidateLogins: string[];
  orgCount: number;
};

type ProxyResponse<T> = { data: T };

type GithubUserPayload = { login?: unknown };
type GithubOrgPayload = { login?: unknown };

const MAX_ORG_PAGES = 3; // 3 × 100 — far above any realistic membership count.

/**
 * List the authenticated user's GitHub login + org logins through the user's
 * `github-oauth-relay` Nango connection. Server-side only; the user token
 * never leaves this process, and callers must never persist the result —
 * org membership is user-private data and reconcile is a read-only lookup.
 */
export async function fetchGithubIdentityOrgs(connectionId: string): Promise<GithubIdentityOrgs> {
  const client = getNangoClient();

  const userResponse = (await client.proxy({
    method: "GET",
    endpoint: "/user",
    connectionId,
    providerConfigKey: GITHUB_OAUTH_IDENTITY_CONFIG_KEY,
  })) as ProxyResponse<GithubUserPayload>;

  const userLogin =
    typeof userResponse.data?.login === "string" ? userResponse.data.login.trim() : "";
  if (!userLogin) {
    throw new Error("GitHub /user response did not include a login.");
  }

  const orgLogins: string[] = [];
  for (let page = 1; page <= MAX_ORG_PAGES; page += 1) {
    const orgsResponse = (await client.proxy({
      method: "GET",
      endpoint: `/user/orgs?per_page=100&page=${page}`,
      connectionId,
      providerConfigKey: GITHUB_OAUTH_IDENTITY_CONFIG_KEY,
    })) as ProxyResponse<GithubOrgPayload[]>;

    const batch = Array.isArray(orgsResponse.data) ? orgsResponse.data : [];
    for (const org of batch) {
      if (typeof org?.login === "string" && org.login.trim()) {
        orgLogins.push(org.login.trim());
      }
    }
    if (batch.length < 100) {
      break;
    }
  }

  const candidateLogins = [
    ...new Set([userLogin.toLowerCase(), ...orgLogins.map((login) => login.toLowerCase())]),
  ];

  return { userLogin, candidateLogins, orgCount: orgLogins.length };
}

export type GithubInstallationMatch = {
  installationId: string;
  accountLogin: string;
  accountType: string;
  suspended: boolean;
};

/**
 * Match candidate logins (already lowercased) against the #1538
 * `github_installations` index. Case-insensitive on account_login.
 *
 * Detection-only: under the guided-authorize design (see PR1 / the 0010
 * connection-uniqueness constraint), a match is acted on by routing the user
 * through the standard github-relay connect — GitHub fast-paths orgs that
 * already have the App installed to a lightweight member authorize, and the
 * workspace gets its OWN Nango connection. No connection fields leak out of
 * the index here.
 */
export async function findGithubInstallationsByAccountLogins(
  candidateLogins: string[],
): Promise<GithubInstallationMatch[]> {
  if (candidateLogins.length === 0) {
    return [];
  }

  const db = getDb();
  const rows = await db
    .select({
      installationId: githubInstallations.installationId,
      accountLogin: githubInstallations.accountLogin,
      accountType: githubInstallations.accountType,
      suspended: githubInstallations.suspended,
    })
    .from(githubInstallations)
    .where(inArray(sql`lower(${githubInstallations.accountLogin})`, candidateLogins));

  return rows
    .filter((row) => row.accountLogin)
    .map((row) => ({
      installationId: row.installationId,
      accountLogin: row.accountLogin as string,
      accountType: row.accountType ?? "unknown",
      suspended: row.suspended ?? false,
    }));
}

/**
 * Resolve the caller's github-oauth identity connection. `oauthConnectionId`
 * (when supplied) must belong to the caller — arbitrary connection ids are
 * rejected so one user can never reconcile with another user's identity.
 *
 * When `oauthConnectionId` is provided (fresh-connect path), ownership is
 * verified directly against the Nango API by checking `relayfile_integration_user_id`
 * in the connection tags. This avoids a race where the reconcile fires before
 * the connection.created webhook has written the user_integrations row.
 *
 * When no `oauthConnectionId` is provided (e.g. membership join with an
 * already-established connection), falls back to the user_integrations DB record.
 */
export async function resolveGithubIdentityConnection(
  userId: string,
  oauthConnectionId?: string | null,
): Promise<{ connectionId: string } | null> {
  const trimmedId = oauthConnectionId?.trim() || null;

  if (trimmedId) {
    // Fast path: if the webhook has already written the row, use it directly.
    const record = await getUserIntegration(userId, GITHUB_OAUTH_IDENTITY_PROVIDER);
    if (record?.connectionId === trimmedId) {
      return { connectionId: trimmedId };
    }

    // Slow path: webhook hasn't arrived yet (fresh-connect race). Verify
    // ownership directly via Nango API — userId is embedded in the connection
    // tags as relayfile_integration_user_id at session creation time.
    const details = await getNangoConnectionDetails(trimmedId, GITHUB_OAUTH_IDENTITY_CONFIG_KEY);
    if (!details) return null;
    const scope = readIntegrationConnectionScopeFromRecord(details.payload);
    if (!scope || scope.userId !== userId) return null;
    return { connectionId: trimmedId };
  }

  // No connectionId provided — use the user_integrations DB record directly
  // (membership join paths always have the webhook-written row by this point).
  const record = await getUserIntegration(userId, GITHUB_OAUTH_IDENTITY_PROVIDER);
  if (!record?.connectionId) return null;
  return { connectionId: record.connectionId };
}

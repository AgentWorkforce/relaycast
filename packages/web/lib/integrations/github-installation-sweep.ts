import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { workspaceIntegrations } from "@/lib/db/schema";
import { upsertGithubInstallationIndex } from "@/lib/integrations/github-installation-index";
import { getNangoClient, getNangoConnectionDetails } from "@/lib/integrations/nango-service";
import { logger } from "@/lib/logger";

/**
 * Sweep github-relay Nango connections into the #1538 installation index.
 *
 * Why this exists: org-reconcile DETECTION (github/reconcile) matches the
 * user's org logins against `github_installations.account_login` — an
 * installation that isn't indexed can't be surfaced as "already installed".
 * The webhook path populates the index going forward (since 2026-06-03);
 * this sweep backfills installs that predate it. Every install that went
 * through our connect flow has a github-relay Nango connection, so sweeping
 * Nango's connection list gives authoritative coverage WITHOUT GitHub's
 * /app/installations (cloud holds no App private key — Nango does). No
 * second installations model: every write goes through the canonical
 * `upsertGithubInstallationIndex`.
 *
 * Connections that resolve to no workspace_integrations row anywhere
 * ("orphans" — e.g. their workspace was deleted) are counted and skipped:
 * the canonical upsert requires a workspaceId for the links table, and an
 * orphan's org is still reachable through the standard connect flow.
 */

const GITHUB_SWEEP_CONFIG_KEYS = [
  "github-relay",
  // Legacy aliases still resolvable in Nango (see providers.ts github entry).
  "github-sage",
  "github-app-oauth",
  "github-app",
];

type NangoConnectionListEntry = {
  connection_id?: string;
  provider_config_key?: string;
};

type SweepResult = {
  scanned: number;
  indexed: number;
  skippedNoInstallation: number;
  skippedOrphan: number;
  failed: number;
};

type ProxyResponse<T> = { data: T };

type InstallationRepoPayload = {
  repositories?: Array<{ owner?: { login?: unknown; type?: unknown } }>;
};

async function findWorkspaceIdsByConnectionId(connectionId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ workspaceId: workspaceIntegrations.workspaceId })
    .from(workspaceIntegrations)
    .where(sql`${workspaceIntegrations.connectionId} = ${connectionId}`);
  return [...new Set(rows.map((row) => row.workspaceId))];
}

async function readAccountFromInstallationRepos(
  connectionId: string,
  providerConfigKey: string,
): Promise<{ login: string; type: string } | null> {
  try {
    const response = (await getNangoClient().proxy({
      method: "GET",
      endpoint: "/installation/repositories?per_page=1",
      connectionId,
      providerConfigKey,
    })) as ProxyResponse<InstallationRepoPayload>;
    const owner = response.data?.repositories?.[0]?.owner;
    if (owner && typeof owner.login === "string" && owner.login.trim()) {
      return {
        login: owner.login.trim(),
        type: typeof owner.type === "string" ? owner.type : "unknown",
      };
    }
  } catch {
    // Pending-approval installs 403 here; the sweep still indexes the
    // installation id so reconcile can at least surface it.
  }
  return null;
}

export async function sweepGithubInstallationsFromNango(options: {
  configKeys?: string[];
  dryRun?: boolean;
} = {}): Promise<SweepResult> {
  const configKeys = options.configKeys ?? GITHUB_SWEEP_CONFIG_KEYS;
  const result: SweepResult = {
    scanned: 0,
    indexed: 0,
    skippedNoInstallation: 0,
    skippedOrphan: 0,
    failed: 0,
  };

  const client = getNangoClient();
  const listResponse = (await client.listConnections()) as {
    connections?: NangoConnectionListEntry[];
  };
  const connections = (listResponse.connections ?? []).filter(
    (connection) =>
      connection.connection_id &&
      connection.provider_config_key &&
      configKeys.includes(connection.provider_config_key),
  );

  for (const connection of connections) {
    const connectionId = connection.connection_id as string;
    const providerConfigKey = connection.provider_config_key as string;
    result.scanned += 1;

    try {
      const details = await getNangoConnectionDetails(connectionId, providerConfigKey);
      const installationId = details?.installationId ?? null;
      if (!installationId) {
        result.skippedNoInstallation += 1;
        continue;
      }

      const workspaceIds = await findWorkspaceIdsByConnectionId(connectionId);
      if (workspaceIds.length === 0) {
        result.skippedOrphan += 1;
        await logger.info("github installation sweep skipped orphan connection", {
          area: "github-installation-sweep",
          connectionId,
          providerConfigKey,
          installationId,
        });
        continue;
      }

      // Pending-approval installs 403 the repo probe and index WITHOUT an
      // account_login — they count as `indexed` here but cannot match in
      // reconcile until a webhook fills the login in. Don't read `indexed`
      // as "reconcilable".
      const account = await readAccountFromInstallationRepos(connectionId, providerConfigKey);

      if (!options.dryRun) {
        for (const workspaceId of workspaceIds) {
          await upsertGithubInstallationIndex({
            workspaceId,
            installationId,
            connectionId,
            providerConfigKey,
            payload: {
              installation: {
                id: installationId,
                ...(account
                  ? { account: { login: account.login, type: account.type } }
                  : {}),
              },
            },
            metadata: { sweptVia: "nango-connection-sweep" },
          });
        }
      }
      result.indexed += 1;
    } catch (error) {
      result.failed += 1;
      await logger.warn("github installation sweep failed for connection", {
        area: "github-installation-sweep",
        connectionId,
        providerConfigKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

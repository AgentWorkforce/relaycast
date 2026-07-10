import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type {
  GithubCloneJobRow,
  GithubCloneJobStatus,
  GithubCloneMaterialization,
  GithubCloneMode,
} from "../../packages/core/src/clone/github-clone-job";
import { githubCloneJobs } from "../../packages/core/src/db/schema";

export const WORKSPACE_INTEGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS workspace_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  adapter TEXT NOT NULL DEFAULT 'nango',
  name TEXT,
  display_name TEXT,
  created_by_user_id UUID,
  connection_id TEXT NOT NULL,
  provider_config_key TEXT,
  installation_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_integrations_workspace_provider_default_unique
  ON workspace_integrations (workspace_id, provider)
  WHERE name IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS workspace_integrations_workspace_provider_name_unique
  ON workspace_integrations (workspace_id, provider, name)
  WHERE name IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS workspace_integrations_provider_connection_unique
  ON workspace_integrations (provider, connection_id);
`;

export const GITHUB_CLONE_JOBS_DDL = `
CREATE TABLE IF NOT EXISTS github_clone_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  ref TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  -- mode mirrors the production drizzle schema; tests exercise both
  -- 'full' (default) and 'incremental' rows via insertJob overrides.
  mode VARCHAR(16) NOT NULL DEFAULT 'full',
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  files_written INTEGER,
  head_sha TEXT,
  base_sha VARCHAR(40),
  duration_ms INTEGER,
  materialization_json JSONB,
  last_error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS github_clone_jobs_dedupe_idx
  ON github_clone_jobs (workspace_id, owner, repo, ref, status, created_at)
  WHERE status IN ('queued', 'running');
`;

export const GITHUB_CLONE_DB_DDL = `
${WORKSPACE_INTEGRATIONS_DDL}
${GITHUB_CLONE_JOBS_DDL}
`;

type SqlExecutor = {
  exec(sql: string): Promise<unknown> | unknown;
};

type TestDb = ReturnType<typeof drizzle>;

// Drizzle infers `status` as a plain `string` on text columns, but the
// runtime values are constrained by the schema's check constraint to the
// GithubCloneJobStatus union. Narrow explicitly so TypeScript can accept
// the result as a GithubCloneJobRow.
function toGithubCloneJobRow(
  row: { status: string; mode: string; materializationJson: unknown } & Omit<
    GithubCloneJobRow,
    "status" | "mode" | "materializationJson"
  >,
): GithubCloneJobRow {
  return {
    ...row,
    status: row.status as GithubCloneJobStatus,
    mode: (row.mode === "incremental" ? "incremental" : "full") as GithubCloneMode,
    materializationJson: row.materializationJson as GithubCloneMaterialization | null,
  };
}

export interface GithubCloneTestDb {
  client: PGlite;
  db: TestDb;
  close(): Promise<void>;
  cleanup(): Promise<void>;
  reset(): Promise<void>;
  getJob(jobId: string): Promise<GithubCloneJobRow | null>;
  insertJob(
    overrides?: Partial<GithubCloneJobRow>,
  ): Promise<GithubCloneJobRow>;
}

export async function createGithubCloneDbSchema(db: SqlExecutor): Promise<void> {
  await db.exec(GITHUB_CLONE_DB_DDL);
}

export async function createGithubCloneTestDb(): Promise<GithubCloneTestDb> {
  const client = new PGlite();
  await createGithubCloneDbSchema(client);
  const db = drizzle(client);

  return {
    client,
    db,
    async close() {
      await client.close();
    },
    async cleanup() {
      await client.close();
    },
    async reset() {
      await client.exec("DELETE FROM github_clone_jobs;");
      await client.exec("DELETE FROM workspace_integrations;");
    },
    async getJob(jobId) {
      const [job] = await db
        .select()
        .from(githubCloneJobs)
        .where(eq(githubCloneJobs.id, jobId))
        .limit(1);

      return job ? toGithubCloneJobRow(job) : null;
    },
    async insertJob(overrides = {}) {
      const now = new Date("2026-01-01T00:00:00.000Z");
      const [job] = await db
        .insert(githubCloneJobs)
        .values({
          workspaceId: "ws-1",
          owner: "octo",
          repo: "hello-world",
          ref: "main",
          connectionId: "conn-1",
          status: "queued",
          attempts: 0,
          filesWritten: null,
          headSha: null,
          durationMs: null,
          materializationJson: null,
          lastError: null,
          startedAt: null,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
          ...overrides,
        })
        .returning();

      if (!job) {
        throw new Error("Failed to insert github clone test job");
      }

      return toGithubCloneJobRow(job);
    },
  };
}

export async function getGithubCloneJobByDedupeKey(
  db: TestDb,
  key: Pick<GithubCloneJobRow, "workspaceId" | "owner" | "repo" | "ref">,
): Promise<GithubCloneJobRow[]> {
  return (await db
    .select()
    .from(githubCloneJobs)
    .where(
      and(
        eq(githubCloneJobs.workspaceId, key.workspaceId),
        eq(githubCloneJobs.owner, key.owner),
        eq(githubCloneJobs.repo, key.repo),
        eq(githubCloneJobs.ref, key.ref),
      ),
    )).map(toGithubCloneJobRow);
}

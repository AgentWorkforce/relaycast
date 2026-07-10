import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createApiTokenSession,
  OPERATOR_API_ACCESS_TOKEN_TTL_SECONDS,
  OPERATOR_API_REFRESH_TOKEN_TTL_SECONDS,
  resolveApiTokenSession,
  refreshApiTokenSession,
  revokeApiTokenSessionByRefreshToken,
} from "./api-token-store";

const mocks = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
}));

vi.mock("../db", () => ({
  getDb: () => {
    if (!mocks.db) {
      throw new Error("test db is not configured");
    }
    return mocks.db;
  },
}));

vi.mock("../db/schema", async () => {
  const { index, pgTable, text, timestamp, uniqueIndex, uuid } =
    await import("drizzle-orm/pg-core");
  const timestampColumn = (name: string) =>
    timestamp(name, { withTimezone: true });
  const uuidColumn = (name: string) => uuid(name);
  const apiTokenSessions = pgTable(
    "api_token_sessions",
    {
      id: uuidColumn("id").primaryKey(),
      tokenFamilyId: uuidColumn("token_family_id").notNull(),
      subjectType: text("subject_type").notNull(),
      userId: uuidColumn("user_id").notNull(),
      workspaceId: uuidColumn("workspace_id").notNull(),
      organizationId: uuidColumn("organization_id").notNull(),
      sandboxId: text("sandbox_id"),
      runId: uuidColumn("run_id"),
      scopes: text("scopes").notNull(),
      accessTokenHash: text("access_token_hash").notNull(),
      accessTokenExpiresAt: timestampColumn(
        "access_token_expires_at",
      ).notNull(),
      refreshTokenHash: text("refresh_token_hash").notNull(),
      refreshTokenExpiresAt: timestampColumn(
        "refresh_token_expires_at",
      ).notNull(),
      createdAt: timestampColumn("created_at").notNull(),
      updatedAt: timestampColumn("updated_at").notNull(),
      lastUsedAt: timestampColumn("last_used_at"),
      lastRefreshedAt: timestampColumn("last_refreshed_at"),
      revokedAt: timestampColumn("revoked_at"),
      revokedReason: text("revoked_reason"),
    },
    (table) => ({
      accessTokenHashUnique: uniqueIndex(
        "api_token_sessions_access_hash_unique",
      ).on(table.accessTokenHash),
      refreshTokenHashUnique: uniqueIndex(
        "api_token_sessions_refresh_hash_unique",
      ).on(table.refreshTokenHash),
      tokenFamilyIndex: index("idx_api_token_sessions_family").on(
        table.tokenFamilyId,
      ),
      userIndex: index("idx_api_token_sessions_user").on(table.userId),
      runIndex: index("idx_api_token_sessions_run").on(table.runId),
      sandboxIndex: index("idx_api_token_sessions_sandbox").on(table.sandboxId),
    }),
  );

  return { apiTokenSessions };
});

const API_TOKEN_SESSIONS_DDL = `
CREATE TABLE "api_token_sessions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "token_family_id" uuid NOT NULL,
  "subject_type" text NOT NULL,
  "user_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "sandbox_id" text,
  "run_id" uuid,
  "scopes" text NOT NULL,
  "access_token_hash" text NOT NULL,
  "access_token_expires_at" timestamp with time zone NOT NULL,
  "refresh_token_hash" text NOT NULL,
  "refresh_token_expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "last_used_at" timestamp with time zone,
  "last_refreshed_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_reason" text
);

CREATE UNIQUE INDEX "api_token_sessions_access_hash_unique"
  ON "api_token_sessions" ("access_token_hash");
CREATE UNIQUE INDEX "api_token_sessions_refresh_hash_unique"
  ON "api_token_sessions" ("refresh_token_hash");
CREATE INDEX "idx_api_token_sessions_family" ON "api_token_sessions" ("token_family_id");
CREATE INDEX "idx_api_token_sessions_user" ON "api_token_sessions" ("user_id");
CREATE INDEX "idx_api_token_sessions_run" ON "api_token_sessions" ("run_id");
CREATE INDEX "idx_api_token_sessions_sandbox" ON "api_token_sessions" ("sandbox_id");
`;

type TokenSessionSnapshot = {
  id: string;
  access_token_hash: string;
  access_token_expires_at: Date;
  refresh_token_hash: string;
  refresh_token_expires_at: Date;
  last_refreshed_at: Date | null;
  revoked_at: Date | null;
  revoked_reason: string | null;
};

let pg: PGlite;

describe("api token store", () => {
  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(API_TOKEN_SESSIONS_DDL);
    mocks.db = drizzle(pg) as never;
  });

  afterEach(async () => {
    mocks.db = null;
    await pg.close();
  });

  it("does not rotate or persist tokens after the refresh token session is revoked", async () => {
    const issued = await createApiTokenSession({
      subjectType: "cli",
      userId: "00000000-0000-4000-8000-000000000001",
      workspaceId: "00000000-0000-4000-8000-000000000002",
      organizationId: "00000000-0000-4000-8000-000000000003",
      scopes: ["cli:auth"],
    });

    const beforeRevoke = await readOnlySession();
    await expect(
      revokeApiTokenSessionByRefreshToken(issued.refreshToken, "manual_revoke"),
    ).resolves.toBe(true);

    const revoked = await readOnlySession();
    expect(revoked).toMatchObject({
      id: issued.sessionId,
      access_token_hash: beforeRevoke.access_token_hash,
      refresh_token_hash: beforeRevoke.refresh_token_hash,
      last_refreshed_at: null,
      revoked_reason: "manual_revoke",
    });
    expect(revoked.revoked_at).toBeInstanceOf(Date);

    await expect(
      refreshApiTokenSession(issued.refreshToken),
    ).resolves.toBeNull();

    const afterRefreshAttempt = await readOnlySession();
    expect(afterRefreshAttempt).toEqual(revoked);
    await expect(countSessions()).resolves.toBe(1);
  });

  it("preserves workspace binding and scopes across refresh rotation", async () => {
    const workspaceId = "00000000-0000-4000-8000-000000000002";
    const issued = await createApiTokenSession({
      subjectType: "cli",
      userId: "00000000-0000-4000-8000-000000000001",
      workspaceId,
      organizationId: "00000000-0000-4000-8000-000000000003",
      scopes: ["cli:auth", "auth:workspace:follow-user"],
    });

    const refreshed = await refreshApiTokenSession(issued.refreshToken);

    expect(refreshed).toMatchObject({
      sessionId: issued.sessionId,
      tokenFamilyId: issued.tokenFamilyId,
      subjectType: "cli",
      scopes: ["auth:workspace:follow-user", "cli:auth"],
    });
    expect(refreshed?.accessToken).not.toBe(issued.accessToken);
    expect(refreshed?.refreshToken).not.toBe(issued.refreshToken);

    const resolved = await resolveApiTokenSession(refreshed!.accessToken);
    expect(resolved).toMatchObject({
      id: issued.sessionId,
      workspaceId,
      subjectType: "cli",
      scopes: ["auth:workspace:follow-user", "cli:auth"],
    });
  });

  it("preserves long-lived operator session TTLs across refresh rotation", async () => {
    const issued = await createApiTokenSession({
      subjectType: "cli",
      userId: "00000000-0000-4000-8000-000000000001",
      workspaceId: "00000000-0000-4000-8000-000000000002",
      organizationId: "00000000-0000-4000-8000-000000000003",
      scopes: ["cli:auth", "auth:workspace:follow-user"],
      accessTokenTtlSeconds: OPERATOR_API_ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlSeconds: OPERATOR_API_REFRESH_TOKEN_TTL_SECONDS,
    });

    const beforeRefresh = Date.now();
    const refreshed = await refreshApiTokenSession(issued.refreshToken);
    const afterRefresh = Date.now();

    expect(refreshed).toMatchObject({
      sessionId: issued.sessionId,
      subjectType: "cli",
      scopes: ["auth:workspace:follow-user", "cli:auth"],
    });
    expect(refreshed?.accessTokenExpiresAt).toBeTruthy();
    expect(refreshed?.refreshTokenExpiresAt).toBeTruthy();
    expectTtlNear(
      refreshed!.accessTokenExpiresAt,
      beforeRefresh,
      afterRefresh,
      OPERATOR_API_ACCESS_TOKEN_TTL_SECONDS,
    );
    expectTtlNear(
      refreshed!.refreshTokenExpiresAt,
      beforeRefresh,
      afterRefresh,
      OPERATOR_API_REFRESH_TOKEN_TTL_SECONDS,
    );

    const stored = await readOnlySession();
    expect(stored.last_refreshed_at).toBeInstanceOf(Date);
    expectTtlNear(
      stored.access_token_expires_at.toISOString(),
      beforeRefresh,
      afterRefresh,
      OPERATOR_API_ACCESS_TOKEN_TTL_SECONDS,
    );
    expectTtlNear(
      stored.refresh_token_expires_at.toISOString(),
      beforeRefresh,
      afterRefresh,
      OPERATOR_API_REFRESH_TOKEN_TTL_SECONDS,
    );
  });
});

function expectTtlNear(
  isoTimestamp: string,
  beforeMs: number,
  afterMs: number,
  ttlSeconds: number,
): void {
  const expiresAt = Date.parse(isoTimestamp);
  expect(expiresAt).toBeGreaterThanOrEqual(beforeMs + ttlSeconds * 1000);
  expect(expiresAt).toBeLessThanOrEqual(afterMs + ttlSeconds * 1000);
}

async function readOnlySession(): Promise<TokenSessionSnapshot> {
  const result = await pg.query<TokenSessionSnapshot>(`
    SELECT
      id,
      access_token_hash,
      access_token_expires_at,
      refresh_token_hash,
      refresh_token_expires_at,
      last_refreshed_at,
      revoked_at,
      revoked_reason
    FROM api_token_sessions
  `);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

async function countSessions(): Promise<number> {
  const result = await pg.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM api_token_sessions",
  );
  return Number(result.rows[0]?.count ?? 0);
}

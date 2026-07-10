import { eq } from "drizzle-orm";
import type {
  SessionData,
  SessionStore,
} from "@cloud/core/auth/sandbox-auth.js";
import { resolveDaytonaAuthCredentials } from "@cloud/core/auth/credentials.js";
import { getDb, type AppDb } from "@/lib/db";
import { cloudCliBootstrapSessions } from "@/lib/db/schema";
import { resolveServerDaytonaAuthParams } from "@/lib/daytona-auth";

function resolveStoredDaytonaAuth(row: typeof cloudCliBootstrapSessions.$inferSelect) {
  if (row.daytonaApiKey) {
    return resolveDaytonaAuthCredentials({
      apiKey: row.daytonaApiKey,
    });
  }

  const fallbackAuth = resolveServerDaytonaAuthParams();

  return resolveDaytonaAuthCredentials({
    jwtToken: row.daytonaJwtToken ?? fallbackAuth.daytonaJwtToken,
    organizationId: row.daytonaOrganizationId ?? fallbackAuth.daytonaOrganizationId,
  });
}

function mapSession(row: typeof cloudCliBootstrapSessions.$inferSelect): SessionData {
  return {
    sessionId: row.id,
    sandboxId: row.sandboxId,
    sshToken: row.sshToken,
    provider: row.provider,
    language: row.language,
    home: row.home,
    userId: row.userId,
    daytonaAuth: resolveStoredDaytonaAuth(row),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export async function createSession(
  session: SessionData,
  db: AppDb = getDb(),
): Promise<void> {
  const daytonaAuthColumns =
    "apiKey" in session.daytonaAuth
      ? {
          daytonaApiKey: session.daytonaAuth.apiKey,
          daytonaJwtToken: null,
          daytonaOrganizationId: null,
        }
      : {
          daytonaApiKey: null,
          daytonaJwtToken: session.daytonaAuth.jwtToken,
          daytonaOrganizationId: session.daytonaAuth.organizationId,
        };

  await db.insert(cloudCliBootstrapSessions).values({
    id: session.sessionId,
    sandboxId: session.sandboxId,
    provider: session.provider,
    language: session.language,
    home: session.home,
    userId: session.userId,
    sshToken: session.sshToken,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    ...daytonaAuthColumns,
  });
}

export async function getSession(
  sessionId: string,
  db: AppDb = getDb(),
): Promise<SessionData | null> {
  const [row] = await db
    .select()
    .from(cloudCliBootstrapSessions)
    .where(eq(cloudCliBootstrapSessions.id, sessionId))
    .limit(1);

  if (!row) {
    return null;
  }

  // Don't delete expired sessions here — return them so callers (e.g. completeAuthSession)
  // can clean up associated resources (Daytona sandboxes, SSH access) before deletion.
  // The caller is responsible for checking expiry and calling deleteSession.

  return mapSession(row);
}

export async function deleteSession(
  sessionId: string,
  db: AppDb = getDb(),
): Promise<void> {
  await db.delete(cloudCliBootstrapSessions).where(eq(cloudCliBootstrapSessions.id, sessionId));
}

export function createCliAuthSessionStore(db: AppDb = getDb()): SessionStore {
  return {
    create(session) {
      return createSession(session, db);
    },
    get(sessionId) {
      return getSession(sessionId, db);
    },
    delete(sessionId) {
      return deleteSession(sessionId, db);
    },
  };
}

export const cliAuthSessionStore: SessionStore = {
  create(session) {
    return createSession(session);
  },
  get(sessionId) {
    return getSession(sessionId);
  },
  delete(sessionId) {
    return deleteSession(sessionId);
  },
};

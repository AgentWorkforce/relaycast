import { and, eq, gt, lt } from "drizzle-orm";
import type {
  RelayFileRevocationRecord,
  RelayFileRevocationStore,
} from "../relay-file-access.js";
import { getDb } from "./client.js";
import { relayFileAccessRevocations } from "./schema.js";

type RevocationDb = Pick<ReturnType<typeof getDb>, "insert" | "select" | "delete">;

/**
 * Postgres-backed (drizzle) implementation of RelayFileRevocationStore. This
 * is the production store: rows live in `relay_file_access_revocations`
 * (migration 0088), are shared by every replica, and survive process/Lambda
 * restarts. Rows self-expire at the token's natural JWT expiry — reads filter
 * on `expires_at` and `prune()` deletes past-expiry rows.
 */
export class DrizzleRelayFileRevocationStore implements RelayFileRevocationStore {
  private readonly resolveDb: () => RevocationDb;

  constructor(db?: RevocationDb | (() => RevocationDb)) {
    if (typeof db === "function") {
      this.resolveDb = db;
    } else if (db) {
      this.resolveDb = () => db;
    } else {
      this.resolveDb = () => getDb();
    }
  }

  async revoke(record: RelayFileRevocationRecord): Promise<void> {
    await this.resolveDb()
      .insert(relayFileAccessRevocations)
      .values({
        tokenHash: record.tokenHash,
        scope: record.scope,
        workspace: record.workspace,
        agentName: record.agentName,
        revokedAt: record.revokedAt,
        expiresAt: record.expiresAt,
      })
      .onConflictDoNothing({ target: relayFileAccessRevocations.tokenHash });
  }

  async isRevoked(tokenHash: string, now: Date = new Date()): Promise<boolean> {
    const rows = await this.resolveDb()
      .select({ tokenHash: relayFileAccessRevocations.tokenHash })
      .from(relayFileAccessRevocations)
      .where(
        and(
          eq(relayFileAccessRevocations.tokenHash, tokenHash),
          gt(relayFileAccessRevocations.expiresAt, now),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async prune(now: Date = new Date()): Promise<number> {
    const deleted = await this.resolveDb()
      .delete(relayFileAccessRevocations)
      .where(lt(relayFileAccessRevocations.expiresAt, now))
      .returning({ tokenHash: relayFileAccessRevocations.tokenHash });
    return deleted.length;
  }
}

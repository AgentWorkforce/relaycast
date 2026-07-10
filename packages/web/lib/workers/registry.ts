import crypto from "node:crypto";
import {
  WorkerRegistry as CoreWorkerRegistry,
  type RegisterWorkerRecord,
  type WorkerRecord as CoreWorkerRecord,
  type WorkerRegistryDb,
  type WorkerSelection as CoreWorkerSelection,
} from "@cloud/core/workers/index.js";
import { and, desc, eq, lte, ne } from "drizzle-orm";
import { getDb } from "@/lib/db/index";
import { workers } from "@/lib/db/schema";
import { hashWorkerTokenBytes, mintWorkerToken, validateWorkerToken } from "./tokens";
import type { WorkerHostInfo, WorkerRecord, WorkerSelection } from "./types";

type RegistryDbClient = Pick<ReturnType<typeof getDb>, "insert" | "select" | "update">;
type WorkerRow = typeof workers.$inferSelect;

function toHostInfo(value: unknown): WorkerHostInfo {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkerHostInfo)
    : {};
}

function toTags(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((tag): tag is string => typeof tag === "string")
            .map((tag) => tag.trim())
            .filter(Boolean),
        ),
      ]
    : [];
}

function decodeTokenHash(hash: string): Uint8Array {
  return /^[0-9a-f]{64}$/i.test(hash) ? Buffer.from(hash, "hex") : Buffer.alloc(0);
}

function mapWorkerRowToCore(row: WorkerRow): CoreWorkerRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    displayName: row.displayName,
    status: row.status as CoreWorkerRecord["status"],
    lastSeen: row.lastSeen ?? null,
    hostInfo: toHostInfo(row.hostInfo),
    tags: toTags(row.tags),
  };
}

function mapWorkerRow(row: WorkerRow): WorkerRecord {
  return {
    ...mapWorkerRowToCore(row),
    lastSeen: row.lastSeen ? row.lastSeen.toISOString() : null,
    registeredAt: row.registeredAt.toISOString(),
    registeredBy: row.registeredBy,
  };
}

async function findWorkerRowById(
  db: RegistryDbClient,
  workerId: string,
): Promise<WorkerRow | null> {
  const [row] = await db.select().from(workers).where(eq(workers.id, workerId)).limit(1);
  return row ?? null;
}

async function findWorkerRowByName(
  db: RegistryDbClient,
  workspaceId: string,
  name: string,
): Promise<WorkerRow | null> {
  const [row] = await db
    .select()
    .from(workers)
    .where(and(eq(workers.workspaceId, workspaceId), eq(workers.name, name)))
    .limit(1);

  return row ?? null;
}

function createCoreRegistry(): CoreWorkerRegistry {
  return new CoreWorkerRegistry({
    generateToken: mintWorkerToken,
    hashToken: hashWorkerTokenBytes,
  });
}

export function createWorkerRegistryDb(
  db: RegistryDbClient,
  options?: {
    registeredBy?: string;
  },
): WorkerRegistryDb {
  return {
    async registerWorker(input: RegisterWorkerRecord): Promise<CoreWorkerRecord> {
      if (!options?.registeredBy) {
        throw new Error("registeredBy is required for worker registration");
      }

      const [row] = await db
        .insert(workers)
        .values({
          ...(input.id ? { id: input.id } : {}),
          workspaceId: input.workspaceId,
          name: input.name.trim(),
          displayName: input.displayName.trim(),
          hostInfo: toHostInfo(input.hostInfo),
          tokenHash: Buffer.from(input.tokenHash).toString("hex"),
          status: input.status ?? "pending",
          lastSeen: input.lastSeen ?? null,
          registeredBy: options.registeredBy,
          tags: toTags(input.tags),
        })
        .returning();

      return mapWorkerRowToCore(row);
    },

    async findWorkerByName(workspaceId: string, name: string): Promise<CoreWorkerRecord | null> {
      const row = await findWorkerRowByName(db, workspaceId, name.trim());
      return row ? mapWorkerRowToCore(row) : null;
    },

    async findWorkerById(workerId: string): Promise<CoreWorkerRecord | null> {
      const row = await findWorkerRowById(db, workerId);
      return row ? mapWorkerRowToCore(row) : null;
    },

    async listWorkersByWorkspace(workspaceId: string): Promise<CoreWorkerRecord[]> {
      const rows = await db
        .select()
        .from(workers)
        .where(eq(workers.workspaceId, workspaceId))
        .orderBy(desc(workers.lastSeen), desc(workers.registeredAt));

      return rows.map(mapWorkerRowToCore);
    },

    async updateWorkerStatus(input): Promise<void> {
      const patch: Partial<typeof workers.$inferInsert> = {
        status: input.status,
      };

      if (input.lastSeen !== undefined) {
        patch.lastSeen = input.lastSeen;
      }

      const rows = await db
        .update(workers)
        .set(patch)
        .where(and(eq(workers.id, input.workerId), ne(workers.status, "revoked")))
        .returning({ id: workers.id });

      if (rows.length === 0) {
        throw new Error(`Worker ${input.workerId} not found`);
      }
    },

    async revokeWorker(workerId: string): Promise<void> {
      const rotatedTokenHash = crypto
        .createHash("sha256")
        .update(`revoked:${workerId}:${crypto.randomUUID()}`)
        .digest("hex");

      const rows = await db
        .update(workers)
        .set({
          status: "revoked",
          tokenHash: rotatedTokenHash,
        })
        .where(eq(workers.id, workerId))
        .returning({ id: workers.id });

      if (rows.length === 0) {
        throw new Error(`Worker ${workerId} not found`);
      }
    },

    async getWorkerToken(workerId: string) {
      const row = await findWorkerRowById(db, workerId);
      if (!row) {
        return null;
      }

      return {
        workerId: row.id,
        tokenHash: decodeTokenHash(row.tokenHash),
        worker: mapWorkerRowToCore(row),
      };
    },
  };
}

export class WorkerRegistry {
  private readonly db = getDb();
  private readonly core = createCoreRegistry();
  private readonly registryDb = createWorkerRegistryDb(this.db);

  async findById(workerId: string): Promise<WorkerRecord | null> {
    const row = await findWorkerRowById(this.db, workerId);
    return row ? mapWorkerRow(row) : null;
  }

  async findByName(workspaceId: string, name: string): Promise<WorkerRecord | null> {
    const row = await findWorkerRowByName(this.db, workspaceId, name.trim());
    return row ? mapWorkerRow(row) : null;
  }

  async listByWorkspace(workspaceId: string): Promise<WorkerRecord[]> {
    const rows = await this.db
      .select()
      .from(workers)
      .where(eq(workers.workspaceId, workspaceId))
      .orderBy(desc(workers.lastSeen), desc(workers.registeredAt));

    return rows.map(mapWorkerRow);
  }

  async markOnline(workerId: string): Promise<WorkerRecord> {
    await this.core.markOnline(this.registryDb, workerId);

    const worker = await this.findById(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} not found`);
    }

    return worker;
  }

  async markOffline(workerId: string): Promise<void> {
    await this.core.markOffline(this.registryDb, workerId);
  }

  async markOfflineIfStale(workerId: string, expectedLastSeen: Date): Promise<void> {
    await this.db
      .update(workers)
      .set({
        status: "offline",
      })
      .where(
        and(
          eq(workers.id, workerId),
          ne(workers.status, "revoked"),
          lte(workers.lastSeen, expectedLastSeen),
        ),
      );
  }

  async revoke(workerId: string): Promise<WorkerRecord> {
    await this.core.revoke(this.registryDb, workerId);

    const worker = await this.findById(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} not found`);
    }

    return worker;
  }

  async select(
    workspaceId: string,
    selection?: WorkerSelection | null,
  ): Promise<WorkerRecord> {
    // TODO: Tag-based pool selection is still a linear scan in v4.
    const worker = await this.core.select(
      this.registryDb,
      workspaceId,
      selection as CoreWorkerSelection | undefined,
    );

    const hydrated = await this.findById(worker.id);
    if (!hydrated) {
      throw new Error(`Worker ${worker.id} not found`);
    }

    return hydrated;
  }

  async validateToken(workerId: string, plaintextToken: string): Promise<boolean> {
    return validateWorkerToken(this.db, workerId, plaintextToken);
  }
}

export { mapWorkerRow };

import crypto, { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import {
  WorkerRegistry as CoreWorkerRegistry,
  type RegisterWorkerRecord,
  type WorkerRecord as CoreWorkerRecord,
  type WorkerRegistryDb,
} from "@cloud/core/workers/index.js";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/index";
import { workerEnrollmentTokens, workers } from "@/lib/db/schema";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ENROLLMENT_TOKEN_PREFIX = "ocl_wrk_enr_";
const WORKER_TOKEN_PREFIX = "ocl_wrk_";

type AppDb = ReturnType<typeof getDb>;
type RegistrationDbClient = Pick<AppDb, "insert">;
type WorkerTokenLookupDb = Pick<AppDb, "select">;
type WorkerRow = typeof workers.$inferSelect;

function encodeBase58(length: number): string {
  let value = "";

  while (value.length < length) {
    const bytes = crypto.randomBytes(length);
    for (const byte of bytes) {
      if (value.length >= length) {
        break;
      }

      if (byte < 232) {
        value += BASE58_ALPHABET[byte % BASE58_ALPHABET.length];
      }
    }
  }

  return value;
}

function normalizeHostInfo(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function extractTags(hostInfo: Record<string, unknown>): string[] {
  const raw = hostInfo.tags;
  return Array.isArray(raw)
    ? [
        ...new Set(
          raw
            .filter((tag): tag is string => typeof tag === "string")
            .map((tag) => tag.trim())
            .filter(Boolean),
        ),
      ]
    : [];
}

function decodeHexHash(hash: string): Buffer {
  return /^[0-9a-f]{64}$/i.test(hash) ? Buffer.from(hash, "hex") : Buffer.alloc(0);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.byteLength !== rightBuffer.byteLength) {
    const maxLength = Math.max(leftBuffer.byteLength, rightBuffer.byteLength);
    const paddedLeft = Buffer.alloc(maxLength);
    const paddedRight = Buffer.alloc(maxLength);

    leftBuffer.copy(paddedLeft);
    rightBuffer.copy(paddedRight);
    timingSafeEqual(paddedLeft, paddedRight);
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function compareTokenHash(expectedHash: string, token: string): boolean {
  return constantTimeEqual(decodeHexHash(expectedHash), hashWorkerTokenBytes(token));
}

function mapWorkerRowToCore(row: WorkerRow): CoreWorkerRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    displayName: row.displayName,
    status: row.status as CoreWorkerRecord["status"],
    lastSeen: row.lastSeen ?? null,
    hostInfo: normalizeHostInfo(row.hostInfo),
    tags: extractTags({ tags: row.tags }),
  };
}

function createRegistrationDb(
  db: RegistrationDbClient,
  registeredBy: string,
): WorkerRegistryDb {
  return {
    registerWorker: async (input: RegisterWorkerRecord): Promise<CoreWorkerRecord> => {
      const [row] = await db
        .insert(workers)
        .values({
          ...(input.id ? { id: input.id } : {}),
          workspaceId: input.workspaceId,
          name: input.name.trim(),
          displayName: input.displayName.trim(),
          hostInfo: normalizeHostInfo(input.hostInfo),
          tokenHash: Buffer.from(input.tokenHash).toString("hex"),
          status: input.status ?? "pending",
          lastSeen: input.lastSeen ?? null,
          registeredBy,
          tags: extractTags({ tags: input.tags }),
        })
        .returning();

      return mapWorkerRowToCore(row);
    },
  } as WorkerRegistryDb;
}

function createCoreRegistry(): CoreWorkerRegistry {
  return new CoreWorkerRegistry({
    generateToken: mintWorkerToken,
    hashToken: hashWorkerTokenBytes,
  });
}

export function hashWorkerTokenBytes(token: string): Uint8Array {
  return crypto.createHash("sha256").update(token).digest();
}

export function hashWorkerToken(token: string): string {
  return Buffer.from(hashWorkerTokenBytes(token)).toString("hex");
}

export function mintWorkerToken(): string {
  // TODO: Worker token rotation is not implemented in v4.
  return `${WORKER_TOKEN_PREFIX}${encodeBase58(48)}`;
}

export function mintEnrollmentTokenValue(): string {
  return `${ENROLLMENT_TOKEN_PREFIX}${encodeBase58(24)}`;
}

export function isWorkerToken(token: string): boolean {
  return token.startsWith(WORKER_TOKEN_PREFIX) && !token.startsWith(ENROLLMENT_TOKEN_PREFIX);
}

export function extractRequestIp(request: NextRequest | Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded && isIP(forwarded)) {
    return forwarded;
  }

  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp && isIP(realIp)) {
    return realIp;
  }

  return null;
}

export async function mintEnrollmentToken(
  db: AppDb,
  input: {
    workspaceId: string;
    userId: string;
  },
): Promise<{ plaintext: string; expiresAt: Date }> {
  const plaintext = mintEnrollmentTokenValue();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  await db.insert(workerEnrollmentTokens).values({
    tokenHash: hashWorkerToken(plaintext),
    workspaceId: input.workspaceId,
    createdBy: input.userId,
    expiresAt,
  });

  return { plaintext, expiresAt };
}

export async function redeemEnrollmentToken(
  db: AppDb,
  plaintext: string,
  input: {
    name: string;
    hostInfo?: unknown;
    ip?: string | null;
  },
): Promise<{
  workerId: string;
  workerToken: string;
}> {
  const now = new Date();
  const tokenHash = hashWorkerToken(plaintext);
  const name = input.name.trim();
  const hostInfo = normalizeHostInfo(input.hostInfo);
  const tags = extractTags(hostInfo);

  if (!plaintext.startsWith(ENROLLMENT_TOKEN_PREFIX)) {
    throw new Error("Invalid enrollment token");
  }

  return db.transaction(async (tx) => {
    const [tokenRow] = await tx
      .select()
      .from(workerEnrollmentTokens)
      .where(
        and(
          eq(workerEnrollmentTokens.tokenHash, tokenHash),
          isNull(workerEnrollmentTokens.usedAt),
          gt(workerEnrollmentTokens.expiresAt, now),
        ),
      )
      .limit(1);

    if (!tokenRow || !compareTokenHash(tokenRow.tokenHash, plaintext)) {
      throw new Error("Invalid enrollment token");
    }

    const { worker, plaintextToken } = await createCoreRegistry().register(
      createRegistrationDb(tx, tokenRow.createdBy),
      {
        workspaceId: tokenRow.workspaceId,
        name,
        displayName: name,
        hostInfo,
        tags,
        status: "pending",
      },
    );

    await tx
      .update(workerEnrollmentTokens)
      .set({
        usedAt: now,
        usedFromIp: input.ip ?? null,
      })
      .where(eq(workerEnrollmentTokens.id, tokenRow.id));

    return {
      workerId: worker.id,
      workerToken: plaintextToken,
    };
  });
}

export async function validateWorkerToken(
  db: WorkerTokenLookupDb,
  workerId: string,
  plaintextToken: string,
): Promise<boolean> {
  const token = plaintextToken.trim();
  if (!token || !isWorkerToken(token)) {
    return false;
  }

  const [worker] = await db
    .select({
      tokenHash: workers.tokenHash,
      status: workers.status,
    })
    .from(workers)
    .where(eq(workers.id, workerId))
    .limit(1);

  if (!worker || worker.status === "revoked") {
    return false;
  }

  return compareTokenHash(worker.tokenHash, token);
}

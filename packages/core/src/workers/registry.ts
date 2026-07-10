import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  NewWorkerRow,
  WorkerRecord,
  WorkerRegistryDb,
  WorkerSelection,
} from "./types.js";

const DEFAULT_TOKEN_PREFIX = "ocl_wrk_";
const DEFAULT_TOKEN_BYTES = 24;

function normalizeToken(token: string): string {
  return token.trim();
}

function normalizeIdentifier(value: string, fieldName: string): string {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    throw new Error(`${fieldName} is required`);
  }

  return normalizedValue;
}

function normalizeName(name: string): string {
  return normalizeIdentifier(name, "Worker name");
}

function normalizeDisplayName(displayName: string | undefined, fallbackName: string): string {
  const normalizedDisplayName = displayName?.trim() ?? "";
  return normalizedDisplayName || fallbackName;
}

function normalizeTags(tags: readonly string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
}

function normalizeHostInfo(hostInfo: WorkerRecord["hostInfo"] | undefined): WorkerRecord["hostInfo"] {
  return hostInfo ? { ...hostInfo } : {};
}

function toBuffer(value: Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const leftBuffer = toBuffer(left);
  const rightBuffer = toBuffer(right);

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

function defaultHashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function defaultGenerateToken(): string {
  return `${DEFAULT_TOKEN_PREFIX}${randomBytes(DEFAULT_TOKEN_BYTES).toString("hex")}`;
}

function workerMatchesTags(worker: WorkerRecord, selection?: WorkerSelection | null): boolean {
  const requiredTags = normalizeTags(selection?.tags);
  if (requiredTags.length === 0) {
    return true;
  }

  const workerTags = new Set(worker.tags);
  return requiredTags.every((tag) => workerTags.has(tag));
}

function assertOnlineWorker(worker: WorkerRecord | null): WorkerRecord {
  if (!worker) {
    throw new Error("Worker not found");
  }
  if (worker.status !== "online") {
    throw new Error("Worker is not online");
  }
  return worker;
}

export interface WorkerRegistryOptions {
  now?: () => Date;
  generateToken?: () => string;
  hashToken?: (plaintextToken: string) => Uint8Array;
}

export class WorkerRegistry {
  private readonly now: () => Date;
  private readonly generateToken: () => string;
  private readonly hashToken: (plaintextToken: string) => Uint8Array;

  constructor(options: WorkerRegistryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.generateToken = options.generateToken ?? defaultGenerateToken;
    this.hashToken = options.hashToken ?? defaultHashToken;
  }

  async register(
    db: WorkerRegistryDb,
    row: NewWorkerRow,
  ): Promise<{ worker: WorkerRecord; plaintextToken: string }> {
    const name = normalizeName(row.name);
    const plaintextToken = this.generateToken();
    const worker = await db.registerWorker({
      ...row,
      name,
      displayName: normalizeDisplayName(row.displayName, name),
      status: row.status ?? "pending",
      lastSeen: row.lastSeen ?? null,
      hostInfo: normalizeHostInfo(row.hostInfo),
      tags: normalizeTags(row.tags),
      tokenHash: this.hashToken(plaintextToken),
    });

    return { worker, plaintextToken };
  }

  async findByName(
    db: WorkerRegistryDb,
    workspaceId: string,
    name: string,
  ): Promise<WorkerRecord | null> {
    return db.findWorkerByName(
      normalizeIdentifier(workspaceId, "workspaceId"),
      normalizeName(name),
    );
  }

  async findById(db: WorkerRegistryDb, workerId: string): Promise<WorkerRecord | null> {
    return db.findWorkerById(normalizeIdentifier(workerId, "workerId"));
  }

  async listByWorkspace(db: WorkerRegistryDb, workspaceId: string): Promise<WorkerRecord[]> {
    return db.listWorkersByWorkspace(normalizeIdentifier(workspaceId, "workspaceId"));
  }

  async select(
    db: WorkerRegistryDb,
    workspaceId: string,
    selection?: WorkerSelection | null,
  ): Promise<WorkerRecord> {
    const normalizedWorkspaceId = normalizeIdentifier(workspaceId, "workspaceId");
    const workerId = selection?.workerId?.trim();
    if (workerId) {
      const worker = await db.findWorkerById(normalizeIdentifier(workerId, "workerId"));
      if (!worker || worker.workspaceId !== normalizedWorkspaceId) {
        throw new Error("Worker not found");
      }
      return assertOnlineWorker(worker);
    }

    const workerName = selection?.name?.trim();
    if (workerName) {
      const worker = await db.findWorkerByName(normalizedWorkspaceId, workerName);
      return assertOnlineWorker(worker);
    }

    const workers = await db.listWorkersByWorkspace(normalizedWorkspaceId);
    const match = workers.find((worker) => worker.status === "online" && workerMatchesTags(worker, selection));
    if (!match) {
      throw new Error("No matching online worker");
    }

    return match;
  }

  async markOnline(db: WorkerRegistryDb, workerId: string): Promise<void> {
    await db.updateWorkerStatus({
      workerId: normalizeIdentifier(workerId, "workerId"),
      status: "online",
      lastSeen: this.now(),
    });
  }

  async markOffline(db: WorkerRegistryDb, workerId: string): Promise<void> {
    await db.updateWorkerStatus({
      workerId: normalizeIdentifier(workerId, "workerId"),
      status: "offline",
    });
  }

  async revoke(db: WorkerRegistryDb, workerId: string): Promise<void> {
    await db.revokeWorker(normalizeIdentifier(workerId, "workerId"));
  }

  async validateToken(
    db: WorkerRegistryDb,
    workerId: string,
    plaintextToken: string,
  ): Promise<boolean> {
    const normalizedWorkerId = normalizeIdentifier(workerId, "workerId");
    const normalizedToken = normalizeToken(plaintextToken);
    if (!normalizedToken) {
      return false;
    }

    const tokenRecord = await db.getWorkerToken(normalizedWorkerId);
    if (!tokenRecord || tokenRecord.worker.status === "revoked") {
      return false;
    }

    return constantTimeEqual(tokenRecord.tokenHash, this.hashToken(normalizedToken));
  }
}

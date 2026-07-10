import { getCloudflareContext } from "@/lib/cloudflare-context";
import { logger } from "@/lib/logger";
export {
  FactoryStateStoreDO,
  factoryClarificationKey,
  factoryInFlightKey,
  factoryInFlightPrefix,
  type FactoryClarificationRecord,
  type FactoryInFlightRecord,
  type FactoryInFlightSpawnRecord,
  type FactoryMergeGateRecord,
  type FactorySpawnTerminalStatus,
  type FactoryStateOp,
  type FactoryWritebackRecord,
} from "@/lib/proactive-runtime/factory-state-store-core";
import {
  factoryClarificationKey,
  factoryInFlightKey,
  factoryInFlightPrefix,
  type FactoryClarificationRecord,
  type FactoryInFlightRecord,
  type FactoryStateOp,
} from "@/lib/proactive-runtime/factory-state-store-core";

export interface FactoryStateStore {
  getInFlight(workspaceId: string, issueId: string): Promise<FactoryInFlightRecord | null>;
  putInFlight(record: FactoryInFlightRecord): Promise<void>;
  deleteInFlight(workspaceId: string, issueId: string): Promise<void>;
  listInFlight(workspaceId: string): Promise<FactoryInFlightRecord[]>;
  getWaitingClarification(workspaceId: string, threadId: string): Promise<FactoryClarificationRecord | null>;
  putWaitingClarification(record: FactoryClarificationRecord): Promise<void>;
  deleteWaitingClarification(workspaceId: string, threadId: string): Promise<void>;
}

type DurableObjectNamespaceLike = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
};

const memoryRecords = new Map<string, FactoryInFlightRecord | FactoryClarificationRecord>();

class MemoryFactoryStateStore implements FactoryStateStore {
  async getInFlight(workspaceId: string, issueId: string): Promise<FactoryInFlightRecord | null> {
    return memoryRecords.get(factoryInFlightKey(workspaceId, issueId)) as FactoryInFlightRecord | undefined ?? null;
  }

  async putInFlight(record: FactoryInFlightRecord): Promise<void> {
    memoryRecords.set(factoryInFlightKey(record.workspaceId, record.issueId), record);
  }

  async deleteInFlight(workspaceId: string, issueId: string): Promise<void> {
    memoryRecords.delete(factoryInFlightKey(workspaceId, issueId));
  }

  async listInFlight(workspaceId: string): Promise<FactoryInFlightRecord[]> {
    const prefix = factoryInFlightPrefix(workspaceId);
    return [...memoryRecords.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, value]) => value as FactoryInFlightRecord);
  }

  async getWaitingClarification(
    workspaceId: string,
    threadId: string,
  ): Promise<FactoryClarificationRecord | null> {
    return memoryRecords.get(factoryClarificationKey(workspaceId, threadId)) as
      FactoryClarificationRecord | undefined ?? null;
  }

  async putWaitingClarification(record: FactoryClarificationRecord): Promise<void> {
    memoryRecords.set(factoryClarificationKey(record.workspaceId, record.threadId), record);
  }

  async deleteWaitingClarification(workspaceId: string, threadId: string): Promise<void> {
    memoryRecords.delete(factoryClarificationKey(workspaceId, threadId));
  }
}

export class DurableObjectFactoryStateStore implements FactoryStateStore {
  constructor(private readonly namespace: DurableObjectNamespaceLike) {}

  async getInFlight(workspaceId: string, issueId: string): Promise<FactoryInFlightRecord | null> {
    return (await this.request<{ record: FactoryInFlightRecord | null }>({
      op: "getInFlight",
      workspaceId,
      issueId,
    })).record;
  }

  async putInFlight(record: FactoryInFlightRecord): Promise<void> {
    await this.request({ op: "putInFlight", record });
  }

  async deleteInFlight(workspaceId: string, issueId: string): Promise<void> {
    await this.request({ op: "deleteInFlight", workspaceId, issueId });
  }

  async listInFlight(workspaceId: string): Promise<FactoryInFlightRecord[]> {
    return (await this.request<{ records: FactoryInFlightRecord[] }>({
      op: "listInFlight",
      workspaceId,
    })).records;
  }

  async getWaitingClarification(
    workspaceId: string,
    threadId: string,
  ): Promise<FactoryClarificationRecord | null> {
    return (await this.request<{ record: FactoryClarificationRecord | null }>({
      op: "getWaitingClarification",
      workspaceId,
      threadId,
    })).record;
  }

  async putWaitingClarification(record: FactoryClarificationRecord): Promise<void> {
    await this.request({ op: "putWaitingClarification", record });
  }

  async deleteWaitingClarification(workspaceId: string, threadId: string): Promise<void> {
    await this.request({ op: "deleteWaitingClarification", workspaceId, threadId });
  }

  private async request<T>(body: FactoryStateOp): Promise<T> {
    const stub = this.namespace.get(this.namespace.idFromName("factory-state-store"));
    const response = await stub.fetch(new Request("https://factory-state-store.local/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
    if (!response.ok) {
      throw new Error(`Factory StateStore DO request failed: ${response.status}`);
    }
    return response.json() as Promise<T>;
  }
}

function resolveCloudflareEnv(): Record<string, unknown> | null {
  try {
    return getCloudflareContext({ async: false }).env ?? null;
  } catch {
    // No Cloudflare context: local Node / unit test. Memory is expected here.
    return null;
  }
}

function asNamespace(value: unknown): DurableObjectNamespaceLike | null {
  const candidate = value as DurableObjectNamespaceLike | undefined;
  return candidate &&
    typeof candidate.idFromName === "function" &&
    typeof candidate.get === "function"
    ? candidate
    : null;
}

// One-shot guard so the degraded-state warning is emitted once per isolate
// instead of on every delivery drain.
let warnedMemoryFallback = false;

export function createFactoryStateStore(): FactoryStateStore {
  const env = resolveCloudflareEnv();
  const namespace = env ? asNamespace(env.FACTORY_STATE_STORE) : null;
  if (namespace) {
    return new DurableObjectFactoryStateStore(namespace);
  }

  // A Cloudflare context with NO `FACTORY_STATE_STORE` binding means we are in a
  // deployed worker whose infra has not wired the Durable Object yet (see the DO
  // wiring procedure in CLAUDE.md / infra/web-worker.ts). Falling back to the
  // module-global memory store there is per-isolate and volatile — in-flight and
  // clarification records are lost on redeploy. Make that degradation OBSERVABLE
  // (one structured warn) rather than a silent downgrade. Local/test runs have no
  // Cloudflare context (`env === null`) and stay quiet.
  if (env && !warnedMemoryFallback) {
    warnedMemoryFallback = true;
    void logger.warn("Factory StateStore degraded to per-isolate memory", {
      area: "factory-cloud-brain",
      diag: "state-store-memory-fallback",
      reason:
        "FACTORY_STATE_STORE durable object binding is not present on the worker; durable in-flight/clarification state is not persisted",
    });
  }
  return new MemoryFactoryStateStore();
}

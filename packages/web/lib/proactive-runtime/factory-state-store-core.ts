export type FactorySpawnTerminalStatus = "completed" | "failed";

export type FactoryInFlightSpawnRecord = {
  name: string;
  capability: string;
  invocationId: string;
  status: "pending" | "dispatched" | FactorySpawnTerminalStatus;
  role?: string;
  persona?: string;
  repo?: string;
  completedAt?: string;
  output?: string;
  error?: string;
};

export type FactoryMergeGateRecord = {
  status: "pending" | "ready" | "blocked";
  reason: string;
  decidedAt: string;
};

export type FactoryWritebackRecord = {
  status: "pending" | "posted" | "failed";
  postedAt?: string;
  error?: string;
};

export type FactoryInFlightRecord = {
  workspaceId: string;
  issueId: string;
  issueKey: string;
  issuePath: string;
  recipe: "single" | "workflow" | "team";
  deliveryId: string;
  connectionId?: string | null;
  spawns: FactoryInFlightSpawnRecord[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  mergeGate?: FactoryMergeGateRecord;
  linearWriteback?: FactoryWritebackRecord;
  slackWriteback?: FactoryWritebackRecord;
};

export type FactoryClarificationRecord = {
  workspaceId: string;
  threadId: string;
  issueId: string;
  reason: string;
  createdAt: string;
  updatedAt: string;
};

export type FactoryStateOp =
  | { op: "getInFlight"; workspaceId: string; issueId: string }
  | { op: "putInFlight"; record: FactoryInFlightRecord }
  | { op: "deleteInFlight"; workspaceId: string; issueId: string }
  | { op: "listInFlight"; workspaceId: string }
  | { op: "getWaitingClarification"; workspaceId: string; threadId: string }
  | { op: "putWaitingClarification"; record: FactoryClarificationRecord }
  | { op: "deleteWaitingClarification"; workspaceId: string; threadId: string };

type StorageLike = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
};

type DurableObjectStateLike = {
  storage: StorageLike;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function factoryInFlightKey(workspaceId: string, issueId: string): string {
  return `workspace:${workspaceId}:in-flight:${issueId}`;
}

export function factoryInFlightPrefix(workspaceId: string): string {
  return `workspace:${workspaceId}:in-flight:`;
}

export function factoryClarificationKey(workspaceId: string, threadId: string): string {
  return `workspace:${workspaceId}:clarification:${threadId}`;
}

export class FactoryStateStoreDO {
  constructor(private readonly state: DurableObjectStateLike, _env?: unknown) {}

  async fetch(request: Request): Promise<Response> {
    let body: FactoryStateOp;
    try {
      body = (await request.json()) as FactoryStateOp;
    } catch {
      return jsonResponse({ error: "invalid json body" }, 400);
    }

    switch (body.op) {
      case "getInFlight":
        return jsonResponse({
          record: await this.state.storage.get<FactoryInFlightRecord>(
            factoryInFlightKey(body.workspaceId, body.issueId),
          ) ?? null,
        });
      case "putInFlight":
        await this.state.storage.put(
          factoryInFlightKey(body.record.workspaceId, body.record.issueId),
          body.record,
        );
        return jsonResponse({ ok: true });
      case "deleteInFlight":
        await this.state.storage.delete(factoryInFlightKey(body.workspaceId, body.issueId));
        return jsonResponse({ ok: true });
      case "listInFlight":
        return jsonResponse({
          records: [
            ...(await this.state.storage.list<FactoryInFlightRecord>({
              prefix: factoryInFlightPrefix(body.workspaceId),
            })).values(),
          ],
        });
      case "getWaitingClarification":
        return jsonResponse({
          record: await this.state.storage.get<FactoryClarificationRecord>(
            factoryClarificationKey(body.workspaceId, body.threadId),
          ) ?? null,
        });
      case "putWaitingClarification":
        await this.state.storage.put(
          factoryClarificationKey(body.record.workspaceId, body.record.threadId),
          body.record,
        );
        return jsonResponse({ ok: true });
      case "deleteWaitingClarification":
        await this.state.storage.delete(factoryClarificationKey(body.workspaceId, body.threadId));
        return jsonResponse({ ok: true });
      default:
        return jsonResponse({ error: "unknown op" }, 400);
    }
  }
}

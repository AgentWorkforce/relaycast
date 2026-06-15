import type { Hono } from 'hono';
import { createEngine } from '../../engine.js';
import { createNodeRuntime, type NodeRuntime, type EngineSocket } from '../../adapters/node/index.js';
import type { AppEnv } from '../../env.js';
import type { EngineConfig } from '../../ports/index.js';

export interface TestStack {
  app: Hono<AppEnv>;
  runtime: NodeRuntime;
  close(): void;
}

/** Build an in-memory engine on the Node adapter with a fast presence sweep disabled. */
export function makeNodeStack(options?: {
  ttlMs?: number;
  mailbox?: EngineConfig['mailbox'];
  /** Phase 6 rollout flag default. Defaults to true so node tests run unchanged. */
  fleetNodesEnabled?: boolean;
}): TestStack {
  const runtime = createNodeRuntime({
    dbPath: ':memory:',
    baseUrl: 'http://localhost:0',
    migrate: true,
    config: {
      environment: 'test',
      workspaceStreamEnabled: true,
      fleetNodesEnabled: options?.fleetNodesEnabled ?? true,
      mailbox: options?.mailbox,
    },
    // Disable the auto-sweep timer; tests drive presence.sweep() explicitly.
    presence: { ttlMs: options?.ttlMs ?? 60_000, sweepIntervalMs: 0 },
  });
  const app = createEngine(runtime.deps);
  return { app, runtime, close: () => runtime.close() };
}

/** A capturing EngineSocket for asserting realtime delivery without a network. */
export class FakeSocket implements EngineSocket {
  readonly received: Record<string, unknown>[] = [];
  closed = false;
  send(data: string): void {
    this.received.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
  }
  /** Events of a given `type`. */
  ofType(type: string): Record<string, unknown>[] {
    return this.received.filter((e) => e.type === type);
  }
}

interface CreatedWorkspace {
  workspaceKey: string;
  workspaceId: string;
}

/** Create a workspace via the HTTP API and return its key + id. */
export async function createWorkspace(app: Hono<AppEnv>, name: string): Promise<CreatedWorkspace> {
  const res = await app.request('/v1/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (res.status >= 300) {
    throw new Error(`createWorkspace failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    data?: { id?: string; workspace_id?: string; api_key?: string; key?: string };
  };
  const data = body.data ?? {};
  const workspaceId = data.workspace_id ?? data.id ?? '';
  const workspaceKey = data.api_key ?? data.key ?? '';
  return { workspaceKey, workspaceId };
}

interface CreatedAgent {
  token: string;
  agentId: string;
  name: string;
}

/** Register an agent via the HTTP API and return its token + id. */
export async function registerAgent(app: Hono<AppEnv>, workspaceKey: string, name: string): Promise<CreatedAgent> {
  const res = await app.request('/v1/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
    body: JSON.stringify({ name }),
  });
  if (res.status >= 300) {
    throw new Error(`registerAgent failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data?: { id?: string; token?: string; agent_token?: string } };
  const data = body.data ?? {};
  return { token: data.token ?? data.agent_token ?? '', agentId: data.id ?? '', name };
}

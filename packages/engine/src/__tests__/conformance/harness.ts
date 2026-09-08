import { afterEach, vi } from 'vitest';
import { BackgroundTasks } from '../backgroundTasks.js';
import { DurableEventQueue } from '../../adapters/node/event-queue.js';
import * as nodeContext from '../../engine/nodeContext.js';
import type { Hono } from 'hono';
import { createEngine } from '../../engine.js';
import { createNodeRuntime, type NodeRuntime, type EngineSocket } from '../../adapters/node/index.js';
import type { AppEnv } from '../../env.js';
import type { EngineConfig, EntitlementsProvider } from '../../ports/index.js';

export interface TestStack {
  app: Hono<AppEnv>;
  runtime: NodeRuntime;
  settle(): Promise<void>;
  close(): Promise<void>;
}

const stacks = new Set<TestStack>();
const contextTasks = new WeakMap<object, BackgroundTasks>();
const sendPresence = nodeContext.sendNodePresenceContext;
const presenceTrackers = new WeakSet<typeof sendPresence>();

// Presence deliberately detaches node context delivery. Observe its real promise
// at the exported boundary, including HTTP push and its final database writes.
function observePresence(): void {
  const current = nodeContext.sendNodePresenceContext;
  const implementation = vi.isMockFunction(current) ? current.getMockImplementation() : current;
  if (implementation && presenceTrackers.has(implementation)) return;
  const send = implementation ?? sendPresence;
  const tracked: typeof sendPresence = (deps, ...args) => {
    const promise = send(deps, ...args);
    return contextTasks.get(deps.db)?.track(promise) ?? promise;
  };
  presenceTrackers.add(tracked);
  vi.spyOn(nodeContext, 'sendNodePresenceContext').mockImplementation(tracked);
}

afterEach(async () => {
  await Promise.all([...stacks].map((stack) => stack.close()));
});

/** Build an in-memory engine on the Node adapter with a fast presence sweep disabled. */
export function makeNodeStack(options?: {
  ttlMs?: number;
  mailbox?: EngineConfig['mailbox'];
  environment?: string;
  httpPushProxy?: EngineConfig['httpPushProxy'];
  workspaceBootstrapSecret?: string;
  entitlements?: EntitlementsProvider;
}): TestStack {
  const tasks = new BackgroundTasks();
  observePresence();
  // start() launches poll() before createNodeRuntime returns. Capture that exact
  // promise; calling poll() again would return early while it is already busy.
  const poll = DurableEventQueue.prototype.poll;
  DurableEventQueue.prototype.poll = function () {
    return tasks.track(poll.call(this));
  };
  let runtime: NodeRuntime;
  try {
    runtime = createNodeRuntime({
      dbPath: ':memory:',
      baseUrl: 'http://localhost:0',
      migrate: true,
      config: {
        environment: options?.environment ?? 'test',
        mailbox: options?.mailbox,
        httpPushProxy: options?.httpPushProxy,
        workspaceBootstrapSecret: options?.workspaceBootstrapSecret ?? 'test-bootstrap-secret',
      },
      entitlements: options?.entitlements,
      // Disable the auto-sweep timer; tests drive presence.sweep() explicitly.
      eventQueue: { pollIntervalMs: 0 },
      presence: { ttlMs: options?.ttlMs ?? 60_000, sweepIntervalMs: 0 },
    });
  } finally {
    DurableEventQueue.prototype.poll = poll;
  }
  contextTasks.set(runtime.deps.db, tasks);
  const queuePoll = runtime.webhookQueue.poll.bind(runtime.webhookQueue);
  runtime.webhookQueue.poll = () => tasks.track(queuePoll());
  const drainNode = runtime.realtime.drainNode.bind(runtime.realtime);
  runtime.realtime.drainNode = (...args) => tasks.track(drainNode(...args));
  const app = createEngine(runtime.deps);
  tasks.bind(app);
  let closing: Promise<void> | undefined;
  const stack: TestStack = {
    app, runtime,
    settle: () => tasks.drain(),
    close: () => closing ??= (async () => {
      runtime.webhookQueue.stop();
      runtime.presence.stop();
      try {
        await tasks.drain();
      } finally {
        try {
          runtime.close();
        } finally {
          stacks.delete(stack);
        }
      }
    })(),
  };
  stacks.add(stack);
  return stack;
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

export async function attachDirectNodeSocket(
  stack: TestStack,
  workspaceId: string,
  agent: CreatedAgent,
): Promise<{ sock: FakeSocket; handle: { handleMessage(raw: string): Promise<void>; handleClose(): Promise<void> }; nodeId: string }> {
  const nodeId = `node_direct_${agent.agentId}`;
  const sock = new FakeSocket();
  const handle = stack.runtime.realtime.attachNodeSocket(workspaceId, nodeId, sock);
  await handle.handleMessage(JSON.stringify({
    v: 1,
    id: `test-direct-${agent.agentId}`,
    type: 'node.register',
    node_id: nodeId,
    name: `direct-${agent.agentId}`,
    capabilities: [],
    max_agents: 1,
    tags: ['implicit', 'direct', 'test'],
    version: 'test-direct-node',
    resume_cursor: null,
  }));
  return { sock, handle, nodeId };
}

export function deliverFramesOfType(sock: FakeSocket, type: string): Record<string, unknown>[] {
  return sock.ofType('deliver').filter((frame) => {
    const payload = frame.payload;
    return !!payload && typeof payload === 'object' && !Array.isArray(payload)
      && (payload as Record<string, unknown>).type === type;
  });
}

export function contextUpdatesOfType(sock: FakeSocket, event: string): Record<string, unknown>[] {
  return sock.ofType('context.update').filter((frame) => frame.event === event);
}

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createNodeRuntime } from '../../adapters/node/index.js';
import { actionInvocations, nodes } from '../../db/tables.js';
import { createEngine } from '../../engine.js';
import { createWorkspace, FakeSocket, registerAgent } from './harness.js';
import { conformancePgDb } from './pgMode.js';

const schema = 'relay.spawn.invoke.logical/1';

it('replay route resumes a pre-dispatch claim after an actual SQLite runtime restart', async () => {
  if (conformancePgDb()) return;
  const dir = mkdtempSync(join(tmpdir(), 'relaycast-strict-spawn-restart-'));
  const dbPath = join(dir, 'relaycast.db');
  const options = {
    dbPath,
    baseUrl: 'http://localhost:0',
    migrate: true,
    config: { environment: 'test', workspaceBootstrapSecret: 'strict-spawn-restart-secret' },
    eventQueue: { pollIntervalMs: 0 },
    presence: { ttlMs: 60_000, sweepIntervalMs: 0 },
  } as const;
  let first: ReturnType<typeof createNodeRuntime> | undefined;
  let restarted: ReturnType<typeof createNodeRuntime> | undefined;
  try {
    first = createNodeRuntime(options);
    const firstApp = createEngine(first.deps);
    const ws = await createWorkspace(firstApp, 'strict-spawn-restart');
    const caller = await registerAgent(firstApp, ws.workspaceKey, 'restart-caller');
    const nodeId = 'node_strict_restart';
    const created = await firstApp.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({
        node_id: nodeId,
        name: 'strict-restart',
        capabilities: ['spawn:claude'],
        max_agents: 2,
        tags: ['test'],
        version: 'test-node',
      }),
    });
    expect(created.status).toBe(201);
    const logical = {
      schema,
      target_node_id: nodeId,
      target_node: 'strict-restart',
      name: 'worker',
      cli: 'claude',
      task: 'prove crash recovery',
      directory: '/repo',
      verify_ready: true,
    };
    const input = {
      spawn_contract: schema,
      target_node_id: nodeId,
      target_node: logical.target_node,
      name: logical.name,
      cli: logical.cli,
      task: logical.task,
      worker_cwd: '/materialized/repo',
      verify_ready: logical.verify_ready,
      logical_request: logical,
      spawn_contract_applied: schema,
    };
    const key = 'persisted-replay-crash';
    const invocationId = `inv_idem_${createHash('sha256')
      .update(['action-invoke-v1', ws.workspaceId, caller.agentId, 'spawn', key].join('\0'))
      .digest('hex')}`;
    await first.deps.db.insert(actionInvocations).values({
      id: invocationId,
      workspaceId: ws.workspaceId,
      actionName: 'spawn',
      invocationOrigin: 'builtin',
      callerId: caller.agentId,
      callerName: caller.name,
      input,
      status: 'pending',
    });
    first.close();
    first = undefined;

    restarted = createNodeRuntime(options);
    const sock = new FakeSocket();
    const handle = restarted.realtime.attachNodeSocket(ws.workspaceId, nodeId, sock);
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-strict-restart',
      type: 'node.register',
      name: 'strict-restart',
      node_id: nodeId,
      capabilities: [{ name: 'spawn:claude', kind: 'spawn', metadata: { agent: 'claude' } }],
      max_agents: 2,
      tags: ['test'],
      version: 'test-node',
      resume_cursor: null,
    }));
    await handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'node.heartbeat',
      active_agents: 0,
      handlers_live: true,
    }));

    const replay = await createEngine(restarted.deps).request('/v1/actions/spawn/replay', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${caller.token}`,
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ logical_request: logical }),
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    expect(sock.ofType('action.invoke')).toEqual([
      expect.objectContaining({ action: 'spawn:claude', invocation_id: invocationId }),
    ]);
    const [node] = await restarted.deps.db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, nodeId)));
    expect(node.reservedAgents).toBe(1);
  } finally {
    restarted?.close();
    first?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeNodeStack, createWorkspace, registerAgent, FakeSocket, type TestStack } from './harness.js';
import { createTrigger, fireMessageTriggers, type TriggerMessageInput } from '../../engine/trigger.js';

// A trigger binds to an action name with no node. It must reach node-scoped
// (fleet-provider) actions, dispatching node-addressed — otherwise defineNode's
// onMessage->action feature never fires, because the workspace-global resolver
// excludes plain node-scoped actions.
describe('message triggers fire node-scoped actions', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack.close());

  async function enrollNode(wsKey: string, nodeId: string, name: string) {
    const res = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${wsKey}` },
      body: JSON.stringify({ node_id: nodeId, name, role: 'broker', capabilities: [], max_agents: 4, tags: ['test'], version: 'v0' }),
    });
    expect(res.status).toBe(201);
  }

  function message(caller: { agentId: string; name: string }, overrides: Partial<TriggerMessageInput> = {}): TriggerMessageInput {
    return {
      id: `msg_${Math.random().toString(36).slice(2)}`,
      channel_id: 'chan_general',
      channel_name: 'general',
      agent_id: caller.agentId,
      agent_name: caller.name,
      text: 'please run the etl',
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it('dispatches to the node that owns a plain node-scoped action', async () => {
    const ws = await createWorkspace(stack.app, 'trg-node');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    await enrollNode(ws.workspaceKey, 'node_a', 'alpha');

    // A fleet provider on node_a registers a plain node-scoped action.
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, 'node_a', sock);
    await handle.handleMessage(JSON.stringify({
      v: 1, id: 'reg-py', type: 'node.register', name: 'alpha', node_id: 'node_a',
      provider: { name: 'py', instance_id: 'py-i1' },
      capabilities: [{ name: 'run-etl', kind: 'action' }],
      max_agents: 4, tags: ['test'], version: 'v1', resume_cursor: null,
    }));

    await createTrigger(stack.runtime.handle.db, ws.workspaceId, { channel: 'general', action_name: 'run-etl' });

    const invoked = await fireMessageTriggers({
      db: stack.runtime.handle.db,
      nodeConnections: stack.runtime.realtime,
      workspaceId: ws.workspaceId,
      message: message(caller),
    });

    expect(invoked).toHaveLength(1);
    // The node-scoped action was dispatched node-addressed to node_a's provider.
    expect(sock.ofType('action.invoke').at(-1)).toMatchObject({ action: 'run-etl' });
  });
});

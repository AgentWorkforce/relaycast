import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliTypeSchema, KNOWN_CLI_TYPES } from '@relaycast/types';
import { makeNodeStack, createWorkspace, registerAgent, FakeSocket, type TestStack } from './harness.js';

// `POST /v1/agents/spawn` accepts any harness a node advertises as
// `spawn:<id>`, not only the harnesses Relaycast has always named, and refuses
// ids that could not be a capability name.
describe('spawn harness ids', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack?.close());

  async function attachNode(ws: { workspaceKey: string; workspaceId: string }, nodeId: string, name: string, harness: string) {
    const enrolled = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ node_id: nodeId, name, role: 'broker', capabilities: [], max_agents: 4, tags: ['test'], version: 'v0' }),
    });
    expect(enrolled.status).toBe(201);
    const provider = { name: 'broker', instance_id: `${nodeId}-i1` };
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, nodeId, sock);
    await handle.handleMessage(JSON.stringify({
      v: 1, id: `reg-${nodeId}`, type: 'node.register', name, node_id: nodeId, provider,
      capabilities: [{ name: `spawn:${harness}`, kind: 'capacity' }],
      max_agents: 4, tags: ['test'], version: 'v1', resume_cursor: null,
    }));
    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.heartbeat', provider, load: 0, active_agents: 0, handlers_live: true,
    }));
    return sock;
  }

  function spawn(token: string, body: Record<string, unknown>) {
    return stack.app.request('/v1/agents/spawn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ task: 'Say hello', ...body }),
    });
  }

  it('places a harness outside the built-in list on the node that advertises it', async () => {
    const ws = await createWorkspace(stack.app, 'spawn-harness-ids');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    const claudeNode = await attachNode(ws, 'node_claude', 'claude-box', 'claude');
    const cursorNode = await attachNode(ws, 'node_cursor', 'cursor-box', 'cursor');

    const cursor = await spawn(caller.token, { name: 'cursor-worker', cli: 'cursor' });
    expect(cursor.status).toBe(201);
    expect((await cursor.json()).data.handler_node_id).toBe('node_cursor');
    await stack.settle();
    expect(cursorNode.ofType('action.invoke').at(-1)).toMatchObject({ input: { name: 'cursor-worker', cli: 'cursor' } });

    const claude = await spawn(caller.token, { name: 'claude-worker', cli: 'claude' });
    expect(claude.status).toBe(201);
    expect((await claude.json()).data.handler_node_id).toBe('node_claude');
    await stack.settle();
    expect(claudeNode.ofType('action.invoke').at(-1)).toMatchObject({ input: { name: 'claude-worker', cli: 'claude' } });
    expect(cursorNode.ofType('action.invoke')).toHaveLength(1);
  });

  it.each(['Cursor', 'cursor_ai', 'spawn:cursor', '-cursor', 'cur sor', 'cursor\n', '', 'a'.repeat(33)])(
    'refuses a malformed harness id %j before dispatch',
    async (cli) => {
      const ws = await createWorkspace(stack.app, 'spawn-harness-ids-bad');
      const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
      const node = await attachNode(ws, 'node_cursor', 'cursor-box', 'cursor');
      const response = await spawn(caller.token, { name: 'bad-worker', cli });
      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toContain('cli must be a harness id');
      await stack.settle();
      expect(node.ofType('action.invoke')).toHaveLength(0);
    },
  );

  it('keeps every built-in harness id and accepts the 32-character limit', () => {
    for (const cli of [...KNOWN_CLI_TYPES, 'cursor', 'copilot', 'devin', 'qwen', 'amp', 'claude-code', 'a'.repeat(32)]) {
      expect(CliTypeSchema.safeParse(cli).success).toBe(true);
    }
  });
});

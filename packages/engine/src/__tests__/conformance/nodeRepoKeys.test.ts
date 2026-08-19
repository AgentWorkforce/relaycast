import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspace, FakeSocket, makeNodeStack, type TestStack } from './harness.js';

describe('fleet node repository advertisements', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  async function enrollNode(workspaceKey: string) {
    const response = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify({
        node_id: 'node_repos',
        name: 'repo-builder',
        max_agents: 4,
        tags: ['enrolled'],
        version: 'test-node',
      }),
    });
    expect(response.status).toBe(201);
  }

  async function readNode(workspaceKey: string) {
    const response = await stack.app.request('/v1/nodes?name=repo-builder', {
      headers: { authorization: `Bearer ${workspaceKey}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Array<Record<string, unknown>> };
    return body.data[0];
  }

  it('persists merged repo tags, replaces them on reconnect, and exposes readback', async () => {
    const workspace = await createWorkspace(stack.app, 'node-repo-keys');
    await enrollNode(workspace.workspaceKey);

    const firstSocket = new FakeSocket();
    const first = stack.runtime.realtime.attachNodeSocket(workspace.workspaceId, 'node_repos', firstSocket);
    await first.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-repos-1',
      type: 'node.register',
      name: 'repo-builder',
      node_id: 'node_repos',
      capabilities: [],
      max_agents: 4,
      tags: ['linux', 'cwd:/Users/build', 'repo:relay', 'repo:acme/legacy'],
      repo_keys: ['AgentWorkforce/relaycast', 'acme/legacy'],
      version: 'test-node',
      resume_cursor: null,
    }));

    expect(firstSocket.ofType('reply').at(-1)).toMatchObject({
      ok: true,
      data: {
        tags: [
          'linux',
          'cwd:/Users/build',
          'repo:relay',
          'repo:acme/legacy',
          'repo:AgentWorkforce/relaycast',
        ],
      },
    });
    expect(await readNode(workspace.workspaceKey)).toMatchObject({
      tags: [
        'linux',
        'cwd:/Users/build',
        'repo:relay',
        'repo:acme/legacy',
        'repo:AgentWorkforce/relaycast',
      ],
    });

    await first.handleClose();
    const secondSocket = new FakeSocket();
    const second = stack.runtime.realtime.attachNodeSocket(workspace.workspaceId, 'node_repos', secondSocket);
    await second.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-repos-2',
      type: 'node.register',
      name: 'repo-builder',
      node_id: 'node_repos',
      capabilities: [],
      max_agents: 4,
      tags: ['linux', 'gpu'],
      repo_keys: ['AgentWorkforce/relay'],
      version: 'test-node-v2',
      resume_cursor: null,
    }));

    expect(secondSocket.ofType('reply').at(-1)).toMatchObject({
      ok: true,
      data: { tags: ['linux', 'gpu', 'repo:AgentWorkforce/relay'] },
    });
    expect(await readNode(workspace.workspaceKey)).toMatchObject({
      tags: ['linux', 'gpu', 'repo:AgentWorkforce/relay'],
      version: 'test-node-v2',
    });
  });

  it('rejects spoofed path-shaped repo tags without changing persisted readback', async () => {
    const workspace = await createWorkspace(stack.app, 'node-unsafe-repo-keys');
    await enrollNode(workspace.workspaceKey);

    const unsafeEnrollment = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspace.workspaceKey}` },
      body: JSON.stringify({
        node_id: 'node_repos',
        name: 'repo-builder',
        tags: ['repo:/srv/private-repo'],
      }),
    });
    expect(unsafeEnrollment.status).toBe(400);

    const socket = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(workspace.workspaceId, 'node_repos', socket);

    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-safe-repo',
      type: 'node.register',
      name: 'repo-builder',
      node_id: 'node_repos',
      capabilities: [],
      max_agents: 4,
      tags: ['linux'],
      repo_keys: ['AgentWorkforce/relaycast'],
      version: 'test-node',
    }));
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-spoofed-repo',
      type: 'node.register',
      name: 'repo-builder',
      node_id: 'node_repos',
      capabilities: [],
      max_agents: 4,
      tags: ['linux', 'repo:/Users/alice/private-repo'],
      version: 'test-node',
    }));

    expect(socket.ofType('error').at(-1)).toMatchObject({ ok: false, code: 'invalid_message' });
    expect(await readNode(workspace.workspaceKey)).toMatchObject({
      tags: ['linux', 'repo:AgentWorkforce/relaycast'],
    });
  });
});

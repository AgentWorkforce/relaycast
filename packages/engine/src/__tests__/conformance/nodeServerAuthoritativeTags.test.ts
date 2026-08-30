import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspace, FakeSocket, makeNodeStack, type TestStack } from './harness.js';

/**
 * Server-authoritative tags survive re-registration by a client that has
 * no defineNode of its own (`cloud#3213`). A JIT-provisioned sandbox
 * runs `relay cloud enroll && relay node up` bare; the broker's
 * subsequent `node.register` carries `tags: []`, and before this
 * behaviour was locked down that emptied the enrollment-set
 * `cloud:node-type:daytona-jit` tag placement's sandbox-only gate
 * matches on. Placement then refused every JIT node cloud provisioned
 * for it.
 */
describe('fleet node server-authoritative tag preservation', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  async function readNode(workspaceKey: string, name: string) {
    const response = await stack.app.request(`/v1/nodes?name=${name}`, {
      headers: { authorization: `Bearer ${workspaceKey}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Array<Record<string, unknown>> };
    return body.data[0];
  }

  it('preserves cloud:* tags set at enrollment when the node re-registers with no tags', async () => {
    const workspace = await createWorkspace(stack.app, 'jit-tag-preservation');
    const enrollment = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspace.workspaceKey}` },
      body: JSON.stringify({
        node_id: 'node_jit',
        name: 'fleet-jit-abc',
        max_agents: 4,
        tags: ['cloud:node-type:daytona-jit'],
        version: 'test-node',
      }),
    });
    expect(enrollment.status).toBe(201);

    // The broker mirror: bare `relay node up` with no defineNode.
    // `NodeProviderClient` defaults `tags` to `[]`, so the register
    // frame arrives with an empty list. The enrollment-set JIT tag
    // MUST survive.
    const socket = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(workspace.workspaceId, 'node_jit', socket);
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-bare',
      type: 'node.register',
      name: 'fleet-jit-abc',
      node_id: 'node_jit',
      capabilities: [],
      max_agents: 4,
      tags: [],
      version: 'test-node',
      resume_cursor: null,
    }));

    const reply = socket.ofType('reply').at(-1) as { ok: boolean; data: { tags: string[] } };
    expect(reply.ok).toBe(true);
    expect(reply.data.tags).toEqual(['cloud:node-type:daytona-jit']);
    expect(await readNode(workspace.workspaceKey, 'fleet-jit-abc')).toMatchObject({
      tags: ['cloud:node-type:daytona-jit'],
    });
  });

  it('merges cloud:* enrollment tags with a client-supplied non-cloud tag on re-register', async () => {
    const workspace = await createWorkspace(stack.app, 'jit-tag-merge');
    const enrollment = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspace.workspaceKey}` },
      body: JSON.stringify({
        node_id: 'node_jit2',
        name: 'fleet-jit-def',
        max_agents: 4,
        tags: ['cloud:node-type:daytona-jit', 'linux'],
        version: 'test-node',
      }),
    });
    expect(enrollment.status).toBe(201);

    const socket = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(workspace.workspaceId, 'node_jit2', socket);
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-with-client-tag',
      type: 'node.register',
      name: 'fleet-jit-def',
      node_id: 'node_jit2',
      capabilities: [],
      max_agents: 4,
      // Client declares `gpu`; drops `linux` (no local knowledge of it)
      // and does not repeat the enrollment JIT tag. The JIT tag must
      // still survive; `linux` legitimately drops (client-declared, not
      // server-authoritative); `gpu` is merged in.
      tags: ['gpu'],
      version: 'test-node',
      resume_cursor: null,
    }));

    const reply = socket.ofType('reply').at(-1) as { ok: boolean; data: { tags: string[] } };
    expect(reply.ok).toBe(true);
    // Order: client tags first (no cloud:*), then preserved server tags.
    expect(reply.data.tags).toEqual(['gpu', 'cloud:node-type:daytona-jit']);
  });

  it('drops a client-supplied cloud:* tag — it can only be set by the enrollment surface', async () => {
    const workspace = await createWorkspace(stack.app, 'jit-tag-spoof');
    const enrollment = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspace.workspaceKey}` },
      body: JSON.stringify({
        node_id: 'node_spoof',
        name: 'fleet-spoof-abc',
        max_agents: 4,
        tags: [],
        version: 'test-node',
      }),
    });
    expect(enrollment.status).toBe(201);

    const socket = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(workspace.workspaceId, 'node_spoof', socket);
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-spoof',
      type: 'node.register',
      name: 'fleet-spoof-abc',
      node_id: 'node_spoof',
      capabilities: [],
      max_agents: 4,
      // The node self-declares the JIT tag. Placement would then match
      // this as a JIT sandbox even though it never was one. Must be
      // dropped, same guarantee as `repo:` — a node cannot self-declare
      // a server-authoritative identity.
      tags: ['cloud:node-type:daytona-jit'],
      version: 'test-node',
      resume_cursor: null,
    }));

    const reply = socket.ofType('reply').at(-1) as { ok: boolean; data: { tags: string[] } };
    expect(reply.ok).toBe(true);
    expect(reply.data.tags).toEqual([]);
    expect(await readNode(workspace.workspaceKey, 'fleet-spoof-abc')).toMatchObject({ tags: [] });
  });
});
